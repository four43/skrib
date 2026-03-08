/**
 * E2E tests: @ mention autocomplete in chat rooms.
 *
 * Tests the autocomplete dropdown that appears when typing "@" in the
 * message input, prioritizing room members over other users.
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

/**
 * Type '@' (or '@partial') via pressSequentially to trigger the input event
 * properly, then wait for the mention dropdown to appear with items.
 */
async function typeMention(page, text = '@') {
    const input = page.locator('#message-input');
    await input.pressSequentially(text);
    const dropdown = page.locator('.mention-dropdown');
    await expect(dropdown).toBeVisible();
    await expect(dropdown.locator('.mention-item').first()).toBeVisible();
    return dropdown;
}

// ── Tests ───────────────────────────────────────────────────────────────

test.describe('@ mention autocomplete', () => {

    test('Typing @ shows the autocomplete dropdown with visible user list', async ({ threeUsers }) => {
        const { admin: userA, userB, userC } = threeUsers;
        await userA.page.waitForLoadState('networkidle');

        await createRoom(userA.page, 'mention-room');
        await inviteUser(userA.page, userB.username);

        const input = userA.page.locator('#message-input');
        await input.pressSequentially('@');

        const dropdown = userA.page.locator('.mention-dropdown');
        await expect(dropdown).toBeVisible();

        // Verify the dropdown has user items
        const items = dropdown.locator('.mention-item');
        await expect(items.first()).toBeVisible();
        const count = await items.count();
        expect(count).toBeGreaterThanOrEqual(2); // at least admin + userB

        // Verify the dropdown is not clipped by overflow:hidden ancestors —
        // its bounding box should be within the viewport and fully visible
        const dropdownBox = await dropdown.boundingBox();
        expect(dropdownBox).not.toBeNull();
        expect(dropdownBox.y).toBeGreaterThanOrEqual(0);
        expect(dropdownBox.height).toBeGreaterThan(0);

        // The dropdown should be positioned above the input
        const inputBox = await input.boundingBox();
        expect(dropdownBox.y + dropdownBox.height).toBeLessThanOrEqual(inputBox.y + 10);

        // Each mention item should display the user's name
        const names = [];
        for (let i = 0; i < count; i++) {
            const text = await items.nth(i).textContent();
            names.push(text);
        }
        // All three users should appear
        expect(names.some(n => n.includes(userA.username))).toBe(true);
        expect(names.some(n => n.includes(userB.username))).toBe(true);
        expect(names.some(n => n.includes(userC.username))).toBe(true);
    });

    test('Dropdown is visible at mobile viewport width', async ({ threeUsers }) => {
        const { admin: userA, userB } = threeUsers;
        await userA.page.waitForLoadState('networkidle');

        // Create room at default viewport, then resize to mobile
        await createRoom(userA.page, 'mobile-mention-room');
        await inviteUser(userA.page, userB.username);
        await userA.page.setViewportSize({ width: 400, height: 700 });

        const input = userA.page.locator('#message-input');
        await input.pressSequentially('@');

        const dropdown = userA.page.locator('.mention-dropdown');
        await expect(dropdown).toBeVisible();
        await expect(dropdown.locator('.mention-item').first()).toBeVisible();

        // Verify the dropdown is not clipped — bounding box should be within viewport
        const dropdownBox = await dropdown.boundingBox();
        expect(dropdownBox).not.toBeNull();
        expect(dropdownBox.y).toBeGreaterThanOrEqual(0);
        expect(dropdownBox.height).toBeGreaterThan(0);
        expect(dropdownBox.width).toBeGreaterThan(100);

        // Items should list users
        const count = await dropdown.locator('.mention-item').count();
        expect(count).toBeGreaterThanOrEqual(2);
    });

    test('Dropdown filters results as user types', async ({ threeUsers }) => {
        const { admin: userA, userB } = threeUsers;
        await userA.page.waitForLoadState('networkidle');

        await createRoom(userA.page, 'filter-room');
        await inviteUser(userA.page, userB.username);

        const input = userA.page.locator('#message-input');

        // Type @ followed by the first few chars of userB's username
        const partialName = userB.username.slice(0, 4);
        await input.pressSequentially(`@${partialName}`);

        const dropdown = userA.page.locator('.mention-dropdown');
        await expect(dropdown).toBeVisible();

        // userB should appear in the results
        await expect(dropdown.locator('.mention-item', { hasText: userB.username })).toBeVisible();
    });

    test('Room members appear before non-members', async ({ threeUsers }) => {
        const { admin: userA, userB, userC } = threeUsers;
        await userA.page.waitForLoadState('networkidle');

        await createRoom(userA.page, 'priority-room');
        // Only invite userB, not userC
        await inviteUser(userA.page, userB.username);

        const dropdown = await typeMention(userA.page, '@');

        // Get all mention items
        const items = dropdown.locator('.mention-item');
        const count = await items.count();
        expect(count).toBeGreaterThanOrEqual(2);

        // Find the indices of userA (room owner), userB (member), and userC (not member)
        const names = [];
        for (let i = 0; i < count; i++) {
            const text = await items.nth(i).textContent();
            names.push(text);
        }

        const indexA = names.findIndex(n => n.includes(userA.username));
        const indexB = names.findIndex(n => n.includes(userB.username));
        const indexC = names.findIndex(n => n.includes(userC.username));

        // Room members (userA, userB) should come before non-member (userC)
        expect(indexA).toBeLessThan(indexC);
        expect(indexB).toBeLessThan(indexC);

        // Non-member should have the "other" badge
        const userCItem = items.nth(indexC);
        await expect(userCItem.locator('.mention-badge')).toBeVisible();

        // Room members should NOT have the "other" badge
        const userBItem = items.nth(indexB);
        await expect(userBItem.locator('.mention-badge')).toHaveCount(0);
    });

    test('Arrow keys navigate the dropdown and Enter selects', async ({ threeUsers }) => {
        const { admin: userA, userB } = threeUsers;
        await userA.page.waitForLoadState('networkidle');

        await createRoom(userA.page, 'keyboard-room');
        await inviteUser(userA.page, userB.username);

        const input = userA.page.locator('#message-input');
        const dropdown = await typeMention(userA.page, '@');

        // First item should be selected by default
        await expect(dropdown.locator('.mention-item').first()).toHaveClass(/selected/);

        // Press ArrowDown to select the next item
        await input.press('ArrowDown');
        await expect(dropdown.locator('.mention-item').nth(1)).toHaveClass(/selected/);
        await expect(dropdown.locator('.mention-item').first()).not.toHaveClass(/selected/);

        // Press ArrowUp to go back
        await input.press('ArrowUp');
        await expect(dropdown.locator('.mention-item').first()).toHaveClass(/selected/);

        // Get the selected username before pressing Enter
        const firstItemName = await dropdown.locator('.mention-item.selected .mention-name').textContent();

        // Press Enter to accept the selection
        await input.press('Enter');

        // Dropdown should dismiss
        await expect(dropdown).toHaveCount(0);

        // Input should contain @username
        const value = await input.inputValue();
        expect(value).toContain(`@`);
        expect(value).toContain(firstItemName.trim());
    });

    test('Tab also accepts the mention selection', async ({ threeUsers }) => {
        const { admin: userA, userB } = threeUsers;
        await userA.page.waitForLoadState('networkidle');

        await createRoom(userA.page, 'tab-room');
        await inviteUser(userA.page, userB.username);

        const input = userA.page.locator('#message-input');
        const dropdown = await typeMention(userA.page, '@');

        const firstItemName = await dropdown.locator('.mention-item.selected .mention-name').textContent();
        await input.press('Tab');

        await expect(dropdown).toHaveCount(0);
        const value = await input.inputValue();
        expect(value).toContain(firstItemName.trim());
    });

    test('Escape dismisses the dropdown without inserting', async ({ threeUsers }) => {
        const { admin: userA } = threeUsers;
        await userA.page.waitForLoadState('networkidle');

        await createRoom(userA.page, 'escape-room');

        const input = userA.page.locator('#message-input');
        await typeMention(userA.page, '@');

        await input.press('Escape');

        const dropdown = userA.page.locator('.mention-dropdown');
        await expect(dropdown).toHaveCount(0);
        // Input should still have just '@'
        const value = await input.inputValue();
        expect(value).toBe('@');
    });

    test('Clicking a dropdown item inserts the mention', async ({ threeUsers }) => {
        const { admin: userA, userB } = threeUsers;
        await userA.page.waitForLoadState('networkidle');

        await createRoom(userA.page, 'click-room');
        await inviteUser(userA.page, userB.username);

        const input = userA.page.locator('#message-input');
        const dropdown = await typeMention(userA.page, '@');

        // Find and click the item for userB
        const userBItem = dropdown.locator('.mention-item', { hasText: userB.username });
        await expect(userBItem).toBeVisible();
        await userBItem.click();

        // Dropdown should dismiss and input should contain @userB.username
        await expect(dropdown).toHaveCount(0);
        const value = await input.inputValue();
        expect(value).toContain(`@${userB.username}`);
    });

    test('Mention works mid-sentence', async ({ threeUsers }) => {
        const { admin: userA, userB } = threeUsers;
        await userA.page.waitForLoadState('networkidle');

        await createRoom(userA.page, 'midsentence-room');
        await inviteUser(userA.page, userB.username);

        const input = userA.page.locator('#message-input');

        // Type "hello " then "@" + partial username
        const partial = userB.username.slice(0, 3);
        await input.pressSequentially(`hello @${partial}`);

        const dropdown = userA.page.locator('.mention-dropdown');
        await expect(dropdown).toBeVisible();
        await expect(dropdown.locator('.mention-item').first()).toBeVisible();

        const selectedName = await dropdown.locator('.mention-item.selected .mention-name').textContent();

        // Select with Enter
        await input.press('Enter');

        await expect(dropdown).toHaveCount(0);
        const value = await input.inputValue();
        expect(value).toMatch(/^hello @/);
        expect(value).toContain(selectedName.trim());
    });

    test('No dropdown when @ is part of an email-like word', async ({ threeUsers }) => {
        const { admin: userA } = threeUsers;
        await userA.page.waitForLoadState('networkidle');

        await createRoom(userA.page, 'noemail-room');

        const input = userA.page.locator('#message-input');
        // Type a word with @ in the middle (no space before @)
        await input.pressSequentially('test@example');

        const dropdown = userA.page.locator('.mention-dropdown');
        await expect(dropdown).toHaveCount(0);
    });

    test('Dropdown dismisses when @ query is deleted', async ({ threeUsers }) => {
        const { admin: userA } = threeUsers;
        await userA.page.waitForLoadState('networkidle');

        await createRoom(userA.page, 'dismiss-room');

        const input = userA.page.locator('#message-input');
        await typeMention(userA.page, '@');

        // Delete the '@' character
        await input.press('Backspace');

        const dropdown = userA.page.locator('.mention-dropdown');
        await expect(dropdown).toHaveCount(0);
    });

    test('Enter sends the message when dropdown is not open', async ({ threeUsers }) => {
        const { admin: userA } = threeUsers;
        await userA.page.waitForLoadState('networkidle');

        await createRoom(userA.page, 'send-room');

        const input = userA.page.locator('#message-input');
        await input.fill('hello world');
        await input.press('Enter');

        // Message should appear in the chat
        await expect(userA.page.locator('#messages')).toContainText('hello world');
    });

    test('Mention is sent as part of the message and visible to other users', async ({ threeUsers }) => {
        const { admin: userA, userB } = threeUsers;
        await userA.page.waitForLoadState('networkidle');

        await createRoom(userA.page, 'sendmention-room');
        await inviteUser(userA.page, userB.username);
        await navigateToRoom(userB.page, 'sendmention-room');

        const input = userA.page.locator('#message-input');

        // Type "hey " then trigger mention
        await input.pressSequentially('hey ');
        const dropdown = await typeMention(userA.page, `@${userB.username.slice(0, 3)}`);

        // Click the userB item to accept the mention
        const userBItem = dropdown.locator('.mention-item', { hasText: userB.username });
        await expect(userBItem).toBeVisible();
        await userBItem.click();

        // Dropdown should be dismissed
        await expect(dropdown).toHaveCount(0);

        // Verify the input contains the mention
        const value = await input.inputValue();
        expect(value).toContain(`@${userB.username}`);

        // Now send the message (Enter sends since dropdown is closed)
        await input.press('Enter');

        // Both users should see the mention in the message
        const expectedText = `hey @${userB.username}`;
        await expect(userA.page.locator('#messages')).toContainText(expectedText);
        await expect(userB.page.locator('#messages')).toContainText(expectedText);
    });
});
