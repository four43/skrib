/**
 * E2E tests for inline emoji autocomplete.
 *
 * Tests the `:` trigger in chat input that shows a filterable dropdown
 * of emoji, with keyboard navigation and insertion as `:shortcode:`.
 */

import { test, expect } from './fixtures.js';

/**
 * Helper: create a chat room via the UI and wait for message input.
 */
async function createRoomAndEnter(page) {
    const roomName = `emoji-${Date.now()}`;
    await page.locator('#add-channel-btn').click();
    await page.locator('#new-room-input').fill(roomName);
    await page.locator('#create-room-submit-btn').click();
    await expect(page.locator('#room-content-name')).toHaveText(`#${roomName}`);
    await page.locator('#message-input').waitFor({ state: 'visible', timeout: 5000 });
    return roomName;
}

test.describe('Inline emoji autocomplete', () => {

    test('typing :sm shows emoji dropdown with matching results', async ({ registeredUser }) => {
        const { page } = registeredUser;
        await createRoomAndEnter(page);

        const input = page.locator('#message-input');
        await input.fill('');
        await input.type(':sm', { delay: 50 });

        // Dropdown should appear with emoji matching "sm"
        const dropdown = page.locator('.emoji-inline-dropdown');
        await expect(dropdown).toBeVisible({ timeout: 3000 });

        // Should contain at least one result with "sm" in the shortcode
        const items = dropdown.locator('.emoji-inline-item');
        await expect(items.first()).toBeVisible();
        const firstShortcode = await items.first().locator('.emoji-inline-shortcode').textContent();
        expect(firstShortcode.toLowerCase()).toContain('sm');
    });

    test('selecting emoji with Enter inserts :shortcode: markdown', async ({ registeredUser }) => {
        const { page } = registeredUser;
        await createRoomAndEnter(page);

        const input = page.locator('#message-input');
        await input.fill('');
        await input.type(':grinning', { delay: 30 });

        // Wait for dropdown
        const dropdown = page.locator('.emoji-inline-dropdown');
        await expect(dropdown).toBeVisible({ timeout: 3000 });

        // Press Enter to accept the first result
        await input.press('Enter');

        // Input should contain :shortcode: format
        const value = await input.inputValue();
        expect(value).toMatch(/^:[a-z0-9-]+:\s/);

        // Dropdown should be dismissed
        await expect(dropdown).not.toBeVisible();
    });

    test('arrow keys navigate through emoji results', async ({ registeredUser }) => {
        const { page } = registeredUser;
        await createRoomAndEnter(page);

        const input = page.locator('#message-input');
        await input.fill('');
        await input.type(':fa', { delay: 50 });

        const dropdown = page.locator('.emoji-inline-dropdown');
        await expect(dropdown).toBeVisible({ timeout: 3000 });

        // Best match (data-index=0) is at the bottom of the dropdown, closest to input
        const item0 = dropdown.locator('.emoji-inline-item[data-index="0"]');
        const item1 = dropdown.locator('.emoji-inline-item[data-index="1"]');
        await expect(item0).toHaveClass(/selected/);

        // Press ArrowUp — moves selection visually upward to index 1 (worse match)
        await input.press('ArrowUp');
        await expect(item1).toHaveClass(/selected/);
        await expect(item0).not.toHaveClass(/selected/);

        // Press ArrowDown — moves selection visually downward back to index 0 (best match)
        await input.press('ArrowDown');
        await expect(item0).toHaveClass(/selected/);
    });

    test('Escape dismisses the emoji dropdown', async ({ registeredUser }) => {
        const { page } = registeredUser;
        await createRoomAndEnter(page);

        const input = page.locator('#message-input');
        await input.fill('');
        await input.type(':sm', { delay: 50 });

        const dropdown = page.locator('.emoji-inline-dropdown');
        await expect(dropdown).toBeVisible({ timeout: 3000 });

        await input.press('Escape');
        await expect(dropdown).not.toBeVisible();
    });

    test('clicking an emoji result inserts :shortcode:', async ({ registeredUser }) => {
        const { page } = registeredUser;
        await createRoomAndEnter(page);

        const input = page.locator('#message-input');
        await input.fill('');
        await input.type(':grin', { delay: 50 });

        const dropdown = page.locator('.emoji-inline-dropdown');
        await expect(dropdown).toBeVisible({ timeout: 3000 });

        // Click the first result
        await dropdown.locator('.emoji-inline-item').first().click();

        const value = await input.inputValue();
        expect(value).toMatch(/^:[a-z0-9-]+:\s/);
        await expect(dropdown).not.toBeVisible();
    });

    test('dropdown does not appear with less than 2 characters after :', async ({ registeredUser }) => {
        const { page } = registeredUser;
        await createRoomAndEnter(page);

        const input = page.locator('#message-input');
        await input.fill('');
        await input.type(':s', { delay: 50 });

        // Dropdown should NOT appear with only 1 char
        const dropdown = page.locator('.emoji-inline-dropdown');
        await expect(dropdown).not.toBeVisible({ timeout: 1000 });
    });

    test('emoji inserted mid-sentence preserves surrounding text', async ({ registeredUser }) => {
        const { page } = registeredUser;
        await createRoomAndEnter(page);

        const input = page.locator('#message-input');
        await input.fill('hello ');
        // Move cursor to end and type emoji trigger
        await input.press('End');
        await input.type(':grinning', { delay: 30 });

        const dropdown = page.locator('.emoji-inline-dropdown');
        await expect(dropdown).toBeVisible({ timeout: 3000 });

        await input.press('Enter');

        const value = await input.inputValue();
        // Should start with "hello " and contain the shortcode
        expect(value).toMatch(/^hello\s:[a-z0-9-]+:\s/);
    });

    test('Tab key also accepts the selected emoji', async ({ registeredUser }) => {
        const { page } = registeredUser;
        await createRoomAndEnter(page);

        const input = page.locator('#message-input');
        await input.fill('');
        await input.type(':grin', { delay: 50 });

        const dropdown = page.locator('.emoji-inline-dropdown');
        await expect(dropdown).toBeVisible({ timeout: 3000 });

        await input.press('Tab');

        const value = await input.inputValue();
        expect(value).toMatch(/^:[a-z0-9-]+:\s/);
        await expect(dropdown).not.toBeVisible();
    });

    test('sent :shortcode: renders as emoji in the message', async ({ registeredUser }) => {
        const { page } = registeredUser;
        await createRoomAndEnter(page);

        const input = page.locator('#message-input');
        await input.fill(':grinning-face: hello');
        await input.press('Enter');

        // Wait for the message to appear in the chat
        const messages = page.locator('#messages .message-text');
        const lastMessage = messages.last();
        await expect(lastMessage).toBeVisible({ timeout: 5000 });

        // Should contain an emoji span (resolved shortcode), not raw `:grinning-face:`
        const emojiSpan = lastMessage.locator('.emoji-shortcode');
        await expect(emojiSpan).toBeVisible({ timeout: 3000 });

        // The span should contain the actual emoji character
        const emojiText = await emojiSpan.textContent();
        expect(emojiText.length).toBeGreaterThan(0);
        // Raw shortcode text should NOT appear
        await expect(lastMessage).not.toContainText(':grinning-face:');
    });

    test('unknown :shortcode: is left as-is in the message', async ({ registeredUser }) => {
        const { page } = registeredUser;
        await createRoomAndEnter(page);

        const input = page.locator('#message-input');
        await input.fill(':nonexistent-emoji-xyz: test');
        await input.press('Enter');

        const messages = page.locator('#messages .message-text');
        const lastMessage = messages.last();
        await expect(lastMessage).toContainText(':nonexistent-emoji-xyz:', { timeout: 5000 });
    });
});
