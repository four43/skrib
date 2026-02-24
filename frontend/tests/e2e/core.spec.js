/**
 * E2E tests: Core room management — create, message, invite.
 *
 * Uses the `threeUsers` fixture which provides an admin (User A),
 * User B, and User C — all registered, approved, and logged in to app.html.
 */

import { test, expect } from './fixtures.js';

// ── Helpers ─────────────────────────────────────────────────────────────

/** Ensure the members panel is open (auto-opens on wide viewports). */
async function ensureMembersPanelOpen(page) {
    const panel = page.locator('#members-panel');
    if (!(await panel.evaluate(el => el.classList.contains('open')))) {
        await page.locator('#members-toggle-btn').click();
    }
    await expect(panel).toHaveClass(/open/);
}

/** Create a room via the UI. Caller must be on app.html. Returns room name. */
async function createRoom(page, roomName) {
    await page.locator('#add-channel-btn').click();
    await page.locator('#new-room-input').fill(roomName);
    await page.locator('#create-room-submit-btn').click();
    await expect(page.locator('#chat-header-name')).toHaveText(`#${roomName}`);
    await page.locator('#message-input').waitFor();
    return roomName;
}

/** Send a chat message in the current room and verify it appears. */
async function sendMessage(page, text) {
    await page.locator('#message-input').fill(text);
    await page.locator('#message-input').press('Enter');
    await expect(page.locator('#messages')).toContainText(text);
}

/** Invite a user via /invite command and verify the system message. */
async function inviteUser(page, username) {
    await page.locator('#message-input').fill(`/invite ${username}`);
    await page.locator('#message-input').press('Enter');
    await expect(page.locator('#messages')).toContainText(`Invited ${username}`);
}

/** Add users via the Add User modal. */
async function addUsersViaModal(page, usernames) {
    await ensureMembersPanelOpen(page);
    await page.locator('#add-member-btn').click();
    await page.locator('#add-member-user-list .user-select-item').first().waitFor();

    for (const username of usernames) {
        await page.locator(`#add-member-user-list .user-select-item input[value="${username}"]`).check();
    }

    await page.locator('#add-member-btn-confirm').click();
    await expect(page.locator('#add-member-modal')).not.toHaveClass(/open/);
}

/** Reload a user's page, click into a room, and return. */
async function navigateToRoom(page, roomName) {
    await page.reload();
    await page.waitForLoadState('networkidle');
    await page.locator(`.room-item[data-room-id="${roomName}"]`).waitFor();
    await page.locator(`.room-item[data-room-id="${roomName}"]`).click();
    await expect(page.locator('#chat-header-name')).toHaveText(`#${roomName}`);
}

// ── Tests ───────────────────────────────────────────────────────────────

test.describe('Core room management', () => {

    test('User A creates a room, sends Hello World, invites User B who can see the message', async ({ threeUsers }) => {
        const { admin: userA, userB } = threeUsers;
        await userA.page.waitForLoadState('networkidle');

        await createRoom(userA.page, 'test-room-a');
        await sendMessage(userA.page, 'Hello World');
        await inviteUser(userA.page, userB.username);

        await navigateToRoom(userB.page, 'test-room-a');
        await expect(userB.page.locator('#messages')).toContainText('Hello World');
    });

    test('User A adds User B and User C via Add User button, they exchange messages', async ({ threeUsers }) => {
        const { admin: userA, userB, userC } = threeUsers;
        await userA.page.waitForLoadState('networkidle');

        await createRoom(userA.page, 'test-room-add');
        await sendMessage(userA.page, 'Hello World');

        // Add User B and User C via modal
        await addUsersViaModal(userA.page, [userB.username, userC.username]);

        // User B sees the room and User A's message
        await navigateToRoom(userB.page, 'test-room-add');
        await expect(userB.page.locator('#messages')).toContainText('Hello World');

        // User C sees the room and User A's message
        await navigateToRoom(userC.page, 'test-room-add');
        await expect(userC.page.locator('#messages')).toContainText('Hello World');

        // User B sends a message, User A sees it
        await sendMessage(userB.page, 'Hi User A');
        await expect(userA.page.locator('#messages')).toContainText('Hi User A');

        // User C sends a message, User A and User B see it
        await sendMessage(userC.page, 'Hi User A and B');
        await expect(userA.page.locator('#messages')).toContainText('Hi User A and B');
        await expect(userB.page.locator('#messages')).toContainText('Hi User A and B');
    });

    test('User B creates a room, invites User A, User A sends a message User B can see', async ({ threeUsers }) => {
        const { admin: userA, userB } = threeUsers;
        await userB.page.waitForLoadState('networkidle');

        await createRoom(userB.page, 'test-room-b');
        await inviteUser(userB.page, userA.username);

        // User A sees the room in sidebar after reload
        await userA.page.reload();
        await userA.page.waitForLoadState('networkidle');
        await userA.page.locator('.room-item[data-room-id="test-room-b"]').waitFor();

        // User A has NOT clicked into the room yet — no messages should be loaded
        // Now User A clicks into the room
        await userA.page.locator('.room-item[data-room-id="test-room-b"]').click();
        await expect(userA.page.locator('#chat-header-name')).toHaveText('#test-room-b');

        // Room should have no chat messages (only the system invite message from User B's perspective)
        // User A sends a message
        await sendMessage(userA.page, 'Hello User B');

        // User B can see User A's message (User B is already in the room)
        await expect(userB.page.locator('#messages')).toContainText('Hello User B');
    });
});
