import { test, expect } from './fixtures.js';

/** Generate a unique room name. */
function uniqueRoom(prefix) {
  return `${prefix}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Helper: create a chat room and wait for it to be selected.
 * Returns the room name.
 */
async function createChatRoom(page, name) {
  await page.locator('#add-channel-btn').click();
  await expect(page.locator('#create-room-modal')).toBeVisible();
  await page.locator('input[name="create-room-type"][value="chat"]').waitFor({ timeout: 10000 });
  await page.locator('input[name="create-room-type"][value="chat"]').check();
  await page.locator('#new-room-input').pressSequentially(name, { delay: 20 });
  await page.locator('#create-room-submit-btn').click();
  await expect(page.locator('#chat-header-name')).toContainText(name, { timeout: 10000 });
  return name;
}

/**
 * Helper: clear session and log back in via the login page.
 * Preserves localStorage keys other than session/auth ones (e.g. skrib_ui_prefs).
 */
async function relogin(page) {
  await page.evaluate(() => {
    localStorage.removeItem('session_token');
    localStorage.removeItem('username');
    localStorage.removeItem('role');
  });
  await page.goto('/login.html');
  await page.locator('#login-button').click();
  await page.waitForURL(/.*app\.html/, { timeout: 15000 });
  await expect(page.locator('#chat-view')).toBeVisible({ timeout: 5000 });
}

test.describe('Room Selection Persistence', () => {
  test('re-login restores previously selected room', async ({ registeredUser: { page } }) => {
    // Create two rooms so we can verify the *selected* one is restored, not just the first
    const room1 = uniqueRoom('first');
    const room2 = uniqueRoom('second');
    await createChatRoom(page, room1);
    await createChatRoom(page, room2);

    // room2 is now selected (most recently created). Verify.
    await expect(page.locator('#chat-header-name')).toContainText(room2);

    // Switch back to room1 explicitly
    await page.locator(`.room-item[data-room-id] .room-name`).filter({ hasText: room1 }).click();
    await expect(page.locator('#chat-header-name')).toContainText(room1, { timeout: 5000 });

    // Re-login (preserves skrib_ui_prefs in localStorage)
    await relogin(page);

    // The previously selected room (room1) should be restored
    await expect(page.locator('#chat-header-name')).toContainText(room1, { timeout: 10000 });
  });

  test('first login with rooms but no previous selection shows the first room', async ({ registeredUser: { page } }) => {
    // Create a room so the user has at least one
    const roomName = uniqueRoom('auto');
    await createChatRoom(page, roomName);

    // Clear the lastRoom preference AND session, simulating a fresh login with no prior selection
    await page.evaluate(() => {
      const key = 'skrib_ui_prefs';
      try {
        const prefs = JSON.parse(localStorage.getItem(key) || '{}');
        delete prefs.lastRoom;
        localStorage.setItem(key, JSON.stringify(prefs));
      } catch {}
    });

    await relogin(page);

    // Should auto-select the first (and only) room
    await expect(page.locator('#chat-header-name')).toContainText(roomName, { timeout: 10000 });
  });

  test('first login with no rooms shows blank state', async ({ registeredUser: { page } }) => {
    // Fresh user from registeredUser fixture has no rooms. Clear any lastRoom pref.
    await page.evaluate(() => {
      localStorage.removeItem('skrib_ui_prefs');
    });

    await relogin(page);

    // No room should be selected — header shows placeholder, messages area shows empty state
    await expect(page.locator('#chat-header-name')).toHaveText('[No room selected]', { timeout: 10000 });
    await expect(page.locator('#messages .empty-state')).toBeVisible();
  });
});
