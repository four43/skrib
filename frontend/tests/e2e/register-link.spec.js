/**
 * E2E tests: Invite link (register link) functionality.
 *
 * Covers the admin invite token workflow:
 *   - Creating invite tokens via API
 *   - Registering with a valid invite in invite_only mode (auto-approved)
 *   - Rejection when no token or invalid token is provided
 *   - Listing and deleting invite tokens
 *   - Used tokens cannot be reused
 */

import { test, expect, registerNewUser } from './fixtures.js';

const PASSPHRASE = 'Test-Passphrase-1234!abcdefghijk';

/**
 * Set registration mode via admin API.
 */
async function setRegistrationMode(page, baseURL, sessionToken, mode) {
    const resp = await page.request.patch(`${baseURL}/api/server`, {
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${sessionToken}`,
        },
        data: { registration_mode: mode },
    });
    expect(resp.ok()).toBeTruthy();
}

/**
 * Create an invite token via admin API. Returns { token, invite_url }.
 */
async function createInvite(page, baseURL, sessionToken) {
    const resp = await page.request.post(`${baseURL}/api/server/invites`, {
        headers: {
            'Authorization': `Bearer ${sessionToken}`,
        },
    });
    expect(resp.ok()).toBeTruthy();
    return resp.json();
}

/**
 * Set up a new browser context with a virtual WebAuthn authenticator.
 * Returns { context, page, client, authenticatorId }.
 */
async function newAuthenticatedContext(browser, baseURL) {
    const context = await browser.newContext({ baseURL });
    const page = await context.newPage();
    const client = await context.newCDPSession(page);
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
    return { context, page, client, authenticatorId };
}

/**
 * Fill and submit the registration form on register.html.
 */
async function fillAndSubmitRegistration(page, username) {
    await page.locator('#register-username').fill(username);
    await page.locator('#recovery-passphrase').fill(PASSPHRASE);
    await page.locator('#recovery-passphrase-confirm').fill(PASSPHRASE);
    await page.locator('#register-submit-button').click();
}

// ─── Invite link tests ───────────────────────────────────────────────────

test.describe('Register link (invite tokens)', () => {

    test('admin creates invite, user registers with it in invite_only mode and is auto-approved', async ({ registeredUser, browser, baseURL }) => {
        const admin = registeredUser;

        // Set server to invite_only mode
        await setRegistrationMode(admin.page, baseURL, admin.sessionToken, 'invite_only');

        // Admin creates an invite token
        const invite = await createInvite(admin.page, baseURL, admin.sessionToken);
        expect(invite.token).toBeTruthy();
        expect(invite.invite_url).toContain(`register.html?invite=${invite.token}`);

        // New user opens the invite URL
        const { context, page } = await newAuthenticatedContext(browser, baseURL);
        await page.goto(`/register.html?invite=${invite.token}`);
        await page.waitForLoadState('networkidle');

        // Form should NOT be disabled (valid invite token)
        await expect(page.locator('#register-submit-button')).toBeEnabled();
        await expect(page.locator('#register-username')).toBeEnabled();

        // Register
        const username = `inv${(Date.now() % 100000).toString(36)}`;
        await fillAndSubmitRegistration(page, username);

        // Should go through passkey enrollment
        await page.waitForURL('**/enroll-passkey.html**');
        await page.locator('#enroll-passkey-button').click();

        // Invite user should be auto-approved → redirect to app.html
        await page.waitForURL('**/app.html**', { timeout: 15_000 });
        await expect(page.locator('#sidebar')).toBeVisible();

        await context.close();
    });

    test('invite_only mode without token shows error and disables form', async ({ registeredUser, browser, baseURL }) => {
        const admin = registeredUser;

        // Set server to invite_only mode
        await setRegistrationMode(admin.page, baseURL, admin.sessionToken, 'invite_only');

        // New user opens register page WITHOUT an invite token
        const ctx = await browser.newContext({ baseURL });
        const page = await ctx.newPage();
        await page.goto('/register.html');
        await page.waitForLoadState('networkidle');

        // Should show error and disable the form
        await expect(page.locator('#register-status')).toContainText('Registration requires an invite link');
        await expect(page.locator('#register-submit-button')).toBeDisabled();
        await expect(page.locator('#register-username')).toBeDisabled();

        await ctx.close();
    });

    test('invite_only mode with invalid token is rejected at registration', async ({ registeredUser, browser, baseURL }) => {
        const admin = registeredUser;

        // Set server to invite_only mode
        await setRegistrationMode(admin.page, baseURL, admin.sessionToken, 'invite_only');

        // New user opens register page with a bogus invite token
        const { context, page } = await newAuthenticatedContext(browser, baseURL);
        await page.goto('/register.html?invite=bogus-invalid-token');
        await page.waitForLoadState('networkidle');

        // Form should be enabled (client-side check passes because a token IS present)
        await expect(page.locator('#register-submit-button')).toBeEnabled();

        // Try to register — server should reject the invalid token
        const username = `bad${(Date.now() % 100000).toString(36)}`;
        await fillAndSubmitRegistration(page, username);

        // Server redirects back to register.html with an error
        await page.waitForURL('**/register.html**');
        await expect(page.locator('#register-status')).toContainText(/invite|invalid|not valid/i);

        await context.close();
    });

    test('used invite token cannot be reused', async ({ registeredUser, browser, baseURL }) => {
        const admin = registeredUser;

        // Set server to invite_only mode and create invite
        await setRegistrationMode(admin.page, baseURL, admin.sessionToken, 'invite_only');
        const invite = await createInvite(admin.page, baseURL, admin.sessionToken);

        // First user registers with the invite — should succeed
        const user1 = await newAuthenticatedContext(browser, baseURL);
        await user1.page.goto(`/register.html?invite=${invite.token}`);
        await user1.page.waitForLoadState('networkidle');

        const username1 = `u1_${(Date.now() % 100000).toString(36)}`;
        await fillAndSubmitRegistration(user1.page, username1);
        await user1.page.waitForURL('**/enroll-passkey.html**');
        await user1.page.locator('#enroll-passkey-button').click();
        await user1.page.waitForURL('**/app.html**', { timeout: 15_000 });

        // Second user tries same invite token — should be rejected
        const user2 = await newAuthenticatedContext(browser, baseURL);
        await user2.page.goto(`/register.html?invite=${invite.token}`);
        await user2.page.waitForLoadState('networkidle');

        const username2 = `u2_${(Date.now() % 100000).toString(36)}`;
        await fillAndSubmitRegistration(user2.page, username2);

        // Server should reject the already-used token
        await user2.page.waitForURL('**/register.html**');
        await expect(user2.page.locator('#register-status')).toContainText(/invite|invalid|not valid/i);

        await user1.context.close();
        await user2.context.close();
    });

    test('admin can list invite tokens', async ({ registeredUser, baseURL }) => {
        const admin = registeredUser;

        // Create two invite tokens
        const invite1 = await createInvite(admin.page, baseURL, admin.sessionToken);
        const invite2 = await createInvite(admin.page, baseURL, admin.sessionToken);

        // List invites
        const resp = await admin.page.request.get(`${baseURL}/api/server/invites`, {
            headers: { 'Authorization': `Bearer ${admin.sessionToken}` },
        });
        expect(resp.ok()).toBeTruthy();
        const invites = await resp.json();

        expect(invites.length).toBeGreaterThanOrEqual(2);

        const tokens = invites.map(i => i.token);
        expect(tokens).toContain(invite1.token);
        expect(tokens).toContain(invite2.token);

        // All should be unused
        for (const inv of invites) {
            expect(inv.created_by).toBe(admin.username);
            expect(inv.used_by).toBeNull();
        }
    });

    test('admin can delete an unused invite token', async ({ registeredUser, baseURL }) => {
        const admin = registeredUser;

        // Create an invite
        const invite = await createInvite(admin.page, baseURL, admin.sessionToken);

        // Delete it
        const delResp = await admin.page.request.delete(
            `${baseURL}/api/server/invites/${invite.token}`,
            { headers: { 'Authorization': `Bearer ${admin.sessionToken}` } }
        );
        expect(delResp.ok()).toBeTruthy();

        // Verify it's gone from the list
        const listResp = await admin.page.request.get(`${baseURL}/api/server/invites`, {
            headers: { 'Authorization': `Bearer ${admin.sessionToken}` },
        });
        const invites = await listResp.json();
        const tokens = invites.map(i => i.token);
        expect(tokens).not.toContain(invite.token);
    });

    test('non-admin cannot create invite tokens', async ({ twoUsers, baseURL }) => {
        const { user } = twoUsers;

        // User B (non-admin) needs a session token — log in first
        await user.page.goto('/login.html');
        await user.page.locator('#login-button').click();
        await user.page.waitForURL('**/app.html**', { timeout: 15_000 });
        const userToken = await user.page.evaluate(() => localStorage.getItem('session_token'));

        // Try to create an invite — should be forbidden
        const resp = await user.page.request.post(`${baseURL}/api/server/invites`, {
            headers: { 'Authorization': `Bearer ${userToken}` },
        });
        expect(resp.status()).toBe(403);
    });

    test('invite works in invite_only mode but registration is normal in approval_required mode', async ({ registeredUser, browser, baseURL }) => {
        const admin = registeredUser;

        // Verify default mode is approval_required
        const serverResp = await admin.page.request.get(`${baseURL}/api/server`);
        const serverInfo = await serverResp.json();
        expect(serverInfo.registration_mode).toBe('approval_required');

        // Register a user normally (no invite) — should go to pending approval
        const { context, page } = await newAuthenticatedContext(browser, baseURL);
        await page.goto('/register.html');
        await page.waitForLoadState('networkidle');

        const username = `norm${(Date.now() % 100000).toString(36)}`;
        await fillAndSubmitRegistration(page, username);

        await page.waitForURL('**/enroll-passkey.html**');
        await page.locator('#enroll-passkey-button').click();

        // Should see pending approval (not auto-approved)
        await page.locator('.approval-code').waitFor({ timeout: 15_000 });
        const approvalCode = await page.locator('.approval-code .code').textContent();
        expect(approvalCode).toBeTruthy();

        await context.close();
    });
});
