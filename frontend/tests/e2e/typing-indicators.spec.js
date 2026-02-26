/**
 * E2E tests: Typing indicator plugin — indicator display, timeout,
 * self-suppression, room switch clearing.
 *
 * Uses the `threeUsers` fixture (admin User A, User B, User C).
 */

import { test, expect } from './fixtures.js';

// ── Helpers ─────────────────────────────────────────────────────────────

async function createRoom(page, roomName) {
    await page.locator('#add-channel-btn').click();
    await page.locator('#new-room-input').fill(roomName);
    await page.locator('#create-room-submit-btn').click();
    await expect(page.locator('#room-content-name')).toHaveText(`#${roomName}`);
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
    await expect(page.locator('#room-content-name')).toHaveText(`#${roomName}`);
}

async function selectRoom(page, roomName) {
    await page.locator(`.room-item[data-room-id="${roomName}"]`).click();
    await expect(page.locator('#room-content-name')).toHaveText(`#${roomName}`);
}

const TYPING_INDICATOR = '#four43-chat-typing-indicator';

// ── Tests ───────────────────────────────────────────────────────────────

test.describe('Typing indicators', () => {

    test('Typing indicator appears for other user, not for self', async ({ threeUsers }) => {
        const { admin: userA, userB } = threeUsers;
        await userA.page.waitForLoadState('networkidle');

        await createRoom(userA.page, 'typing-room');
        await inviteUser(userA.page, userB.username);
        await navigateToRoom(userB.page, 'typing-room');

        // User A types without sending
        await userA.page.locator('#message-input').pressSequentially('hello', { delay: 50 });

        // User B sees typing indicator
        await expect(userB.page.locator(TYPING_INDICATOR)).toBeVisible();
        await expect(userB.page.locator(TYPING_INDICATOR)).toContainText('is typing');

        // User A does NOT see their own typing indicator
        await expect(userA.page.locator(TYPING_INDICATOR)).not.toBeVisible();
    });

    test('Typing indicator disappears when message is sent', async ({ threeUsers }) => {
        const { admin: userA, userB } = threeUsers;
        await userA.page.waitForLoadState('networkidle');

        await createRoom(userA.page, 'typing-send');
        await inviteUser(userA.page, userB.username);
        await navigateToRoom(userB.page, 'typing-send');

        // User A types
        await userA.page.locator('#message-input').pressSequentially('test msg', { delay: 50 });

        // User B sees indicator
        await expect(userB.page.locator(TYPING_INDICATOR)).toBeVisible();

        // User A sends the message
        await userA.page.locator('#message-input').press('Enter');
        await expect(userB.page.locator('#messages')).toContainText('test msg');

        // Indicator disappears for User B
        await expect(userB.page.locator(TYPING_INDICATOR)).not.toBeVisible();
    });

    test('Typing indicator disappears after timeout (~3 seconds)', async ({ threeUsers }) => {
        const { admin: userA, userB } = threeUsers;
        await userA.page.waitForLoadState('networkidle');

        await createRoom(userA.page, 'typing-timeout');
        await inviteUser(userA.page, userB.username);
        await navigateToRoom(userB.page, 'typing-timeout');

        // User A types a single character, then stops
        await userA.page.locator('#message-input').pressSequentially('x', { delay: 50 });

        // User B sees indicator
        await expect(userB.page.locator(TYPING_INDICATOR)).toBeVisible();

        // Wait for the timeout (3 seconds + buffer)
        await userB.page.waitForTimeout(4000);

        // Indicator should disappear
        await expect(userB.page.locator(TYPING_INDICATOR)).not.toBeVisible();
    });

    test('Both users typing simultaneously, each sees the other', async ({ threeUsers }) => {
        const { admin: userA, userB } = threeUsers;
        await userA.page.waitForLoadState('networkidle');

        await createRoom(userA.page, 'typing-both');
        await inviteUser(userA.page, userB.username);
        await navigateToRoom(userB.page, 'typing-both');

        // Both start typing
        await userA.page.locator('#message-input').pressSequentially('from A', { delay: 50 });
        await userB.page.locator('#message-input').pressSequentially('from B', { delay: 50 });

        // Each sees the other's indicator
        await expect(userB.page.locator(TYPING_INDICATOR)).toBeVisible();
        await expect(userA.page.locator(TYPING_INDICATOR)).toBeVisible();
    });

    test('Typing indicator clears when user switches rooms', async ({ threeUsers }) => {
        const { admin: userA, userB } = threeUsers;
        await userA.page.waitForLoadState('networkidle');

        await createRoom(userA.page, 'typing-switch');
        await inviteUser(userA.page, userB.username);
        await createRoom(userA.page, 'other-typing-room');

        await navigateToRoom(userB.page, 'typing-switch');

        // User A navigates to typing-switch and types
        await selectRoom(userA.page, 'typing-switch');
        await userA.page.locator('#message-input').pressSequentially('typing here', { delay: 50 });

        // User B sees indicator
        await expect(userB.page.locator(TYPING_INDICATOR)).toBeVisible();

        // User A switches to another room
        await selectRoom(userA.page, 'other-typing-room');

        // Indicator clears for User B
        await expect(userB.page.locator(TYPING_INDICATOR)).not.toBeVisible();
    });
});
