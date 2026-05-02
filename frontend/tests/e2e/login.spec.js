/**
 * E2E tests: Username-assisted login flow.
 *
 * With residentKey: "preferred", users who have non-discoverable credentials
 * (or browsers like Firefox without platform authenticators) can log in by
 * entering their username first. The server then provides allowCredentials
 * so the authenticator knows which credential to use.
 */

import { test, expect, registerNewUser } from './fixtures.js';

/** Clear session data only (not IndexedDB encryption keys). */
async function clearSession(page) {
    await page.evaluate(() => {
        localStorage.clear();
        sessionStorage.clear();
    });
}

test('login page has a username input field', async ({ authenticatedPage: page }) => {
    await page.goto('/login.html');
    await page.waitForLoadState('networkidle');

    const usernameInput = page.locator('#login-username');
    await expect(usernameInput).toBeVisible();
    await expect(usernameInput).toHaveAttribute('placeholder', /username/i);
});

test('username-assisted login: user enters username then signs in', async ({ browser, baseURL }) => {
    // Register a user (first user = auto-approved admin)
    const user = await registerNewUser(browser, baseURL);
    const username = user.username;

    // Clear session (keep encryption keys in IndexedDB + virtual authenticator credentials)
    await clearSession(user.page);

    // Navigate to login page
    await user.page.goto('/login.html');
    await user.page.waitForLoadState('networkidle');

    // Enter username in the field
    await user.page.locator('#login-username').fill(username);

    // Click sign in
    await user.page.locator('#login-button').click();

    // Should successfully log in and redirect to app
    await user.page.waitForURL('**/app.html**', { timeout: 15_000 });

    // Verify session is established
    const sessionToken = await user.page.evaluate(() => localStorage.getItem('session_token'));
    expect(sessionToken).toBeTruthy();

    const storedUsername = await user.page.evaluate(() => localStorage.getItem('username'));
    expect(storedUsername).toBe(username);

    await user.context.close();
});

test('login still works without username (discoverable credential flow)', async ({ browser, baseURL }) => {
    // Register a user
    const user = await registerNewUser(browser, baseURL);
    const username = user.username;

    // Clear session, keep encryption keys + authenticator credentials
    await clearSession(user.page);

    // Navigate to login
    await user.page.goto('/login.html');
    await user.page.waitForLoadState('networkidle');

    // Do NOT fill in username — leave it empty
    // Click sign in (discoverable credential flow)
    await user.page.locator('#login-button').click();

    // Should still work (virtual authenticator has discoverable credentials)
    await user.page.waitForURL('**/app.html**', { timeout: 15_000 });

    const storedUsername = await user.page.evaluate(() => localStorage.getItem('username'));
    expect(storedUsername).toBe(username);

    await user.context.close();
});
