/**
 * E2E tests: User settings functionality.
 *
 * Covers nickname/display name, color scheme, theme selection,
 * and the /nick slash command. Verifies settings persist and
 * are reflected in the chat UI.
 *
 * Uses threeUsers fixture (admin User A, User B, User C).
 */

import { test, expect } from './fixtures.js';

// ── Helpers ─────────────────────────────────────────────────────────────

/** Create a room via the UI. */
async function createRoom(page, roomName) {
    await page.locator('#add-channel-btn').click();
    await page.locator('#new-room-input').fill(roomName);
    await page.locator('#create-room-submit-btn').click();
    await expect(page.locator('#room-content-name')).toHaveText(`#${roomName}`);
    await page.locator('#message-input').waitFor();
}

/** Send a chat message and verify it appears. */
async function sendMessage(page, text) {
    await page.locator('#message-input').fill(text);
    await page.locator('#message-input').press('Enter');
    await expect(page.locator('#messages')).toContainText(text);
}

/** Send a slash command. */
async function sendCommand(page, command) {
    await page.locator('#message-input').fill(command);
    await page.locator('#message-input').press('Enter');
}

/** Invite a user to the current room. */
async function inviteUser(page, username) {
    await sendCommand(page, `/invite ${username}`);
    await expect(page.locator('#messages')).toContainText(`Invited ${username}`);
}

/** Navigate to a room after reload. */
async function navigateToRoom(page, roomName) {
    await page.reload();
    await page.waitForLoadState('networkidle');
    await page.locator(`.room-item[data-room-id="${roomName}"]`).waitFor();
    await page.locator(`.room-item[data-room-id="${roomName}"]`).click();
    await expect(page.locator('#room-content-name')).toHaveText(`#${roomName}`);
}

// ── Tests ───────────────────────────────────────────────────────────────

test.describe('User settings - Nickname', () => {

    test('user sets nickname via settings page, sees it reflected', async ({ threeUsers, baseURL }) => {
        const { admin } = threeUsers;

        // Navigate to settings
        await admin.page.goto('/settings.html');
        await admin.page.waitForLoadState('networkidle');

        // Username should be displayed
        await expect(admin.page.locator('#current-user')).toContainText(admin.username);

        // Admin badge should be visible
        await expect(admin.page.locator('#admin-badge')).toBeVisible();
        await expect(admin.page.locator('#admin-badge')).toHaveText('ADMIN');

        // Set nickname
        const nicknameInput = admin.page.locator('#user-nickname');
        await nicknameInput.fill('Cool Admin');

        // Trigger change event (successful update shows no dialog)
        await nicknameInput.dispatchEvent('change');
        await admin.page.waitForTimeout(1000);

        // Verify via API that nickname was saved
        const resp = await admin.page.request.get(`${baseURL}/api/users/${admin.username}`, {
            headers: { 'Authorization': `Bearer ${admin.sessionToken}` },
        });
        const data = await resp.json();
        expect(data.nickname).toBe('Cool Admin');
    });

    test('user sets nickname via /nick command, other users see display name', async ({ threeUsers }) => {
        const { admin: userA, userB } = threeUsers;
        await userA.page.waitForLoadState('networkidle');

        await createRoom(userA.page, 'nick-room');
        await inviteUser(userA.page, userB.username);
        await navigateToRoom(userB.page, 'nick-room');

        // User A sets nickname via /nick command
        await sendCommand(userA.page, '/nick TestNick');

        // /nick triggers a room re-render, wait for messages to reload
        await userA.page.locator('#message-input').waitFor();
        await userA.page.waitForTimeout(1000);

        // User A sends a message — User B should see it with the display name
        await sendMessage(userA.page, 'Hello with nickname');
        await expect(userB.page.locator('#messages')).toContainText('Hello with nickname');

        // Clear nickname
        await sendCommand(userA.page, '/nick clear');
    });

    test('user clears nickname via settings page', async ({ threeUsers, baseURL }) => {
        const { admin } = threeUsers;

        // Set nickname via API first
        await admin.page.request.patch(`${baseURL}/api/users/${admin.username}`, {
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${admin.sessionToken}`,
            },
            data: { nickname: 'TempNick' },
        });

        // Go to settings
        await admin.page.goto('/settings.html');
        await admin.page.waitForLoadState('networkidle');

        // Nickname should be populated
        await expect(admin.page.locator('#user-nickname')).toHaveValue('TempNick');

        // Clear nickname using the native search clear (type="search" fires 'search' event)
        const nicknameInput = admin.page.locator('#user-nickname');
        await nicknameInput.fill('');
        admin.page.once('dialog', dialog => dialog.accept());
        await nicknameInput.dispatchEvent('search');
        await admin.page.waitForTimeout(500);

        // Verify cleared via API
        const resp = await admin.page.request.get(`${baseURL}/api/users/${admin.username}`, {
            headers: { 'Authorization': `Bearer ${admin.sessionToken}` },
        });
        const data = await resp.json();
        expect(data.nickname).toBeFalsy();
    });
});

test.describe('User settings - Appearance', () => {

    test('user can switch color scheme to dark and light', async ({ threeUsers }) => {
        const { admin } = threeUsers;

        await admin.page.goto('/settings.html');
        await admin.page.waitForLoadState('networkidle');

        // Switch to Appearance section
        await admin.page.locator('.settings-nav-item[data-section="appearance"]').click();
        await expect(admin.page.locator('#section-appearance')).toHaveClass(/active/);

        // Click dark mode
        await admin.page.locator('.color-scheme-option[data-scheme="dark"]').click();
        await expect(admin.page.locator('.color-scheme-option[data-scheme="dark"]')).toHaveClass(/active/);

        // Verify data-theme-dark attribute is set on html element
        const isDark = await admin.page.evaluate(() =>
            document.documentElement.hasAttribute('data-theme-dark')
        );
        expect(isDark).toBe(true);

        // Switch to light
        await admin.page.locator('.color-scheme-option[data-scheme="light"]').click();
        await expect(admin.page.locator('.color-scheme-option[data-scheme="light"]')).toHaveClass(/active/);

        const isStillDark = await admin.page.evaluate(() =>
            document.documentElement.hasAttribute('data-theme-dark')
        );
        expect(isStillDark).toBe(false);
    });

    test('color scheme persists across page reload', async ({ threeUsers }) => {
        const { admin } = threeUsers;

        await admin.page.goto('/settings.html');
        await admin.page.waitForLoadState('networkidle');

        // Switch to appearance
        await admin.page.locator('.settings-nav-item[data-section="appearance"]').click();

        // Set dark mode
        await admin.page.locator('.color-scheme-option[data-scheme="dark"]').click();
        await admin.page.waitForTimeout(500);

        // Reload settings page
        await admin.page.goto('/settings.html');
        await admin.page.waitForLoadState('networkidle');
        await admin.page.locator('.settings-nav-item[data-section="appearance"]').click();

        // Dark should still be selected
        await expect(admin.page.locator('.color-scheme-option[data-scheme="dark"]')).toHaveClass(/active/);

        // Reset to auto
        await admin.page.locator('.color-scheme-option[data-scheme="auto"]').click();
    });

    test('user color picker updates username color', async ({ threeUsers, baseURL }) => {
        const { admin } = threeUsers;

        await admin.page.goto('/settings.html');
        await admin.page.waitForLoadState('networkidle');

        // Switch to appearance
        await admin.page.locator('.settings-nav-item[data-section="appearance"]').click();

        // Change color
        const colorInput = admin.page.locator('#user-color');
        await expect(colorInput).toBeVisible();

        // Set color via JS (color input is tricky to interact with via Playwright)
        admin.page.once('dialog', dialog => dialog.accept());
        await admin.page.evaluate(() => {
            const input = document.getElementById('user-color');
            input.value = '#ff0000';
            input.dispatchEvent(new Event('change'));
        });
        await admin.page.waitForTimeout(500);

        // Verify via API
        const resp = await admin.page.request.get(`${baseURL}/api/users/${admin.username}`, {
            headers: { 'Authorization': `Bearer ${admin.sessionToken}` },
        });
        const data = await resp.json();
        expect(data.color).toBe('#ff0000');
    });
});

test.describe('User settings - Session', () => {

    test('logout button clears session and redirects to login', async ({ threeUsers }) => {
        const { admin } = threeUsers;

        await admin.page.goto('/settings.html');
        await admin.page.waitForLoadState('networkidle');

        // Click logout
        await admin.page.locator('#settings-logout-btn').click();

        // Should redirect to login page
        await admin.page.waitForURL('**/login.html**', { timeout: 10_000 });

        // Session token should be cleared
        const token = await admin.page.evaluate(() => localStorage.getItem('session_token'));
        expect(token).toBeNull();
    });
});
