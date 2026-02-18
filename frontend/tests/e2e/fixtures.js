/**
 * Shared E2E test fixtures for Skrīb.
 *
 * Provides:
 *   - authenticatedPage: a Page with a virtual WebAuthn authenticator attached
 *   - registeredUser: registers a fresh user and returns { page, username }
 */
import { test as base, expect } from '@playwright/test';

export const test = base.extend({
  /**
   * Page with a virtual WebAuthn authenticator (CDP).
   * Authenticator is torn down after the test.
   */
  authenticatedPage: async ({ page }, use) => {
    const client = await page.context().newCDPSession(page);
    await client.send('WebAuthn.enable');

    const { authenticatorId } = await client.send('WebAuthn.addVirtualAuthenticator', {
      options: {
        protocol: 'ctap2',
        transport: 'internal',
        hasResidentKey: true,
        hasUserVerification: true,
        isUserVerified: true,
        automaticPresenceSimulation: true,
      },
    });

    await use(page);

    await client.send('WebAuthn.removeVirtualAuthenticator', { authenticatorId });
    await client.send('WebAuthn.disable');
  },

  /**
   * Registers a brand-new user against the running E2E backend.
   * Returns { page, username }.
   *
   * Depends on authenticatedPage so the WebAuthn ceremony succeeds.
   * Uses pressSequentially (project convention: fill() doesn't fire validation events).
   */
  registeredUser: async ({ authenticatedPage: page }, use) => {
    const username = `tu${Math.random().toString(36).slice(2, 9)}`;

    await page.goto('/register.html');
    await page.waitForLoadState('networkidle');

    const input = page.locator('#register-username');
    await input.pressSequentially(username, { delay: 30 });
    await expect(input).not.toHaveClass(/invalid/);

    await page.locator('#register-submit-button').click();

    // First user is auto-approved (open registration mode) -> redirects to chat
    await page.waitForURL(/.*app\.html/, { timeout: 20000 });

    const sessionToken = await page.evaluate(() => localStorage.getItem('session_token'));
    expect(sessionToken).toBeTruthy();

    await use({ page, username });
  },
});

export { expect };
