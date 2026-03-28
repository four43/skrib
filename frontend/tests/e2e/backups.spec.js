/**
 * E2E tests: Backup system.
 *
 * Covers backup creation, listing, downloading, deletion, configuration,
 * system log, and auth boundaries.
 */

import { test, expect } from './fixtures.js';

// ── Helpers ─────────────────────────────────────────────────────────────

/** Make an authenticated API request. */
function authHeaders(token) {
    return {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
    };
}

// ── Tests ───────────────────────────────────────────────────────────────

test.describe('Backup API', () => {

    test('list backups returns empty array initially', async ({ registeredUser, baseURL }) => {
        const { page, sessionToken } = registeredUser;
        const resp = await page.request.get(`${baseURL}/api/admin/backups`, {
            headers: authHeaders(sessionToken),
        });
        expect(resp.ok()).toBeTruthy();
        const data = await resp.json();
        expect(data.backups).toEqual([]);
    });

    test('trigger manual backup and verify it appears in list', async ({ registeredUser, baseURL }) => {
        const { page, sessionToken } = registeredUser;

        // Trigger backup
        const createResp = await page.request.post(`${baseURL}/api/admin/backups`, {
            headers: authHeaders(sessionToken),
        });
        expect(createResp.ok()).toBeTruthy();
        const backup = await createResp.json();
        expect(backup.filename).toMatch(/^skrib-backup-.*\.zip$/);
        expect(backup.size).toBeGreaterThan(0);

        // List should now contain one backup
        const listResp = await page.request.get(`${baseURL}/api/admin/backups`, {
            headers: authHeaders(sessionToken),
        });
        const list = await listResp.json();
        expect(list.backups).toHaveLength(1);
        expect(list.backups[0].filename).toBe(backup.filename);
    });

    test('download backup returns a zip file', async ({ registeredUser, baseURL }) => {
        const { page, sessionToken } = registeredUser;

        // Create a backup first
        const createResp = await page.request.post(`${baseURL}/api/admin/backups`, {
            headers: authHeaders(sessionToken),
        });
        const backup = await createResp.json();

        // Download it
        const dlResp = await page.request.get(
            `${baseURL}/api/admin/backups/${encodeURIComponent(backup.filename)}`,
            { headers: { 'Authorization': `Bearer ${sessionToken}` } }
        );
        expect(dlResp.ok()).toBeTruthy();
        expect(dlResp.headers()['content-type']).toContain('application/zip');

        // Verify it's a valid zip (starts with PK magic bytes)
        const body = await dlResp.body();
        expect(body[0]).toBe(0x50); // P
        expect(body[1]).toBe(0x4B); // K
    });

    test('delete a backup', async ({ registeredUser, baseURL }) => {
        const { page, sessionToken } = registeredUser;

        // Create then delete
        const createResp = await page.request.post(`${baseURL}/api/admin/backups`, {
            headers: authHeaders(sessionToken),
        });
        const backup = await createResp.json();

        const delResp = await page.request.delete(
            `${baseURL}/api/admin/backups/${encodeURIComponent(backup.filename)}`,
            { headers: authHeaders(sessionToken) }
        );
        expect(delResp.ok()).toBeTruthy();

        // List should be empty again
        const listResp = await page.request.get(`${baseURL}/api/admin/backups`, {
            headers: authHeaders(sessionToken),
        });
        const list = await listResp.json();
        expect(list.backups).toHaveLength(0);
    });

    test('get and update backup config', async ({ registeredUser, baseURL }) => {
        const { page, sessionToken } = registeredUser;

        // Get defaults
        const getResp = await page.request.get(`${baseURL}/api/admin/backups/config`, {
            headers: authHeaders(sessionToken),
        });
        expect(getResp.ok()).toBeTruthy();
        const config = await getResp.json();
        expect(config.enabled).toBe(true);
        expect(config.schedule).toBe('03:00');

        // Update schedule
        const patchResp = await page.request.patch(`${baseURL}/api/admin/backups/config`, {
            headers: authHeaders(sessionToken),
            data: { schedule: '04:30' },
        });
        expect(patchResp.ok()).toBeTruthy();

        // Verify persisted
        const getResp2 = await page.request.get(`${baseURL}/api/admin/backups/config`, {
            headers: authHeaders(sessionToken),
        });
        const config2 = await getResp2.json();
        expect(config2.schedule).toBe('04:30');
    });
});

test.describe('System log', () => {

    test('backup events appear in system log', async ({ registeredUser, baseURL }) => {
        const { page, sessionToken } = registeredUser;

        // Trigger a backup to generate log entries
        await page.request.post(`${baseURL}/api/admin/backups`, {
            headers: authHeaders(sessionToken),
        });

        // Check system log
        const resp = await page.request.get(`${baseURL}/api/admin/logs?category=backup`, {
            headers: authHeaders(sessionToken),
        });
        expect(resp.ok()).toBeTruthy();
        const data = await resp.json();
        expect(data.entries.length).toBeGreaterThan(0);
        expect(data.entries[0].category).toBe('backup');
    });
});

test.describe('Backup auth boundaries', () => {

    test('non-admin cannot access backup endpoints', async ({ twoUsers, baseURL }) => {
        const { user } = twoUsers;

        // Log in the non-admin user
        await user.page.goto('/login.html');
        await user.page.locator('#login-button').click();
        await user.page.waitForURL('**/app.html**', { timeout: 15_000 });
        const userToken = await user.page.evaluate(() => localStorage.getItem('session_token'));

        const endpoints = [
            ['GET', `${baseURL}/api/admin/backups`],
            ['POST', `${baseURL}/api/admin/backups`],
            ['GET', `${baseURL}/api/admin/backups/config`],
            ['GET', `${baseURL}/api/admin/logs`],
        ];

        for (const [method, url] of endpoints) {
            const resp = await user.page.request.fetch(url, {
                method,
                headers: authHeaders(userToken),
            });
            expect(resp.status()).toBe(403);
        }
    });
});

test.describe('Backup UI', () => {

    test('admin can see backups tab and trigger manual backup', async ({ registeredUser, baseURL }) => {
        const { page, sessionToken } = registeredUser;

        await page.goto('/admin.html');
        await page.waitForLoadState('networkidle');

        // Backups nav item should exist
        const backupsNav = page.locator('.settings-nav-item[data-section="backups"]');
        await expect(backupsNav).toBeVisible();

        // Switch to backups section
        await backupsNav.click();
        await expect(page.locator('#section-backups')).toHaveClass(/active/);

        // Manual backup button should be visible
        const backupBtn = page.locator('#trigger-backup-btn');
        await expect(backupBtn).toBeVisible();

        // Click it and wait for the backup to complete
        await backupBtn.click();
        await expect(page.locator('.backup-item')).toBeVisible({ timeout: 10_000 });
    });

    test('admin can see system log tab', async ({ registeredUser }) => {
        const { page } = registeredUser;

        await page.goto('/admin.html');
        await page.waitForLoadState('networkidle');

        const logsNav = page.locator('.settings-nav-item[data-section="logs"]');
        await expect(logsNav).toBeVisible();

        await logsNav.click();
        await expect(page.locator('#section-logs')).toHaveClass(/active/);
    });
});
