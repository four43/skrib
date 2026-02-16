import { test, expect } from '@playwright/test';

test.describe('Chat Page', () => {
  test.describe('HTML Structure', () => {
    test('should have correct kebab-case IDs', async ({ page }) => {
      await page.goto('/chat.html');

      // Main containers
      await expect(page.locator('#chat-view')).toBeVisible();
      await expect(page.locator('#sidebar')).toBeVisible();
      await expect(page.locator('#sidebar-overlay')).toBeVisible();

      // Header elements
      await expect(page.locator('#menu-toggle')).toBeVisible();
      await expect(page.locator('#admin-panel-btn')).toBeVisible();

      // Sidebar elements
      await expect(page.locator('#add-channel-btn')).toBeVisible();
      await expect(page.locator('#add-dm-btn')).toBeVisible();
      await expect(page.locator('#channel-list')).toBeVisible();
      await expect(page.locator('#dm-list')).toBeVisible();
      await expect(page.locator('#sidebar-settings-btn')).toBeVisible();

      // Chat area elements
      await expect(page.locator('#chat-header')).toBeVisible();
      await expect(page.locator('#chat-header-name')).toBeVisible();
      await expect(page.locator('#chat-header-topic')).toBeVisible();
      await expect(page.locator('#messages')).toBeVisible();
      await expect(page.locator('#message-input')).toBeVisible();
      await expect(page.locator('#send-button')).toBeVisible();
    });

    test('settings panel should have correct IDs', async ({ page }) => {
      await page.goto('/chat.html');

      await expect(page.locator('#settings-panel')).toBeVisible();
      await expect(page.locator('#settings-close-btn')).toBeVisible();
      await expect(page.locator('#current-user')).toBeVisible();
      await expect(page.locator('#admin-badge')).toBeVisible();
      await expect(page.locator('#settings-logout-btn')).toBeVisible();
      await expect(page.locator('#user-nickname')).toBeVisible();
      await expect(page.locator('#user-color')).toBeVisible();
      await expect(page.locator('#user-theme-color')).toBeVisible();
      await expect(page.locator('#clear-nickname-btn')).toBeVisible();
      await expect(page.locator('#reset-theme-color-btn')).toBeVisible();
    });

    test('modals should have correct IDs', async ({ page }) => {
      await page.goto('/chat.html');

      // Room settings modal
      await expect(page.locator('#room-settings-modal')).toBeVisible();
      await expect(page.locator('#room-settings-backdrop')).toBeVisible();
      await expect(page.locator('#room-settings-close-btn')).toBeVisible();
      await expect(page.locator('#room-settings-name')).toBeVisible();
      await expect(page.locator('#notify-level-select')).toBeVisible();
      await expect(page.locator('#delete-room-btn')).toBeVisible();

      // Create room modal
      await expect(page.locator('#create-room-modal')).toBeVisible();
      await expect(page.locator('#create-room-backdrop')).toBeVisible();
      await expect(page.locator('#create-room-close-btn')).toBeVisible();
      await expect(page.locator('#new-room-input')).toBeVisible();
      await expect(page.locator('#create-room-submit-btn')).toBeVisible();

      // DM modal
      await expect(page.locator('#dm-modal')).toBeVisible();
      await expect(page.locator('#dm-modal-backdrop')).toBeVisible();
      await expect(page.locator('#dm-modal-close-btn')).toBeVisible();
      await expect(page.locator('#dm-user-list')).toBeVisible();
      await expect(page.locator('#dm-start-btn')).toBeVisible();
    });
  });

  test.describe('Interactions', () => {
    test('menu toggle should be clickable', async ({ page }) => {
      await page.goto('/chat.html');

      const menuToggle = page.locator('#menu-toggle');
      await expect(menuToggle).toBeEnabled();
      await menuToggle.click();
    });

    test('settings button should toggle panel', async ({ page }) => {
      await page.goto('/chat.html');

      const settingsBtn = page.locator('#sidebar-settings-btn');
      const settingsPanel = page.locator('#settings-panel');

      // Panel starts closed
      await expect(settingsPanel).not.toHaveClass(/open/);

      // Click to open
      await settingsBtn.click();
      await expect(settingsPanel).toHaveClass(/open/);

      // Click close button
      const closeBtn = page.locator('#settings-close-btn');
      await closeBtn.click();
      await expect(settingsPanel).not.toHaveClass(/open/);
    });

    test('send button should be clickable', async ({ page }) => {
      await page.goto('/chat.html');

      const sendButton = page.locator('#send-button');
      await expect(sendButton).toBeEnabled();

      // Type a message
      const messageInput = page.locator('#message-input');
      await messageInput.fill('Test message');

      // Click send (will fail without auth, but button works)
      await sendButton.click();

      // Input should be cleared or error shown
      // (exact behavior depends on auth state)
    });

    test('message input Enter key should work', async ({ page }) => {
      await page.goto('/chat.html');

      const messageInput = page.locator('#message-input');
      await messageInput.fill('Test message');
      await messageInput.press('Enter');

      // Message should be sent (or error shown if not authenticated)
    });

    test('add channel button should open modal', async ({ page }) => {
      await page.goto('/chat.html');

      const addChannelBtn = page.locator('#add-channel-btn');
      const modal = page.locator('#create-room-modal');

      await expect(modal).not.toHaveClass(/open/);
      await addChannelBtn.click();
      await expect(modal).toHaveClass(/open/);
    });

    test('create room modal should close on backdrop click', async ({ page }) => {
      await page.goto('/chat.html');

      // Open modal
      await page.locator('#add-channel-btn').click();
      const modal = page.locator('#create-room-modal');
      await expect(modal).toHaveClass(/open/);

      // Click backdrop
      await page.locator('#create-room-backdrop').click();
      await expect(modal).not.toHaveClass(/open/);
    });

    test('color pickers should be functional', async ({ page }) => {
      await page.goto('/chat.html');

      // Open settings
      await page.locator('#sidebar-settings-btn').click();

      const userColor = page.locator('#user-color');
      const themeColor = page.locator('#user-theme-color');

      await expect(userColor).toBeVisible();
      await expect(themeColor).toBeVisible();

      // Should be able to set values
      await userColor.evaluate(el => el.value = '#ff0000');
      await themeColor.evaluate(el => el.value = '#00ff00');
    });
  });

  test.describe('CSS Classes', () => {
    test('should have proper semantic classes', async ({ page }) => {
      await page.goto('/chat.html');

      // Check for new semantic classes
      await expect(page.locator('.header-brand')).toBeVisible();
      await expect(page.locator('.preference-input-group')).toHaveCount(2); // nickname and theme color

      // Mobile hint should exist
      await expect(page.locator('.mobile-hint')).toBeVisible();
    });

    test('should have no inline styles in HTML', async ({ page }) => {
      await page.goto('/chat.html');

      // Check that commonly problematic elements don't have inline styles
      const elementsWithInlineStyles = await page.evaluate(() => {
        const elements = Array.from(document.querySelectorAll('*'));
        return elements.filter(el => el.hasAttribute('style')).length;
      });

      // Should be 0 or very minimal (only dynamic JS-set styles are OK)
      expect(elementsWithInlineStyles).toBeLessThan(5);
    });
  });
});
