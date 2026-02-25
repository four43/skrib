/**
 * E2E tests: Message reactions plugin — add/remove emoji reactions,
 * pill counts, highlights, real-time sync, persistence.
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
 * Click a message to show hover bar, then click an emoji reaction button.
 * Returns the message locator.
 */
async function addReactionViaHoverBar(page, messageText, emoji) {
    const msg = page.locator('.message', { hasText: messageText }).first();
    await msg.click();
    await expect(msg.locator('.message-hover-bar')).toHaveClass(/active/);

    // Click the specific emoji button in the hover bar
    await msg.locator(`.four43-hover-emoji-btn`, { hasText: emoji }).click();
    return msg;
}

/**
 * Get the reaction pill for a specific emoji on a message.
 */
function getReactionPill(page, messageText, emoji) {
    const msg = page.locator('.message', { hasText: messageText }).first();
    return msg.locator(`.four43-reaction-btn[data-emoji="${emoji}"]`);
}

// ── Tests ───────────────────────────────────────────────────────────────

test.describe('Adding and removing reactions', () => {

    test('User can add a reaction via hover bar, pill shows with count 1, highlighted', async ({ threeUsers }) => {
        const { admin: userA, userB, userC } = threeUsers;
        await userA.page.waitForLoadState('networkidle');

        await createRoom(userA.page, 'react-room');
        await inviteUser(userA.page, userB.username);
        await inviteUser(userA.page, userC.username);
        await navigateToRoom(userB.page, 'react-room');
        await navigateToRoom(userC.page, 'react-room');

        await sendMessage(userA.page, 'React to this');

        // User A adds 👍 via hover bar
        await addReactionViaHoverBar(userA.page, 'React to this', '👍');

        // Pill appears with count 1 and is highlighted for User A
        const pillA = getReactionPill(userA.page, 'React to this', '👍');
        await expect(pillA).toBeVisible();
        await expect(pillA.locator('.count')).toHaveText('1');
        await expect(pillA).toHaveClass(/reacted/);

        // User B and User C see the pill in real-time (not highlighted for them)
        const pillB = getReactionPill(userB.page, 'React to this', '👍');
        await expect(pillB).toBeVisible();
        await expect(pillB.locator('.count')).toHaveText('1');
        await expect(pillB).not.toHaveClass(/reacted/);

        const pillC = getReactionPill(userC.page, 'React to this', '👍');
        await expect(pillC).toBeVisible();
        await expect(pillC.locator('.count')).toHaveText('1');
    });

    test('Second user adds same reaction, count goes to 2, toggle removes', async ({ threeUsers }) => {
        const { admin: userA, userB } = threeUsers;
        await userA.page.waitForLoadState('networkidle');

        await createRoom(userA.page, 'react-toggle');
        await inviteUser(userA.page, userB.username);
        await navigateToRoom(userB.page, 'react-toggle');

        await sendMessage(userA.page, 'Toggle test');

        // User A adds 👍
        await addReactionViaHoverBar(userA.page, 'Toggle test', '👍');
        await expect(getReactionPill(userA.page, 'Toggle test', '👍').locator('.count')).toHaveText('1');

        // User B adds 👍 by clicking the existing pill
        const pillB = getReactionPill(userB.page, 'Toggle test', '👍');
        await expect(pillB).toBeVisible();
        await pillB.click();

        // Count goes to 2 for both users
        await expect(getReactionPill(userA.page, 'Toggle test', '👍').locator('.count')).toHaveText('2');
        await expect(getReactionPill(userB.page, 'Toggle test', '👍').locator('.count')).toHaveText('2');
        await expect(getReactionPill(userB.page, 'Toggle test', '👍')).toHaveClass(/reacted/);

        // User A toggles off by clicking the pill
        await getReactionPill(userA.page, 'Toggle test', '👍').click();

        // Count drops to 1, pill no longer highlighted for User A
        await expect(getReactionPill(userA.page, 'Toggle test', '👍').locator('.count')).toHaveText('1');
        await expect(getReactionPill(userA.page, 'Toggle test', '👍')).not.toHaveClass(/reacted/);

        // User B toggles off — pill should disappear entirely
        await getReactionPill(userB.page, 'Toggle test', '👍').click();
        await expect(getReactionPill(userA.page, 'Toggle test', '👍')).toHaveCount(0);
        await expect(getReactionPill(userB.page, 'Toggle test', '👍')).toHaveCount(0);
    });
});

test.describe('Multiple reactions', () => {

    test('Multiple different emojis on one message, each with correct count', async ({ threeUsers }) => {
        const { admin: userA, userB, userC } = threeUsers;
        await userA.page.waitForLoadState('networkidle');

        await createRoom(userA.page, 'multi-react');
        await inviteUser(userA.page, userB.username);
        await inviteUser(userA.page, userC.username);
        await navigateToRoom(userB.page, 'multi-react');
        await navigateToRoom(userC.page, 'multi-react');

        await sendMessage(userA.page, 'Multi-react message');

        // User A adds 👍
        await addReactionViaHoverBar(userA.page, 'Multi-react message', '👍');

        // User B adds ❤️ via hover bar
        await addReactionViaHoverBar(userB.page, 'Multi-react message', '❤️');

        // User C adds 👍 (via pill) and 😂 (via hover bar)
        await expect(getReactionPill(userC.page, 'Multi-react message', '👍')).toBeVisible();
        await getReactionPill(userC.page, 'Multi-react message', '👍').click();
        await addReactionViaHoverBar(userC.page, 'Multi-react message', '😂');

        // All users should see: 👍 2, ❤️ 1, 😂 1
        for (const user of [userA, userB, userC]) {
            await expect(getReactionPill(user.page, 'Multi-react message', '👍').locator('.count')).toHaveText('2');
            await expect(getReactionPill(user.page, 'Multi-react message', '❤️').locator('.count')).toHaveText('1');
            await expect(getReactionPill(user.page, 'Multi-react message', '😂').locator('.count')).toHaveText('1');
        }

        // User A's 👍 is highlighted, ❤️ is not
        await expect(getReactionPill(userA.page, 'Multi-react message', '👍')).toHaveClass(/reacted/);
        await expect(getReactionPill(userA.page, 'Multi-react message', '❤️')).not.toHaveClass(/reacted/);

        // User C's 👍 and 😂 are highlighted, ❤️ is not
        await expect(getReactionPill(userC.page, 'Multi-react message', '👍')).toHaveClass(/reacted/);
        await expect(getReactionPill(userC.page, 'Multi-react message', '😂')).toHaveClass(/reacted/);
        await expect(getReactionPill(userC.page, 'Multi-react message', '❤️')).not.toHaveClass(/reacted/);
    });
});

test.describe('Reaction persistence', () => {

    test('Reactions persist after page refresh', async ({ threeUsers }) => {
        const { admin: userA } = threeUsers;
        await userA.page.waitForLoadState('networkidle');

        await createRoom(userA.page, 'react-persist');
        await sendMessage(userA.page, 'Persistent reactions');

        // Add a reaction
        await addReactionViaHoverBar(userA.page, 'Persistent reactions', '🎉');
        await expect(getReactionPill(userA.page, 'Persistent reactions', '🎉')).toBeVisible();

        // Refresh and re-enter room
        await userA.page.reload();
        await userA.page.waitForLoadState('networkidle');
        await selectRoom(userA.page, 'react-persist');

        // Reaction still visible
        await expect(getReactionPill(userA.page, 'Persistent reactions', '🎉')).toBeVisible();
        await expect(getReactionPill(userA.page, 'Persistent reactions', '🎉').locator('.count')).toHaveText('1');
        await expect(getReactionPill(userA.page, 'Persistent reactions', '🎉')).toHaveClass(/reacted/);
    });
});

test.describe('Real-time reaction sync', () => {

    test('Reactions from other users appear in real-time', async ({ threeUsers }) => {
        const { admin: userA, userB } = threeUsers;
        await userA.page.waitForLoadState('networkidle');

        await createRoom(userA.page, 'react-realtime');
        await inviteUser(userA.page, userB.username);
        await navigateToRoom(userB.page, 'react-realtime');

        // User B sends a message
        await sendMessage(userB.page, 'React in real-time');
        await expect(userA.page.locator('#messages')).toContainText('React in real-time');

        // User A adds a reaction — User B sees it without refreshing
        await addReactionViaHoverBar(userA.page, 'React in real-time', '🚀');
        await expect(getReactionPill(userB.page, 'React in real-time', '🚀')).toBeVisible();
        await expect(getReactionPill(userB.page, 'React in real-time', '🚀').locator('.count')).toHaveText('1');
    });
});
