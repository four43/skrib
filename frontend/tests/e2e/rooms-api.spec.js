/**
 * E2E tests: Rooms API behavior.
 *
 * Tests the core rooms REST API — CRUD, PATCH split permissions,
 * room movement into folders, membership operations, and DM constraints.
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

async function createRoomAPI(page, baseURL, sessionToken, roomId, visibility = 'private') {
    const resp = await page.request.post(`${baseURL}/api/rooms`, {
        headers: authHeaders(sessionToken),
        data: { room_id: roomId, room_type: 'chat', visibility },
    });
    expect(resp.ok()).toBeTruthy();
    return roomId;
}

async function addMemberAPI(page, baseURL, sessionToken, roomId, username) {
    return page.request.post(`${baseURL}/api/rooms/${roomId}/members`, {
        headers: authHeaders(sessionToken),
        data: { username },
    });
}

async function createFolderAPI(page, baseURL, sessionToken, name) {
    const resp = await page.request.post(`${baseURL}/api/rooms/folders`, {
        headers: authHeaders(sessionToken),
        data: { name },
    });
    expect(resp.ok()).toBeTruthy();
    return resp.json();
}

async function createDMAPI(page, baseURL, sessionToken, usernames) {
    const resp = await page.request.post(`${baseURL}/api/rooms/dm`, {
        headers: authHeaders(sessionToken),
        data: { usernames },
    });
    expect(resp.ok()).toBeTruthy();
    return (await resp.json()).room;
}

async function patchRoom(page, baseURL, sessionToken, roomId, data) {
    return page.request.patch(`${baseURL}/api/rooms/${roomId}`, {
        headers: authHeaders(sessionToken),
        data,
    });
}

async function getRoomDetail(page, baseURL, sessionToken, roomId) {
    const resp = await page.request.get(`${baseURL}/api/rooms/${encodeURIComponent(roomId)}`, {
        headers: authHeaders(sessionToken),
    });
    return resp;
}

async function getFolderTree(page, baseURL, sessionToken) {
    const resp = await page.request.get(`${baseURL}/api/rooms/folders`, {
        headers: { 'Authorization': `Bearer ${sessionToken}` },
    });
    expect(resp.ok()).toBeTruthy();
    return resp.json();
}

// ── Room CRUD ───────────────────────────────────────────────────────────

test.describe('Room CRUD', () => {

    test('create room and verify via GET', async ({ threeUsers, baseURL }) => {
        const { admin } = threeUsers;

        await createRoomAPI(admin.page, baseURL, admin.sessionToken, 'crud-room', 'public');

        const resp = await getRoomDetail(admin.page, baseURL, admin.sessionToken, 'crud-room');
        expect(resp.ok()).toBeTruthy();
        const room = await resp.json();
        expect(room.room_id).toBe('crud-room');
        expect(room.visibility).toBe('public');
        expect(room.topic).toBe('');
        expect(room.members.length).toBe(1);
        expect(room.members[0].username).toBe(admin.username);
        expect(room.members[0].room_role).toBe('owner');
    });

    test('duplicate room creation fails with 400', async ({ threeUsers, baseURL }) => {
        const { admin } = threeUsers;

        await createRoomAPI(admin.page, baseURL, admin.sessionToken, 'dup-room');
        const resp = await admin.page.request.post(`${baseURL}/api/rooms`, {
            headers: authHeaders(admin.sessionToken),
            data: { room_id: 'dup-room', room_type: 'chat' },
        });
        expect(resp.status()).toBe(400);
    });

    test('delete room removes it from room list', async ({ threeUsers, baseURL }) => {
        const { admin } = threeUsers;

        await createRoomAPI(admin.page, baseURL, admin.sessionToken, 'del-room');

        const delResp = await admin.page.request.delete(`${baseURL}/api/rooms/del-room`, {
            headers: authHeaders(admin.sessionToken),
        });
        expect(delResp.ok()).toBeTruthy();

        // Room no longer accessible
        const getResp = await getRoomDetail(admin.page, baseURL, admin.sessionToken, 'del-room');
        expect(getResp.status()).toBe(404);
    });

    test('room list only includes rooms user is a member of', async ({ threeUsers, baseURL }) => {
        const { admin, userB } = threeUsers;

        await createRoomAPI(admin.page, baseURL, admin.sessionToken, 'list-room');

        const resp = await userB.page.request.get(`${baseURL}/api/rooms`, {
            headers: authHeaders(userB.sessionToken),
        });
        expect(resp.ok()).toBeTruthy();
        const rooms = await resp.json();
        expect(rooms.find(r => r.room_id === 'list-room')).toBeUndefined();
    });
});

// ── PATCH /rooms/{room_id} split permissions ────────────────────────────

test.describe('PATCH room — topic and visibility', () => {

    test('owner can update topic', async ({ threeUsers, baseURL }) => {
        const { admin } = threeUsers;

        await createRoomAPI(admin.page, baseURL, admin.sessionToken, 'patch-topic');

        const resp = await patchRoom(admin.page, baseURL, admin.sessionToken, 'patch-topic', {
            topic: 'New topic',
        });
        expect(resp.ok()).toBeTruthy();

        const detail = await (await getRoomDetail(admin.page, baseURL, admin.sessionToken, 'patch-topic')).json();
        expect(detail.topic).toBe('New topic');
    });

    test('owner can update visibility', async ({ threeUsers, baseURL }) => {
        const { admin } = threeUsers;

        await createRoomAPI(admin.page, baseURL, admin.sessionToken, 'patch-vis');

        const resp = await patchRoom(admin.page, baseURL, admin.sessionToken, 'patch-vis', {
            visibility: 'public',
        });
        expect(resp.ok()).toBeTruthy();

        const detail = await (await getRoomDetail(admin.page, baseURL, admin.sessionToken, 'patch-vis')).json();
        expect(detail.visibility).toBe('public');
    });

    test('non-member cannot update topic', async ({ threeUsers, baseURL }) => {
        const { admin, userB } = threeUsers;

        await createRoomAPI(admin.page, baseURL, admin.sessionToken, 'patch-noaccess');

        const resp = await patchRoom(userB.page, baseURL, userB.sessionToken, 'patch-noaccess', {
            topic: 'Hacked',
        });
        expect(resp.status()).toBe(403);
    });

    test('regular member cannot update topic', async ({ threeUsers, baseURL }) => {
        const { admin, userB } = threeUsers;

        await createRoomAPI(admin.page, baseURL, admin.sessionToken, 'patch-member');
        await addMemberAPI(admin.page, baseURL, admin.sessionToken, 'patch-member', userB.username);

        const resp = await patchRoom(userB.page, baseURL, userB.sessionToken, 'patch-member', {
            topic: 'Not allowed',
        });
        expect(resp.status()).toBe(403);
    });

    test('cannot change visibility on a DM', async ({ threeUsers, baseURL }) => {
        const { admin, userB } = threeUsers;

        const dm = await createDMAPI(admin.page, baseURL, admin.sessionToken, [userB.username]);

        const resp = await patchRoom(admin.page, baseURL, admin.sessionToken, dm.room_id, {
            visibility: 'public',
        });
        expect(resp.status()).toBe(400);
    });
});

test.describe('PATCH room — folder placement', () => {

    test('admin can move room to folder without being a member', async ({ threeUsers, baseURL }) => {
        const { admin, userB } = threeUsers;

        // userB creates a room (admin is NOT a member via room creation)
        // Actually admin is global admin, so let's use a room that userB owns
        // We need userB to create the room — but createRoom requires the user to be the caller
        // Let's just have admin create a room, then test that a separate moderator can move it
        await createRoomAPI(admin.page, baseURL, admin.sessionToken, 'folder-move-test');
        const folder = await createFolderAPI(admin.page, baseURL, admin.sessionToken, 'move-target');

        // Promote userB to moderator
        await admin.page.request.patch(`${baseURL}/api/users/${userB.username}`, {
            headers: authHeaders(admin.sessionToken),
            data: { role: 'moderator' },
        });

        // userB (moderator, NOT a member of the room) moves room to folder
        const resp = await patchRoom(userB.page, baseURL, userB.sessionToken, 'folder-move-test', {
            folder_id: folder.folder_id,
            sort_position: 5,
        });
        expect(resp.ok()).toBeTruthy();

        // Verify
        const tree = await getFolderTree(admin.page, baseURL, admin.sessionToken);
        const roomPos = tree.room_positions.find(r => r.room_id === 'folder-move-test');
        expect(roomPos.folder_id).toBe(folder.folder_id);
        expect(roomPos.position).toBe(5);

        // Clean up
        await admin.page.request.patch(`${baseURL}/api/users/${userB.username}`, {
            headers: authHeaders(admin.sessionToken),
            data: { role: 'user' },
        });
    });

    test('regular user cannot move room to folder', async ({ threeUsers, baseURL }) => {
        const { admin, userB } = threeUsers;

        await createRoomAPI(admin.page, baseURL, admin.sessionToken, 'folder-noperm');
        await addMemberAPI(admin.page, baseURL, admin.sessionToken, 'folder-noperm', userB.username);
        const folder = await createFolderAPI(admin.page, baseURL, admin.sessionToken, 'no-perm');

        // userB is a regular member + regular user — cannot move to folder
        const resp = await patchRoom(userB.page, baseURL, userB.sessionToken, 'folder-noperm', {
            folder_id: folder.folder_id,
        });
        expect(resp.status()).toBe(403);
    });

    test('move room to non-existent folder fails', async ({ threeUsers, baseURL }) => {
        const { admin } = threeUsers;

        await createRoomAPI(admin.page, baseURL, admin.sessionToken, 'folder-invalid');

        const resp = await patchRoom(admin.page, baseURL, admin.sessionToken, 'folder-invalid', {
            folder_id: 'does-not-exist',
        });
        expect(resp.status()).toBe(400);
    });

    test('unfile room by setting folder_id to null', async ({ threeUsers, baseURL }) => {
        const { admin } = threeUsers;

        await createRoomAPI(admin.page, baseURL, admin.sessionToken, 'folder-unfile');
        const folder = await createFolderAPI(admin.page, baseURL, admin.sessionToken, 'unfile');

        // Move to folder
        let resp = await patchRoom(admin.page, baseURL, admin.sessionToken, 'folder-unfile', {
            folder_id: folder.folder_id,
        });
        expect(resp.ok()).toBeTruthy();

        // Unfile
        resp = await patchRoom(admin.page, baseURL, admin.sessionToken, 'folder-unfile', {
            folder_id: null,
        });
        expect(resp.ok()).toBeTruthy();

        const tree = await getFolderTree(admin.page, baseURL, admin.sessionToken);
        const roomPos = tree.room_positions.find(r => r.room_id === 'folder-unfile');
        expect(roomPos.folder_id).toBeNull();
    });

    test('regular member cannot combine topic + folder in one PATCH', async ({ threeUsers, baseURL }) => {
        const { admin, userB } = threeUsers;

        await createRoomAPI(admin.page, baseURL, admin.sessionToken, 'combo-patch');
        await addMemberAPI(admin.page, baseURL, admin.sessionToken, 'combo-patch', userB.username);
        const folder = await createFolderAPI(admin.page, baseURL, admin.sessionToken, 'combo');

        // userB is a regular member + regular user — fails on topic permission (needs op)
        const resp = await patchRoom(userB.page, baseURL, userB.sessionToken, 'combo-patch', {
            topic: 'New topic',
            folder_id: folder.folder_id,
        });
        expect(resp.status()).toBe(403);
    });

    test('admin can set topic + folder in one PATCH', async ({ threeUsers, baseURL }) => {
        const { admin } = threeUsers;

        await createRoomAPI(admin.page, baseURL, admin.sessionToken, 'combo-ok');
        const folder = await createFolderAPI(admin.page, baseURL, admin.sessionToken, 'combo-ok');

        const resp = await patchRoom(admin.page, baseURL, admin.sessionToken, 'combo-ok', {
            topic: 'Combined update',
            folder_id: folder.folder_id,
            sort_position: 3,
        });
        expect(resp.ok()).toBeTruthy();

        // Verify topic
        const detail = await (await getRoomDetail(admin.page, baseURL, admin.sessionToken, 'combo-ok')).json();
        expect(detail.topic).toBe('Combined update');

        // Verify folder
        const tree = await getFolderTree(admin.page, baseURL, admin.sessionToken);
        const roomPos = tree.room_positions.find(r => r.room_id === 'combo-ok');
        expect(roomPos.folder_id).toBe(folder.folder_id);
        expect(roomPos.position).toBe(3);
    });
});

// ── DM constraints via API ──────────────────────────────────────────────

test.describe('DM API constraints', () => {

    test('DM returns is_dm true in room list', async ({ threeUsers, baseURL }) => {
        const { admin, userB } = threeUsers;

        const dm = await createDMAPI(admin.page, baseURL, admin.sessionToken, [userB.username]);

        const resp = await admin.page.request.get(`${baseURL}/api/rooms`, {
            headers: authHeaders(admin.sessionToken),
        });
        const rooms = await resp.json();
        const dmRoom = rooms.find(r => r.room_id === dm.room_id);
        expect(dmRoom).toBeTruthy();
        expect(dmRoom.is_dm).toBe(true);
    });

    test('creating DM with same users returns existing room', async ({ threeUsers, baseURL }) => {
        const { admin, userB } = threeUsers;

        const dm1 = await createDMAPI(admin.page, baseURL, admin.sessionToken, [userB.username]);
        const dm2 = await createDMAPI(admin.page, baseURL, admin.sessionToken, [userB.username]);

        expect(dm1.room_id).toBe(dm2.room_id);
    });

    test('cannot remove member from DM', async ({ threeUsers, baseURL }) => {
        const { admin, userB } = threeUsers;

        const dm = await createDMAPI(admin.page, baseURL, admin.sessionToken, [userB.username]);

        const resp = await admin.page.request.delete(
            `${baseURL}/api/rooms/${encodeURIComponent(dm.room_id)}/members/${userB.username}`,
            { headers: authHeaders(admin.sessionToken) },
        );
        expect(resp.status()).toBe(400);
    });
});

// ── Room search ─────────────────────────────────────────────────────────

test.describe('Room search', () => {

    test('public rooms appear in search, private rooms do not', async ({ threeUsers, baseURL }) => {
        const { admin, userB } = threeUsers;

        await createRoomAPI(admin.page, baseURL, admin.sessionToken, 'searchable-pub', 'public');
        await createRoomAPI(admin.page, baseURL, admin.sessionToken, 'searchable-priv', 'private');

        const resp = await userB.page.request.get(`${baseURL}/api/rooms/search?q=searchable`, {
            headers: authHeaders(userB.sessionToken),
        });
        expect(resp.ok()).toBeTruthy();
        const results = await resp.json();

        const ids = results.map(r => r.room_id);
        expect(ids).toContain('searchable-pub');
        expect(ids).not.toContain('searchable-priv');
    });

    test('search excludes rooms user is already a member of', async ({ threeUsers, baseURL }) => {
        const { admin } = threeUsers;

        await createRoomAPI(admin.page, baseURL, admin.sessionToken, 'search-own', 'public');

        const resp = await admin.page.request.get(`${baseURL}/api/rooms/search?q=search-own`, {
            headers: authHeaders(admin.sessionToken),
        });
        expect(resp.ok()).toBeTruthy();
        const results = await resp.json();
        expect(results.find(r => r.room_id === 'search-own')).toBeUndefined();
    });

    test('search results include member_count', async ({ threeUsers, baseURL }) => {
        const { admin, userB } = threeUsers;

        await createRoomAPI(admin.page, baseURL, admin.sessionToken, 'search-count', 'public');

        const resp = await userB.page.request.get(`${baseURL}/api/rooms/search?q=search-count`, {
            headers: authHeaders(userB.sessionToken),
        });
        const results = await resp.json();
        const room = results.find(r => r.room_id === 'search-count');
        expect(room).toBeTruthy();
        expect(room.member_count).toBe(1);
    });
});

// ── Membership operations ───────────────────────────────────────────────

test.describe('Membership API', () => {

    test('get member detail returns role and notify_level', async ({ threeUsers, baseURL }) => {
        const { admin } = threeUsers;

        await createRoomAPI(admin.page, baseURL, admin.sessionToken, 'member-detail');

        const resp = await admin.page.request.get(
            `${baseURL}/api/rooms/member-detail/members/${admin.username}`,
            { headers: authHeaders(admin.sessionToken) },
        );
        expect(resp.ok()).toBeTruthy();
        const data = await resp.json();
        expect(data.username).toBe(admin.username);
        expect(data.room_role).toBe('owner');
        expect(data.notify_level).toBe('all');
    });

    test('member can change own notify_level', async ({ threeUsers, baseURL }) => {
        const { admin, userB } = threeUsers;

        await createRoomAPI(admin.page, baseURL, admin.sessionToken, 'notify-room');
        await addMemberAPI(admin.page, baseURL, admin.sessionToken, 'notify-room', userB.username);

        const resp = await userB.page.request.patch(
            `${baseURL}/api/rooms/notify-room/members/${userB.username}`,
            {
                headers: authHeaders(userB.sessionToken),
                data: { notify_level: 'muted' },
            },
        );
        expect(resp.ok()).toBeTruthy();

        // Verify
        const detail = await (await userB.page.request.get(
            `${baseURL}/api/rooms/notify-room/members/${userB.username}`,
            { headers: authHeaders(userB.sessionToken) },
        )).json();
        expect(detail.notify_level).toBe('muted');
    });

    test('member cannot change another member notify_level', async ({ threeUsers, baseURL }) => {
        const { admin, userB } = threeUsers;

        await createRoomAPI(admin.page, baseURL, admin.sessionToken, 'notify-other');
        await addMemberAPI(admin.page, baseURL, admin.sessionToken, 'notify-other', userB.username);

        const resp = await userB.page.request.patch(
            `${baseURL}/api/rooms/notify-other/members/${admin.username}`,
            {
                headers: authHeaders(userB.sessionToken),
                data: { notify_level: 'muted' },
            },
        );
        expect(resp.status()).toBe(403);
    });

    test('owner can promote member to op', async ({ threeUsers, baseURL }) => {
        const { admin, userB } = threeUsers;

        await createRoomAPI(admin.page, baseURL, admin.sessionToken, 'promote-room');
        await addMemberAPI(admin.page, baseURL, admin.sessionToken, 'promote-room', userB.username);

        const resp = await admin.page.request.patch(
            `${baseURL}/api/rooms/promote-room/members/${userB.username}`,
            {
                headers: authHeaders(admin.sessionToken),
                data: { room_role: 'op' },
            },
        );
        expect(resp.ok()).toBeTruthy();

        // Verify
        const detail = await (await admin.page.request.get(
            `${baseURL}/api/rooms/promote-room/members/${userB.username}`,
            { headers: authHeaders(admin.sessionToken) },
        )).json();
        expect(detail.room_role).toBe('op');
    });

    test('removing non-member returns 404', async ({ threeUsers, baseURL }) => {
        const { admin, userC } = threeUsers;

        await createRoomAPI(admin.page, baseURL, admin.sessionToken, 'remove-nonmember');

        const resp = await admin.page.request.delete(
            `${baseURL}/api/rooms/remove-nonmember/members/${userC.username}`,
            { headers: authHeaders(admin.sessionToken) },
        );
        expect(resp.status()).toBe(404);
    });
});
