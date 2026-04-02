/**
 * E2E tests: Room security fixes.
 *
 * Tests for security issues S1-S8 identified in the rooms audit.
 * These tests are written to FAIL against the current codebase,
 * and should pass after the security fixes are applied.
 *
 * Uses threeUsers fixture (admin User A, User B, User C).
 */

import { test, expect } from './fixtures.js';

// ── Helpers ─────────────────────────────────────────────────────────────

function authHeaders(sessionToken) {
    return {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${sessionToken}`,
    };
}

/** Create a room via API. Returns room_id. */
async function createRoomAPI(page, baseURL, sessionToken, roomId, visibility = 'private') {
    const resp = await page.request.post(`${baseURL}/api/rooms`, {
        headers: authHeaders(sessionToken),
        data: { room_id: roomId, room_type: 'chat', visibility },
    });
    expect(resp.ok()).toBeTruthy();
    return roomId;
}

/** Add a member via API. */
async function addMemberAPI(page, baseURL, sessionToken, roomId, username) {
    const resp = await page.request.post(`${baseURL}/api/rooms/${roomId}/members`, {
        headers: authHeaders(sessionToken),
        data: { username },
    });
    return resp;
}

/** Create a DM via API. Returns the room object. */
async function createDMAPI(page, baseURL, sessionToken, usernames) {
    const resp = await page.request.post(`${baseURL}/api/rooms/dm`, {
        headers: authHeaders(sessionToken),
        data: { usernames },
    });
    expect(resp.ok()).toBeTruthy();
    return (await resp.json()).room;
}

// ── S1: Key storage impersonation ───────────────────────────────────────

test.describe('S1: Room key storage authorization', () => {

    test('regular member cannot store keys for another member', async ({ threeUsers, baseURL }) => {
        const { admin: userA, userB, userC } = threeUsers;

        const roomId = await createRoomAPI(userA.page, baseURL, userA.sessionToken, 's1-key-room');
        await addMemberAPI(userA.page, baseURL, userA.sessionToken, roomId, userB.username);
        await addMemberAPI(userA.page, baseURL, userA.sessionToken, roomId, userC.username);

        // userB (regular member) tries to store keys for userC
        const resp = await userB.page.request.post(`${baseURL}/api/rooms/${roomId}/keys`, {
            headers: authHeaders(userB.sessionToken),
            data: { username: userC.username, encrypted_key: 'malicious-key', key_epoch: 0 },
        });
        expect(resp.status()).toBe(403);
    });

    test('room owner can store keys for another member', async ({ threeUsers, baseURL }) => {
        const { admin: userA, userB } = threeUsers;

        const roomId = await createRoomAPI(userA.page, baseURL, userA.sessionToken, 's1-key-owner');
        await addMemberAPI(userA.page, baseURL, userA.sessionToken, roomId, userB.username);

        // userA (owner) stores keys for userB — should work
        const resp = await userA.page.request.post(`${baseURL}/api/rooms/${roomId}/keys`, {
            headers: authHeaders(userA.sessionToken),
            data: { username: userB.username, encrypted_key: 'valid-encrypted-key', key_epoch: 0 },
        });
        expect(resp.ok()).toBeTruthy();
    });
});

// ── S2: Non-member channel access ───────────────────────────────────────

test.describe('S2: Channel membership enforcement', () => {

    test('non-member cannot access channel details', async ({ threeUsers, baseURL }) => {
        const { admin: userA, userB } = threeUsers;

        const roomId = await createRoomAPI(userA.page, baseURL, userA.sessionToken, 's2-private-room');

        // userB (not a member) tries to get room details
        const resp = await userB.page.request.get(`${baseURL}/api/rooms/${roomId}`, {
            headers: authHeaders(userB.sessionToken),
        });
        expect(resp.status()).toBe(403);
    });

    test('non-member cannot store keys in channel', async ({ threeUsers, baseURL }) => {
        const { admin: userA, userB } = threeUsers;

        const roomId = await createRoomAPI(userA.page, baseURL, userA.sessionToken, 's2-keys-room');

        // userB (not a member) tries to store keys
        const resp = await userB.page.request.post(`${baseURL}/api/rooms/${roomId}/keys`, {
            headers: authHeaders(userB.sessionToken),
            data: { username: userB.username, encrypted_key: 'key', key_epoch: 0 },
        });
        expect(resp.status()).toBe(403);
    });

    test('accessing non-existent room returns 404', async ({ threeUsers, baseURL }) => {
        const { userB } = threeUsers;

        const resp = await userB.page.request.get(`${baseURL}/api/rooms/nonexistent-room-xyz-999`, {
            headers: authHeaders(userB.sessionToken),
        });
        expect(resp.status()).toBe(404);
    });
});

// ── S3: DM deletion ────────────────────────────────────────────────────

test.describe('S3: DM deletion prevention', () => {

    test('cannot delete a DM room', async ({ threeUsers, baseURL }) => {
        const { admin: userA, userB } = threeUsers;

        const dm = await createDMAPI(userA.page, baseURL, userA.sessionToken, [userB.username]);

        // Owner tries to delete the DM — should be blocked
        const resp = await userA.page.request.delete(`${baseURL}/api/rooms/${encodeURIComponent(dm.room_id)}`, {
            headers: authHeaders(userA.sessionToken),
        });
        expect(resp.status()).toBe(400);
    });
});

// ── S4: DM role changes ────────────────────────────────────────────────

test.describe('S4: DM role change prevention', () => {

    test('cannot change roles in a DM', async ({ threeUsers, baseURL }) => {
        const { admin: userA, userB } = threeUsers;

        const dm = await createDMAPI(userA.page, baseURL, userA.sessionToken, [userB.username]);

        // Try to make userB an op in the DM
        const resp = await userA.page.request.patch(
            `${baseURL}/api/rooms/${encodeURIComponent(dm.room_id)}/members/${userB.username}`,
            {
                headers: authHeaders(userA.sessionToken),
                data: { room_role: 'op' },
            },
        );
        expect(resp.status()).toBe(400);
    });
});

// ── S5: Invite permissions ──────────────────────────────────────────────

test.describe('S5: Invite authorization', () => {

    test('regular member cannot invite to a channel', async ({ threeUsers, baseURL }) => {
        const { admin: userA, userB, userC } = threeUsers;

        const roomId = await createRoomAPI(userA.page, baseURL, userA.sessionToken, 's5-invite-room');
        await addMemberAPI(userA.page, baseURL, userA.sessionToken, roomId, userB.username);

        // userB (regular member) tries to invite userC
        const resp = await addMemberAPI(userB.page, baseURL, userB.sessionToken, roomId, userC.username);
        expect(resp.status()).toBe(403);
    });

    test('room owner can invite to a channel', async ({ threeUsers, baseURL }) => {
        const { admin: userA, userC } = threeUsers;

        const roomId = await createRoomAPI(userA.page, baseURL, userA.sessionToken, 's5-invite-owner');

        // userA (owner) invites userC — should work
        const resp = await addMemberAPI(userA.page, baseURL, userA.sessionToken, roomId, userC.username);
        expect(resp.ok()).toBeTruthy();
    });
});

// ── S7: Username enumeration ────────────────────────────────────────────

test.describe('S7: Username enumeration prevention', () => {

    test('DM creation error does not leak specific usernames', async ({ threeUsers, baseURL }) => {
        const { admin: userA } = threeUsers;

        const resp = await userA.page.request.post(`${baseURL}/api/rooms/dm`, {
            headers: authHeaders(userA.sessionToken),
            data: { usernames: ['doesnotexist_user_xyz'] },
        });
        expect(resp.status()).toBe(404);
        const body = await resp.json();
        // Error message should NOT contain the specific username
        expect(body.detail).not.toContain('doesnotexist_user_xyz');
    });
});

// ── S8: Search query length ─────────────────────────────────────────────

test.describe('S8: Search query length limit', () => {

    test('very long search query returns 200 not 500', async ({ threeUsers, baseURL }) => {
        const { userB } = threeUsers;

        const longQuery = 'a'.repeat(500);
        const resp = await userB.page.request.get(`${baseURL}/api/rooms/search?q=${longQuery}`, {
            headers: authHeaders(userB.sessionToken),
        });
        expect(resp.ok()).toBeTruthy();
        const results = await resp.json();
        expect(Array.isArray(results)).toBeTruthy();
    });
});
