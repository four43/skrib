/**
 * E2E tests for passphrase-based key recovery.
 *
 * Covers: registration stores passphrase-wrapped key, cross-domain key recovery
 * via passphrase, wrong passphrase handling, skip fallback, and message continuity.
 */
import { test as base, expect } from './fixtures.js';

const TEST_PASSPHRASE = 'This-is-a-valid-test-passphrase-32!';

/** Generate a unique username that fits the 15-char max. */
function uniqueName(prefix) {
    return `${prefix}${Math.random().toString(36).slice(2, 9)}`;
}

/** Attach a standard virtual WebAuthn authenticator (no PRF). */
async function addStandardAuthenticator(page) {
    const client = await page.context().newCDPSession(page);
    await client.send('WebAuthn.enable');
    const { authenticatorId } = await client.send('WebAuthn.addVirtualAuthenticator', {
        options: {
            protocol: 'ctap2',
            transport: 'internal',
            hasResidentKey: true,
            hasUserVerification: true,
            isUserVerified: true,
            automaticPresenceSimulation: true,
        },
    });
    return { client, authenticatorId };
}

/** Register a user with recovery passphrase and wait for redirect to app.html. */
async function registerUser(page, username, passphrase = TEST_PASSPHRASE) {
    await page.goto('/register.html');
    await page.waitForLoadState('networkidle');
    await page.locator('#register-username').pressSequentially(username, { delay: 30 });
    await page.locator('#recovery-passphrase').fill(passphrase);
    await page.locator('#recovery-passphrase-confirm').fill(passphrase);
    await page.locator('#register-submit-button').click();
    await page.waitForURL(/.*enroll-passkey\.html/, { timeout: 5000 });
    await page.locator('#enroll-passkey-button').click();
    await page.waitForURL(/.*app\.html/, { timeout: 20000 });
}

/** Login, entering passphrase for recovery when prompted. */
async function loginWithPassphrase(page, passphrase) {
    await page.goto('/login.html');
    await page.waitForLoadState('networkidle');
    await page.locator('#login-button').click();
    // Wait for passphrase recovery prompt
    await page.locator('#passphrase-recovery').waitFor({ state: 'visible', timeout: 10000 });
    await page.locator('#login-recovery-passphrase').fill(passphrase);
    await page.locator('#recovery-submit-button').click();
    await page.waitForURL(/.*app\.html/, { timeout: 20000 });
}

/** Login and skip passphrase recovery. */
async function loginSkipRecovery(page) {
    await page.goto('/login.html');
    await page.waitForLoadState('networkidle');
    await page.locator('#login-button').click();
    const skipBtn = page.locator('#recovery-skip-button');
    try {
        await skipBtn.waitFor({ state: 'visible', timeout: 3000 });
        await skipBtn.click();
    } catch {
        // No prompt
    }
    await page.waitForURL(/.*app\.html/, { timeout: 20000 });
}

/** Fetch the encryption key data from the server API. */
async function getServerEncryptionKey(page, username) {
    const token = await page.evaluate(() => localStorage.getItem('session_token'));
    const resp = await page.request.get(`/api/auth/encryption-key/${encodeURIComponent(username)}`, {
        headers: { 'Authorization': `Bearer ${token}` },
        failOnStatusCode: false,
    });
    return { status: resp.status(), data: resp.status() === 200 ? await resp.json() : null };
}

/** Clear all browser-side encryption state (IndexedDB + localStorage session). */
async function clearLocalData(page) {
    await page.evaluate(async () => {
        const dbs = await indexedDB.databases();
        for (const db of dbs) indexedDB.deleteDatabase(db.name);
        localStorage.removeItem('session_token');
        localStorage.removeItem('username');
        localStorage.removeItem('role');
    });
}

/** Check if a private key exists in IndexedDB for the given username. */
async function hasPrivateKey(page, username) {
    return await page.evaluate(async (uname) => {
        return new Promise((resolve) => {
            const req = indexedDB.open('skrib-keys', 1);
            req.onsuccess = () => {
                const db = req.result;
                const tx = db.transaction('keys', 'readonly');
                const getReq = tx.objectStore('keys').get(`private:${uname}`);
                getReq.onsuccess = () => resolve(!!getReq.result?.value);
                getReq.onerror = () => resolve(false);
            };
            req.onerror = () => resolve(false);
        });
    }, username);
}

const test = base;

test.describe('Passphrase Key Recovery', () => {
    test('registration stores passphrase-wrapped key on server', async ({ page }) => {
        const { client, authenticatorId } = await addStandardAuthenticator(page);
        const username = uniqueName('pp');

        const consoleMessages = [];
        page.on('console', (msg) => consoleMessages.push(msg.text()));

        await registerUser(page, username);

        // Server should have passphrase-wrapped private key
        const { status, data } = await getServerEncryptionKey(page, username);
        expect(status).toBe(200);
        expect(data.public_key).toBeTruthy();
        expect(data.passphrase_encrypted_private_key).toBeTruthy();

        // The wrapped blob should be valid JSON with expected fields
        const blob = JSON.parse(data.passphrase_encrypted_private_key);
        expect(blob.v).toBe(1);
        expect(blob.salt).toBeTruthy();
        expect(blob.iv).toBeTruthy();
        expect(blob.ct).toBeTruthy();
        expect(blob.iterations).toBe(600000);

        // Console should confirm passphrase wrapping
        expect(consoleMessages.some((m) =>
            m.includes('[E2E] Private key wrapped with passphrase for recovery')
        )).toBeTruthy();

        await client.send('WebAuthn.removeVirtualAuthenticator', { authenticatorId });
    });

    test('key recovery via passphrase after losing local keys', async ({ page }) => {
        const { client, authenticatorId } = await addStandardAuthenticator(page);
        const username = uniqueName('prec');

        await registerUser(page, username);

        // Get original public key
        const original = await getServerEncryptionKey(page, username);
        const originalPubKey = original.data.public_key;

        // Destroy local data
        await clearLocalData(page);

        const consoleMessages = [];
        page.on('console', (msg) => consoleMessages.push(msg.text()));

        // Login and recover via passphrase
        await loginWithPassphrase(page, TEST_PASSPHRASE);

        // Should have recovered via passphrase
        expect(consoleMessages.some((m) =>
            m.includes('[E2E] Private key recovered from server via passphrase')
        )).toBeTruthy();

        // Private key should be back in IndexedDB
        expect(await hasPrivateKey(page, username)).toBeTruthy();

        // Public key modulus should be the SAME (key was recovered, not regenerated)
        const after = await getServerEncryptionKey(page, username);
        const originalN = JSON.parse(originalPubKey).n;
        const afterN = JSON.parse(after.data.public_key).n;
        expect(afterN).toBe(originalN);

        // No system warning about key regeneration (app.js consumes the flag from localStorage)
        const systemMessages = await page.locator('.system-message').allTextContents();
        const hasRegenWarning = systemMessages.some((m) => m.includes('encryption key was regenerated'));
        expect(hasRegenWarning).toBeFalsy();

        await client.send('WebAuthn.removeVirtualAuthenticator', { authenticatorId });
    });

    test('wrong passphrase shows error and allows retry', async ({ page }) => {
        const { client, authenticatorId } = await addStandardAuthenticator(page);
        const username = uniqueName('wrng');

        await registerUser(page, username);
        await clearLocalData(page);

        // Start login
        await page.goto('/login.html');
        await page.waitForLoadState('networkidle');
        await page.locator('#login-button').click();

        // Wait for passphrase recovery prompt
        await page.locator('#passphrase-recovery').waitFor({ state: 'visible', timeout: 10000 });

        // Enter wrong passphrase
        await page.locator('#login-recovery-passphrase').fill('WrongPass999!');
        await page.locator('#recovery-submit-button').click();

        // Should show error
        await expect(page.locator('#recovery-status')).toContainText('Wrong password', { timeout: 10000 });

        // Submit button should be re-enabled for retry
        await expect(page.locator('#recovery-submit-button')).toBeEnabled();

        // Now enter correct passphrase
        await page.locator('#login-recovery-passphrase').fill(TEST_PASSPHRASE);
        await page.locator('#recovery-submit-button').click();

        // Should redirect to app
        await page.waitForURL(/.*app\.html/, { timeout: 20000 });

        // Key should be recovered
        expect(await hasPrivateKey(page, username)).toBeTruthy();

        await client.send('WebAuthn.removeVirtualAuthenticator', { authenticatorId });
    });

    test('skip passphrase recovery generates new key pair', async ({ page }) => {
        const { client, authenticatorId } = await addStandardAuthenticator(page);
        const username = uniqueName('skip');

        await registerUser(page, username);

        const original = await getServerEncryptionKey(page, username);
        const originalPubKey = original.data.public_key;

        await clearLocalData(page);

        const consoleMessages = [];
        page.on('console', (msg) => consoleMessages.push(msg.text()));

        // Login and skip recovery
        await loginSkipRecovery(page);

        // Should have generated fresh key pair
        expect(consoleMessages.some((m) =>
            m.includes('[E2E] No recovery method succeeded. Generating fresh key pair.')
        )).toBeTruthy();

        // Public key modulus should be DIFFERENT (new key pair)
        const after = await getServerEncryptionKey(page, username);
        const originalN = JSON.parse(originalPubKey).n;
        const afterN = JSON.parse(after.data.public_key).n;
        expect(afterN).not.toBe(originalN);

        // System message about key regeneration should appear (app.js consumes the localStorage flag)
        await expect(page.locator('.system-message')).toContainText(
            'encryption key was regenerated',
            { timeout: 5000 },
        );

        await client.send('WebAuthn.removeVirtualAuthenticator', { authenticatorId });
    });

    test('passphrase recovery preserves old message readability', async ({ page }) => {
        const { client, authenticatorId } = await addStandardAuthenticator(page);
        const username = uniqueName('pmsg');

        await registerUser(page, username);

        // Create a room and send a message
        await page.locator('#add-channel-btn').click();
        await expect(page.locator('#create-room-modal')).toBeVisible();
        const roomName = `room-${Math.random().toString(36).slice(2, 8)}`;
        await page.locator('#new-room-input').pressSequentially(roomName, { delay: 20 });
        await page.locator('#create-room-submit-btn').click();
        await expect(page.locator('#chat-header-name')).not.toHaveText('[No room selected]', { timeout: 1000 });

        const originalMessage = `secret-${Math.random().toString(36).slice(2, 8)}`;
        await page.locator('#message-input').fill(originalMessage);
        await page.locator('#send-button').click();
        await expect(page.locator('#messages')).toContainText(originalMessage, { timeout: 1000 });

        // Destroy local data
        await clearLocalData(page);

        // Login and recover via passphrase
        await loginWithPassphrase(page, TEST_PASSPHRASE);
        await expect(page.locator('#chat-view')).toBeVisible({ timeout: 1000 });

        // Select the same room
        await page.locator(`.room-item:has-text("${roomName}")`).click();
        await expect(page.locator('#chat-header-name')).toContainText(roomName, { timeout: 1000 });

        // Wait for messages and room keys to load
        await page.waitForTimeout(1000);

        // Old message should still be readable (same key recovered)
        await expect(page.locator('#messages')).toContainText(originalMessage, { timeout: 1000 });

        // No system warning about key regeneration
        const systemMessages = await page.locator('.system-message').allTextContents();
        const hasRegenWarning = systemMessages.some((m) => m.includes('encryption key was regenerated'));
        expect(hasRegenWarning).toBeFalsy();

        await client.send('WebAuthn.removeVirtualAuthenticator', { authenticatorId });
    });
});
