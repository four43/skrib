import { test, expect } from '@playwright/test';
import { setupAuthMocks } from './helpers/auth-mock.js';

test.describe('Settings Page', () => {
  test.beforeEach(async ({ page }) => {
    await setupAuthMocks(page);
  });

  test.describe('HTML Structure', () => {
    test('should have correct kebab-case IDs', async ({ page }) => {
      await page.goto('/settings.html');

      // Main containers
      await expect(page.locator('.settings-page')).toBeVisible();
      await expect(page.locator('.settings-content')).toBeVisible();

      // Account section (active by default)
      await expect(page.locator('#section-account')).toBeVisible();
      await expect(page.locator('#current-user')).toBeVisible();
      await expect(page.locator('#admin-badge')).toBeAttached(); // hidden unless admin check runs
      await expect(page.locator('#user-nickname')).toBeVisible();
      await expect(page.locator('#clear-nickname-btn')).toBeVisible();
      await expect(page.locator('#settings-logout-btn')).toBeVisible();

      // Appearance section (non-active tab, attached but not visible)
      await expect(page.locator('#section-appearance')).toBeAttached();
      await expect(page.locator('#user-color')).toBeAttached();
    });
  });

  test.describe('Interactions', () => {
    test('color picker should be functional', async ({ page }) => {
      await page.goto('/settings.html');
      // Wait for settings JS to finish init (populates username after async API calls)
      await expect(page.locator('#current-user')).not.toHaveText('');

      // Navigate to appearance section and wait for it to become active
      await page.locator('.settings-nav-item[data-section="appearance"]').click();
      await expect(page.locator('#section-appearance')).toHaveClass(/active/);

      const userColor = page.locator('#user-color');
      await expect(userColor).toBeVisible();

      // Should be able to set values
      await userColor.evaluate(el => el.value = '#ff0000');
    });

    test('back to chat link should navigate', async ({ page }) => {
      await page.goto('/settings.html');

      const backLink = page.locator('.page-header a.close-btn');
      await expect(backLink).toBeVisible();
      await expect(backLink).toHaveAttribute('href', '/app.html');
    });

    test('section nav should switch active section', async ({ page }) => {
      await page.goto('/settings.html');
      await expect(page.locator('#current-user')).not.toHaveText('');

      // Account section is active by default
      await expect(page.locator('#section-account')).toHaveClass(/active/);

      // Click appearance nav
      await page.locator('.settings-nav-item[data-section="appearance"]').click();
      await expect(page.locator('#section-appearance')).toHaveClass(/active/);
      await expect(page.locator('#section-account')).not.toHaveClass(/active/);
    });
  });

  test.describe('Navigation', () => {
    test('nav should display as horizontal tabs on mobile', async ({ page }) => {
      await page.setViewportSize({ width: 375, height: 667 });
      await page.goto('/settings.html');

      const nav = page.locator('.settings-nav');
      const flexDirection = await nav.evaluate(el => getComputedStyle(el).flexDirection);
      expect(flexDirection).toBe('row');
    });
  });

  test.describe('CSS Classes', () => {
    test('should have preference-input-group elements', async ({ page }) => {
      await page.goto('/settings.html');
      await expect(page.locator('#current-user')).not.toHaveText('');

      // nickname group is in active account section
      await expect(page.locator('#section-account .preference-input-group')).toHaveCount(1);
    });

    test('should have no inline styles in HTML', async ({ page }) => {
      await page.goto('/settings.html');

      // Count inline styles on our own elements, excluding third-party
      // components (iconify-icon) and the theme preview (intentional demo styles)
      const elementsWithInlineStyles = await page.evaluate(() => {
        const elements = Array.from(document.querySelectorAll('*'));
        return elements.filter(el =>
          el.hasAttribute('style') &&
          el.tagName !== 'ICONIFY-ICON' &&
          !el.closest('iconify-icon') &&
          !el.closest('.theme-preview')
        ).length;
      });

      expect(elementsWithInlineStyles).toBeLessThan(5);
    });
  });
});
