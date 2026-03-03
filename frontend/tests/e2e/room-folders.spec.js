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

    const resp = await page.request.post(`${baseURL}/api/room-folders`, {
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${sessionToken}`,
        },
        data: body,
    });
    expect(resp.ok()).toBeTruthy();
    return resp.json();
}

/** Move a room into a folder via API. */
async function moveRoomToFolder(page, baseURL, sessionToken, roomId, folderId, position = 0) {
    const resp = await page.request.put(`${baseURL}/api/room-folders/rooms/${roomId}`, {
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${sessionToken}`,
        },
        data: { folder_id: folderId, position },
    });
    expect(resp.ok()).toBeTruthy();
}

/** Get folder tree via API. */
async function getFolders(page, baseURL, sessionToken) {
    const resp = await page.request.get(`${baseURL}/api/room-folders`, {
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
        const folder = await createFolder(admin.page, baseURL, admin.sessionToken, 'General');

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
        const folder = await createFolder(admin.page, baseURL, admin.sessionToken, 'Old Name');

        // Rename it
        const resp = await admin.page.request.patch(`${baseURL}/api/room-folders/${folder.folder_id}`, {
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${admin.sessionToken}`,
            },
            data: { name: 'New Name' },
        });
        expect(resp.ok()).toBeTruthy();

        // Verify via API
        const tree = await getFolders(admin.page, baseURL, admin.sessionToken);
        const renamed = tree.folders.find(f => f.folder_id === folder.folder_id);
        expect(renamed.name).toBe('New Name');
    });

    test('admin can delete a folder', async ({ threeUsers, baseURL }) => {
        const { admin } = threeUsers;

        const folder = await createFolder(admin.page, baseURL, admin.sessionToken, 'ToDelete');

        // Delete it
        const resp = await admin.page.request.delete(`${baseURL}/api/room-folders/${folder.folder_id}`, {
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
        const parent = await createFolder(admin.page, baseURL, admin.sessionToken, 'Parent');

        // Create child folder
        const child = await createFolder(admin.page, baseURL, admin.sessionToken, 'Child', parent.folder_id);

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
        const folder = await createFolder(admin.page, baseURL, admin.sessionToken, 'Organized');

        // Move room into folder
        await moveRoomToFolder(admin.page, baseURL, admin.sessionToken, 'folder-test-room', folder.folder_id);

        // Verify via API
        const tree = await getFolders(admin.page, baseURL, admin.sessionToken);
        const roomPos = tree.room_positions.find(r => r.room_id === 'folder-test-room');
        expect(roomPos.folder_id).toBe(folder.folder_id);
    });

    test('deleting a folder moves rooms back to root', async ({ threeUsers, baseURL }) => {
        const { admin } = threeUsers;
        await admin.page.waitForLoadState('networkidle');

        // Create room and folder
        await createRoom(admin.page, 'orphan-room');
        const folder = await createFolder(admin.page, baseURL, admin.sessionToken, 'Temporary');
        await moveRoomToFolder(admin.page, baseURL, admin.sessionToken, 'orphan-room', folder.folder_id);

        // Delete folder
        await admin.page.request.delete(`${baseURL}/api/room-folders/${folder.folder_id}`, {
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
        const folder = await createFolder(admin.page, baseURL, admin.sessionToken, 'SharedFolder');
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

        const resp = await userB.page.request.post(`${baseURL}/api/room-folders`, {
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${userB.sessionToken}`,
            },
            data: { name: 'Unauthorized Folder' },
        });
        expect(resp.status()).toBe(403);
    });

    test('regular user cannot delete folders', async ({ threeUsers, baseURL }) => {
        const { admin, userB } = threeUsers;

        const folder = await createFolder(admin.page, baseURL, admin.sessionToken, 'AdminFolder');

        const resp = await userB.page.request.delete(`${baseURL}/api/room-folders/${folder.folder_id}`, {
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
        const folder = await createFolder(userB.page, baseURL, userB.sessionToken, 'ModFolder');
        expect(folder.folder_id).toBeTruthy();

        // Moderator deletes folder
        const delResp = await userB.page.request.delete(`${baseURL}/api/room-folders/${folder.folder_id}`, {
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
        const folder = await createFolder(admin.page, baseURL, admin.sessionToken, 'PermFolder');

        const resp = await userB.page.request.put(`${baseURL}/api/room-folders/rooms/perm-move-room`, {
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${userB.sessionToken}`,
            },
            data: { folder_id: folder.folder_id, position: 0 },
        });
        expect(resp.status()).toBe(403);
    });

    test('moderator can move a room into a folder', async ({ threeUsers, baseURL }) => {
        const { admin, userB } = threeUsers;

        await createRoom(admin.page, 'mod-move-room');
        const folder = await createFolder(admin.page, baseURL, admin.sessionToken, 'ModMoveFolder');

        // Promote User B to moderator
        await admin.page.request.patch(`${baseURL}/api/users/${userB.username}`, {
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${admin.sessionToken}`,
            },
            data: { role: 'moderator' },
        });

        const resp = await userB.page.request.put(`${baseURL}/api/room-folders/rooms/mod-move-room`, {
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${userB.sessionToken}`,
            },
            data: { folder_id: folder.folder_id, position: 0 },
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
