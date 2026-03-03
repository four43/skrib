/**
 * E2E tests: Security boundaries and authorization enforcement.
 *
 * Verifies that unauthenticated users are blocked, non-admin users
 * cannot access admin endpoints, room access is enforced, and
 * role-based permissions work correctly at the API level.
 *
 * Uses threeUsers fixture (admin User A, User B, User C).
 */

import { test, expect } from './fixtures.js';

// ── Helpers ─────────────────────────────────────────────────────────────

/** Create a room via the UI. */
async function createRoom(page, roomName) {
    await page.locator('#add-channel-btn').click();
    await page.locator('#new-room-input').fill(roomName);
    await page.locator('#create-room-submit-btn').click();
    await expect(page.locator('#room-content-name')).toHaveText(`#${roomName}`);
    await page.locator('#message-input').waitFor();
}

// ── Tests ───────────────────────────────────────────────────────────────

test.describe('Unauthenticated access', () => {

    test('unauthenticated API requests to protected endpoints return 401', async ({ browser, baseURL, _backend }) => {
        // Use a fresh context with no session state
        const ctx = await browser.newContext({ baseURL });
        const page = await ctx.newPage();

        // Try accessing protected endpoints without auth header
        const endpoints = [
            { method: 'GET', path: '/api/rooms' },
            { method: 'GET', path: '/api/users' },
        ];

        for (const ep of endpoints) {
            const resp = await page.request.fetch(`${baseURL}${ep.path}`, {
                method: ep.method,
                headers: {},
            });
            expect(resp.status()).toBe(401);
        }

        await ctx.close();
    });

    test('invalid session token returns 401', async ({ browser, baseURL, _backend }) => {
        const ctx = await browser.newContext({ baseURL });
        const page = await ctx.newPage();

        const resp = await page.request.get(`${baseURL}/api/rooms`, {
            headers: { 'Authorization': 'Bearer totally-fake-token' },
        });
        expect(resp.status()).toBe(401);

        await ctx.close();
    });

    test('unauthenticated user navigating to app.html is redirected to login', async ({ threeUsers }) => {
        const { admin } = threeUsers;

        // Clear session and try to access app.html
        await admin.page.evaluate(() => {
            localStorage.removeItem('session_token');
            localStorage.removeItem('username');
        });
        await admin.page.goto('/app.html');
        await admin.page.waitForURL('**/login.html**', { timeout: 10_000 });
    });
});

test.describe('Admin-only endpoint protection', () => {

    test('non-admin cannot update server settings', async ({ threeUsers, baseURL }) => {
        const { userB } = threeUsers;

        const resp = await userB.page.request.patch(`${baseURL}/api/server`, {
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${userB.sessionToken}`,
            },
            data: { registration_mode: 'open' },
        });
        expect(resp.status()).toBe(403);
    });

    test('non-admin cannot change user roles', async ({ threeUsers, baseURL }) => {
        const { userB, userC } = threeUsers;

        const resp = await userB.page.request.patch(`${baseURL}/api/users/${userC.username}`, {
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${userB.sessionToken}`,
            },
            data: { role: 'admin' },
        });
        expect(resp.status()).toBe(403);
    });

    test('non-admin cannot delete users', async ({ threeUsers, baseURL }) => {
        const { userB, userC } = threeUsers;

        const resp = await userB.page.request.delete(`${baseURL}/api/users/${userC.username}`, {
            headers: { 'Authorization': `Bearer ${userB.sessionToken}` },
        });
        expect(resp.status()).toBe(403);
    });

    test('non-admin cannot create invite tokens', async ({ threeUsers, baseURL }) => {
        const { userB } = threeUsers;

        const resp = await userB.page.request.post(`${baseURL}/api/server/invites`, {
            headers: { 'Authorization': `Bearer ${userB.sessionToken}` },
        });
        expect(resp.status()).toBe(403);
    });
});

test.describe('Room access enforcement', () => {

    test('non-member DM access is blocked', async ({ threeUsers, baseURL }) => {
        const { admin: userA, userB, userC } = threeUsers;
        await userA.page.waitForLoadState('networkidle');

        // Create a DM between User A and User B
        const dmResp = await userA.page.request.post(`${baseURL}/api/rooms/dm`, {
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${userA.sessionToken}`,
            },
            data: { usernames: [userB.username] },
        });
        expect(dmResp.ok()).toBeTruthy();
        const dm = await dmResp.json();

        // User C (not in DM) tries to access — should be blocked (403 or 404)
        const resp = await userC.page.request.get(`${baseURL}/api/rooms/${dm.room_id}`, {
            headers: { 'Authorization': `Bearer ${userC.sessionToken}` },
        });
        expect([403, 404]).toContain(resp.status());
    });

    test('non-owner/non-admin cannot delete a room', async ({ threeUsers, baseURL }) => {
        const { admin: userA, userB } = threeUsers;
        await userA.page.waitForLoadState('networkidle');

        await createRoom(userA.page, 'nodelete-sec-room');

        // Invite User B so they have access
        await userA.page.locator('#message-input').fill(`/invite ${userB.username}`);
        await userA.page.locator('#message-input').press('Enter');
        await expect(userA.page.locator('#messages')).toContainText(`Invited ${userB.username}`);

        // User B (member, not owner/admin) tries to delete the room
        const resp = await userB.page.request.delete(`${baseURL}/api/rooms/nodelete-sec-room`, {
            headers: { 'Authorization': `Bearer ${userB.sessionToken}` },
        });
        expect(resp.status()).toBe(403);
    });

    test('user rooms list only includes rooms they are a member of', async ({ threeUsers, baseURL }) => {
        const { admin: userA, userB } = threeUsers;
        await userA.page.waitForLoadState('networkidle');

        await createRoom(userA.page, 'members-only-room');

        // User B lists their rooms — should NOT include the room
        const resp = await userB.page.request.get(`${baseURL}/api/rooms`, {
            headers: { 'Authorization': `Bearer ${userB.sessionToken}` },
        });
        expect(resp.ok()).toBeTruthy();
        const rooms = await resp.json();
        const roomIds = rooms.map(r => r.room_id);
        expect(roomIds).not.toContain('members-only-room');
    });
});

test.describe('Registration mode enforcement', () => {

    test('closed registration rejects new users', async ({ registeredUser, browser, baseURL }) => {
        const admin = registeredUser;

        // Set registration to closed
        await admin.page.request.patch(`${baseURL}/api/server`, {
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${admin.sessionToken}`,
            },
            data: { registration_mode: 'closed' },
        });

        // New user tries to register
        const ctx = await browser.newContext({ baseURL });
        const page = await ctx.newPage();
        await page.goto('/register.html');
        await page.waitForLoadState('networkidle');

        // Registration should be disabled
        await expect(page.locator('#register-submit-button')).toBeDisabled();
        await expect(page.locator('#register-status')).toContainText(/closed|not available/i);

        await ctx.close();
    });
});

test.describe('Server info endpoint', () => {

    test('GET /api/server is publicly accessible (no auth required)', async ({ threeUsers, baseURL }) => {
        const { admin } = threeUsers;

        // No auth header
        const resp = await admin.page.request.get(`${baseURL}/api/server`);
        expect(resp.ok()).toBeTruthy();
        const data = await resp.json();

        // Should have basic server info
        expect(data.registration_mode).toBeTruthy();
    });
});
