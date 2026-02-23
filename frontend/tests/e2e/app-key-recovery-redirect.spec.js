/**
 * E2E test for app.js key recovery redirect.
 *
 * Covers the scenario where a user has a valid session on app.html but loses
 * their IndexedDB encryption keys (e.g. cleared browser data). The app should
 * detect the missing key, find the server-side passphrase-wrapped backup, and
 * redirect through the login flow for recovery.
 */
import { test as base, expect } from './fixtures.js';

const TEST_PASSPHRASE = 'This-is-a-valid-test-passphrase-32!';

function uniqueName(prefix) {
    return `${prefix}${Math.random().toString(36).slice(2, 9)}`;
}

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

/**
 * Clear all keys from IndexedDB while keeping the session token in localStorage.
 * Clears the object store records (rather than deleting the database) to avoid
 * blocking issues with open connections.
 */
async function clearIndexedDBOnly(page) {
    await page.evaluate(async () => {
        return new Promise((resolve, reject) => {
            const req = indexedDB.open('skrib-keys', 1);
            req.onsuccess = () => {
                const db = req.result;
                const tx = db.transaction('keys', 'readwrite');
                tx.objectStore('keys').clear();
                tx.oncomplete = () => { db.close(); resolve(); };
                tx.onerror = () => { db.close(); reject(tx.error); };
            };
            req.onerror = () => reject(req.error);
        });
    });
}

async function hasPrivateKey(page, username) {
    return await page.evaluate(async (uname) => {
        return new Promise((resolve) => {
            const req = indexedDB.open('skrib-keys', 1);
            req.onupgradeneeded = () => {
                // DB was just created (was deleted) — no keys exist
                req.result.createObjectStore('keys', { keyPath: 'id' });
            };
            req.onsuccess = () => {
                const db = req.result;
                const tx = db.transaction('keys', 'readonly');
                const getReq = tx.objectStore('keys').get(`private:${uname}`);
                getReq.onsuccess = () => {
                    db.close();
                    resolve(!!getReq.result?.value);
                };
                getReq.onerror = () => { db.close(); resolve(false); };
            };
            req.onerror = () => resolve(false);
        });
    }, username);
}

const test = base;

test.describe('App key recovery redirect', () => {
    test('redirects to login when IndexedDB key is missing but session is valid', async ({ page }) => {
        const { client, authenticatorId } = await addStandardAuthenticator(page);
        const username = uniqueName('akr');

        // Register — ends up on app.html with valid session + key in IndexedDB
        await registerUser(page, username);

        // Confirm session token exists
        const token = await page.evaluate(() => localStorage.getItem('session_token'));
        expect(token).toBeTruthy();

        // Clear IndexedDB only (navigates to about:blank, session token stays)
        await clearIndexedDBOnly(page);
        expect(await hasPrivateKey(page, username)).toBeFalsy();

        const consoleMessages = [];
        page.on('console', (msg) => consoleMessages.push(msg.text()));

        // Reload the page — should detect missing key and redirect to login
        await page.reload({ waitUntil: 'domcontentloaded' });
        await page.waitForURL(/.*login\.html/, { timeout: 10000 });

        // Session should have been cleared by the redirect logic
        const tokenAfter = await page.evaluate(() => localStorage.getItem('session_token'));
        expect(tokenAfter).toBeFalsy();

        // Console should show the redirect reason
        expect(consoleMessages.some((m) =>
            m.includes('[E2E] Server has recoverable key, redirecting to login')
        )).toBeTruthy();

        await client.send('WebAuthn.removeVirtualAuthenticator', { authenticatorId });
    });

    test('full round-trip: app redirect → login → passphrase recovery → app with keys', async ({ page }) => {
        const { client, authenticatorId } = await addStandardAuthenticator(page);
        const username = uniqueName('art');

        // Register and send a message
        await registerUser(page, username);

        await page.locator('#add-channel-btn').click();
        await expect(page.locator('#create-room-modal')).toBeVisible();
        const roomName = `room-${Math.random().toString(36).slice(2, 8)}`;
        await page.locator('#new-room-input').pressSequentially(roomName, { delay: 20 });
        await page.locator('#create-room-submit-btn').click();
        await expect(page.locator('#chat-header-name')).not.toHaveText('[No room selected]', { timeout: 1000 });

        const testMessage = `secret-${Math.random().toString(36).slice(2, 8)}`;
        await page.locator('#message-input').fill(testMessage);
        await page.locator('#send-button').click();
        await expect(page.locator('#messages')).toContainText(testMessage, { timeout: 1000 });

        // Get original public key for later comparison
        const origToken = await page.evaluate(() => localStorage.getItem('session_token'));
        const origResp = await page.request.get(`/api/auth/encryption-key/${encodeURIComponent(username)}`, {
            headers: { 'Authorization': `Bearer ${origToken}` },
        });
        const originalN = JSON.parse((await origResp.json()).public_key).n;

        // Clear only IndexedDB (session stays)
        await clearIndexedDBOnly(page);

        const consoleMessages = [];
        page.on('console', (msg) => consoleMessages.push(msg.text()));

        // Reload the page — triggers redirect to login
        await page.reload({ waitUntil: 'domcontentloaded' });
        await page.waitForURL(/.*login\.html/, { timeout: 10000 });

        // Complete passkey login
        await page.locator('#login-button').click();

        // Passphrase recovery prompt should appear
        await page.locator('#passphrase-recovery').waitFor({ state: 'visible', timeout: 10000 });
        await page.locator('#login-recovery-passphrase').fill(TEST_PASSPHRASE);
        await page.locator('#recovery-submit-button').click();

        // Should land back on app.html
        await page.waitForURL(/.*app\.html/, { timeout: 20000 });

        // Private key should be restored in IndexedDB
        expect(await hasPrivateKey(page, username)).toBeTruthy();

        // Public key modulus should be the SAME (recovered, not regenerated)
        const afterToken = await page.evaluate(() => localStorage.getItem('session_token'));
        const afterResp = await page.request.get(`/api/auth/encryption-key/${encodeURIComponent(username)}`, {
            headers: { 'Authorization': `Bearer ${afterToken}` },
        });
        const afterN = JSON.parse((await afterResp.json()).public_key).n;
        expect(afterN).toBe(originalN);

        // Select the room and verify old message is still readable
        await page.locator(`.room-item:has-text("${roomName}")`).click();
        await expect(page.locator('#chat-header-name')).toContainText(roomName, { timeout: 1000 });
        await page.waitForTimeout(1000);
        await expect(page.locator('#messages')).toContainText(testMessage, { timeout: 1000 });

        // No regeneration warning
        const systemMessages = await page.locator('.system-message').allTextContents();
        const hasRegenWarning = systemMessages.some((m) => m.includes('encryption key was regenerated'));
        expect(hasRegenWarning).toBeFalsy();

        await client.send('WebAuthn.removeVirtualAuthenticator', { authenticatorId });
    });

    test('does NOT redirect when no recoverable key exists on server', async ({ page }) => {
        const { client, authenticatorId } = await addStandardAuthenticator(page);
        const username = uniqueName('nrk');

        await registerUser(page, username);

        // Clear the passphrase-wrapped key from the server by posting empty strings
        const token = await page.evaluate(() => localStorage.getItem('session_token'));
        const ekResp = await page.request.get(`/api/auth/encryption-key/${encodeURIComponent(username)}`, {
            headers: { 'Authorization': `Bearer ${token}` },
        });
        const ekData = await ekResp.json();
        await page.request.post('/api/auth/encryption-key', {
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json',
            },
            data: {
                public_key: ekData.public_key,
                encrypted_private_key: '',
                passphrase_encrypted_private_key: '',
            },
        });

        // Verify server no longer has wrapped keys
        const checkResp = await page.request.get(`/api/auth/encryption-key/${encodeURIComponent(username)}`, {
            headers: { 'Authorization': `Bearer ${token}` },
        });
        const checkData = await checkResp.json();
        expect(checkData.passphrase_encrypted_private_key).toBeFalsy();
        expect(checkData.encrypted_private_key).toBeFalsy();

        // Clear IndexedDB only (navigates to about:blank)
        await clearIndexedDBOnly(page);

        // Navigate to app.html — should NOT redirect (no recovery possible)
        await page.goto('/app.html');

        // Should stay on app.html (the chat view should be visible)
        await expect(page.locator('#chat-view')).toBeVisible({ timeout: 10000 });
        expect(page.url()).toContain('/app.html');

        await client.send('WebAuthn.removeVirtualAuthenticator', { authenticatorId });
    });
});
