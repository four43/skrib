/**
 * E2E tests: Markdown rendering and multi-line textarea input.
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
}

async function inviteUser(page, username) {
    await page.locator('#message-input').fill(`/invite ${username}`);
    await page.locator('#message-input').press('Enter');
    await expect(page.locator('#messages')).toContainText(`Invited ${username}`);
}

async function navigateToRoom(page, roomName) {
    await page.reload();
    await page.waitForLoadState('networkidle');
    await page.locator(`.room-item[data-room-id="${roomName}"]`).waitFor();
    await page.locator(`.room-item[data-room-id="${roomName}"]`).click();
    await expect(page.locator('#room-content-name')).toHaveText(`#${roomName}`);
}

// ── Markdown rendering tests ────────────────────────────────────────────

test.describe('Markdown rendering', () => {

    test('Bold and italic text renders correctly', async ({ threeUsers }) => {
        const { admin: userA } = threeUsers;
        await userA.page.waitForLoadState('networkidle');
        await createRoom(userA.page, 'md-bold-room');

        await sendMessage(userA.page, '**bold text** and *italic text*');

        const msgText = userA.page.locator('.message-text').last();
        await expect(msgText.locator('strong')).toHaveText('bold text');
        await expect(msgText.locator('em')).toHaveText('italic text');
    });

    test('Inline code renders with code tag', async ({ threeUsers }) => {
        const { admin: userA } = threeUsers;
        await userA.page.waitForLoadState('networkidle');
        await createRoom(userA.page, 'md-code-room');

        await sendMessage(userA.page, 'Use `console.log()` to debug');

        const msgText = userA.page.locator('.message-text').last();
        await expect(msgText.locator('code')).toHaveText('console.log()');
    });

    test('Code block renders with syntax highlighting', async ({ threeUsers }) => {
        const { admin: userA } = threeUsers;
        await userA.page.waitForLoadState('networkidle');
        await createRoom(userA.page, 'md-codeblock-room');

        // Use Shift+Enter for the multiline code block
        const input = userA.page.locator('#message-input');
        await input.fill('');
        await input.type('```python');
        await input.press('Shift+Enter');
        await input.type('import requests');
        await input.press('Shift+Enter');
        await input.type('```');
        await input.press('Enter');

        const msgText = userA.page.locator('.message-text').last();
        await expect(msgText.locator('pre code')).toBeVisible();
        // highlight.js adds a language class
        await expect(msgText.locator('pre code')).toHaveClass(/language-python|hljs/);
    });

    test('Headings render as h1-h3 elements', async ({ threeUsers }) => {
        const { admin: userA } = threeUsers;
        await userA.page.waitForLoadState('networkidle');
        await createRoom(userA.page, 'md-heading-room');

        await sendMessage(userA.page, '# Heading 1');
        await expect(userA.page.locator('.message-text').last().locator('h1')).toHaveText('Heading 1');

        await sendMessage(userA.page, '## Heading 2');
        await expect(userA.page.locator('.message-text').last().locator('h2')).toHaveText('Heading 2');

        await sendMessage(userA.page, '### Heading 3');
        await expect(userA.page.locator('.message-text').last().locator('h3')).toHaveText('Heading 3');
    });

    test('Unordered and ordered lists render correctly', async ({ threeUsers }) => {
        const { admin: userA } = threeUsers;
        await userA.page.waitForLoadState('networkidle');
        await createRoom(userA.page, 'md-list-room');

        // Unordered list
        const input = userA.page.locator('#message-input');
        await input.fill('');
        await input.type('- item one');
        await input.press('Shift+Enter');
        await input.type('- item two');
        await input.press('Enter');

        const ulMsg = userA.page.locator('.message-text').last();
        await expect(ulMsg.locator('ul')).toBeVisible();
        await expect(ulMsg.locator('li')).toHaveCount(2);

        // Ordered list
        await input.fill('');
        await input.type('1. first');
        await input.press('Shift+Enter');
        await input.type('2. second');
        await input.press('Enter');

        const olMsg = userA.page.locator('.message-text').last();
        await expect(olMsg.locator('ol')).toBeVisible();
        await expect(olMsg.locator('li')).toHaveCount(2);
    });

    test('Blockquote renders correctly', async ({ threeUsers }) => {
        const { admin: userA } = threeUsers;
        await userA.page.waitForLoadState('networkidle');
        await createRoom(userA.page, 'md-quote-room');

        await sendMessage(userA.page, '> This is a quote');

        const msgText = userA.page.locator('.message-text').last();
        await expect(msgText.locator('blockquote')).toBeVisible();
        await expect(msgText.locator('blockquote')).toContainText('This is a quote');
    });

    test('Links render as clickable anchor tags with target=_blank', async ({ threeUsers }) => {
        const { admin: userA } = threeUsers;
        await userA.page.waitForLoadState('networkidle');
        await createRoom(userA.page, 'md-link-room');

        await sendMessage(userA.page, 'Check [example](https://example.com)');

        const msgText = userA.page.locator('.message-text').last();
        const link = msgText.locator('a[href="https://example.com"]');
        await expect(link).toBeVisible();
        await expect(link).toHaveAttribute('target', '_blank');
    });

    test('Table renders correctly', async ({ threeUsers }) => {
        const { admin: userA } = threeUsers;
        await userA.page.waitForLoadState('networkidle');
        await createRoom(userA.page, 'md-table-room');

        const input = userA.page.locator('#message-input');
        await input.fill('');
        await input.type('| Name | Value |');
        await input.press('Shift+Enter');
        await input.type('| --- | --- |');
        await input.press('Shift+Enter');
        await input.type('| foo | bar |');
        await input.press('Enter');

        const msgText = userA.page.locator('.message-text').last();
        await expect(msgText.locator('table')).toBeVisible();
        await expect(msgText.locator('th')).toHaveCount(2);
        await expect(msgText.locator('td')).toHaveCount(2);
    });

    test('Horizontal rule renders', async ({ threeUsers }) => {
        const { admin: userA } = threeUsers;
        await userA.page.waitForLoadState('networkidle');
        await createRoom(userA.page, 'md-hr-room');

        await sendMessage(userA.page, '---');

        const msgText = userA.page.locator('.message-text').last();
        await expect(msgText.locator('hr')).toBeVisible();
    });

    test('Strikethrough renders with del tag', async ({ threeUsers }) => {
        const { admin: userA } = threeUsers;
        await userA.page.waitForLoadState('networkidle');
        await createRoom(userA.page, 'md-strike-room');

        await sendMessage(userA.page, '~~deleted~~');

        const msgText = userA.page.locator('.message-text').last();
        await expect(msgText.locator('del')).toHaveText('deleted');
    });

    test('Markdown renders correctly for other users too', async ({ threeUsers }) => {
        const { admin: userA, userB } = threeUsers;
        await userA.page.waitForLoadState('networkidle');
        await createRoom(userA.page, 'md-multi-user');
        await inviteUser(userA.page, userB.username);
        await navigateToRoom(userB.page, 'md-multi-user');

        await sendMessage(userA.page, '**bold** and `code`');

        // User B should also see rendered markdown
        const msgTextB = userB.page.locator('.message-text').last();
        await expect(msgTextB.locator('strong')).toHaveText('bold');
        await expect(msgTextB.locator('code')).toHaveText('code');
    });

    test('Plain text without markdown renders normally', async ({ threeUsers }) => {
        const { admin: userA } = threeUsers;
        await userA.page.waitForLoadState('networkidle');
        await createRoom(userA.page, 'md-plain-room');

        await sendMessage(userA.page, 'Just a regular message');

        const msgText = userA.page.locator('.message-text').last();
        await expect(msgText).toContainText('Just a regular message');
        // Should be wrapped in a <p> by marked but no special elements
        await expect(msgText.locator('strong')).toHaveCount(0);
        await expect(msgText.locator('code')).toHaveCount(0);
    });
});

// ── Helpers for edit mode ────────────────────────────────────────────────

async function startEdit(page, messageText) {
    const textMsg = page.locator('.message', { hasText: messageText }).first();
    const messageId = await textMsg.getAttribute('data-message-id');

    await textMsg.evaluate(el => {
        el.click();
        el.querySelector('.message-hover-btn[title="Edit"]').click();
    });

    const msg = page.locator(`.message[data-message-id="${messageId}"]`);
    const editInput = msg.locator('.message-edit-input');
    await expect(editInput).toBeVisible();
    return { msg, editInput };
}

// ── Multi-line input tests ──────────────────────────────────────────────

test.describe('Multi-line textarea input', () => {

    test('Input is a textarea element', async ({ threeUsers }) => {
        const { admin: userA } = threeUsers;
        await userA.page.waitForLoadState('networkidle');
        await createRoom(userA.page, 'textarea-room');

        const input = userA.page.locator('#message-input');
        const tagName = await input.evaluate(el => el.tagName.toLowerCase());
        expect(tagName).toBe('textarea');
    });

    test('Shift+Enter inserts a newline without sending', async ({ threeUsers }) => {
        const { admin: userA } = threeUsers;
        await userA.page.waitForLoadState('networkidle');
        await createRoom(userA.page, 'shift-enter-room');

        const input = userA.page.locator('#message-input');
        await input.fill('');
        await input.type('line one');
        await input.press('Shift+Enter');
        await input.type('line two');

        // Message should NOT have been sent yet
        const value = await input.inputValue();
        expect(value).toContain('line one');
        expect(value).toContain('line two');
        expect(value).toContain('\n');

        // Now send with Enter
        await input.press('Enter');

        // Both lines appear in the rendered message
        const msgText = userA.page.locator('.message-text').last();
        await expect(msgText).toContainText('line one');
        await expect(msgText).toContainText('line two');
    });

    test('Enter sends the message (not a newline)', async ({ threeUsers }) => {
        const { admin: userA } = threeUsers;
        await userA.page.waitForLoadState('networkidle');
        await createRoom(userA.page, 'enter-send-room');

        const input = userA.page.locator('#message-input');
        await input.fill('hello world');
        await input.press('Enter');

        // Input should be cleared after sending
        await expect(input).toHaveValue('');
        // Message should appear in the chat
        await expect(userA.page.locator('#messages')).toContainText('hello world');
    });

    test('Textarea auto-resizes with content and resets after send', async ({ threeUsers }) => {
        const { admin: userA } = threeUsers;
        await userA.page.waitForLoadState('networkidle');
        await createRoom(userA.page, 'resize-room');

        const input = userA.page.locator('#message-input');

        // Get initial height
        const initialHeight = await input.evaluate(el => el.offsetHeight);

        // Type multiple lines using Shift+Enter
        await input.fill('');
        await input.type('line 1');
        await input.press('Shift+Enter');
        await input.type('line 2');
        await input.press('Shift+Enter');
        await input.type('line 3');

        // Height should have increased
        const expandedHeight = await input.evaluate(el => el.offsetHeight);
        expect(expandedHeight).toBeGreaterThan(initialHeight);

        // Send the message
        await input.press('Enter');

        // Height should reset back
        const resetHeight = await input.evaluate(el => el.offsetHeight);
        expect(resetHeight).toBeLessThanOrEqual(initialHeight + 5); // small tolerance
    });

    test('Textarea does not exceed max height with many lines', async ({ threeUsers }) => {
        const { admin: userA } = threeUsers;
        await userA.page.waitForLoadState('networkidle');
        await createRoom(userA.page, 'maxheight-room');

        const input = userA.page.locator('#message-input');

        // Type 10 lines
        await input.fill('');
        for (let i = 0; i < 10; i++) {
            if (i > 0) await input.press('Shift+Enter');
            await input.type(`line ${i + 1}`);
        }

        // Get the computed line-height and check max height (7 lines)
        const { height, lineHeight } = await input.evaluate(el => ({
            height: el.offsetHeight,
            lineHeight: parseFloat(getComputedStyle(el).lineHeight) || 20,
        }));

        // Max height should be approximately 7 * lineHeight + padding
        // Allow generous tolerance for padding/borders
        const maxExpected = lineHeight * 7 + 40;
        expect(height).toBeLessThanOrEqual(maxExpected);

        // Should have overflow-y: auto when exceeding max
        const overflowY = await input.evaluate(el => el.style.overflowY);
        expect(overflowY).toBe('auto');
    });
});

// ── Edit textarea tests ─────────────────────────────────────────────────

test.describe('Multi-line edit textarea', () => {

    test('Edit input is a textarea element', async ({ threeUsers }) => {
        const { admin: userA } = threeUsers;
        await userA.page.waitForLoadState('networkidle');
        await createRoom(userA.page, 'edit-textarea-room');
        await sendMessage(userA.page, 'editable message');

        const { editInput } = await startEdit(userA.page, 'editable message');
        const tagName = await editInput.evaluate(el => el.tagName.toLowerCase());
        expect(tagName).toBe('textarea');
    });

    test('Edit textarea shows original multi-line content', async ({ threeUsers }) => {
        const { admin: userA } = threeUsers;
        await userA.page.waitForLoadState('networkidle');
        await createRoom(userA.page, 'edit-multiline-room');

        // Send a multi-line message
        const input = userA.page.locator('#message-input');
        await input.fill('');
        await input.type('line one');
        await input.press('Shift+Enter');
        await input.type('line two');
        await input.press('Enter');

        await expect(userA.page.locator('.message-text').last()).toContainText('line one');

        // Enter edit mode — textarea should contain both lines
        const { editInput } = await startEdit(userA.page, 'line one');
        const value = await editInput.inputValue();
        expect(value).toContain('line one');
        expect(value).toContain('line two');
    });

    test('Shift+Enter in edit adds newline, Enter saves', async ({ threeUsers }) => {
        const { admin: userA } = threeUsers;
        await userA.page.waitForLoadState('networkidle');
        await createRoom(userA.page, 'edit-shiftenter-room');
        await sendMessage(userA.page, 'original');

        const { msg, editInput } = await startEdit(userA.page, 'original');

        // Clear and type multi-line content
        await editInput.fill('');
        await editInput.type('new line one');
        await editInput.press('Shift+Enter');
        await editInput.type('new line two');

        // Shift+Enter should NOT have saved — still in edit mode
        await expect(msg).toHaveClass(/editing/);

        // Enter saves the edit
        await editInput.press('Enter');
        await expect(msg).not.toHaveClass(/editing/);

        // Both lines rendered in the message
        const msgText = msg.locator('.message-text');
        await expect(msgText).toContainText('new line one');
        await expect(msgText).toContainText('new line two');
    });

    test('Edit textarea auto-resizes for multi-line content', async ({ threeUsers }) => {
        const { admin: userA } = threeUsers;
        await userA.page.waitForLoadState('networkidle');
        await createRoom(userA.page, 'edit-resize-room');
        await sendMessage(userA.page, 'short msg');

        const { editInput } = await startEdit(userA.page, 'short msg');

        const initialHeight = await editInput.evaluate(el => el.offsetHeight);

        // Type several lines
        await editInput.fill('');
        await editInput.type('line 1');
        await editInput.press('Shift+Enter');
        await editInput.type('line 2');
        await editInput.press('Shift+Enter');
        await editInput.type('line 3');

        const expandedHeight = await editInput.evaluate(el => el.offsetHeight);
        expect(expandedHeight).toBeGreaterThan(initialHeight);
    });
});
