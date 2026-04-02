/**
 * E2E tests: Registration, login, user approval, passphrase recovery, and chat.
 *
 * See TESTS.md for the full spec these tests cover.
 * Uses "User A" (first user / admin) and "User B" (second user) naming.
 */

import { test, expect, registerNewUser, clearAllStorage } from './fixtures.js';

// ── Helpers ─────────────────────────────────────────────────────────────

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

/**
 * Clear all storage, navigate to login, click Sign In, wait for the inline
 * recovery form to appear on login.html.
 */
async function clearAndLoginToRecovery(page) {
    await clearAllStorage(page);
    await page.goto('/login.html');
    await page.locator('#login-button').click();
    await page.locator('#login-recovery-form').waitFor({ state: 'visible', timeout: 15_000 });
}

// ─── Registration form validation ───────────────────────────────────────

test.describe('Registration form', () => {
    test('login page renders with a Register button', async ({ authenticatedPage: page }) => {
        await page.goto('/login.html');
        await expect(page.locator('#login-button')).toBeVisible();
        await expect(page.locator('#go-to-register-button')).toBeVisible();
    });

    test('register form has username and two passphrase fields', async ({ authenticatedPage: page }) => {
        await page.goto('/register.html');
        await expect(page.locator('#register-username')).toBeVisible();
        await expect(page.locator('#recovery-passphrase')).toBeVisible();
        await expect(page.locator('#recovery-passphrase-confirm')).toBeVisible();
    });

    test('User A: reserved words in username show error', async ({ authenticatedPage: page }) => {
        await page.goto('/register.html');

        for (const reserved of ['admin_user', 'myskrib', 'system01']) {
            await page.locator('#register-username').fill(reserved);
            await page.locator('#register-username').dispatchEvent('input');
            await expect(page.locator('#register-username')).toHaveClass(/invalid/);
        }
    });

    test('User A: too-short username shows error', async ({ authenticatedPage: page }) => {
        await page.goto('/register.html');
        const input = page.locator('#register-username');
        await input.fill('ab');
        await input.dispatchEvent('input');
        await expect(input).toHaveClass(/invalid/);
    });

    test('User A: too-long username shows error', async ({ authenticatedPage: page }) => {
        await page.goto('/register.html');
        const input = page.locator('#register-username');
        // Bypass HTML maxlength to set a value the JS validator will reject (>16 chars)
        await page.evaluate(() => {
            document.getElementById('register-username').removeAttribute('maxlength');
        });
        await input.fill('a'.repeat(17));
        await input.dispatchEvent('input');
        await expect(input).toHaveClass(/invalid/);
    });

    test('User A: mismatched passphrase shows error', async ({ authenticatedPage: page }) => {
        await page.goto('/register.html');

        await page.locator('#register-username').fill('test_user1');
        await page.locator('#recovery-passphrase').fill(PASSPHRASE);
        await page.locator('#recovery-passphrase-confirm').fill('Different-Passphrase-1234!xxxxx');

        await page.locator('#register-submit-button').click();

        await expect(page.locator('#passphrase-status')).toContainText('do not match');
    });
});

// ─── Full registration + passkey + login flow ───────────────────────────

test.describe('Registration and login flow', () => {

    test('User A registers, creates passkey, sends Hello World, sees it in chat', async ({ authenticatedPage: page }) => {
        await page.goto('/register.html');
        await page.waitForLoadState('networkidle');

        const username = `tu${(Date.now() % 100000).toString(36)}`;

        await page.locator('#register-username').fill(username);
        await page.locator('#recovery-passphrase').fill(PASSPHRASE);
        await page.locator('#recovery-passphrase-confirm').fill(PASSPHRASE);
        await page.locator('#register-submit-button').click();

        // Should redirect to enroll-passkey page
        await page.waitForURL('**/enroll-passkey.html**');
        await expect(page.locator('#enroll-username')).toHaveText(username);

        // Enroll passkey — virtual authenticator handles the ceremony
        await page.locator('#enroll-passkey-button').click();

        // First user is auto-approved → redirect to app.html
        await page.waitForURL('**/app.html**', { timeout: 15_000 });
        await expect(page.locator('#sidebar')).toBeVisible();

        // Create a room and send Hello World
        await createRoomAndSendHello(page);
    });

    test('passkey enrollment fails, shows helpful error', async ({ browser, baseURL }) => {
        const context = await browser.newContext({ baseURL });
        const page = await context.newPage();

        await page.goto('/register.html');
        await page.waitForLoadState('networkidle');

        const username = `pfail${(Date.now() % 100000).toString(36)}`;
        await page.locator('#register-username').fill(username);
        await page.locator('#recovery-passphrase').fill(PASSPHRASE);
        await page.locator('#recovery-passphrase-confirm').fill(PASSPHRASE);
        await page.locator('#register-submit-button').click();

        await page.waitForURL('**/enroll-passkey.html**');

        // Override credentials.create to simulate authenticator failure
        await page.evaluate(() => {
            navigator.credentials.create = () => Promise.reject(
                new DOMException('The operation either timed out or was not allowed.', 'NotAllowedError')
            );
        });

        await page.locator('#enroll-passkey-button').click();

        // Should show user-friendly error
        await expect(page.locator('#enroll-status')).toContainText(/cancelled|not allowed/i, { timeout: 5_000 });

        await context.close();
    });

    test('User A logs out and logs in again with passkey, sees chat UI', async ({ registeredUser }) => {
        const { page, username } = registeredUser;

        await page.waitForURL('**/app.html**', { timeout: 15_000 });
        await expect(page.locator('#sidebar')).toBeVisible();

        // Logout — clear session but keep IndexedDB (private key stays)
        await page.evaluate(() => {
            localStorage.removeItem('session_token');
            localStorage.removeItem('username');
            localStorage.removeItem('role');
        });
        await page.goto('/login.html');

        // Login with passkey
        await page.locator('#login-button').click();

        // Should redirect to app.html
        await page.waitForURL('**/app.html**', { timeout: 15_000 });
        await expect(page.locator('#sidebar')).toBeVisible();

        const storedUsername = await page.evaluate(() => localStorage.getItem('username'));
        expect(storedUsername).toBe(username);
    });

    test('User A recovers encryption key with correct passphrase, sees Hello World', async ({ registeredUser }) => {
        const { page } = registeredUser;
        await page.waitForURL('**/app.html**', { timeout: 15_000 });

        // Create room and send message
        const roomName = await createRoomAndSendHello(page);

        // Clear ALL storage (localStorage, sessionStorage, IndexedDB) — simulates new device
        // Virtual authenticator credential persists (CDP-level)
        await clearAndLoginToRecovery(page);

        // Enter correct passphrase in inline recovery form
        await page.locator('#login-recovery-passphrase').fill(PASSPHRASE);
        await page.locator('#login-recovery-submit').click();

        // Should redirect to app.html after recovery
        await page.waitForURL('**/app.html**', { timeout: 15_000 });

        // Navigate to the room and verify Hello World is still decryptable
        await page.locator(`.room-item[data-room-id="${roomName}"]`).waitFor({ timeout: 10_000 });
        await page.locator(`.room-item[data-room-id="${roomName}"]`).click();
        await expect(page.locator('#messages')).toContainText('Hello World', { timeout: 15_000 });
    });

    test('User A enters wrong passphrase during recovery, gets error', async ({ registeredUser }) => {
        const { page } = registeredUser;
        await page.waitForURL('**/app.html**', { timeout: 15_000 });

        // Create room and send message (so there's a passphrase-wrapped key on the server)
        await createRoomAndSendHello(page);

        // Clear all storage and trigger recovery flow
        await clearAndLoginToRecovery(page);

        // Enter WRONG passphrase in inline recovery form
        await page.locator('#login-recovery-passphrase').fill('Wrong-Passphrase-9999!xxxxxxxxxxxxx');
        await page.locator('#login-recovery-submit').click();

        // Should show error and stay on login page
        await expect(page.locator('#login-recovery-status')).toContainText('Wrong password', { timeout: 10_000 });
        expect(page.url()).toContain('login.html');
    });

    test('User B: duplicate username is rejected', async ({ registeredUser, browser, baseURL }) => {
        const { username: existingUsername } = registeredUser;

        const context = await browser.newContext({ baseURL });
        const page2 = await context.newPage();

        const client = await context.newCDPSession(page2);
        await client.send('WebAuthn.enable');
        await client.send('WebAuthn.addVirtualAuthenticator', {
            options: {
                protocol: 'ctap2',
                transport: 'internal',
                hasResidentKey: true,
                hasUserVerification: true,
                isUserVerified: true,
                automaticPresenceSimulation: true,
            },
        });

        await page2.goto('/register.html');
        await page2.waitForLoadState('networkidle');

        // User B tries to register with User A's username
        await page2.locator('#register-username').fill(existingUsername);
        await page2.locator('#recovery-passphrase').fill(PASSPHRASE);
        await page2.locator('#recovery-passphrase-confirm').fill(PASSPHRASE);
        await page2.locator('#register-submit-button').click();

        // Should redirect back to register.html with an error
        await page2.waitForURL('**/register.html**');
        await expect(page2.locator('#register-status')).toContainText('already taken');

        await context.close();
    });

    test('Admin (User A) approves User B, User B logs in with passkey and sees chat UI', async ({ registeredUser, browser, baseURL }) => {
        const admin = registeredUser;

        // Register User B
        const ctx2 = await browser.newContext({ baseURL });
        const page2 = await ctx2.newPage();
        const client2 = await ctx2.newCDPSession(page2);
        await client2.send('WebAuthn.enable');
        await client2.send('WebAuthn.addVirtualAuthenticator', {
            options: {
                protocol: 'ctap2',
                transport: 'internal',
                hasResidentKey: true,
                hasUserVerification: true,
                isUserVerified: true,
                automaticPresenceSimulation: true,
            },
        });

        const username2 = `ub${(Date.now() % 100000).toString(36)}`;

        await page2.goto('/register.html');
        await page2.waitForLoadState('networkidle');
        await page2.locator('#register-username').fill(username2);
        await page2.locator('#recovery-passphrase').fill(PASSPHRASE);
        await page2.locator('#recovery-passphrase-confirm').fill(PASSPHRASE);
        await page2.locator('#register-submit-button').click();

        await page2.waitForURL('**/enroll-passkey.html**');
        await page2.locator('#enroll-passkey-button').click();

        // User B should see pending approval
        await page2.locator('.approval-code').waitFor({ timeout: 15_000 });
        const approvalCode = await page2.locator('.approval-code .code').textContent();
        expect(approvalCode).toBeTruthy();

        // Admin (User A) approves via API
        const approveResp = await admin.page.request.patch(
            `${baseURL}/api/users/pending/${encodeURIComponent(approvalCode)}`,
            {
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${admin.sessionToken}`,
                },
                data: { status: 'approved' },
            }
        );
        expect(approveResp.ok()).toBeTruthy();

        // User B logs in
        await page2.goto('/login.html');
        await page2.locator('#login-button').click();
        await page2.waitForURL('**/app.html**', { timeout: 15_000 });
        await expect(page2.locator('#sidebar')).toBeVisible();

        await ctx2.close();
    });

    test('User B recovers encryption key with passphrase, sees User A Hello World', async ({ browser, baseURL }) => {
        // Register User A (auto-approved as admin)
        const userA = await registerNewUser(browser, baseURL);
        await userA.page.waitForURL('**/app.html**', { timeout: 15_000 });

        // User A creates a room and sends Hello World
        const roomName = await createRoomAndSendHello(userA.page);

        // Register User B (pending)
        const userB = await registerNewUser(browser, baseURL);

        // User A approves User B
        const approveResp = await userA.page.request.patch(
            `${baseURL}/api/users/pending/${encodeURIComponent(userB.approvalCode)}`,
            {
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${userA.sessionToken}`,
                },
                data: { status: 'approved' },
            }
        );
        expect(approveResp.ok()).toBeTruthy();

        // User A invites User B to the room (shares encrypted room key)
        await userA.page.locator('#message-input').fill(`/invite ${userB.username}`);
        await userA.page.locator('#message-input').press('Enter');
        await expect(userA.page.locator('#messages')).toContainText(`Invited ${userB.username}`, { timeout: 10_000 });

        // User B logs in and navigates to the room
        await userB.page.goto('/login.html');
        await userB.page.locator('#login-button').click();
        await userB.page.waitForURL('**/app.html**', { timeout: 15_000 });

        // User B selects the room and sees Hello World
        await userB.page.locator(`.room-item[data-room-id="${roomName}"]`).waitFor({ timeout: 10_000 });
        await userB.page.locator(`.room-item[data-room-id="${roomName}"]`).click();
        await expect(userB.page.locator('#messages')).toContainText('Hello World', { timeout: 15_000 });

        // User B clears all storage (simulates new device)
        await clearAndLoginToRecovery(userB.page);

        // User B enters correct passphrase in inline recovery form
        await userB.page.locator('#login-recovery-passphrase').fill(PASSPHRASE);
        await userB.page.locator('#login-recovery-submit').click();

        // User B redirected to app.html after recovery
        await userB.page.waitForURL('**/app.html**', { timeout: 15_000 });

        // User B navigates to room and can still decrypt User A's message
        await userB.page.locator(`.room-item[data-room-id="${roomName}"]`).waitFor({ timeout: 10_000 });
        await userB.page.locator(`.room-item[data-room-id="${roomName}"]`).click();
        await expect(userB.page.locator('#messages')).toContainText('Hello World', { timeout: 15_000 });

        await userA.context.close();
        await userB.context.close();
    });

    test('Admin (User A) declines User B, User B cannot log in', async ({ registeredUser, browser, baseURL }) => {
        const admin = registeredUser;

        // Register User B
        const ctx2 = await browser.newContext({ baseURL });
        const page2 = await ctx2.newPage();
        const client2 = await ctx2.newCDPSession(page2);
        await client2.send('WebAuthn.enable');
        await client2.send('WebAuthn.addVirtualAuthenticator', {
            options: {
                protocol: 'ctap2',
                transport: 'internal',
                hasResidentKey: true,
                hasUserVerification: true,
                isUserVerified: true,
                automaticPresenceSimulation: true,
            },
        });

        const username3 = `uc${(Date.now() % 100000).toString(36)}`;

        await page2.goto('/register.html');
        await page2.waitForLoadState('networkidle');
        await page2.locator('#register-username').fill(username3);
        await page2.locator('#recovery-passphrase').fill(PASSPHRASE);
        await page2.locator('#recovery-passphrase-confirm').fill(PASSPHRASE);
        await page2.locator('#register-submit-button').click();

        await page2.waitForURL('**/enroll-passkey.html**');
        await page2.locator('#enroll-passkey-button').click();

        await page2.locator('.approval-code').waitFor({ timeout: 15_000 });
        const approvalCode = await page2.locator('.approval-code .code').textContent();

        // Admin (User A) rejects
        const rejectResp = await admin.page.request.patch(
            `${baseURL}/api/users/pending/${encodeURIComponent(approvalCode)}`,
            {
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${admin.sessionToken}`,
                },
                data: { status: 'rejected' },
            }
        );
        expect(rejectResp.ok()).toBeTruthy();

        // User B tries to login — credential is deleted with rejected user
        await page2.goto('/login.html');
        await page2.locator('#login-button').click();

        // Should show error, not redirect to app
        await expect(page2.locator('#auth-status')).toContainText(/not found|error/i, { timeout: 10_000 });
        expect(page2.url()).toContain('login.html');

        await ctx2.close();
    });

    // WebAuthn is usernameless (discoverable credentials), so "invalid username"
    // and "wrong passkey" reduce to: no credential in authenticator → sign in fails.
    test('sign in with no registered credentials shows error', async ({ browser, baseURL }) => {
        const context = await browser.newContext({ baseURL });
        const page = await context.newPage();

        // Enable WebAuthn but add no authenticator credentials
        const client = await context.newCDPSession(page);
        await client.send('WebAuthn.enable');
        await client.send('WebAuthn.addVirtualAuthenticator', {
            options: {
                protocol: 'ctap2',
                transport: 'internal',
                hasResidentKey: true,
                hasUserVerification: true,
                isUserVerified: true,
                automaticPresenceSimulation: true,
            },
        });

        await page.goto('/login.html');
        await page.locator('#login-button').click();

        // Authenticator has no credentials → ceremony fails
        await expect(page.locator('#auth-status')).toContainText(/error|not allowed|cancelled/i, { timeout: 10_000 });
        expect(page.url()).toContain('login.html');

        await context.close();
    });

    test('unauthenticated user accessing app.html is redirected to login', async ({ authenticatedPage: page }) => {
        await page.goto('/app.html');
        await page.waitForURL('**/login.html**', { timeout: 10_000 });
    });

    test('User A on app.html with missing IndexedDB keys is redirected to login for recovery', async ({ registeredUser }) => {
        const { page } = registeredUser;
        await page.waitForURL('**/app.html**', { timeout: 15_000 });
        await expect(page.locator('#sidebar')).toBeVisible();

        // Send a message so the server has a passphrase-wrapped key to recover
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

        // Reload app.html — should detect missing key and redirect to login for re-auth + recovery
        await page.goto('/app.html');
        await page.waitForURL('**/login.html**', { timeout: 15_000 });
    });

    test('User A sets server to closed, new user cannot register', async ({ registeredUser, browser, baseURL }) => {
        const admin = registeredUser;

        // Admin (User A) sets registration mode to closed
        const resp = await admin.page.request.patch(`${baseURL}/api/server`, {
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${admin.sessionToken}`,
            },
            data: { registration_mode: 'closed' },
        });
        expect(resp.ok()).toBeTruthy();

        // New user opens login page — Register button should be hidden
        const ctx2 = await browser.newContext({ baseURL });
        const page2 = await ctx2.newPage();
        await page2.goto('/login.html');
        await page2.waitForLoadState('networkidle');
        await expect(page2.locator('#register-section')).toHaveClass(/hidden/);

        // New user navigates directly to register.html
        await page2.goto('/register.html');
        await page2.waitForLoadState('networkidle');

        // Should show "closed" error and disable the form
        await expect(page2.locator('#register-status')).toContainText('Registration is currently closed');
        await expect(page2.locator('#register-submit-button')).toBeDisabled();
        await expect(page2.locator('#register-username')).toBeDisabled();

        await ctx2.close();
    });
});
