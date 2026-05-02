import { test, expect } from '@playwright/test';

/**
 * Mock /api/server so login.js checkRegistrationMode() succeeds
 * and register.js checkRegistrationAccess() succeeds without a backend.
 *
 * Playwright routes match LIFO — register catch-all first, specific after.
 */
async function setupServerMock(page) {
  await page.route('**/api/**', route =>
    route.fulfill({ status: 200, contentType: 'application/json', body: '{}' }),
  );
  await page.route('**/api/server', route =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        name: 'Test Server',
        registration_mode: 'open',
        default_theme: 'four43.theme-default',
      }),
    }),
  );
}

test.describe('Login Page', () => {
  test.beforeEach(async ({ page }) => {
    await setupServerMock(page);
  });

  test('should have correct kebab-case IDs', async ({ page }) => {
    await page.goto('/login.html');

    await expect(page.locator('#auth-view')).toBeVisible();
    await expect(page.locator('#login-form')).toBeVisible();
    await expect(page.locator('#auth-status')).toBeAttached();
    await expect(page.locator('#login-button')).toBeVisible();
    await expect(page.locator('#register-section')).toBeAttached();
  });

  test('should show register button when registration is enabled', async ({ page }) => {
    await page.goto('/login.html');

    await expect(page.locator('#register-section')).toBeVisible();
    await expect(page.locator('#go-to-register-button')).toBeVisible();
  });

  test('should have a username input field for assisted login', async ({ page }) => {
    await page.goto('/login.html');

    const usernameInput = page.locator('#login-username');
    await expect(usernameInput).toBeVisible();
    await expect(usernameInput).toHaveAttribute('type', 'text');
    await expect(usernameInput).toHaveAttribute('autocomplete', 'username');
  });

  test('login button should be clickable', async ({ page }) => {
    await page.goto('/login.html');

    const loginButton = page.locator('#login-button');
    await expect(loginButton).toBeEnabled();
    await loginButton.click();
  });

  test('go to register button should navigate', async ({ page }) => {
    await page.goto('/login.html');

    await expect(page.locator('#register-section')).toBeVisible();

    const registerButton = page.locator('#go-to-register-button');
    await registerButton.click();

    await expect(page).toHaveURL(/.*register\.html/);
  });
});

test.describe('Register Page', () => {
  test.beforeEach(async ({ page }) => {
    await setupServerMock(page);
  });

  test('should have correct kebab-case IDs', async ({ page }) => {
    await page.goto('/register.html');

    await expect(page.locator('#auth-view')).toBeVisible();
    await expect(page.locator('#register-form')).toBeVisible();
    await expect(page.locator('#register-status')).toBeAttached();
    await expect(page.locator('#register-username')).toBeVisible();
    await expect(page.locator('#register-submit-button')).toBeVisible();
    await expect(page.locator('#go-to-login-button')).toBeVisible();
  });

  test('username input should validate in real-time', async ({ page }) => {
    await page.goto('/register.html');

    const input = page.locator('#register-username');

    // Too short
    await input.fill('ab');
    await expect(input).toHaveClass(/invalid/);

    // Valid
    await input.fill('testuser123');
    await expect(input).not.toHaveClass(/invalid/);
  });

  test('go to login button should navigate', async ({ page }) => {
    await page.goto('/register.html');

    await page.locator('#go-to-login-button').click();
    await expect(page).toHaveURL(/.*login\.html/);
  });

  test('should show validation errors for invalid usernames', async ({ page }) => {
    await page.goto('/register.html');
    const usernameInput = page.locator('#register-username');

    // Too short
    await usernameInput.fill('ab');
    await expect(usernameInput).toHaveClass(/invalid/);

    // Too long — bypass maxlength via JS
    await page.evaluate(() => {
      const input = document.getElementById('register-username');
      input.value = 'thisusernameiswaytoolong';
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await expect(usernameInput).toHaveClass(/invalid/);

    // Invalid characters
    await page.evaluate(() => {
      const input = document.getElementById('register-username');
      input.value = 'user@name';
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await expect(usernameInput).toHaveClass(/invalid/);

    // Reserved word
    await usernameInput.fill('admin123');
    await expect(usernameInput).toHaveClass(/invalid/);

    // Valid
    await usernameInput.fill('validuser99');
    await expect(usernameInput).not.toHaveClass(/invalid/);
  });
});
