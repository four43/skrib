/**
 * E2E tests: Chat room type plugin — message editing, deletion,
 * hover bar, history loading, and read receipts.
 *
 * Uses the `threeUsers` fixture (admin User A, User B, User C).
 */

import { test, expect } from './fixtures.js';

// ── Helpers ─────────────────────────────────────────────────────────────

async function createRoom(page, roomName) {
    await page.locator('#add-channel-btn').click();
    await page.locator('#new-room-input').fill(roomName);
    await page.locator('#create-room-submit-btn').click();
    await expect(page.locator('#chat-header-name')).toHaveText(`#${roomName}`);
    await page.locator('#message-input').waitFor();
}

async function sendMessage(page, text) {
    await page.locator('#message-input').fill(text);
    await page.locator('#message-input').press('Enter');
    await expect(page.locator('#messages')).toContainText(text);
}

async function sendCommand(page, command) {
    await page.locator('#message-input').fill(command);
    await page.locator('#message-input').press('Enter');
}

async function inviteUser(page, username) {
    await sendCommand(page, `/invite ${username}`);
    await expect(page.locator('#messages')).toContainText(`Invited ${username}`);
}

async function navigateToRoom(page, roomName) {
    await page.reload();
    await page.waitForLoadState('networkidle');
    await page.locator(`.room-item[data-room-id="${roomName}"]`).waitFor();
    await page.locator(`.room-item[data-room-id="${roomName}"]`).click();
    await expect(page.locator('#chat-header-name')).toHaveText(`#${roomName}`);
}

async function selectRoom(page, roomName) {
    await page.locator(`.room-item[data-room-id="${roomName}"]`).click();
    await expect(page.locator('#chat-header-name')).toHaveText(`#${roomName}`);
}

/**
 * Click a message to activate its hover bar.
 * Returns the message locator.
 */
async function clickMessage(page, text) {
    const msg = page.locator('.message', { hasText: text }).first();
    await msg.click();
    await expect(msg.locator('.message-hover-bar')).toHaveClass(/active/);
    return msg;
}

/**
 * Enter edit mode on a message.
 * Activates hover bar and clicks Edit in a single evaluate to prevent
 * the hover bar from being deactivated between Playwright actions.
 *
 * Returns a stable message locator (by data-message-id) and the edit input.
 * We can't use hasText after edit mode starts because the original text
 * is replaced by the <input> element.
 */
async function startEdit(page, messageText) {
    const textMsg = page.locator('.message', { hasText: messageText }).first();
    // Get the stable message-id before editing replaces the text content
    const messageId = await textMsg.getAttribute('data-message-id');

    await textMsg.evaluate(el => {
        el.click();
        el.querySelector('.message-hover-btn[title="Edit"]').click();
    });

    // Use data-message-id for a stable locator that survives text changes
    const msg = page.locator(`.message[data-message-id="${messageId}"]`);
    const editInput = msg.locator('.message-edit-input');
    await expect(editInput).toBeVisible();
    return { msg, editInput };
}

// ── Tests ───────────────────────────────────────────────────────────────

test.describe('Message editing', () => {

    test('Author can edit a message, both users see update with (edited) indicator', async ({ threeUsers }) => {
        const { admin: userA, userB } = threeUsers;
        await userA.page.waitForLoadState('networkidle');

        await createRoom(userA.page, 'edit-room');
        await sendMessage(userA.page, 'original message');
        await inviteUser(userA.page, userB.username);

        await navigateToRoom(userB.page, 'edit-room');
        await expect(userB.page.locator('#messages')).toContainText('original message');

        // User A clicks message to show hover bar, clicks Edit button
        const { msg, editInput } = await startEdit(userA.page, 'original message');

        // Message enters edit mode — clear and type new content
        await editInput.fill('edited message');
        await editInput.press('Enter');

        // User A sees the updated text and (edited) indicator
        await expect(msg.locator('.message-text')).toContainText('edited message');
        await expect(msg.locator('.edited-indicator')).toBeVisible();

        // User B sees the update in real-time
        await expect(userB.page.locator('#messages')).toContainText('edited message');
        await expect(userB.page.locator('.edited-indicator')).toBeVisible();
    });

    test('Edit can be cancelled with Escape', async ({ threeUsers }) => {
        const { admin: userA } = threeUsers;
        await userA.page.waitForLoadState('networkidle');

        await createRoom(userA.page, 'edit-cancel-room');
        await sendMessage(userA.page, 'keep this text');

        // Click message, click Edit
        const { msg, editInput } = await startEdit(userA.page, 'keep this text');

        // Type something, then Escape
        await editInput.fill('changed text');
        await editInput.press('Escape');

        // Original text remains
        await expect(msg.locator('.message-text')).toContainText('keep this text');
        await expect(msg.locator('.edited-indicator')).toHaveCount(0);
    });

    test('Non-author cannot see Edit button, but owner/admin can see Delete', async ({ threeUsers }) => {
        const { admin: userA, userB } = threeUsers;
        await userA.page.waitForLoadState('networkidle');

        await createRoom(userA.page, 'perm-room');
        await inviteUser(userA.page, userB.username);
        await navigateToRoom(userB.page, 'perm-room');

        // User B sends a message
        await sendMessage(userB.page, 'User B message');
        await expect(userA.page.locator('#messages')).toContainText('User B message');

        // User A clicks User B's message — should see "..." but NOT pencil (not author)
        const msgA = userA.page.locator('.message', { hasText: 'User B message' }).first();
        await msgA.click();
        await expect(msgA.locator('.message-hover-bar')).toHaveClass(/active/);

        // The hover bar should have the more-btn (for delete) but not the edit btn
        // Edit is only for the author; admin gets the "..." menu for delete
        await expect(msgA.locator('.message-more-btn')).toBeVisible();

        // User B clicks their own message — should see Edit button
        const msgB = userB.page.locator('.message', { hasText: 'User B message' }).first();
        await msgB.click();
        await expect(msgB.locator('.message-hover-bar')).toHaveClass(/active/);
        // Author sees both edit (pencil) and more (...)
        const hoverBtns = msgB.locator('.message-hover-btn');
        await expect(hoverBtns).toHaveCount(2); // edit + more
    });
});

test.describe('Message deletion', () => {

    test('Author can delete a message, shows [deleted] for all users', async ({ threeUsers }) => {
        const { admin: userA, userB } = threeUsers;
        await userA.page.waitForLoadState('networkidle');

        await createRoom(userA.page, 'delete-msg-room');
        await inviteUser(userA.page, userB.username);
        await navigateToRoom(userB.page, 'delete-msg-room');

        await sendMessage(userA.page, 'delete me');
        await expect(userB.page.locator('#messages')).toContainText('delete me');

        // User A clicks message, opens "..." menu, clicks Delete
        const msg = await clickMessage(userA.page, 'delete me');
        await msg.locator('.message-more-btn').click();
        await msg.locator('.message-more-menu-item').click();

        // Message shows [deleted] for User A
        await expect(userA.page.locator('#messages')).toContainText('[deleted]');

        // Message shows [deleted] for User B in real-time
        await expect(userB.page.locator('#messages')).toContainText('[deleted]');
    });

    test('Deleted message no longer shows hover bar', async ({ threeUsers }) => {
        const { admin: userA } = threeUsers;
        await userA.page.waitForLoadState('networkidle');

        await createRoom(userA.page, 'no-hover-room');
        await sendMessage(userA.page, 'will be deleted');

        // Delete the message
        const msg = await clickMessage(userA.page, 'will be deleted');
        await msg.locator('.message-more-btn').click();
        await msg.locator('.message-more-menu-item').click();

        await expect(userA.page.locator('#messages')).toContainText('[deleted]');

        // Click the deleted message — hover bar should NOT appear
        const deleted = userA.page.locator('.message-deleted').first();
        await deleted.click();
        await expect(deleted.locator('.message-hover-bar.active')).toHaveCount(0);
    });

    test('Admin can delete other users messages', async ({ threeUsers }) => {
        const { admin: userA, userB } = threeUsers;
        await userA.page.waitForLoadState('networkidle');

        await createRoom(userA.page, 'admin-del-room');
        await inviteUser(userA.page, userB.username);
        await navigateToRoom(userB.page, 'admin-del-room');

        // User B sends a message
        await sendMessage(userB.page, 'User B says hello');
        await expect(userA.page.locator('#messages')).toContainText('User B says hello');

        // User A (admin) deletes User B's message via "..." menu
        const msg = userA.page.locator('.message', { hasText: 'User B says hello' }).first();
        await msg.click();
        await expect(msg.locator('.message-hover-bar')).toHaveClass(/active/);
        await msg.locator('.message-more-btn').click();
        await msg.locator('.message-more-menu-item').click();

        // Shows [deleted] for both
        await expect(userA.page.locator('#messages')).toContainText('[deleted]');
        await expect(userB.page.locator('#messages')).toContainText('[deleted]');
    });

    test('Regular member cannot delete other users messages', async ({ threeUsers }) => {
        const { admin: userA, userB, userC } = threeUsers;
        await userA.page.waitForLoadState('networkidle');

        await createRoom(userA.page, 'no-del-room');
        await inviteUser(userA.page, userB.username);
        await inviteUser(userA.page, userC.username);
        await navigateToRoom(userB.page, 'no-del-room');
        await navigateToRoom(userC.page, 'no-del-room');

        // User C sends a message
        await sendMessage(userC.page, 'User C message');
        await expect(userB.page.locator('#messages')).toContainText('User C message');

        // User B clicks User C's message — should NOT see a "..." menu (not admin/op)
        const msgB = userB.page.locator('.message', { hasText: 'User C message' }).first();
        await msgB.click();

        // User B is not the author and not an admin, so no hover bar buttons should appear for this message
        await expect(msgB.locator('.message-hover-btn')).toHaveCount(0);
    });
});

test.describe('Message history', () => {

    test('Messages persist after page reload', async ({ threeUsers }) => {
        const { admin: userA, userB } = threeUsers;
        await userA.page.waitForLoadState('networkidle');

        await createRoom(userA.page, 'history-room');
        await inviteUser(userA.page, userB.username);

        // User A sends 5 messages
        for (let i = 1; i <= 5; i++) {
            await sendMessage(userA.page, `History msg ${i}`);
        }

        // User B opens the room and sees all 5
        await navigateToRoom(userB.page, 'history-room');
        for (let i = 1; i <= 5; i++) {
            await expect(userB.page.locator('#messages')).toContainText(`History msg ${i}`);
        }

        // User B refreshes — messages still present
        await userB.page.reload();
        await userB.page.waitForLoadState('networkidle');
        await selectRoom(userB.page, 'history-room');
        for (let i = 1; i <= 5; i++) {
            await expect(userB.page.locator('#messages')).toContainText(`History msg ${i}`);
        }
    });
});

test.describe('Read receipts', () => {

    test('Unread badge appears and clears correctly, read position persists', async ({ threeUsers }) => {
        const { admin: userA, userB } = threeUsers;
        await userA.page.waitForLoadState('networkidle');

        // Create two rooms
        await createRoom(userA.page, 'read-room');
        await inviteUser(userA.page, userB.username);
        await createRoom(userA.page, 'other-read-room');
        await inviteUser(userA.page, userB.username);

        // User B navigates to the other room
        await navigateToRoom(userB.page, 'other-read-room');

        // User A sends 3 messages in read-room
        await selectRoom(userA.page, 'read-room');
        await sendMessage(userA.page, 'Unread 1');
        await sendMessage(userA.page, 'Unread 2');
        await sendMessage(userA.page, 'Unread 3');

        // User B reloads to pick up unread counts
        await userB.page.reload();
        await userB.page.waitForLoadState('networkidle');

        // User B sees unread badge
        const badge = userB.page.locator('.room-item[data-room-id="read-room"] .unread-badge');
        await expect(badge).toBeVisible();

        // User B clicks into read-room — badge should clear
        await selectRoom(userB.page, 'read-room');

        // Reload to verify read position persisted
        await userB.page.reload();
        await userB.page.waitForLoadState('networkidle');
        await expect(userB.page.locator('.room-item[data-room-id="read-room"] .unread-badge')).toHaveCount(0);

        // User B switches to other room so read-room isn't auto-selected on reload
        await selectRoom(userB.page, 'other-read-room');

        // User A sends one more — badge reappears
        await sendMessage(userA.page, 'New unread');
        await userB.page.reload();
        await userB.page.waitForLoadState('networkidle');
        const newBadge = userB.page.locator('.room-item[data-room-id="read-room"] .unread-badge');
        await expect(newBadge).toBeVisible();
    });
});
