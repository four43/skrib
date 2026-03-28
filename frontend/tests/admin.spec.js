import { test, expect } from '@playwright/test';
import { setupAuthMocks } from './helpers/auth-mock.js';

test.describe('Admin Page', () => {
  test.beforeEach(async ({ page }) => {
    await setupAuthMocks(page);
  });

  test.describe('HTML Structure', () => {
    test('should have correct kebab-case IDs', async ({ page }) => {
      await page.goto('/admin.html');

      // Main containers (class changed from .admin-page to .settings-page)
      await expect(page.locator('.settings-page')).toBeVisible();
      await expect(page.locator('.page-header')).toBeVisible();
      await expect(page.locator('.settings-content')).toBeVisible();

      // Admin controls (in non-active section-users)
      await expect(page.locator('#reg-mode-slider')).toBeAttached();
      await expect(page.locator('#reg-mode-description')).toBeAttached();

      // Invite section (non-active tab, elements are in DOM but not visible)
      await expect(page.locator('#section-invites')).toBeAttached();
      await expect(page.locator('#generate-invite-btn')).toBeAttached();
      await expect(page.locator('#invite-list')).toBeAttached();

      // User lists (non-active tab)
      await expect(page.locator('#pending-count')).toBeAttached();
      await expect(page.locator('#pending-list')).toBeAttached();
      await expect(page.locator('#user-count')).toBeAttached();
      await expect(page.locator('#users-list')).toBeAttached();
      await expect(page.locator('#user-preferences-list')).toBeAttached();
    });

    test('should have proper CSS classes', async ({ page }) => {
      await page.goto('/admin.html');

      await expect(page.locator('.page-header-content')).toBeVisible();
    });
  });

  test.describe('Navigation Tabs', () => {
    test('should have settings-nav with section buttons', async ({ page }) => {
      await page.goto('/admin.html');

      const nav = page.locator('.settings-nav');
      await expect(nav).toBeVisible();

      // Should have nav items for server, appearance, users
      await expect(page.locator('.settings-nav-item[data-section="server"]')).toBeVisible();
      await expect(page.locator('.settings-nav-item[data-section="appearance"]')).toBeVisible();
      await expect(page.locator('.settings-nav-item[data-section="users"]')).toBeVisible();
    });

    test('section nav should switch active section', async ({ page }) => {
      await page.goto('/admin.html');

      // Server section is active by default
      await expect(page.locator('#section-server')).toHaveClass(/active/);

      // Click users nav
      await page.locator('.settings-nav-item[data-section="users"]').click();
      await expect(page.locator('#section-users')).toHaveClass(/active/);
      await expect(page.locator('#section-server')).not.toHaveClass(/active/);

      // Click appearance nav
      await page.locator('.settings-nav-item[data-section="appearance"]').click();
      await expect(page.locator('#section-appearance')).toHaveClass(/active/);
      await expect(page.locator('#section-users')).not.toHaveClass(/active/);
    });

    test('nav should display as horizontal tabs on mobile', async ({ page }) => {
      await page.setViewportSize({ width: 375, height: 667 });
      await page.goto('/admin.html');

      const nav = page.locator('.settings-nav');
      const flexDirection = await nav.evaluate(el => getComputedStyle(el).flexDirection);
      expect(flexDirection).toBe('row');
    });
  });

  test.describe('Interactions', () => {
    test('registration mode slider should be functional', async ({ page }) => {
      await page.goto('/admin.html');

      // Navigate to Users section where the slider now lives
      await page.locator('.settings-nav-item[data-section="users"]').click();

      const slider = page.locator('#reg-mode-slider');
      const description = page.locator('#reg-mode-description');

      await expect(slider).toBeVisible();
      await expect(description).toBeVisible();

      // Slider should be interactive
      await slider.evaluate(el => el.value = '2');
      await slider.dispatchEvent('input');
    });

    test('generate invite button should be clickable', async ({ page }) => {
      await page.goto('/admin.html');

      // Navigate to the invites section by clicking its nav item
      const invitesNav = page.locator('#invites-nav-item');
      // The invites nav is hidden when not in invite reg mode — make it visible
      await invitesNav.evaluate(el => el.classList.remove('hidden'));
      await invitesNav.click();

      const generateBtn = page.locator('#generate-invite-btn');
      await expect(generateBtn).toBeVisible();
      await expect(generateBtn).toBeEnabled();
      await generateBtn.click();
    });

    test('back to chat link should navigate', async ({ page }) => {
      await page.goto('/admin.html');

      const backLink = page.locator('.page-header a.close-btn');
      await expect(backLink).toBeVisible();
      await expect(backLink).toHaveAttribute('href', '/app.html');
    });
  });

  test.describe('No Inline Handlers', () => {
    test('should have no onclick attributes', async ({ page }) => {
      await page.goto('/admin.html');

      const elementsWithOnclick = await page.evaluate(() => {
        const elements = Array.from(document.querySelectorAll('*'));
        return elements.filter(el => el.hasAttribute('onclick')).length;
      });

      expect(elementsWithOnclick).toBe(0);
    });

    test('should have no onchange attributes', async ({ page }) => {
      await page.goto('/admin.html');

      const elementsWithOnchange = await page.evaluate(() => {
        const elements = Array.from(document.querySelectorAll('*'));
        return elements.filter(el => el.hasAttribute('onchange')).length;
      });

      expect(elementsWithOnchange).toBe(0);
    });

    test('should have no oninput attributes', async ({ page }) => {
      await page.goto('/admin.html');

      const elementsWithOninput = await page.evaluate(() => {
        const elements = Array.from(document.querySelectorAll('*'));
        return elements.filter(el => el.hasAttribute('oninput')).length;
      });

      expect(elementsWithOninput).toBe(0);
    });
  });
});
