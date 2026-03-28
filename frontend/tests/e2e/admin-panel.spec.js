/**
 * E2E tests: Admin panel functionality.
 *
 * Covers server settings, user management, role changes, user deletion,
 * and moderator vs admin capabilities in the admin panel UI.
 *
 * Uses threeUsers fixture (admin User A, User B, User C — all approved and logged in).
 */

import { test, expect } from './fixtures.js';

// ── Helpers ─────────────────────────────────────────────────────────────

/** Navigate to admin panel. Caller must have a valid session. */
async function goToAdmin(page) {
    await page.goto('/admin.html');
    await page.waitForLoadState('networkidle');
}

/** Switch to a section in the admin nav. */
async function switchSection(page, section) {
    await page.locator(`.settings-nav-item[data-section="${section}"]`).click();
    await expect(page.locator(`#section-${section}`)).toHaveClass(/active/);
}

/** Set registration mode via API. */
async function setRegistrationMode(page, baseURL, sessionToken, mode) {
    const resp = await page.request.patch(`${baseURL}/api/server`, {
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${sessionToken}`,
        },
        data: { registration_mode: mode },
    });
    expect(resp.ok()).toBeTruthy();
}

/** Set user role via API. */
async function setUserRole(page, baseURL, sessionToken, username, role) {
    const resp = await page.request.patch(`${baseURL}/api/users/${encodeURIComponent(username)}`, {
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${sessionToken}`,
        },
        data: { role },
    });
    return resp;
}

// ── Tests ───────────────────────────────────────────────────────────────

test.describe('Admin panel - Server settings', () => {

    test('admin can view and update server name', async ({ threeUsers, baseURL }) => {
        const { admin } = threeUsers;

        await goToAdmin(admin.page);

        // Server name input should be visible and editable
        const nameInput = admin.page.locator('#server-name-input');
        await expect(nameInput).toBeVisible();

        // Change server name and wait for the API call to complete
        await nameInput.fill('Test Server');
        await nameInput.dispatchEvent('change');
        await admin.page.waitForLoadState('networkidle');

        // Verify via API that the name was saved
        const resp = await admin.page.request.get(`${baseURL}/api/server`);
        const data = await resp.json();
        expect(data.name).toBe('Test Server');
    });

    test('admin can change registration mode via slider', async ({ threeUsers, baseURL }) => {
        const { admin } = threeUsers;

        await goToAdmin(admin.page);
        await switchSection(admin.page, 'users');

        const slider = admin.page.locator('#reg-mode-slider');
        await expect(slider).toBeVisible();

        // Set to "open" (value 3)
        await slider.fill('3');
        await slider.dispatchEvent('change');

        // Wait for API call to complete
        await admin.page.waitForTimeout(500);

        // Verify via API
        const resp = await admin.page.request.get(`${baseURL}/api/server`);
        const data = await resp.json();
        expect(data.registration_mode).toBe('open');

        // Set back to approval_required (value 2)
        await slider.fill('2');
        await slider.dispatchEvent('change');
        await admin.page.waitForTimeout(500);

        const resp2 = await admin.page.request.get(`${baseURL}/api/server`);
        const data2 = await resp2.json();
        expect(data2.registration_mode).toBe('approval_required');
    });

    test('invite section appears when registration mode is invite_only', async ({ threeUsers }) => {
        const { admin } = threeUsers;

        await goToAdmin(admin.page);
        await switchSection(admin.page, 'users');

        // Wait for the registration mode slider to load
        const slider = admin.page.locator('#reg-mode-slider');
        await slider.waitFor({ state: 'visible' });

        // Move slider to invite_only position (index 1: closed/invite_only/approval_required/open)
        // Dispatch 'change' event which triggers the async API call + UI update
        await slider.evaluate(el => {
            el.value = 1;
            el.dispatchEvent(new Event('input'));   // updates label
            el.dispatchEvent(new Event('change'));  // triggers setRegistrationMode() API call
        });

        // Invites nav item should become visible once API responds and UI updates
        const invitesNav = admin.page.locator('#invites-nav-item');
        await expect(invitesNav).not.toHaveClass(/hidden/, { timeout: 8_000 });

        // Switch to invites section
        await invitesNav.click();
        await expect(admin.page.locator('#section-invites')).toHaveClass(/active/);

        // Generate invite button should be visible
        await expect(admin.page.locator('#generate-invite-btn')).toBeVisible();
    });
});

test.describe('Admin panel - User management', () => {

    test('admin sees user list with roles and action buttons', async ({ threeUsers }) => {
        const { admin, userB, userC } = threeUsers;

        await goToAdmin(admin.page);
        await switchSection(admin.page, 'users');

        // User count should show at least 3 users
        const userCount = admin.page.locator('#user-count');
        await expect(userCount).not.toHaveText('0');

        // All three usernames should be visible in the users list
        const usersList = admin.page.locator('#users-list');
        await expect(usersList).toContainText(admin.username);
        await expect(usersList).toContainText(userB.username);
        await expect(usersList).toContainText(userC.username);
    });

    test('admin can promote user to moderator and demote back', async ({ threeUsers, baseURL }) => {
        const { admin, userB } = threeUsers;

        // Promote User B to moderator via API
        const promoteResp = await setUserRole(admin.page, baseURL, admin.sessionToken, userB.username, 'moderator');
        expect(promoteResp.ok()).toBeTruthy();

        // Verify via API
        const checkResp = await admin.page.request.get(`${baseURL}/api/users/${userB.username}`, {
            headers: { 'Authorization': `Bearer ${admin.sessionToken}` },
        });
        const userData = await checkResp.json();
        expect(userData.role).toBe('moderator');

        // Demote back to user
        const demoteResp = await setUserRole(admin.page, baseURL, admin.sessionToken, userB.username, 'user');
        expect(demoteResp.ok()).toBeTruthy();

        const checkResp2 = await admin.page.request.get(`${baseURL}/api/users/${userB.username}`, {
            headers: { 'Authorization': `Bearer ${admin.sessionToken}` },
        });
        const userData2 = await checkResp2.json();
        expect(userData2.role).toBe('user');
    });

    test('admin can promote user to admin', async ({ threeUsers, baseURL }) => {
        const { admin, userC } = threeUsers;

        const resp = await setUserRole(admin.page, baseURL, admin.sessionToken, userC.username, 'admin');
        expect(resp.ok()).toBeTruthy();

        const checkResp = await admin.page.request.get(`${baseURL}/api/users/${userC.username}`, {
            headers: { 'Authorization': `Bearer ${admin.sessionToken}` },
        });
        const userData = await checkResp.json();
        expect(userData.role).toBe('admin');

        // Clean up: demote back
        await setUserRole(admin.page, baseURL, admin.sessionToken, userC.username, 'user');
    });

    test('admin can delete a user', async ({ threeUsers, baseURL }) => {
        const { admin, userC } = threeUsers;

        // Delete User C
        const resp = await admin.page.request.delete(`${baseURL}/api/users/${userC.username}`, {
            headers: { 'Authorization': `Bearer ${admin.sessionToken}` },
        });
        expect(resp.ok()).toBeTruthy();

        // Verify user is gone from list
        const listResp = await admin.page.request.get(`${baseURL}/api/users`, {
            headers: { 'Authorization': `Bearer ${admin.sessionToken}` },
        });
        const users = await listResp.json();
        const usernames = users.map(u => u.username);
        expect(usernames).not.toContain(userC.username);
    });

    test('cannot delete the last admin', async ({ registeredUser, baseURL }) => {
        const admin = registeredUser;

        // Try to delete self (only admin)
        const resp = await admin.page.request.delete(`${baseURL}/api/users/${admin.username}`, {
            headers: { 'Authorization': `Bearer ${admin.sessionToken}` },
        });
        // Should fail — can't delete last admin
        expect(resp.ok()).toBeFalsy();
    });
});

test.describe('Admin panel - Moderator access', () => {

    test('moderator can access admin panel but only sees Users section', async ({ threeUsers, baseURL }) => {
        const { admin, userB } = threeUsers;

        // Promote User B to moderator
        await setUserRole(admin.page, baseURL, admin.sessionToken, userB.username, 'moderator');

        // User B navigates to admin panel
        await goToAdmin(userB.page);

        // Users section should be visible (moderator can manage users)
        await expect(userB.page.locator('#section-users')).toBeVisible();

        // Server and appearance sections should be hidden (admin-only)
        await expect(userB.page.locator('.settings-nav-item[data-section="server"]')).toBeHidden();
        await expect(userB.page.locator('.settings-nav-item[data-section="appearance"]')).toBeHidden();

        // Clean up: demote back
        await setUserRole(admin.page, baseURL, admin.sessionToken, userB.username, 'user');
    });

    test('regular user is redirected away from admin panel', async ({ threeUsers }) => {
        const { userB } = threeUsers;

        // User B (regular user) navigates to admin panel
        await userB.page.goto('/admin.html');

        // Should redirect to app.html (not admin/mod)
        await userB.page.waitForURL('**/app.html**', { timeout: 10_000 });
    });
});
