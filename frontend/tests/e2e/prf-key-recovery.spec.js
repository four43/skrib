/**
 * E2E tests for PRF-based key recovery across browsers.
 *
 * Covers: registration with/without PRF, cross-browser key recovery,
 * lost-key warning, and retroactive PRF backup upload.
 */
import { test as base, expect } from './fixtures.js';

/** Generate a unique username that fits the 15-char max. */
function uniqueName(prefix) {
    return `${prefix}${Math.random().toString(36).slice(2, 9)}`;
}

/** Attach a virtual WebAuthn authenticator WITH PRF support (CTAP 2.1). */
async function addPrfAuthenticator(page) {
    const client = await page.context().newCDPSession(page);
    await client.send('WebAuthn.enable');
    const { authenticatorId } = await client.send('WebAuthn.addVirtualAuthenticator', {
        options: {
            protocol: 'ctap2',
            ctap2Version: 'ctap2_1',
            transport: 'internal',
            hasResidentKey: true,
            hasUserVerification: true,
            isUserVerified: true,
            automaticPresenceSimulation: true,
            hasPrf: true,
        },
    });
    return { client, authenticatorId };
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
async function registerUser(page, username, passphrase = 'This-is-a-valid-test-passphrase-32!') {
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

/** Login and wait for redirect to app.html. Skips passphrase recovery if prompted. */
async function loginUser(page) {
    await page.goto('/login.html');
    await page.waitForLoadState('networkidle');
    await page.locator('#login-button').click();
    // If passphrase recovery prompt appears, skip it
    const skipBtn = page.locator('#recovery-skip-button');
    try {
        await skipBtn.waitFor({ state: 'visible', timeout: 1000 });
        await skipBtn.click();
    } catch {
        // No recovery prompt (e.g. PRF recovered the key already) — proceed normally
    }
    await page.waitForURL(/.*app\.html/, { timeout: 1000 });
}

/** Fetch the encryption key data from the server API. */
async function getServerEncryptionKey(page, username) {
    const token = await page.evaluate(() => localStorage.getItem('session_token'));
    const baseURL = page.url().replace(/\/[^/]*$/, '');
    const resp = await page.request.get(`/api/auth/encryption-key/${encodeURIComponent(username)}`, {
        headers: { 'Authorization': `Bearer ${token}` },
        failOnStatusCode: false,
    });
    return { status: resp.status(), data: resp.status() === 200 ? await resp.json() : null };
}

// -------------------------------------------------------------------------
// Use a basic test fixture — each test manages its own authenticator(s).
// -------------------------------------------------------------------------
const test = base;

test.describe('PRF Key Recovery', () => {
    test('registration with PRF stores encrypted private key on server', async ({ page }) => {
        const { client, authenticatorId } = await addPrfAuthenticator(page);
        const username = uniqueName('prf');

        const consoleMessages = [];
        page.on('console', (msg) => consoleMessages.push(msg.text()));

        await registerUser(page, username);

        // Check for PRF support log
        expect(consoleMessages.some((m) => m.includes('[E2E] PRF supported by authenticator: true'))).toBeTruthy();

        // Server should have the encrypted private key
        const { status, data } = await getServerEncryptionKey(page, username);
        expect(status).toBe(200);
        expect(data.public_key).toBeTruthy();
        expect(data.encrypted_private_key).toBeTruthy();

        await client.send('WebAuthn.removeVirtualAuthenticator', { authenticatorId });
    });

    test('key recovery via PRF after losing local keys', async ({ page }) => {
        // Use one authenticator — same PRF secret throughout.
        // Simulate "different browser" by deleting IndexedDB (local private key gone).
        const { client, authenticatorId } = await addPrfAuthenticator(page);
        const username = uniqueName('xb');

        await registerUser(page, username);

        // Verify server has the encrypted backup from registration
        const regKey = await getServerEncryptionKey(page, username);
        expect(regKey.data.encrypted_private_key).toBeTruthy();

        // Delete IndexedDB to simulate losing local keys (e.g. different browser)
        await page.evaluate(async () => {
            const dbs = await indexedDB.databases();
            for (const db of dbs) indexedDB.deleteDatabase(db.name);
        });

        // Clear session so we must re-login
        await page.evaluate(() => {
            localStorage.removeItem('session_token');
            localStorage.removeItem('username');
            localStorage.removeItem('role');
        });

        const consoleMessages = [];
        page.on('console', (msg) => consoleMessages.push(msg.text()));

        // Login — no local key, PRF available, server has encrypted backup
        await loginUser(page);

        // Should have recovered the key via PRF
        expect(consoleMessages.some((m) => m.includes('[E2E] Private key recovered from server via PRF'))).toBeTruthy();

        // Verify private key is now back in IndexedDB
        const hasKey = await page.evaluate(async (uname) => {
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
        expect(hasKey).toBeTruthy();

        await client.send('WebAuthn.removeVirtualAuthenticator', { authenticatorId });
    });

    test('registration without PRF does not store encrypted private key', async ({ page }) => {
        const { client, authenticatorId } = await addStandardAuthenticator(page);
        const username = uniqueName('noprf');

        const consoleMessages = [];
        page.on('console', (msg) => consoleMessages.push(msg.text()));

        await registerUser(page, username);

        // Check for PRF not-supported log
        expect(consoleMessages.some((m) => m.includes('[E2E] PRF supported by authenticator: false'))).toBeTruthy();

        // Server should have public key but NOT encrypted private key
        const { status, data } = await getServerEncryptionKey(page, username);
        expect(status).toBe(200);
        expect(data.public_key).toBeTruthy();
        expect(data.encrypted_private_key).toBeNull();

        await client.send('WebAuthn.removeVirtualAuthenticator', { authenticatorId });
    });

    test('login without PRF warns about lost private key', async ({ browser }) => {
        // --- Context A: register with PRF (so server has encrypted_private_key) ---
        const contextA = await browser.newContext();
        const pageA = await contextA.newPage();
        const { client: clientA, authenticatorId: authIdA } = await addPrfAuthenticator(pageA);
        const username = uniqueName('lost');

        await registerUser(pageA, username);

        // Extract credential
        const { credentials } = await clientA.send('WebAuthn.getCredentials', {
            authenticatorId: authIdA,
        });
        expect(credentials.length).toBeGreaterThan(0);

        // --- Context B: standard authenticator (no PRF), clean IndexedDB ---
        const contextB = await browser.newContext();
        const pageB = await contextB.newPage();
        const { client: clientB, authenticatorId: authIdB } = await addStandardAuthenticator(pageB);

        // Transfer credential
        for (const cred of credentials) {
            await clientB.send('WebAuthn.addCredential', {
                authenticatorId: authIdB,
                credential: cred,
            });
        }

        const consoleMessages = [];
        pageB.on('console', (msg) => consoleMessages.push(msg.text()));

        // Login in context B (no local key, no PRF, server has key)
        await loginUser(pageB);

        // Should warn about no recovery method (user skipped passphrase)
        expect(consoleMessages.some((m) => m.includes('[E2E] No recovery method succeeded'))).toBeTruthy();

        // Cleanup
        await clientA.send('WebAuthn.removeVirtualAuthenticator', { authenticatorId: authIdA });
        await clientB.send('WebAuthn.removeVirtualAuthenticator', { authenticatorId: authIdB });
        await contextA.close();
        await contextB.close();
    });

    test('existing user login uploads PRF backup when missing', async ({ page }) => {
        // Use a PRF authenticator throughout, but intercept the registration POST
        // to strip encrypted_private_key — simulating a registration that didn't
        // have PRF (e.g. older browser/platform at the time).
        const { client, authenticatorId } = await addPrfAuthenticator(page);
        const username = uniqueName('upld');

        // Strip encrypted_private_key from the POST during registration
        await page.route('**/api/auth/encryption-key', async (route) => {
            if (route.request().method() === 'POST') {
                const body = JSON.parse(route.request().postData());
                delete body.encrypted_private_key;
                await route.continue({ postData: JSON.stringify(body) });
            } else {
                await route.continue();
            }
        });

        await registerUser(page, username);

        // Remove interception so re-login POST goes through unmodified
        await page.unroute('**/api/auth/encryption-key');

        // Verify server has public key but no encrypted private key
        const before = await getServerEncryptionKey(page, username);
        expect(before.status).toBe(200);
        expect(before.data.encrypted_private_key).toBeNull();

        // Clear session so we must re-login (keep IndexedDB with private key)
        await page.evaluate(() => {
            localStorage.removeItem('session_token');
            localStorage.removeItem('username');
            localStorage.removeItem('role');
        });

        const consoleMessages = [];
        page.on('console', (msg) => consoleMessages.push(msg.text()));

        // Re-login (Branch 1: has local key, PRF available, server has no backup)
        await loginUser(page);

        // Should have uploaded the backup
        expect(consoleMessages.some((m) => m.includes('[E2E] Uploaded PRF-wrapped private key backup'))).toBeTruthy();

        // Server should now have encrypted private key
        const after = await getServerEncryptionKey(page, username);
        expect(after.status).toBe(200);
        expect(after.data.encrypted_private_key).toBeTruthy();

        await client.send('WebAuthn.removeVirtualAuthenticator', { authenticatorId });
    });
});
