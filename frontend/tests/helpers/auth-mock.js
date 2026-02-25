/**
 * Shared auth mock helper for DOM tests.
 *
 * Prevents the auth redirect (app.js / admin.js / settings.js all call
 * checkSession() which redirects to /login.html when there is no
 * session_token in localStorage).
 *
 * Usage:
 *   import { setupAuthMocks } from './helpers/auth-mock.js';
 *   test.beforeEach(async ({ page }) => { await setupAuthMocks(page); });
 */

/**
 * Set localStorage values and intercept API routes so that
 * page JS believes we are an authenticated admin user.
 *
 * Must be called **before** page.goto().
 *
 * NOTE: Playwright routes match LIFO (last registered = first checked).
 * Register the catch-all FIRST so specific routes (registered later)
 * take priority.
 */
export async function setupAuthMocks(page, { role = 'admin' } = {}) {
    // addInitScript runs before any page JS — set localStorage here so
    // checkSession() finds a token and skips the redirect.
    await page.addInitScript(({ role }) => {
        localStorage.setItem('session_token', 'fake-token-for-tests');
        localStorage.setItem('username', 'testadmin');
        localStorage.setItem('role', role);
    }, { role });

    // --- Catch-all FIRST (lowest priority — checked last) ---
    await page.route('**/api/**', route =>
        route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({}),
        }),
    );

    // --- Specific routes AFTER (higher priority — checked first) ---

    await page.route('**/api/auth/session', route =>
        route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({ authenticated: true, role }),
        }),
    );

    await page.route('**/api/server/icon*', route =>
        route.fulfill({
            status: 200,
            contentType: 'image/png',
            body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64'),
        }),
    );

    await page.route('**/api/server', route =>
        route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
                name: 'Test Server',
                registration_mode: 'open',
                default_theme: 'four43.theme-default',
                icon_custom: false,
                dm_room_type: 'four43.room-type-chat',
            }),
        }),
    );

    await page.route('**/api/users/*', route =>
        route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
                theme_name: null,
                nickname: null,
                color: '#1976d2',
            }),
        }),
    );

    await page.route('**/api/themes', route =>
        route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify([]),
        }),
    );

    await page.route('**/api/rooms', route =>
        route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify([]),
        }),
    );

    await page.route('**/api/plugins', route =>
        route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify([{
                id: 'four43.room-type-chat',
                name: 'Chat',
                version: '1.0.0',
                description: 'Text chat',
                author: 'four43',
                entry: 'plugin.js',
                permissions: [],
                hooks: {},
                enabled: true,
                room_types: ['chat'],
                styles: [],
            }]),
        }),
    );

    await page.route('**/api/plugins/**', route =>
        route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify([]),
        }),
    );
}
