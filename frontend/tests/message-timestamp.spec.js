import { test, expect } from '@playwright/test';
import { setupAuthMocks } from './helpers/auth-mock.js';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_DIR = path.resolve(__dirname, '../../backend/plugins/four43.room-type-chat/frontend');

const TEST_ROOM_ID = 'test-room';

/** Known UTC timestamp: 2026-02-22T15:30:00Z */
const UTC_TIMESTAMP = '2026-02-22T15:30:00+00:00';

const MOCK_ROOM = {
  room_id: TEST_ROOM_ID,
  room_type: 'chat',
  display_name: 'Test Room',
  is_dm: false,
  topic: '',
  members: ['testadmin'],
  unread_count: 0,
};

const MOCK_MESSAGE = {
  id: 1,
  room_id: TEST_ROOM_ID,
  username: 'testadmin',
  content: 'Hello world',
  content_type: 'text',
  key_epoch: null,
  timestamp: UTC_TIMESTAMP,
  edited_at: null,
  deleted: 0,
};

const MOCK_PLUGINS = [
  {
    id: 'four43.room-type-chat',
    name: 'Chat Room',
    version: '1.0.0',
    description: 'Chat rooms',
    entry: 'frontend/plugin.js',
    enabled: true,
    room_types: ['chat'],
    styles: ['/api/plugins/four43.room-type-chat/file/frontend/plugin.css'],
  },
];

/**
 * Extend setupAuthMocks with room, plugin, and message mocking.
 */
async function setupChatMocks(page) {
  await setupAuthMocks(page);

  // Rooms list
  await page.route('**/api/rooms', route =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([MOCK_ROOM]),
    }),
  );

  // Room keys (none — messages are unencrypted)
  await page.route('**/api/rooms/*/keys', route =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([]),
    }),
  );

  // Plugin list
  await page.route('**/api/plugins', route => {
    // Only intercept the exact list endpoint, not file sub-paths
    if (route.request().url().endsWith('/api/plugins') ||
        route.request().url().endsWith('/api/plugins/')) {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(MOCK_PLUGINS),
      });
    }
    return route.continue();
  });

  // Serve plugin JS from disk
  await page.route('**/api/plugins/four43.room-type-chat/file/frontend/plugin.js', route =>
    route.fulfill({ path: path.join(PLUGIN_DIR, 'plugin.js'), contentType: 'application/javascript' }),
  );

  // Serve plugin CSS from disk
  await page.route('**/api/plugins/four43.room-type-chat/file/frontend/plugin.css', route =>
    route.fulfill({ path: path.join(PLUGIN_DIR, 'plugin.css'), contentType: 'text/css' }),
  );

  // Messages for the test room
  await page.route(`**/api/plugins/four43.room-type-chat/rooms/${TEST_ROOM_ID}/messages*`, route =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([MOCK_MESSAGE]),
    }),
  );

  // Mark-as-read
  await page.route(`**/api/plugins/four43.room-type-chat/rooms/${TEST_ROOM_ID}/read`, route =>
    route.fulfill({ status: 200, contentType: 'application/json', body: '{}' }),
  );
}

test.describe('Message timestamps', () => {
  test('displays message time in the browser local timezone, not UTC', async ({ browser }) => {
    // Create a context with a non-UTC timezone so we can detect the difference.
    // America/New_York is UTC-5 (EST) in February.
    const context = await browser.newContext({ timezoneId: 'America/New_York' });
    const page = await context.newPage();

    await setupChatMocks(page);

    // Navigate with hash pointing to test room so it auto-selects
    await page.goto(`/app.html#/r/${TEST_ROOM_ID}`);

    // Wait for the message to render
    const timestamp = page.locator('.message .timestamp');
    await expect(timestamp).toBeVisible({ timeout: 5000 });

    const timeText = await timestamp.textContent();

    // UTC time is 15:30 (3:30 PM). In America/New_York (EST, UTC-5) that's 10:30 AM.
    // toLocaleTimeString() output varies by locale but should contain "10:30"
    // and must NOT contain "15:30" or "3:30" (the UTC values).
    expect(timeText).toContain('10:30');
    expect(timeText).not.toContain('15:30');
    expect(timeText).not.toContain('3:30');

    await context.close();
  });

  test('displays message time correctly in a different timezone', async ({ browser }) => {
    // Asia/Tokyo is UTC+9 year-round (no DST).
    // 15:30 UTC → 00:30 next day in Tokyo.
    const context = await browser.newContext({ timezoneId: 'Asia/Tokyo' });
    const page = await context.newPage();

    await setupChatMocks(page);

    await page.goto(`/app.html#/r/${TEST_ROOM_ID}`);

    const timestamp = page.locator('.message .timestamp');
    await expect(timestamp).toBeVisible({ timeout: 5000 });

    const timeText = await timestamp.textContent();

    // 15:30 UTC + 9h = 00:30 (next day). Should contain "0:30" or "12:30 AM".
    // Must NOT show "15:30" or "3:30" (UTC values).
    expect(timeText).not.toContain('15:30');
    expect(timeText).not.toContain('3:30');
    // Verify it shows either "0:30" (24h) or "12:30" (12h AM)
    const showsMidnight = timeText.includes('0:30') || timeText.includes('12:30');
    expect(showsMidnight).toBe(true);

    await context.close();
  });
});
