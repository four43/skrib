/**
 * E2E tests: Users API — GET /users endpoint consolidation.
 *
 * Tests the new unified GET /users endpoint that returns display metadata
 * by default, with ?detail=admin and ?include=presence options.
 * Also tests GET /users/{username} private field trimming.
 *
 * Uses threeUsers fixture (admin User A, User B, User C).
 */

import { test, expect } from './fixtures.js';

function authHeaders(sessionToken) {
    return {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${sessionToken}`,
    };
}

// ── GET /users (default — display metadata) ───────────────────────────

test.describe('Users API - GET /users default', () => {

    test('returns display metadata for all active users', async ({ threeUsers, baseURL }) => {
        const { admin } = threeUsers;

        const resp = await admin.page.request.get(`${baseURL}/api/users`, {
            headers: authHeaders(admin.sessionToken),
        });
        expect(resp.ok()).toBeTruthy();
        const users = await resp.json();

        // Should have all 3 active users
        expect(users.length).toBe(3);

        // Each user should have display fields
        for (const user of users) {
            expect(user).toHaveProperty('username');
            expect(user).toHaveProperty('color');
            expect(user).toHaveProperty('nickname');
            expect(user).toHaveProperty('status');
            expect(user.status).toHaveProperty('emoji');
            expect(user.status).toHaveProperty('text');
        }

        // Should NOT have admin-only fields
        for (const user of users) {
            expect(user).not.toHaveProperty('role');
            expect(user).not.toHaveProperty('account_status');
            expect(user).not.toHaveProperty('approval');
            expect(user).not.toHaveProperty('created_at');
        }
    });

    test('includes status emoji and text when set', async ({ threeUsers, baseURL }) => {
        const { admin } = threeUsers;

        // Set status on admin
        await admin.page.request.patch(`${baseURL}/api/users/${admin.username}`, {
            headers: authHeaders(admin.sessionToken),
            data: { status_emoji: '🚀', status_text: 'shipping' },
        });

        const resp = await admin.page.request.get(`${baseURL}/api/users`, {
            headers: authHeaders(admin.sessionToken),
        });
        const users = await resp.json();
        const me = users.find(u => u.username === admin.username);
        expect(me.status.emoji).toBe('🚀');
        expect(me.status.text).toBe('shipping');
    });
});

// ── GET /users?detail=admin ───────────────────────────────────────────

test.describe('Users API - GET /users?detail=admin', () => {

    test('admin gets full user data with admin detail', async ({ threeUsers, baseURL }) => {
        const { admin } = threeUsers;

        const resp = await admin.page.request.get(`${baseURL}/api/users?detail=admin`, {
            headers: authHeaders(admin.sessionToken),
        });
        expect(resp.ok()).toBeTruthy();
        const users = await resp.json();

        // Should include admin fields in addition to display fields
        for (const user of users) {
            expect(user).toHaveProperty('username');
            expect(user).toHaveProperty('color');
            expect(user).toHaveProperty('status');
            expect(user).toHaveProperty('role');
            expect(user).toHaveProperty('account_status');
            expect(user).toHaveProperty('approval');
            expect(user.approval).toHaveProperty('code');
            expect(user.approval).toHaveProperty('time');
            expect(user.approval).toHaveProperty('by');
            expect(user).toHaveProperty('created_at');
        }
    });

    test('regular user gets 403 for detail=admin', async ({ threeUsers, baseURL }) => {
        const { userB } = threeUsers;

        const resp = await userB.page.request.get(`${baseURL}/api/users?detail=admin`, {
            headers: authHeaders(userB.sessionToken),
        });
        expect(resp.status()).toBe(403);
    });

    test('can filter by account_status=pending', async ({ twoUsers, browser, baseURL }) => {
        const { admin } = twoUsers;

        // Register a third user (will be pending)
        const { registerNewUser } = await import('./fixtures.js');
        const pending = await registerNewUser(browser, baseURL);

        const resp = await admin.page.request.get(
            `${baseURL}/api/users?detail=admin&account_status=pending`,
            { headers: authHeaders(admin.sessionToken) },
        );
        expect(resp.ok()).toBeTruthy();
        const users = await resp.json();

        // Should only contain pending users
        expect(users.length).toBeGreaterThanOrEqual(1);
        for (const u of users) {
            expect(u.account_status).toBe('pending');
        }

        await pending.context.close();
    });

    test('moderator can access detail=admin', async ({ threeUsers, baseURL }) => {
        const { admin, userB } = threeUsers;

        // Promote userB to moderator
        await admin.page.request.patch(`${baseURL}/api/users/${userB.username}`, {
            headers: authHeaders(admin.sessionToken),
            data: { role: 'moderator' },
        });

        const resp = await userB.page.request.get(`${baseURL}/api/users?detail=admin`, {
            headers: authHeaders(userB.sessionToken),
        });
        expect(resp.ok()).toBeTruthy();
    });
});

// ── GET /users?include=presence ───────────────────────────────────────

test.describe('Users API - GET /users?include=presence', () => {

    test('includes connected field when presence requested', async ({ threeUsers, baseURL }) => {
        const { admin } = threeUsers;

        const resp = await admin.page.request.get(`${baseURL}/api/users?include=presence`, {
            headers: authHeaders(admin.sessionToken),
        });
        expect(resp.ok()).toBeTruthy();
        const users = await resp.json();

        for (const user of users) {
            expect(user).toHaveProperty('connected');
            expect(typeof user.connected).toBe('boolean');
        }

        // Admin should be connected (they have an active page/WS)
        const me = users.find(u => u.username === admin.username);
        expect(me.connected).toBe(true);
    });

    test('presence not included by default', async ({ threeUsers, baseURL }) => {
        const { admin } = threeUsers;

        const resp = await admin.page.request.get(`${baseURL}/api/users`, {
            headers: authHeaders(admin.sessionToken),
        });
        const users = await resp.json();
        for (const user of users) {
            expect(user).not.toHaveProperty('connected');
        }
    });

    test('can combine detail=admin with include=presence', async ({ threeUsers, baseURL }) => {
        const { admin } = threeUsers;

        const resp = await admin.page.request.get(
            `${baseURL}/api/users?detail=admin&include=presence`,
            { headers: authHeaders(admin.sessionToken) },
        );
        expect(resp.ok()).toBeTruthy();
        const users = await resp.json();

        // Should have both admin fields and presence
        for (const user of users) {
            expect(user).toHaveProperty('role');
            expect(user).toHaveProperty('account_status');
            expect(user).toHaveProperty('connected');
        }
    });
});

// ── GET /users/{username} — private field trimming ────────────────────

test.describe('Users API - GET /users/{username} private fields', () => {

    test('own profile includes theme fields', async ({ threeUsers, baseURL }) => {
        const { admin } = threeUsers;

        // Set theme preferences first
        await admin.page.request.patch(`${baseURL}/api/users/${admin.username}`, {
            headers: authHeaders(admin.sessionToken),
            data: { theme_name: 'four43.theme-default', color_scheme: 'dark' },
        });

        const resp = await admin.page.request.get(`${baseURL}/api/users/${admin.username}`, {
            headers: authHeaders(admin.sessionToken),
        });
        expect(resp.ok()).toBeTruthy();
        const data = await resp.json();
        expect(data).toHaveProperty('theme_name');
        expect(data).toHaveProperty('color_scheme');
    });

    test('other user profile omits theme fields', async ({ threeUsers, baseURL }) => {
        const { admin, userB } = threeUsers;

        const resp = await userB.page.request.get(`${baseURL}/api/users/${admin.username}`, {
            headers: authHeaders(userB.sessionToken),
        });
        expect(resp.ok()).toBeTruthy();
        const data = await resp.json();
        expect(data).not.toHaveProperty('theme_name');
        expect(data).not.toHaveProperty('color_scheme');
    });

    test('profile uses nested status object', async ({ threeUsers, baseURL }) => {
        const { admin } = threeUsers;

        // Set status
        await admin.page.request.patch(`${baseURL}/api/users/${admin.username}`, {
            headers: authHeaders(admin.sessionToken),
            data: { status_emoji: '☕', status_text: 'break time' },
        });

        const resp = await admin.page.request.get(`${baseURL}/api/users/${admin.username}`, {
            headers: authHeaders(admin.sessionToken),
        });
        const data = await resp.json();
        expect(data.status).toEqual({ emoji: '☕', text: 'break time' });
        // Should not have flat fields
        expect(data).not.toHaveProperty('status_emoji');
        expect(data).not.toHaveProperty('status_text');
    });
});

// ── Removed endpoints return 404/405 ─────────────────────────────────

test.describe('Users API - Removed endpoints', () => {

    test('GET /users/preferences/colors is removed', async ({ registeredUser, baseURL }) => {
        const resp = await registeredUser.page.request.get(
            `${baseURL}/api/users/preferences/colors`,
            { headers: authHeaders(registeredUser.sessionToken) },
        );
        // Should 404 (no longer exists) or get caught by /{username} route
        // Either way it should not return the old dict format
        const data = await resp.json();
        expect(Array.isArray(data) || data.detail).toBeTruthy();
    });

    test('GET /users/presence bulk endpoint is removed', async ({ registeredUser, baseURL }) => {
        const resp = await registeredUser.page.request.get(
            `${baseURL}/api/users/presence`,
            { headers: authHeaders(registeredUser.sessionToken) },
        );
        // Should not return the old { username: bool } dict format
        const data = await resp.json();
        expect(data).not.toHaveProperty(registeredUser.username);
    });
});
