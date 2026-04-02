/**
 * E2E tests: Room folders functionality.
 *
 * Covers folder CRUD (create, rename, delete), moving rooms into folders,
 * folder permission enforcement (admin/mod only), and folder persistence.
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

/** Invite a user to the current room via /invite. */
async function inviteUser(page, username) {
    await page.locator('#message-input').fill(`/invite ${username}`);
    await page.locator('#message-input').press('Enter');
    await expect(page.locator('#messages')).toContainText(`Invited ${username}`);
}

/** Create a folder via API. Returns { folder_id }. */
async function createFolder(page, baseURL, sessionToken, name, parentFolderId = null) {
    const body = { name };
    if (parentFolderId) body.parent_folder_id = parentFolderId;

    const resp = await page.request.post(`${baseURL}/api/rooms/folders`, {
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${sessionToken}`,
        },
        data: body,
    });
    expect(resp.ok()).toBeTruthy();
    return resp.json();
}

/** Move a room into a folder via PATCH /rooms/{roomId}. */
async function moveRoomToFolder(page, baseURL, sessionToken, roomId, folderId, position = 0) {
    const resp = await page.request.patch(`${baseURL}/api/rooms/${roomId}`, {
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${sessionToken}`,
        },
        data: { folder_id: folderId, sort_position: position },
    });
    expect(resp.ok()).toBeTruthy();
}

/** Get folder tree via API. */
async function getFolders(page, baseURL, sessionToken) {
    const resp = await page.request.get(`${baseURL}/api/rooms/folders`, {
        headers: { 'Authorization': `Bearer ${sessionToken}` },
    });
    expect(resp.ok()).toBeTruthy();
    return resp.json();
}

// ── Tests ───────────────────────────────────────────────────────────────

test.describe('Room folders - CRUD', () => {

    test('admin can create a folder via API and it appears in the sidebar', async ({ threeUsers, baseURL }) => {
        const { admin } = threeUsers;
        await admin.page.waitForLoadState('networkidle');

        // Create a folder
        const folder = await createFolder(admin.page, baseURL, admin.sessionToken, 'general');

        expect(folder.folder_id).toBeTruthy();

        // Reload to see the folder in sidebar
        await admin.page.reload();
        await admin.page.waitForLoadState('networkidle');

        // Folder should appear in sidebar
        await expect(admin.page.locator(`.folder-item[data-folder-id="${folder.folder_id}"]`)).toBeVisible();
    });

    test('admin can rename a folder', async ({ threeUsers, baseURL }) => {
        const { admin } = threeUsers;

        // Create folder
        const folder = await createFolder(admin.page, baseURL, admin.sessionToken, 'old-name');

        // Rename it
        const resp = await admin.page.request.patch(`${baseURL}/api/rooms/folders/${folder.folder_id}`, {
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${admin.sessionToken}`,
            },
            data: { name: 'new-name' },
        });
        expect(resp.ok()).toBeTruthy();

        // Verify via API
        const tree = await getFolders(admin.page, baseURL, admin.sessionToken);
        const renamed = tree.folders.find(f => f.folder_id === folder.folder_id);
        expect(renamed.name).toBe('new-name');
    });

    test('admin can delete a folder', async ({ threeUsers, baseURL }) => {
        const { admin } = threeUsers;

        const folder = await createFolder(admin.page, baseURL, admin.sessionToken, 'to-delete');

        // Delete it
        const resp = await admin.page.request.delete(`${baseURL}/api/rooms/folders/${folder.folder_id}`, {
            headers: { 'Authorization': `Bearer ${admin.sessionToken}` },
        });
        expect(resp.ok()).toBeTruthy();

        // Verify it's gone
        const tree = await getFolders(admin.page, baseURL, admin.sessionToken);
        const found = tree.folders.find(f => f.folder_id === folder.folder_id);
        expect(found).toBeUndefined();
    });

    test('admin can create nested folders', async ({ threeUsers, baseURL }) => {
        const { admin } = threeUsers;

        // Create parent folder
        const parent = await createFolder(admin.page, baseURL, admin.sessionToken, 'parent');

        // Create child folder
        const child = await createFolder(admin.page, baseURL, admin.sessionToken, 'child', parent.folder_id);

        // Verify tree structure
        const tree = await getFolders(admin.page, baseURL, admin.sessionToken);
        const childFolder = tree.folders.find(f => f.folder_id === child.folder_id);
        expect(childFolder.parent_folder_id).toBe(parent.folder_id);
    });
});

test.describe('Room folders - Room organization', () => {

    test('admin can move a room into a folder', async ({ threeUsers, baseURL }) => {
        const { admin } = threeUsers;
        await admin.page.waitForLoadState('networkidle');

        // Create a room and a folder
        await createRoom(admin.page, 'folder-test-room');
        const folder = await createFolder(admin.page, baseURL, admin.sessionToken, 'organized');

        // Move room into folder
        await moveRoomToFolder(admin.page, baseURL, admin.sessionToken, 'folder-test-room', folder.folder_id);

        // Verify via API
        const tree = await getFolders(admin.page, baseURL, admin.sessionToken);
        const roomPos = tree.room_positions.find(r => r.room_id === 'folder-test-room');
        expect(roomPos.folder_id).toBe(folder.folder_id);
    });

    test('create folder, move existing room in, then create new room in folder', async ({ threeUsers, baseURL }) => {
        const { admin } = threeUsers;
        await admin.page.waitForLoadState('networkidle');

        // 1. Create an existing room (before the folder exists)
        await createRoom(admin.page, 'pre-existing-room');

        // 2. Create a folder
        const folder = await createFolder(admin.page, baseURL, admin.sessionToken, 'projects');

        // 3. Move the existing room into the folder
        await moveRoomToFolder(admin.page, baseURL, admin.sessionToken, 'pre-existing-room', folder.folder_id, 0);

        // 4. Create a second room and move it into the same folder
        await createRoom(admin.page, 'new-in-folder');
        await moveRoomToFolder(admin.page, baseURL, admin.sessionToken, 'new-in-folder', folder.folder_id, 1);

        // 5. Verify both rooms are in the folder via API
        const tree = await getFolders(admin.page, baseURL, admin.sessionToken);
        const positions = tree.room_positions.filter(r => r.folder_id === folder.folder_id);
        const roomIds = positions.map(r => r.room_id).sort();
        expect(roomIds).toEqual(['new-in-folder', 'pre-existing-room']);

        // Verify sort order
        const preExisting = positions.find(r => r.room_id === 'pre-existing-room');
        const newRoom = positions.find(r => r.room_id === 'new-in-folder');
        expect(preExisting.position).toBeLessThan(newRoom.position);

        // 6. Verify the folder and rooms render correctly in the sidebar
        await admin.page.reload();
        await admin.page.waitForLoadState('networkidle');

        const folderEl = admin.page.locator(`.folder-item[data-folder-id="${folder.folder_id}"]`);
        await expect(folderEl).toBeVisible();

        // Both rooms should be visible under the folder
        const roomItems = admin.page.locator(`.folder-item[data-folder-id="${folder.folder_id}"] .room-item`);
        await expect(roomItems).toHaveCount(2);
    });

    test('deleting a folder moves rooms back to root', async ({ threeUsers, baseURL }) => {
        const { admin } = threeUsers;
        await admin.page.waitForLoadState('networkidle');

        // Create room and folder
        await createRoom(admin.page, 'orphan-room');
        const folder = await createFolder(admin.page, baseURL, admin.sessionToken, 'temporary');
        await moveRoomToFolder(admin.page, baseURL, admin.sessionToken, 'orphan-room', folder.folder_id);

        // Delete folder
        await admin.page.request.delete(`${baseURL}/api/rooms/folders/${folder.folder_id}`, {
            headers: { 'Authorization': `Bearer ${admin.sessionToken}` },
        });

        // Room should now have no folder (root)
        const tree = await getFolders(admin.page, baseURL, admin.sessionToken);
        const roomPos = tree.room_positions.find(r => r.room_id === 'orphan-room');
        // Room should either not be in positions (root) or have null folder_id
        if (roomPos) {
            expect(roomPos.folder_id).toBeNull();
        }
    });

    test('folder structure visible to non-admin members after reload', async ({ threeUsers, baseURL }) => {
        const { admin, userB } = threeUsers;
        await admin.page.waitForLoadState('networkidle');

        // Create room, folder, organize
        await createRoom(admin.page, 'shared-folder-room');
        await inviteUser(admin.page, userB.username);
        const folder = await createFolder(admin.page, baseURL, admin.sessionToken, 'shared-folder');
        await moveRoomToFolder(admin.page, baseURL, admin.sessionToken, 'shared-folder-room', folder.folder_id);

        // User B reloads and should see the folder structure
        await userB.page.reload();
        await userB.page.waitForLoadState('networkidle');

        // Folder should be visible for User B
        await expect(userB.page.locator(`.folder-item[data-folder-id="${folder.folder_id}"]`)).toBeVisible();
    });
});

test.describe('Room folders - Permissions', () => {

    test('regular user cannot create folders', async ({ threeUsers, baseURL }) => {
        const { userB } = threeUsers;

        const resp = await userB.page.request.post(`${baseURL}/api/rooms/folders`, {
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${userB.sessionToken}`,
            },
            data: { name: 'unauthorized-folder' },
        });
        expect(resp.status()).toBe(403);
    });

    test('regular user cannot delete folders', async ({ threeUsers, baseURL }) => {
        const { admin, userB } = threeUsers;

        const folder = await createFolder(admin.page, baseURL, admin.sessionToken, 'admin-folder');

        const resp = await userB.page.request.delete(`${baseURL}/api/rooms/folders/${folder.folder_id}`, {
            headers: { 'Authorization': `Bearer ${userB.sessionToken}` },
        });
        expect(resp.status()).toBe(403);
    });

    test('moderator can create and delete folders', async ({ threeUsers, baseURL }) => {
        const { admin, userB } = threeUsers;

        // Promote User B to moderator
        await admin.page.request.patch(`${baseURL}/api/users/${userB.username}`, {
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${admin.sessionToken}`,
            },
            data: { role: 'moderator' },
        });

        // Moderator creates folder
        const folder = await createFolder(userB.page, baseURL, userB.sessionToken, 'mod-folder');
        expect(folder.folder_id).toBeTruthy();

        // Moderator deletes folder
        const delResp = await userB.page.request.delete(`${baseURL}/api/rooms/folders/${folder.folder_id}`, {
            headers: { 'Authorization': `Bearer ${userB.sessionToken}` },
        });
        expect(delResp.ok()).toBeTruthy();

        // Clean up: demote back
        await admin.page.request.patch(`${baseURL}/api/users/${userB.username}`, {
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${admin.sessionToken}`,
            },
            data: { role: 'user' },
        });
    });

    test('regular user cannot move a room into a folder', async ({ threeUsers, baseURL }) => {
        const { admin, userB } = threeUsers;

        await createRoom(admin.page, 'perm-move-room');
        await inviteUser(admin.page, userB.username);
        const folder = await createFolder(admin.page, baseURL, admin.sessionToken, 'perm-folder');

        // User B (regular member) tries to move room via PATCH
        const resp = await userB.page.request.patch(`${baseURL}/api/rooms/perm-move-room`, {
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${userB.sessionToken}`,
            },
            data: { folder_id: folder.folder_id, sort_position: 0 },
        });
        expect(resp.status()).toBe(403);
    });

    test('moderator can move a room into a folder', async ({ threeUsers, baseURL }) => {
        const { admin, userB } = threeUsers;

        await createRoom(admin.page, 'mod-move-room');
        const folder = await createFolder(admin.page, baseURL, admin.sessionToken, 'mod-move-folder');

        // Promote User B to moderator
        await admin.page.request.patch(`${baseURL}/api/users/${userB.username}`, {
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${admin.sessionToken}`,
            },
            data: { role: 'moderator' },
        });

        // Moderator moves room via PATCH /rooms/{room_id}
        const resp = await userB.page.request.patch(`${baseURL}/api/rooms/mod-move-room`, {
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${userB.sessionToken}`,
            },
            data: { folder_id: folder.folder_id, sort_position: 0 },
        });
        expect(resp.ok()).toBeTruthy();

        // Verify the room is now in the folder
        const tree = await getFolders(admin.page, baseURL, admin.sessionToken);
        const roomPos = tree.room_positions.find(r => r.room_id === 'mod-move-room');
        expect(roomPos.folder_id).toBe(folder.folder_id);

        // Clean up: demote back
        await admin.page.request.patch(`${baseURL}/api/users/${userB.username}`, {
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${admin.sessionToken}`,
            },
            data: { role: 'user' },
        });
    });
});

test.describe('Room folders - Name validation', () => {

    test('empty folder name is rejected', async ({ threeUsers, baseURL }) => {
        const { admin } = threeUsers;

        const resp = await admin.page.request.post(`${baseURL}/api/rooms/folders`, {
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${admin.sessionToken}`,
            },
            data: { name: '' },
        });
        expect(resp.ok()).toBeFalsy();
        expect(resp.status()).toBe(422);
    });

    test('whitespace-only folder name is rejected', async ({ threeUsers, baseURL }) => {
        const { admin } = threeUsers;

        const resp = await admin.page.request.post(`${baseURL}/api/rooms/folders`, {
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${admin.sessionToken}`,
            },
            data: { name: '   ' },
        });
        expect(resp.ok()).toBeFalsy();
    });

    test('folder name over 50 characters is rejected', async ({ threeUsers, baseURL }) => {
        const { admin } = threeUsers;

        const longName = 'a'.repeat(51);
        const resp = await admin.page.request.post(`${baseURL}/api/rooms/folders`, {
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${admin.sessionToken}`,
            },
            data: { name: longName },
        });
        expect(resp.ok()).toBeFalsy();
    });

    test('folder name at exactly 50 characters is accepted', async ({ threeUsers, baseURL }) => {
        const { admin } = threeUsers;

        const name50 = 'a'.repeat(50);
        const resp = await admin.page.request.post(`${baseURL}/api/rooms/folders`, {
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${admin.sessionToken}`,
            },
            data: { name: name50 },
        });
        expect(resp.ok()).toBeTruthy();
    });

    test('renaming folder to empty name is rejected', async ({ threeUsers, baseURL }) => {
        const { admin } = threeUsers;

        const folder = await createFolder(admin.page, baseURL, admin.sessionToken, 'valid-name');

        const resp = await admin.page.request.patch(`${baseURL}/api/rooms/folders/${folder.folder_id}`, {
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${admin.sessionToken}`,
            },
            data: { name: '' },
        });
        expect(resp.ok()).toBeFalsy();
    });

    test('renaming folder to name over 50 characters is rejected', async ({ threeUsers, baseURL }) => {
        const { admin } = threeUsers;

        const folder = await createFolder(admin.page, baseURL, admin.sessionToken, 'short-name');

        const longName = 'b'.repeat(51);
        const resp = await admin.page.request.patch(`${baseURL}/api/rooms/folders/${folder.folder_id}`, {
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${admin.sessionToken}`,
            },
            data: { name: longName },
        });
        expect(resp.ok()).toBeFalsy();
    });

    test('folder name follows room naming rules — lowercase alphanumeric and hyphens', async ({ threeUsers, baseURL }) => {
        const { admin } = threeUsers;

        // Valid names
        for (const name of ['general', 'my-folder', 'dev-2', 'a']) {
            const resp = await admin.page.request.post(`${baseURL}/api/rooms/folders`, {
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${admin.sessionToken}`,
                },
                data: { name },
            });
            expect(resp.ok(), `expected '${name}' to be accepted`).toBeTruthy();
        }

        // Invalid names
        for (const name of ['My Folder', 'UPPER', 'has space', 'special!', '-leading', 'trailing-', 'double--hyphen']) {
            const resp = await admin.page.request.post(`${baseURL}/api/rooms/folders`, {
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${admin.sessionToken}`,
                },
                data: { name },
            });
            expect(resp.ok(), `expected '${name}' to be rejected`).toBeFalsy();
        }
    });

    test('renaming folder enforces same naming rules', async ({ threeUsers, baseURL }) => {
        const { admin } = threeUsers;

        const folder = await createFolder(admin.page, baseURL, admin.sessionToken, 'rename-test');

        // Valid rename
        const goodResp = await admin.page.request.patch(`${baseURL}/api/rooms/folders/${folder.folder_id}`, {
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${admin.sessionToken}`,
            },
            data: { name: 'new-name' },
        });
        expect(goodResp.ok()).toBeTruthy();

        // Invalid rename
        const badResp = await admin.page.request.patch(`${baseURL}/api/rooms/folders/${folder.folder_id}`, {
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${admin.sessionToken}`,
            },
            data: { name: 'Has Spaces' },
        });
        expect(badResp.ok()).toBeFalsy();
    });
});

test.describe('Room folders - batch_reorder validation', () => {

    /** Helper to call reorder endpoint directly. */
    async function reorder(page, baseURL, sessionToken, folders, rooms = []) {
        return page.request.post(`${baseURL}/api/rooms/folders/reorder`, {
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${sessionToken}`,
            },
            data: { folders, rooms },
        });
    }

    test('reorder rejects circular reference (A parent of B, B parent of A)', async ({ threeUsers, baseURL }) => {
        const { admin } = threeUsers;

        const folderA = await createFolder(admin.page, baseURL, admin.sessionToken, 'circ-a');
        const folderB = await createFolder(admin.page, baseURL, admin.sessionToken, 'circ-b');

        // Try to make A child of B and B child of A
        const resp = await reorder(admin.page, baseURL, admin.sessionToken, [
            { folder_id: folderA.folder_id, parent_folder_id: folderB.folder_id, position: 0 },
            { folder_id: folderB.folder_id, parent_folder_id: folderA.folder_id, position: 0 },
        ]);
        expect(resp.ok()).toBeFalsy();
        expect(resp.status()).toBe(400);
    });

    test('reorder rejects self-referencing parent', async ({ threeUsers, baseURL }) => {
        const { admin } = threeUsers;

        const folder = await createFolder(admin.page, baseURL, admin.sessionToken, 'self-ref');

        const resp = await reorder(admin.page, baseURL, admin.sessionToken, [
            { folder_id: folder.folder_id, parent_folder_id: folder.folder_id, position: 0 },
        ]);
        expect(resp.ok()).toBeFalsy();
        expect(resp.status()).toBe(400);
    });

    test('reorder rejects nesting beyond max depth', async ({ threeUsers, baseURL }) => {
        const { admin } = threeUsers;

        // Create 6 folders (depth 5 is max, so a chain of 6 exceeds it)
        const f1 = await createFolder(admin.page, baseURL, admin.sessionToken, 'd1');
        const f2 = await createFolder(admin.page, baseURL, admin.sessionToken, 'd2');
        const f3 = await createFolder(admin.page, baseURL, admin.sessionToken, 'd3');
        const f4 = await createFolder(admin.page, baseURL, admin.sessionToken, 'd4');
        const f5 = await createFolder(admin.page, baseURL, admin.sessionToken, 'd5');
        const f6 = await createFolder(admin.page, baseURL, admin.sessionToken, 'd6');

        // Try to chain them: f1 > f2 > f3 > f4 > f5 > f6
        const resp = await reorder(admin.page, baseURL, admin.sessionToken, [
            { folder_id: f1.folder_id, parent_folder_id: null, position: 0 },
            { folder_id: f2.folder_id, parent_folder_id: f1.folder_id, position: 0 },
            { folder_id: f3.folder_id, parent_folder_id: f2.folder_id, position: 0 },
            { folder_id: f4.folder_id, parent_folder_id: f3.folder_id, position: 0 },
            { folder_id: f5.folder_id, parent_folder_id: f4.folder_id, position: 0 },
            { folder_id: f6.folder_id, parent_folder_id: f5.folder_id, position: 0 },
        ]);
        expect(resp.ok()).toBeFalsy();
        expect(resp.status()).toBe(400);
    });

    test('reorder rejects rooms referencing non-existent folders', async ({ threeUsers, baseURL }) => {
        const { admin } = threeUsers;
        await admin.page.waitForLoadState('networkidle');

        await createRoom(admin.page, 'reorder-room');

        const resp = await reorder(admin.page, baseURL, admin.sessionToken, [], [
            { room_id: 'reorder-room', folder_id: 'non-existent-folder-id', position: 0 },
        ]);
        expect(resp.ok()).toBeFalsy();
        expect(resp.status()).toBe(400);
    });

    test('valid reorder succeeds', async ({ threeUsers, baseURL }) => {
        const { admin } = threeUsers;

        const parent = await createFolder(admin.page, baseURL, admin.sessionToken, 'valid-parent');
        const child = await createFolder(admin.page, baseURL, admin.sessionToken, 'valid-child');

        const resp = await reorder(admin.page, baseURL, admin.sessionToken, [
            { folder_id: parent.folder_id, parent_folder_id: null, position: 0 },
            { folder_id: child.folder_id, parent_folder_id: parent.folder_id, position: 0 },
        ]);
        expect(resp.ok()).toBeTruthy();

        // Verify the structure
        const tree = await getFolders(admin.page, baseURL, admin.sessionToken);
        const childFolder = tree.folders.find(f => f.folder_id === child.folder_id);
        expect(childFolder.parent_folder_id).toBe(parent.folder_id);
    });
});
