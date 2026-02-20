/**
 * E2E tests for encryption key loss and room key regeneration.
 *
 * Tests the full flow: register → create room → send message → lose keys →
 * login again → verify old messages unreadable, new messages work.
 *
 * Uses a standard (non-PRF) authenticator to simulate the common case
 * where PRF-based recovery is not available.
 */
import { test as base, expect } from '@playwright/test';

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

/** Register a user and wait for redirect to app.html. */
async function registerUser(page, username) {
    await page.goto('/register.html');
    await page.waitForLoadState('networkidle');
    await page.locator('#register-username').pressSequentially(username, { delay: 30 });
    await page.locator('#register-submit-button').click();
    await page.waitForURL(/.*app\.html/, { timeout: 20000 });
}

/** Login and wait for redirect to app.html. */
async function loginUser(page) {
    await page.goto('/login.html');
    await page.waitForLoadState('networkidle');
    await page.locator('#login-button').click();
    await page.waitForURL(/.*app\.html/, { timeout: 20000 });
}

/** Create a room, wait for it to be selected, return the room name. */
async function createRoom(page) {
    const roomName = `room-${Math.random().toString(36).slice(2, 8)}`;
    await page.locator('#add-channel-btn').click();
    await expect(page.locator('#create-room-modal')).toBeVisible();
    await page.locator('#new-room-input').pressSequentially(roomName, { delay: 20 });
    await page.locator('#create-room-submit-btn').click();
    await expect(page.locator('#chat-header-name')).not.toHaveText('[No room selected]', { timeout: 10000 });
    return roomName;
}

/** Send a message and wait for it to appear in the chat. */
async function sendMessage(page, text) {
    await page.locator('#message-input').fill(text);
    await page.locator('#send-button').click();
    await expect(page.locator('#messages')).toContainText(text, { timeout: 5000 });
}

/** Clear all browser-side encryption state (IndexedDB + localStorage session). */
async function clearLocalData(page) {
    await page.evaluate(async () => {
        // Delete all IndexedDB databases
        const dbs = await indexedDB.databases();
        for (const db of dbs) indexedDB.deleteDatabase(db.name);
        // Clear session
        localStorage.removeItem('session_token');
        localStorage.removeItem('username');
        localStorage.removeItem('role');
    });
}

const test = base;

test.describe('Key Loss and Recovery', () => {
    test('login generates fresh key pair when local keys are lost (no PRF)', async ({ page }) => {
        const { client, authenticatorId } = await addStandardAuthenticator(page);
        const username = uniqueName('kl');

        await registerUser(page, username);

        // Verify we have a private key in IndexedDB
        const hasKeyBefore = await page.evaluate(async (uname) => {
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
        expect(hasKeyBefore).toBeTruthy();

        // Destroy local data
        await clearLocalData(page);

        const consoleMessages = [];
        page.on('console', (msg) => consoleMessages.push(msg.text()));

        // Login again — wait for app to fully load
        await loginUser(page);
        await expect(page.locator('#chat-view')).toBeVisible({ timeout: 5000 });

        // Should have generated a fresh key pair (Branch 4)
        expect(consoleMessages.some((m) =>
            m.includes('[E2E] Private key lost. No PRF for recovery. Generating fresh key pair.')
        )).toBeTruthy();

        // Private key should be back in IndexedDB (new key)
        const hasKeyAfter = await page.evaluate(async (uname) => {
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
        expect(hasKeyAfter).toBeTruthy();

        // Key regeneration flag consumed by app.js triggers console warning
        expect(consoleMessages.some((m) =>
            m.includes('[E2E] Encryption key was regenerated')
        )).toBeTruthy();

        await client.send('WebAuthn.removeVirtualAuthenticator', { authenticatorId });
    });

    test('old messages unreadable after key loss, new messages work', async ({ page }) => {
        const { client, authenticatorId } = await addStandardAuthenticator(page);
        const username = uniqueName('msg');

        // Register and land on app
        await registerUser(page, username);

        // Create a room and send a message
        const roomName = await createRoom(page);
        const originalMessage = `secret-${Math.random().toString(36).slice(2, 8)}`;
        await sendMessage(page, originalMessage);

        // Verify message is visible (decrypted)
        await expect(page.locator('#messages')).toContainText(originalMessage);

        // Destroy local data (simulates clearing browser / new device without PRF)
        await clearLocalData(page);

        const consoleMessages = [];
        page.on('console', (msg) => consoleMessages.push(msg.text()));

        // Login again — will generate fresh key pair
        await loginUser(page);
        await expect(page.locator('#chat-view')).toBeVisible({ timeout: 5000 });

        // Select the same room
        await page.locator(`.room-item:has-text("${roomName}")`).click();
        await expect(page.locator('#chat-header-name')).toContainText(roomName, { timeout: 5000 });

        // Wait for room keys to load (and regenerate)
        await page.waitForTimeout(1000);

        // Old message should be unreadable
        await expect(page.locator('#messages')).toContainText('encrypted message', { timeout: 5000 });

        // Room key should have been regenerated at a new epoch
        expect(consoleMessages.some((m) =>
            m.includes('[E2E] Regenerated room key for')
        )).toBeTruthy();

        // Send a NEW message — should work with the regenerated room key
        const newMessage = `after-regen-${Math.random().toString(36).slice(2, 8)}`;
        await page.locator('#message-input').fill(newMessage);
        await page.locator('#send-button').click();
        await expect(page.locator('#messages')).toContainText(newMessage, { timeout: 5000 });

        await client.send('WebAuthn.removeVirtualAuthenticator', { authenticatorId });
    });

    test('system message warns user about key regeneration', async ({ page }) => {
        const { client, authenticatorId } = await addStandardAuthenticator(page);
        const username = uniqueName('warn');

        await registerUser(page, username);

        // Destroy local data
        await clearLocalData(page);

        // Login again
        await loginUser(page);
        await expect(page.locator('#chat-view')).toBeVisible({ timeout: 5000 });

        // Should see a system message about key regeneration
        await expect(page.locator('.system-message')).toContainText(
            'encryption key was regenerated',
            { timeout: 3000 },
        );

        await client.send('WebAuthn.removeVirtualAuthenticator', { authenticatorId });
    });

    test('key regeneration uploads new public key to server', async ({ page }) => {
        const { client, authenticatorId } = await addStandardAuthenticator(page);
        const username = uniqueName('pubk');

        await registerUser(page, username);

        // Get original public key from server
        const originalPubKey = await page.evaluate(async (uname) => {
            const token = localStorage.getItem('session_token');
            const resp = await fetch(`/api/auth/encryption-key/${encodeURIComponent(uname)}`, {
                headers: { 'Authorization': `Bearer ${token}` },
            });
            const data = await resp.json();
            return data.public_key;
        }, username);
        expect(originalPubKey).toBeTruthy();

        // Destroy local data
        await clearLocalData(page);

        // Login again (generates fresh key pair, uploads new public key)
        await loginUser(page);

        // Get new public key from server
        const newPubKey = await page.evaluate(async (uname) => {
            const token = localStorage.getItem('session_token');
            const resp = await fetch(`/api/auth/encryption-key/${encodeURIComponent(uname)}`, {
                headers: { 'Authorization': `Bearer ${token}` },
            });
            const data = await resp.json();
            return data.public_key;
        }, username);
        expect(newPubKey).toBeTruthy();

        // Public key should be DIFFERENT (fresh key pair generated)
        expect(newPubKey).not.toBe(originalPubKey);

        await client.send('WebAuthn.removeVirtualAuthenticator', { authenticatorId });
    });
});
