/**
 * E2E tests: / command autocomplete in chat rooms.
 *
 * Tests the autocomplete dropdown that appears when typing "/" in the
 * message input, showing available slash commands with their argument syntax.
 *
 * Uses the `threeUsers` fixture (admin User A, User B, User C).
 */

import { test, expect } from './fixtures.js';

// -- Helpers ------------------------------------------------------------------

async function createRoom(page, roomName) {
    await page.locator('#add-channel-btn').click();
    await page.locator('#new-room-input').fill(roomName);
    await page.locator('#create-room-submit-btn').click();
    await expect(page.locator('#room-content-name')).toHaveText(`#${roomName}`);
    await page.locator('#message-input').waitFor();
}

async function inviteUser(page, username) {
    await page.locator('#message-input').fill(`/invite ${username}`);
    await page.locator('#message-input').press('Enter');
    await expect(page.locator('#messages')).toContainText(`Invited ${username}`);
}

/**
 * Type text via pressSequentially to trigger input events properly,
 * then wait for the command dropdown to appear.
 */
async function typeCommand(page, text = '/') {
    const input = page.locator('#message-input');
    await input.pressSequentially(text);
    const dropdown = page.locator('.command-dropdown');
    await expect(dropdown).toBeVisible();
    await expect(dropdown.locator('.command-item').first()).toBeVisible();
    return dropdown;
}

// -- Tests --------------------------------------------------------------------

test.describe('/ command autocomplete', () => {

    test('Typing / shows the command autocomplete dropdown', async ({ threeUsers }) => {
        const { admin: userA } = threeUsers;
        await userA.page.waitForLoadState('networkidle');

        await createRoom(userA.page, 'cmd-room');

        const input = userA.page.locator('#message-input');
        await input.pressSequentially('/');

        const dropdown = userA.page.locator('.command-dropdown');
        await expect(dropdown).toBeVisible();

        const items = dropdown.locator('.command-item');
        await expect(items.first()).toBeVisible();
        const count = await items.count();
        // Should show all available commands (help, invite, nick, leave, part, kick, topic)
        expect(count).toBeGreaterThanOrEqual(5);
    });

    test('Command items show name, arguments, and description', async ({ threeUsers }) => {
        const { admin: userA } = threeUsers;
        await userA.page.waitForLoadState('networkidle');

        await createRoom(userA.page, 'cmd-detail-room');

        const dropdown = await typeCommand(userA.page, '/');

        // Find the /invite item and check it has argument info
        const inviteItem = dropdown.locator('.command-item', { hasText: 'invite' });
        await expect(inviteItem).toBeVisible();

        // Should show the argument syntax (e.g. "@username")
        await expect(inviteItem.locator('.command-args')).toBeVisible();
        const argsText = await inviteItem.locator('.command-args').textContent();
        expect(argsText).toContain('@username');

        // Should show the description
        await expect(inviteItem.locator('.command-description')).toBeVisible();
    });

    test('Dropdown filters commands as user types', async ({ threeUsers }) => {
        const { admin: userA } = threeUsers;
        await userA.page.waitForLoadState('networkidle');

        await createRoom(userA.page, 'cmd-filter-room');

        const input = userA.page.locator('#message-input');
        await input.pressSequentially('/inv');

        const dropdown = userA.page.locator('.command-dropdown');
        await expect(dropdown).toBeVisible();

        // Only /invite should match
        const items = dropdown.locator('.command-item');
        const count = await items.count();
        expect(count).toBe(1);
        await expect(items.first()).toContainText('invite');
    });

    test('Arrow keys navigate and Enter selects a command', async ({ threeUsers }) => {
        const { admin: userA } = threeUsers;
        await userA.page.waitForLoadState('networkidle');

        await createRoom(userA.page, 'cmd-keyboard-room');

        const input = userA.page.locator('#message-input');
        const dropdown = await typeCommand(userA.page, '/');

        // First item should be selected by default
        await expect(dropdown.locator('.command-item').first()).toHaveClass(/selected/);

        // Arrow down to select second item
        await input.press('ArrowDown');
        await expect(dropdown.locator('.command-item').nth(1)).toHaveClass(/selected/);
        await expect(dropdown.locator('.command-item').first()).not.toHaveClass(/selected/);

        // Arrow up to go back
        await input.press('ArrowUp');
        await expect(dropdown.locator('.command-item').first()).toHaveClass(/selected/);

        // Get the selected command name
        const selectedName = await dropdown.locator('.command-item.selected .command-name').textContent();

        // Press Enter to accept
        await input.press('Enter');

        // Dropdown should dismiss
        await expect(dropdown).toHaveCount(0);

        // Input should contain the selected command with a trailing space
        const value = await input.inputValue();
        expect(value).toMatch(new RegExp(`^/${selectedName.trim()} ?`));
    });

    test('Tab also accepts the command selection', async ({ threeUsers }) => {
        const { admin: userA } = threeUsers;
        await userA.page.waitForLoadState('networkidle');

        await createRoom(userA.page, 'cmd-tab-room');

        const input = userA.page.locator('#message-input');
        const dropdown = await typeCommand(userA.page, '/');

        const selectedName = await dropdown.locator('.command-item.selected .command-name').textContent();
        await input.press('Tab');

        await expect(dropdown).toHaveCount(0);
        const value = await input.inputValue();
        expect(value).toContain(`/${selectedName.trim()}`);
    });

    test('Escape dismisses the command dropdown without inserting', async ({ threeUsers }) => {
        const { admin: userA } = threeUsers;
        await userA.page.waitForLoadState('networkidle');

        await createRoom(userA.page, 'cmd-escape-room');

        const input = userA.page.locator('#message-input');
        await typeCommand(userA.page, '/');

        await input.press('Escape');

        const dropdown = userA.page.locator('.command-dropdown');
        await expect(dropdown).toHaveCount(0);

        // Input should still just have '/'
        const value = await input.inputValue();
        expect(value).toBe('/');
    });

    test('Clicking a command item inserts it', async ({ threeUsers }) => {
        const { admin: userA } = threeUsers;
        await userA.page.waitForLoadState('networkidle');

        await createRoom(userA.page, 'cmd-click-room');

        const input = userA.page.locator('#message-input');
        const dropdown = await typeCommand(userA.page, '/');

        // Find and click the /invite item
        const inviteItem = dropdown.locator('.command-item', { hasText: 'invite' });
        await expect(inviteItem).toBeVisible();
        await inviteItem.click();

        // Dropdown should dismiss and input should contain /invite
        await expect(dropdown).toHaveCount(0);
        const value = await input.inputValue();
        expect(value).toBe('/invite ');
    });

    test('Selecting a command that takes @username, then typing @ triggers mention autocomplete', async ({ threeUsers }) => {
        const { admin: userA, userB } = threeUsers;
        await userA.page.waitForLoadState('networkidle');

        await createRoom(userA.page, 'cmd-chain-room');
        await inviteUser(userA.page, userB.username);

        const input = userA.page.locator('#message-input');

        // Type /inv and select /invite via Enter
        const cmdDropdown = await typeCommand(userA.page, '/inv');
        await expect(cmdDropdown.locator('.command-item', { hasText: 'invite' })).toBeVisible();
        await input.press('Enter');

        // Command dropdown dismissed
        await expect(cmdDropdown).toHaveCount(0);
        let value = await input.inputValue();
        expect(value).toBe('/invite ');

        // Now type @ to trigger mention autocomplete
        await input.pressSequentially('@');
        const mentionDropdown = userA.page.locator('.mention-dropdown');
        await expect(mentionDropdown).toBeVisible();
        await expect(mentionDropdown.locator('.mention-item').first()).toBeVisible();

        // Select userB
        const userBItem = mentionDropdown.locator('.mention-item', { hasText: userB.username });
        await expect(userBItem).toBeVisible();
        await userBItem.click();

        // Mention dropdown dismissed, input has full command
        await expect(mentionDropdown).toHaveCount(0);
        value = await input.inputValue();
        expect(value).toContain(`/invite @${userB.username}`);
    });

    test('No command dropdown when / is not at start of input', async ({ threeUsers }) => {
        const { admin: userA } = threeUsers;
        await userA.page.waitForLoadState('networkidle');

        await createRoom(userA.page, 'cmd-nostart-room');

        const input = userA.page.locator('#message-input');
        // Type some text first, then /
        await input.pressSequentially('hello /inv');

        const dropdown = userA.page.locator('.command-dropdown');
        await expect(dropdown).toHaveCount(0);
    });

    test('Dropdown dismisses when all characters after / are deleted', async ({ threeUsers }) => {
        const { admin: userA } = threeUsers;
        await userA.page.waitForLoadState('networkidle');

        await createRoom(userA.page, 'cmd-dismiss-room');

        const input = userA.page.locator('#message-input');
        await typeCommand(userA.page, '/he');

        // Delete characters back past /
        await input.press('Backspace');
        await input.press('Backspace');
        await input.press('Backspace');

        const dropdown = userA.page.locator('.command-dropdown');
        await expect(dropdown).toHaveCount(0);
    });

    test('No match shows no dropdown', async ({ threeUsers }) => {
        const { admin: userA } = threeUsers;
        await userA.page.waitForLoadState('networkidle');

        await createRoom(userA.page, 'cmd-nomatch-room');

        const input = userA.page.locator('#message-input');
        await input.pressSequentially('/zzzzz');

        const dropdown = userA.page.locator('.command-dropdown');
        await expect(dropdown).toHaveCount(0);
    });

    test('Selecting /kick fills the command and allows @username chaining', async ({ threeUsers }) => {
        const { admin: userA, userB } = threeUsers;
        await userA.page.waitForLoadState('networkidle');

        await createRoom(userA.page, 'cmd-kick-room');
        await inviteUser(userA.page, userB.username);

        const input = userA.page.locator('#message-input');

        // Select /kick command
        const cmdDropdown = await typeCommand(userA.page, '/ki');
        await expect(cmdDropdown.locator('.command-item', { hasText: 'kick' })).toBeVisible();
        await input.press('Enter');

        await expect(cmdDropdown).toHaveCount(0);
        let value = await input.inputValue();
        expect(value).toBe('/kick ');

        // Type @ to get mention autocomplete
        await input.pressSequentially('@');
        const mentionDropdown = userA.page.locator('.mention-dropdown');
        await expect(mentionDropdown).toBeVisible();

        // Select userB
        const userBItem = mentionDropdown.locator('.mention-item', { hasText: userB.username });
        await expect(userBItem).toBeVisible();
        await userBItem.click();

        value = await input.inputValue();
        expect(value).toContain(`/kick @${userB.username}`);
    });
});
