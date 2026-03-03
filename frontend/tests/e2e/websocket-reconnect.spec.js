/**
 * E2E tests: WebSocket reconnection and room rejoin.
 *
 * Verifies that after a WebSocket disconnect (simulated by closing the WS),
 * the client reconnects and rejoins the current room, continuing to receive
 * real-time messages.
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

/** Send a chat message and verify it appears. */
async function sendMessage(page, text) {
    await page.locator('#message-input').fill(text);
    await page.locator('#message-input').press('Enter');
    await expect(page.locator('#messages')).toContainText(text);
}

/** Invite a user to the current room. */
async function inviteUser(page, username) {
    await page.locator('#message-input').fill(`/invite ${username}`);
    await page.locator('#message-input').press('Enter');
    await expect(page.locator('#messages')).toContainText(`Invited ${username}`);
}

/** Navigate to a room after reload. */
async function navigateToRoom(page, roomName) {
    await page.reload();
    await page.waitForLoadState('networkidle');
    await page.locator(`.room-item[data-room-id="${roomName}"]`).waitFor();
    await page.locator(`.room-item[data-room-id="${roomName}"]`).click();
    await expect(page.locator('#room-content-name')).toHaveText(`#${roomName}`);
}

// ── Tests ───────────────────────────────────────────────────────────────

test.describe('WebSocket reconnection', () => {

    test('client reconnects after WebSocket is forcibly closed and receives new messages', async ({ threeUsers }) => {
        const { admin: userA, userB } = threeUsers;
        await userA.page.waitForLoadState('networkidle');

        await createRoom(userA.page, 'reconnect-room');
        await inviteUser(userA.page, userB.username);
        await navigateToRoom(userB.page, 'reconnect-room');

        // Verify WebSocket works before disconnect
        await sendMessage(userA.page, 'Before disconnect');
        await expect(userB.page.locator('#messages')).toContainText('Before disconnect');

        // Force close User B's WebSocket
        await userB.page.evaluate(() => {
            if (window.ws) window.ws.close();
        });

        // Wait for reconnection (exponential backoff starts at 1s)
        await userB.page.waitForTimeout(3000);

        // User A sends a message after User B's reconnect
        await sendMessage(userA.page, 'After reconnect');

        // User B should receive the message (may need a bit more time for reconnect + rejoin)
        await expect(userB.page.locator('#messages')).toContainText('After reconnect', { timeout: 10_000 });
    });

    test('room selection persists through WebSocket reconnection', async ({ threeUsers }) => {
        const { admin: userA } = threeUsers;
        await userA.page.waitForLoadState('networkidle');

        await createRoom(userA.page, 'persist-ws-room');

        // Verify room is selected
        await expect(userA.page.locator('#room-content-name')).toHaveText('#persist-ws-room');

        // Force close WebSocket
        await userA.page.evaluate(() => {
            if (window.ws) window.ws.close();
        });

        // Wait for reconnection
        await userA.page.waitForTimeout(3000);

        // Room should still be selected
        await expect(userA.page.locator('#room-content-name')).toHaveText('#persist-ws-room');
    });
});

test.describe('WebSocket multi-tab scoping', () => {

    test('room:update events reach all tabs for a user', async ({ threeUsers, baseURL }) => {
        const { admin: userA, userB } = threeUsers;
        await userA.page.waitForLoadState('networkidle');

        // Create room in User A's first tab
        await createRoom(userA.page, 'multi-tab-room');

        // Open a second tab for User A
        const tab2 = await userA.context.newPage();
        await tab2.goto(`${baseURL}/app.html`);
        await tab2.waitForLoadState('networkidle');

        // Both tabs should show the room in the sidebar
        await expect(userA.page.locator('.room-item[data-room-id="multi-tab-room"]')).toBeVisible();
        await expect(tab2.locator('.room-item[data-room-id="multi-tab-room"]')).toBeVisible();

        await tab2.close();
    });
});
