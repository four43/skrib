import { test, expect } from './fixtures.js';

/**
 * Register a second user using the same page/authenticator,
 * then restore the original user's session and return to chat.
 *
 * The virtual WebAuthn authenticator supports multiple credentials,
 * so both users get distinct passkeys on the same page.
 */
async function registerSecondUser(page) {
    const user2name = `tu${Math.random().toString(36).slice(2, 9)}`;

    // Save current user's session
    const savedSession = await page.evaluate(() => ({
        token: localStorage.getItem('session_token'),
        username: localStorage.getItem('username'),
        role: localStorage.getItem('role'),
    }));

    // Register user2
    await page.goto('/register.html');
    await page.waitForLoadState('networkidle');
    await page.locator('#register-username').pressSequentially(user2name, { delay: 30 });
    await expect(page.locator('#register-username')).not.toHaveClass(/invalid/);
    await page.locator('#register-submit-button').click();
    await page.waitForURL(/.*chat\.html/, { timeout: 20000 });

    // Restore original user's session
    await page.evaluate((s) => {
        localStorage.setItem('session_token', s.token);
        localStorage.setItem('username', s.username);
        if (s.role) localStorage.setItem('role', s.role);
    }, savedSession);
    await page.goto('/chat.html');
    await page.waitForLoadState('networkidle');

    return user2name;
}

test.describe('DM Chat Room Type', () => {
    test('create a chat DM and verify chat UI', async ({ registeredUser: { page, username } }) => {
        const otherUser = await registerSecondUser(page);

        // Open DM modal
        await page.locator('#add-dm-btn').click();
        await expect(page.locator('#dm-modal')).toHaveClass(/open/, { timeout: 5000 });

        // Select "chat" room type
        await page.locator('input[name="dm-room-type"][value="chat"]').check();

        // Wait for user list to load and select the other user
        await expect(page.locator(`#dm-user-list input[value="${otherUser}"]`)).toBeVisible({ timeout: 5000 });
        await page.locator(`#dm-user-list input[value="${otherUser}"]`).check();

        // Start button should appear
        await expect(page.locator('#dm-start-btn')).toBeVisible();

        // Click start
        await page.locator('#dm-start-btn').click();

        // Wait for DM to be selected -- header shows the other user's name
        await expect(page.locator('#chat-header-name')).toContainText(otherUser, { timeout: 10000 });

        // Chat plugin renders #message-input
        await expect(page.locator('#message-input')).toBeVisible({ timeout: 5000 });
    });
});

test.describe('DM Todo Room Type', () => {
    test('create a todo DM and verify todo UI', async ({ registeredUser: { page, username } }) => {
        const otherUser = await registerSecondUser(page);

        // Open DM modal
        await page.locator('#add-dm-btn').click();
        await expect(page.locator('#dm-modal')).toHaveClass(/open/, { timeout: 5000 });

        // Select "todo" room type
        await page.locator('input[name="dm-room-type"][value="todo"]').check();

        // Wait for user list to load and select the other user
        await expect(page.locator(`#dm-user-list input[value="${otherUser}"]`)).toBeVisible({ timeout: 5000 });
        await page.locator(`#dm-user-list input[value="${otherUser}"]`).check();

        // Start button should appear
        await expect(page.locator('#dm-start-btn')).toBeVisible();

        // Click start
        await page.locator('#dm-start-btn').click();

        // Wait for DM to be selected -- header shows the other user's name
        await expect(page.locator('#chat-header-name')).toContainText(otherUser, { timeout: 10000 });

        // Todo plugin renders its own UI
        await expect(page.locator('.todo-add-title')).toBeVisible({ timeout: 5000 });
    });
});
