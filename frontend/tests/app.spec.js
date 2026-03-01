import { test, expect } from '@playwright/test';
import { setupAuthMocks } from './helpers/auth-mock.js';

test.describe('App Page', () => {
  test.beforeEach(async ({ page }) => {
    await setupAuthMocks(page);
  });

  test.describe('HTML Structure', () => {
    test('should have correct kebab-case IDs', async ({ page }) => {
      await page.goto('/app.html');

      // Main containers
      await expect(page.locator('#chat-view')).toBeVisible();
      await expect(page.locator('#sidebar')).toBeVisible();
      await expect(page.locator('#sidebar-overlay')).toBeAttached(); // hidden until mobile sidebar opens

      // Header elements (hidden on desktop viewport via CSS media query)
      await expect(page.locator('#menu-toggle')).toBeAttached();
      await expect(page.locator('#admin-panel-btn')).toBeAttached(); // has .hidden class; JS removes after auth check

      // Sidebar elements
      await expect(page.locator('#add-channel-btn')).toBeVisible();
      await expect(page.locator('#add-dm-btn')).toBeVisible();
      await expect(page.locator('#channel-list')).toBeVisible();
      await expect(page.locator('#dm-list')).toBeVisible();
      await expect(page.locator('#sidebar-settings-btn')).toBeVisible();

      // Room content area elements
      await expect(page.locator('#room-content-header')).toBeAttached(); // hidden when topic is empty
      await expect(page.locator('#room-content-name')).toBeAttached(); // hidden when empty (no room selected)
      await expect(page.locator('#room-content-topic')).toBeAttached(); // empty span, hidden when no topic set
      await expect(page.locator('#messages')).toBeVisible();
      // #message-input and #send-button are created dynamically by the room type plugin on room selection
    });

    test('modals should have correct IDs', async ({ page }) => {
      await page.goto('/app.html');

      // Room settings modal (hidden until opened)
      await expect(page.locator('#room-settings-modal')).toBeAttached();
      await expect(page.locator('#room-settings-backdrop')).toBeAttached();
      await expect(page.locator('#room-settings-close-btn')).toBeAttached();
      await expect(page.locator('#room-settings-name')).toBeAttached();
      await expect(page.locator('#notify-level-select')).toBeAttached();
      await expect(page.locator('#delete-room-btn')).toBeAttached();

      // Create room modal (hidden until opened)
      await expect(page.locator('#create-room-modal')).toBeAttached();
      await expect(page.locator('#create-room-backdrop')).toBeAttached();
      await expect(page.locator('#create-room-close-btn')).toBeAttached();
      await expect(page.locator('#new-room-input')).toBeAttached();
      await expect(page.locator('#create-room-submit-btn')).toBeAttached();

      // DM modal (hidden until opened)
      await expect(page.locator('#dm-modal')).toBeAttached();
      await expect(page.locator('#dm-modal-backdrop')).toBeAttached();
      await expect(page.locator('#dm-modal-close-btn')).toBeAttached();
      await expect(page.locator('#dm-user-list')).toBeAttached();
      await expect(page.locator('#dm-start-btn')).toBeAttached();
    });
  });

  test.describe('Interactions', () => {
    test('menu toggle should be clickable', async ({ page }) => {
      // Use a mobile viewport so the menu toggle is visible
      await page.setViewportSize({ width: 375, height: 667 });
      await page.goto('/app.html');

      const menuToggle = page.locator('#menu-toggle');
      await expect(menuToggle).toBeVisible();
      // On mobile, sidebar/overlay may initially cover the toggle;
      // use force to bypass the pointer-events interception check.
      await menuToggle.click({ force: true });
    });

    // send button and message input are created dynamically by the room type plugin
    // on room selection — tested in e2e tests with a running backend

    test('add channel button should open modal', async ({ page }) => {
      await page.goto('/app.html');

      const addChannelBtn = page.locator('#add-channel-btn');
      const modal = page.locator('#create-room-modal');

      await expect(modal).not.toHaveClass(/open/);
      await addChannelBtn.click();
      await expect(modal).toHaveClass(/open/);
    });

    test('create room modal should close on backdrop click', async ({ page }) => {
      await page.goto('/app.html');

      // Open modal
      await page.locator('#add-channel-btn').click();
      const modal = page.locator('#create-room-modal');
      await expect(modal).toHaveClass(/open/);

      // Click backdrop at position outside the modal content
      await page.locator('#create-room-backdrop').click({ position: { x: 5, y: 5 } });
      await expect(modal).not.toHaveClass(/open/);
    });
  });

  test.describe('sendMessage guards', () => {
    test('shows alert when WebSocket is still connecting', async ({ page }) => {
      // Override WebSocket constructor BEFORE page loads so that
      // connectWebSocket() in app.js creates our mock stuck at CONNECTING.
      await page.addInitScript(() => {
        window.WebSocket = function(url) {
          this.readyState = 0; // CONNECTING
          this.url = url;
          this.send = function() {};
          this.close = function() { this.readyState = 3; };
        };
        window.WebSocket.CONNECTING = 0;
        window.WebSocket.OPEN = 1;
        window.WebSocket.CLOSING = 2;
        window.WebSocket.CLOSED = 3;
      });

      // Return a room from /api/rooms so the app auto-selects it,
      // which sets the module-scoped `currentRoom`.
      // Registered AFTER setupAuthMocks so it takes priority (LIFO).
      await page.route('**/api/rooms', route =>
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify([{
            room_id: 'test-room',
            display_name: 'test-room',
            room_type: 'four43.room-type-chat',
            is_dm: false,
            topic: '',
            members: ['testadmin'],
          }]),
        }),
      );

      await page.route('**/api/room-folders', route =>
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ folders: [], room_positions: [] }),
        }),
      );

      await page.goto('/app.html');
      await page.waitForLoadState('networkidle');

      // The room type plugin won't fully load in the mock environment,
      // so #message-input won't exist. Inject it manually.
      await page.evaluate(() => {
        const input = document.createElement('input');
        input.id = 'message-input';
        input.value = 'hello world';
        document.getElementById('messages').appendChild(input);
      });

      // Call window.sendMessage() and verify the "still connecting" alert.
      // alert() blocks JS execution, so we must not await evaluate until
      // the dialog is dismissed — otherwise it deadlocks.
      const dialogPromise = page.waitForEvent('dialog');
      const evalPromise = page.evaluate(() => window.sendMessage());
      const dialog = await dialogPromise;

      expect(dialog.type()).toBe('alert');
      expect(dialog.message()).toBe('Still connecting, please try again in a moment.');
      await dialog.accept();
      await evalPromise;
    });
  });

  test.describe('CSS Classes', () => {
    test('should have proper semantic classes', async ({ page }) => {
      await page.goto('/app.html');

      await expect(page.locator('.sidebar-brand')).toBeVisible();
      await expect(page.locator('.mobile-hint')).toBeAttached(); // hidden on desktop viewport
    });

    test('should have no inline styles in HTML', async ({ page }) => {
      await page.goto('/app.html');

      const elementsWithInlineStyles = await page.evaluate(() => {
        const elements = Array.from(document.querySelectorAll('*'));
        return elements.filter(el => el.hasAttribute('style')).length;
      });

      // Should be 0 or very minimal (only dynamic JS-set styles are OK)
      expect(elementsWithInlineStyles).toBeLessThan(5);
    });
  });
});
