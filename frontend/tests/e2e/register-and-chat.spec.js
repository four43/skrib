import { test, expect } from './fixtures.js';

/** Generate a unique username that fits the 15-char max. */
function uniqueName(prefix) {
  return `${prefix}${Math.random().toString(36).slice(2, 9)}`;
}

test.describe('User Registration', () => {
  test('register a new user and land on chat page', async ({ authenticatedPage: page }) => {
    const username = uniqueName('nu');

    await page.goto('/register.html');
    await page.waitForLoadState('networkidle');

    await page.locator('#register-username').pressSequentially(username, { delay: 30 });
    await page.locator('#recovery-passphrase').fill('TestPass123!');
    await page.locator('#recovery-passphrase-confirm').fill('TestPass123!');
    await page.locator('#register-submit-button').click();

    await page.waitForURL(/.*app\.html/, { timeout: 20000 });

    // Session is stored
    const token = await page.evaluate(() => localStorage.getItem('session_token'));
    expect(token).toBeTruthy();

    // Chat UI is visible
    await expect(page.locator('#chat-view')).toBeVisible();
    await expect(page.locator('#sidebar-username')).toHaveText(username);
  });

  test('register then login with same credential', async ({ authenticatedPage: page }) => {
    const username = uniqueName('lu');

    // Register
    await page.goto('/register.html');
    await page.waitForLoadState('networkidle');
    await page.locator('#register-username').pressSequentially(username, { delay: 30 });
    await page.locator('#recovery-passphrase').fill('TestPass123!');
    await page.locator('#recovery-passphrase-confirm').fill('TestPass123!');
    await page.locator('#register-submit-button').click();
    await page.waitForURL(/.*app\.html/, { timeout: 20000 });

    // Clear session
    await page.evaluate(() => {
      localStorage.removeItem('session_token');
      localStorage.removeItem('username');
      localStorage.removeItem('role');
    });

    // Login
    await page.goto('/login.html');
    await page.locator('#login-button').click();
    await page.waitForURL(/.*app\.html/, { timeout: 15000 });

    const storedUsername = await page.evaluate(() => localStorage.getItem('username'));
    expect(storedUsername).toBe(username);
  });
});

test.describe('Auth Flows', () => {
  test('chat UI loads after login', async ({ authenticatedPage: page }) => {
    const username = uniqueName('cl');

    // Register
    await page.goto('/register.html');
    await page.waitForLoadState('networkidle');
    await page.locator('#register-username').pressSequentially(username, { delay: 30 });
    await page.locator('#recovery-passphrase').fill('TestPass123!');
    await page.locator('#recovery-passphrase-confirm').fill('TestPass123!');
    await page.locator('#register-submit-button').click();
    await page.waitForURL(/.*app\.html/, { timeout: 20000 });

    // Clear session
    await page.evaluate(() => {
      localStorage.removeItem('session_token');
      localStorage.removeItem('username');
      localStorage.removeItem('role');
    });

    // Login
    await page.goto('/login.html');
    await page.locator('#login-button').click();
    await page.waitForURL(/.*app\.html/, { timeout: 15000 });

    // Verify chat UI loaded
    await expect(page.locator('#chat-view')).toBeVisible({ timeout: 5000 });
    const storedUsername = await page.evaluate(() => localStorage.getItem('username'));
    expect(storedUsername).toBe(username);
  });

  test('login page redirects to chat when already authenticated', async ({ registeredUser: { page } }) => {
    // registeredUser fixture already registered and landed on chat
    await page.goto('/login.html');
    await page.waitForURL(/.*app\.html/, { timeout: 5000 });
    await expect(page).toHaveURL(/.*app\.html/);
  });
});

test.describe('Chat Functionality', () => {
  test('send a message in a room', async ({ registeredUser: { page, username } }) => {
    // Create a room first
    await page.locator('#add-channel-btn').click();
    await expect(page.locator('#create-room-modal')).toBeVisible();

    const roomName = `test-${Math.random().toString(36).slice(2, 8)}`;
    await page.locator('#new-room-input').pressSequentially(roomName, { delay: 20 });
    await page.locator('#create-room-submit-btn').click();

    // Wait for room to appear in sidebar and be selected
    await expect(page.locator('#chat-header-name')).not.toHaveText('[No room selected]', { timeout: 10000 });

    // Send a message
    const messageText = 'Hello from E2E test!';
    await page.locator('#message-input').fill(messageText);
    await page.locator('#send-button').click();

    // Message appears in the chat area
    await expect(page.locator('#messages')).toContainText(messageText, { timeout: 5000 });
  });

  test('create a new room', async ({ registeredUser: { page } }) => {
    await page.locator('#add-channel-btn').click();
    await expect(page.locator('#create-room-modal')).toBeVisible();

    const roomName = `room-${Math.random().toString(36).slice(2, 8)}`;
    await page.locator('#new-room-input').pressSequentially(roomName, { delay: 20 });
    await page.locator('#create-room-submit-btn').click();

    // Room appears in sidebar
    await expect(page.locator('#channel-list')).toContainText(roomName, { timeout: 10000 });
  });
});
