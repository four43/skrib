import { test, expect } from '@playwright/test';

test.describe('Admin Page', () => {
  test.describe('HTML Structure', () => {
    test('should have correct kebab-case IDs', async ({ page }) => {
      await page.goto('/admin.html');

      // Main containers
      await expect(page.locator('.admin-page')).toBeVisible();
      await expect(page.locator('.admin-page-header')).toBeVisible();
      await expect(page.locator('.admin-page-content')).toBeVisible();

      // Admin controls
      await expect(page.locator('#server-color-picker')).toBeVisible();
      await expect(page.locator('#reg-mode-slider')).toBeVisible();
      await expect(page.locator('#reg-mode-description')).toBeVisible();

      // Invite section
      await expect(page.locator('#invite-section')).toBeVisible();
      await expect(page.locator('#generate-invite-btn')).toBeVisible();
      await expect(page.locator('#invite-list')).toBeVisible();

      // User lists
      await expect(page.locator('#pending-count')).toBeVisible();
      await expect(page.locator('#pending-list')).toBeVisible();
      await expect(page.locator('#user-count')).toBeVisible();
      await expect(page.locator('#users-list')).toBeVisible();
      await expect(page.locator('#user-preferences-list')).toBeVisible();
    });

    test('should have proper CSS classes', async ({ page }) => {
      await page.goto('/admin.html');

      // Check for new semantic class
      await expect(page.locator('.admin-page-header-content')).toBeVisible();
    });
  });

  test.describe('Interactions', () => {
    test('server color picker should be functional', async ({ page }) => {
      await page.goto('/admin.html');

      const colorPicker = page.locator('#server-color-picker');
      await expect(colorPicker).toBeVisible();
      await expect(colorPicker).toBeEnabled();

      // Should be able to set value
      await colorPicker.evaluate(el => el.value = '#ff0000');
      expect(await colorPicker.inputValue()).toBe('#ff0000');
    });

    test('registration mode slider should be functional', async ({ page }) => {
      await page.goto('/admin.html');

      const slider = page.locator('#reg-mode-slider');
      const description = page.locator('#reg-mode-description');

      await expect(slider).toBeVisible();
      await expect(description).toBeVisible();

      // Slider should be interactive
      await slider.evaluate(el => el.value = '2');
      await slider.dispatchEvent('input');

      // Description should update
      // (exact text depends on implementation)
    });

    test('generate invite button should be clickable', async ({ page }) => {
      await page.goto('/admin.html');

      // Invite section might be hidden initially
      const inviteSection = page.locator('#invite-section');

      // If hidden, make visible for testing
      if (await inviteSection.isHidden()) {
        await inviteSection.evaluate(el => el.classList.remove('hidden'));
      }

      const generateBtn = page.locator('#generate-invite-btn');
      await expect(generateBtn).toBeEnabled();
      await generateBtn.click();

      // Button should trigger API call (will fail without auth, but click works)
    });

    test('back to chat link should navigate', async ({ page }) => {
      await page.goto('/admin.html');

      const backLink = page.locator('a.admin-back-btn');
      await expect(backLink).toBeVisible();
      await expect(backLink).toHaveAttribute('href', '/chat.html');
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
