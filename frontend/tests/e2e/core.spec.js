/**
 * E2E tests: Core room management — create, message, invite.
 *
 * Uses the `threeUsers` fixture which provides an admin (User A),
 * User B, and User C — all registered, approved, and logged in to app.html.
 */

import { test, expect } from './fixtures.js';

test.describe('Core room management', () => {

    test('User A creates a room, sends Hello World, invites User B who can see the message', async ({ threeUsers }) => {
        const { admin: userA, userB } = threeUsers;

        // ── User A creates a room ───────────────────────────────────────
        await userA.page.waitForLoadState('networkidle');

        const roomName = `test-room-a`;
        await userA.page.locator('#add-channel-btn').click();
        await userA.page.locator('#new-room-input').fill(roomName);
        await userA.page.locator('#create-room-submit-btn').click();

        await expect(userA.page.locator('#chat-header-name')).toHaveText(`#${roomName}`);
        await userA.page.locator('#message-input').waitFor();

        // ── User A sends "Hello World" ──────────────────────────────────
        await userA.page.locator('#message-input').fill('Hello World');
        await userA.page.locator('#message-input').press('Enter');
        await expect(userA.page.locator('#messages')).toContainText('Hello World');

        // ── User A invites User B ───────────────────────────────────────
        await userA.page.locator('#message-input').fill(`/invite ${userB.username}`);
        await userA.page.locator('#message-input').press('Enter');
        await expect(userA.page.locator('#messages')).toContainText(`Invited ${userB.username}`);

        // ── User B sees the room and the message ────────────────────────
        await userB.page.reload();
        await userB.page.waitForLoadState('networkidle');

        await userB.page.locator(`.room-item[data-room-id="${roomName}"]`).waitFor();
        await userB.page.locator(`.room-item[data-room-id="${roomName}"]`).click();

        await expect(userB.page.locator('#chat-header-name')).toHaveText(`#${roomName}`);
        await expect(userB.page.locator('#messages')).toContainText('Hello World');
    });

    test('User A adds User B and User C via Add User button, both can see existing messages', async ({ threeUsers }) => {
        const { admin: userA, userB, userC } = threeUsers;

        // ── User A creates a room and sends a message ───────────────────
        await userA.page.waitForLoadState('networkidle');

        const roomName = `test-room-add`;
        await userA.page.locator('#add-channel-btn').click();
        await userA.page.locator('#new-room-input').fill(roomName);
        await userA.page.locator('#create-room-submit-btn').click();

        await expect(userA.page.locator('#chat-header-name')).toHaveText(`#${roomName}`);
        await userA.page.locator('#message-input').waitFor();

        await userA.page.locator('#message-input').fill('Hello World');
        await userA.page.locator('#message-input').press('Enter');
        await expect(userA.page.locator('#messages')).toContainText('Hello World');

        // ── User A opens members panel and clicks "+ Add User" ──────────
        // Members panel auto-opens on wide viewports; ensure it's open
        const panel = userA.page.locator('#members-panel');
        if (!(await panel.evaluate(el => el.classList.contains('open')))) {
            await userA.page.locator('#members-toggle-btn').click();
        }
        await expect(panel).toHaveClass(/open/);
        await userA.page.locator('#add-member-btn').click();

        // Wait for the modal's user list to load
        await userA.page.locator('#add-member-user-list .user-select-item').first().waitFor();

        // Check both User B and User C
        await userA.page.locator(`#add-member-user-list .user-select-item input[value="${userB.username}"]`).check();
        await userA.page.locator(`#add-member-user-list .user-select-item input[value="${userC.username}"]`).check();

        // Click "Add Selected"
        await userA.page.locator('#add-member-btn-confirm').click();

        // Wait for modal to close
        await expect(userA.page.locator('#add-member-modal')).not.toHaveClass(/open/);

        // ── User B reloads, sees the room, clicks into it ───────────────
        await userB.page.reload();
        await userB.page.waitForLoadState('networkidle');
        await userB.page.locator(`.room-item[data-room-id="${roomName}"]`).waitFor();
        await userB.page.locator(`.room-item[data-room-id="${roomName}"]`).click();
        await expect(userB.page.locator('#chat-header-name')).toHaveText(`#${roomName}`);
        await expect(userB.page.locator('#messages')).toContainText('Hello World');

        // ── User C reloads, sees the room, clicks into it ───────────────
        await userC.page.reload();
        await userC.page.waitForLoadState('networkidle');
        await userC.page.locator(`.room-item[data-room-id="${roomName}"]`).waitFor();
        await userC.page.locator(`.room-item[data-room-id="${roomName}"]`).click();
        await expect(userC.page.locator('#chat-header-name')).toHaveText(`#${roomName}`);
        await expect(userC.page.locator('#messages')).toContainText('Hello World');
    });
});
