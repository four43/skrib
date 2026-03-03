/**
 * E2E tests: Progressive Web App functionality.
 *
 * Verifies the web app manifest, service worker registration,
 * avatar generation, and basic PWA-related behaviors.
 *
 * Uses registeredUser fixture (single admin user).
 */

import { test, expect } from './fixtures.js';

// ── Tests ───────────────────────────────────────────────────────────────

test.describe('PWA manifest and metadata', () => {

    test('app.html includes PWA manifest link', async ({ registeredUser }) => {
        const { page } = registeredUser;

        await page.goto('/app.html');
        await page.waitForLoadState('networkidle');

        // Check manifest link exists
        const manifestLink = page.locator('link[rel="manifest"]');
        await expect(manifestLink).toHaveAttribute('href', '/manifest.json');
    });

    test('manifest.json is valid and contains required PWA fields', async ({ registeredUser, baseURL }) => {
        const { page } = registeredUser;

        const resp = await page.request.get(`${baseURL}/manifest.json`);
        expect(resp.ok()).toBeTruthy();
        const manifest = await resp.json();

        // Required PWA fields
        expect(manifest.name).toBeTruthy();
        expect(manifest.short_name).toBeTruthy();
        expect(manifest.display).toBe('standalone');
        expect(manifest.start_url).toBeTruthy();
        expect(manifest.icons).toBeDefined();
        expect(manifest.icons.length).toBeGreaterThan(0);

        // At least one icon should be 192x192 (required for installability)
        const icon192 = manifest.icons.find(i => i.sizes === '192x192');
        expect(icon192).toBeDefined();
    });

    test('service worker registers successfully', async ({ registeredUser }) => {
        const { page } = registeredUser;

        await page.goto('/app.html');
        await page.waitForLoadState('networkidle');

        // Check that service worker is registered
        const swRegistered = await page.evaluate(async () => {
            if (!('serviceWorker' in navigator)) return false;
            const registration = await navigator.serviceWorker.getRegistration();
            return !!registration;
        });
        expect(swRegistered).toBe(true);
    });
});

test.describe('Avatar generation', () => {

    test('user avatar is auto-generated on registration', async ({ registeredUser, baseURL }) => {
        const { page, username } = registeredUser;

        // Fetch avatar
        const resp = await page.request.get(`${baseURL}/api/users/${username}/avatar`);
        expect(resp.ok()).toBeTruthy();

        // Should be a PNG image
        const contentType = resp.headers()['content-type'];
        expect(contentType).toContain('image/png');

        // Should have non-trivial content (not empty)
        const body = await resp.body();
        expect(body.length).toBeGreaterThan(100);
    });

    test('server icon is auto-generated', async ({ registeredUser, baseURL }) => {
        const { page } = registeredUser;

        const resp = await page.request.get(`${baseURL}/api/server/icon`);
        expect(resp.ok()).toBeTruthy();

        const contentType = resp.headers()['content-type'];
        expect(contentType).toContain('image/png');
    });
});

test.describe('Theme system', () => {

    test('themes API returns available themes', async ({ registeredUser, baseURL }) => {
        const { page } = registeredUser;

        // Note: route is registered as /api/themes/ — trailing slash required
        const resp = await page.request.get(`${baseURL}/api/themes/`);
        expect(resp.ok()).toBeTruthy();
        const themes = await resp.json();

        // Should have at least the default theme
        expect(themes.length).toBeGreaterThan(0);

        // Each theme should have required fields
        for (const theme of themes) {
            expect(theme.id).toBeTruthy();
            expect(theme.name).toBeTruthy();
        }
    });

    test('theme CSS is served correctly', async ({ registeredUser, baseURL }) => {
        const { page } = registeredUser;

        // Get list of themes (trailing slash required — route is /api/themes/)
        const resp = await page.request.get(`${baseURL}/api/themes/`);
        const themes = await resp.json();

        if (themes.length > 0) {
            // Fetch first theme's CSS
            const cssResp = await page.request.get(`${baseURL}/api/themes/${themes[0].id}`);
            expect(cssResp.ok()).toBeTruthy();

            const contentType = cssResp.headers()['content-type'];
            expect(contentType).toContain('text/css');
        }
    });
});

test.describe('Plugin system', () => {

    test('plugins API returns list of plugins with manifests', async ({ registeredUser, baseURL }) => {
        const { page, sessionToken } = registeredUser;

        const resp = await page.request.get(`${baseURL}/api/plugins`, {
            headers: { 'Authorization': `Bearer ${sessionToken}` },
        });
        expect(resp.ok()).toBeTruthy();
        const plugins = await resp.json();

        // Should have the bundled plugins
        expect(plugins.length).toBeGreaterThan(0);

        // Find the chat plugin
        const chatPlugin = plugins.find(p => p.id === 'four43.room-type-chat');
        expect(chatPlugin).toBeDefined();
        expect(chatPlugin.enabled).toBe(true);
        expect(chatPlugin.name).toBeTruthy();

        // Find the todo plugin
        const todoPlugin = plugins.find(p => p.id === 'four43.room-type-todo');
        expect(todoPlugin).toBeDefined();
    });

    test('plugin frontend files are served correctly', async ({ registeredUser, baseURL }) => {
        const { page, sessionToken } = registeredUser;

        // Get plugin list
        const resp = await page.request.get(`${baseURL}/api/plugins`, {
            headers: { 'Authorization': `Bearer ${sessionToken}` },
        });
        const plugins = await resp.json();

        // Fetch a frontend file for the chat plugin
        const chatPlugin = plugins.find(p => p.id === 'four43.room-type-chat');
        if (chatPlugin && chatPlugin.frontend_entry) {
            const fileResp = await page.request.get(
                `${baseURL}/api/plugins/${chatPlugin.id}/file/${chatPlugin.frontend_entry}`
            );
            expect(fileResp.ok()).toBeTruthy();
        }
    });
});
