/**
 * E2E tests for inline key recovery on the login page (merged flow).
 *
 * Tests that passphrase recovery happens directly on login.html
 * instead of redirecting to a separate key-recovery.html page.
 */

import { test, expect, registerNewUser, clearAllStorage } from './fixtures.js';

const PASSPHRASE = 'Test-Passphrase-1234!abcdefghijk';

/** Create a room, send "Hello World", return room name. Caller must be on app.html. */
async function createRoomAndSendHello(page) {
    await page.waitForLoadState('networkidle');

    const roomName = `room-${(Date.now() % 100000).toString(36)}`;
    await page.locator('#add-channel-btn').click();
    await page.locator('#new-room-input').fill(roomName);
    await page.locator('#create-room-submit-btn').click();

    await expect(page.locator('#room-content-name')).toHaveText(`#${roomName}`, { timeout: 10_000 });
    await page.locator('#message-input').waitFor({ timeout: 10_000 });

    await page.locator('#message-input').fill('Hello World');
    await page.locator('#message-input').press('Enter');
    await expect(page.locator('#messages')).toContainText('Hello World', { timeout: 10_000 });

    return roomName;
}


test.describe('Inline key recovery on login page', () => {

    test('passphrase recovery shows inline on login page, not separate page', async ({ registeredUser }) => {
        const { page } = registeredUser;
        await page.waitForURL('**/app.html**', { timeout: 15_000 });

        // Create room and send message (ensures passphrase-wrapped key exists on server)
        await createRoomAndSendHello(page);

        // Clear ALL storage (simulates new device), keep virtual authenticator credential
        await clearAllStorage(page);
        await page.goto('/login.html');
        await page.locator('#login-button').click();

        // Should show passphrase recovery form INLINE on login page (not redirect to key-recovery.html)
        await expect(page.locator('#login-recovery-form')).toBeVisible({ timeout: 15_000 });
        expect(page.url()).toContain('login.html');
    });

    test('correct passphrase recovers key and redirects to app', async ({ registeredUser }) => {
        const { page } = registeredUser;
        await page.waitForURL('**/app.html**', { timeout: 15_000 });

        const roomName = await createRoomAndSendHello(page);

        await clearAllStorage(page);
        await page.goto('/login.html');
        await page.locator('#login-button').click();

        // Wait for inline recovery form
        await expect(page.locator('#login-recovery-form')).toBeVisible({ timeout: 15_000 });

        // Enter correct passphrase and submit
        await page.locator('#login-recovery-passphrase').fill(PASSPHRASE);
        await page.locator('#login-recovery-submit').click();

        // Should redirect to app.html
        await page.waitForURL('**/app.html**', { timeout: 15_000 });

        // Navigate to the room and verify Hello World is still decryptable
        await page.locator(`.room-item[data-room-id="${roomName}"]`).waitFor({ timeout: 10_000 });
        await page.locator(`.room-item[data-room-id="${roomName}"]`).click();
        await expect(page.locator('#messages')).toContainText('Hello World', { timeout: 15_000 });
    });

    test('wrong passphrase shows error, stays on login page', async ({ registeredUser }) => {
        const { page } = registeredUser;
        await page.waitForURL('**/app.html**', { timeout: 15_000 });

        await createRoomAndSendHello(page);

        await clearAllStorage(page);
        await page.goto('/login.html');
        await page.locator('#login-button').click();

        await expect(page.locator('#login-recovery-form')).toBeVisible({ timeout: 15_000 });

        // Enter WRONG passphrase
        await page.locator('#login-recovery-passphrase').fill('Wrong-Passphrase-9999!xxxxxxxxxxxxx');
        await page.locator('#login-recovery-submit').click();

        // Should show error and stay on login page
        await expect(page.locator('#login-recovery-status')).toContainText(/wrong|incorrect|invalid/i, { timeout: 10_000 });
        expect(page.url()).toContain('login.html');
    });

    test('skip recovery generates fresh key and redirects to app', async ({ registeredUser }) => {
        const { page } = registeredUser;
        await page.waitForURL('**/app.html**', { timeout: 15_000 });

        await createRoomAndSendHello(page);

        await clearAllStorage(page);
        await page.goto('/login.html');
        await page.locator('#login-button').click();

        await expect(page.locator('#login-recovery-form')).toBeVisible({ timeout: 15_000 });

        // Click skip
        await page.locator('#login-recovery-skip').click();

        // Should redirect to app.html
        await page.waitForURL('**/app.html**', { timeout: 15_000 });

        // Should show key regenerated warning
        await expect(page.locator('#messages')).toContainText(/regenerated|cannot be decrypted/i, { timeout: 10_000 });
    });

    test('app.html with missing IndexedDB keys redirects to login, not key-recovery.html', async ({ registeredUser }) => {
        const { page } = registeredUser;
        await page.waitForURL('**/app.html**', { timeout: 15_000 });

        await createRoomAndSendHello(page);

        // Clear only IndexedDB (simulates lost keys) — keep localStorage session intact
        await page.evaluate(async () => {
            if (indexedDB.databases) {
                const dbs = await indexedDB.databases();
                for (const db of dbs) {
                    indexedDB.deleteDatabase(db.name);
                }
            }
        });

        // Reload app.html — should redirect to login.html for re-auth + recovery
        await page.goto('/app.html');
        await page.waitForURL('**/login.html**', { timeout: 15_000 });
        expect(page.url()).not.toContain('key-recovery');
    });
});


test.describe('S1: encryption key access control', () => {

    test('user cannot see another user wrapped private keys via API', async ({ browser, baseURL }) => {
        // Register User A (admin)
        const userA = await registerNewUser(browser, baseURL);
        await userA.page.waitForURL('**/app.html**', { timeout: 15_000 });

        // Register User B
        const userB = await registerNewUser(browser, baseURL);

        // Admin approves User B
        const resp = await userA.page.request.patch(
            `${baseURL}/api/users/pending/${encodeURIComponent(userB.approvalCode)}`,
            {
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${userA.sessionToken}`,
                },
                data: { status: 'approved' },
            }
        );
        expect(resp.ok()).toBeTruthy();

        // User B logs in
        await userB.page.goto('/login.html');
        await userB.page.locator('#login-button').click();
        await userB.page.waitForURL('**/app.html**', { timeout: 15_000 });
        const userBToken = await userB.page.evaluate(() => localStorage.getItem('session_token'));

        // User B fetches User A's encryption keys
        const ekResp = await userB.page.request.get(
            `${baseURL}/api/auth/encryption-key/${encodeURIComponent(userA.username)}`,
            { headers: { 'Authorization': `Bearer ${userBToken}` } }
        );
        expect(ekResp.ok()).toBeTruthy();
        const ekData = await ekResp.json();

        // Should have public key but NOT wrapped private keys
        expect(ekData.public_key).toBeTruthy();
        expect(ekData.encrypted_private_key).toBeNull();
        expect(ekData.passphrase_encrypted_private_key).toBeNull();

        await userA.context.close();
        await userB.context.close();
    });
});
