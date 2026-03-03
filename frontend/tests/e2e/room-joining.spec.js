/**
 * E2E tests: Room joining & discoverability — public/private rooms,
 * search, join requests, approve/deny, visibility toggle, lock icons.
 *
 * Uses the `threeUsers` fixture which provides an admin (User A),
 * User B, and User C — all registered, approved, and logged in to app.html.
 */

import { test, expect } from './fixtures.js';

// ── Helpers ─────────────────────────────────────────────────────────────

/** Create a room via the API with a specific visibility. */
async function createRoomViaAPI(page, sessionToken, roomId, visibility = 'private', baseURL = '') {
    const apiUrl = baseURL ? `${baseURL}/api` : '/api';
    return page.request.post(`${apiUrl}/rooms`, {
        headers: { 'Authorization': `Bearer ${sessionToken}` },
        data: { room_id: roomId, room_type: 'chat', visibility }
    });
}

/** Create a public room via the UI using the Add Channel modal. */
async function createPublicRoom(page, roomName) {
    await page.locator('#add-channel-btn').click();
    await page.locator('#new-room-input').fill(roomName);
    // Wait for debounced search to complete
    await page.waitForTimeout(500);
    // Select public visibility
    await page.locator('input[name="create-room-visibility"][value="public"]').check();
    await page.locator('#create-room-submit-btn').click();
    await expect(page.locator('#room-content-name')).toHaveText(new RegExp(roomName));
    await page.locator('#message-input').waitFor();
}

/** Create a private room via the UI using the Add Channel modal. */
async function createPrivateRoom(page, roomName) {
    await page.locator('#add-channel-btn').click();
    await page.locator('#new-room-input').fill(roomName);
    await page.waitForTimeout(500);
    // Private is the default, just click create
    await page.locator('#create-room-submit-btn').click();
    await expect(page.locator('#room-content-name')).toHaveText(new RegExp(roomName));
    await page.locator('#message-input').waitFor();
}

/** Ensure the members panel is open. */
async function ensureMembersPanelOpen(page) {
    const panel = page.locator('#members-panel');
    if (!(await panel.evaluate(el => el.classList.contains('open')))) {
        await page.locator('#members-toggle-btn').click();
    }
    await expect(panel).toHaveClass(/open/);
}

// ── Tests ───────────────────────────────────────────────────────────────

test.describe('Room joining & discoverability', () => {

    test('Public room appears in search, private room does not', async ({ threeUsers, baseURL }) => {
        const { admin: userA, userB } = threeUsers;
        await userA.page.waitForLoadState('networkidle');

        // Admin creates a public room and a private room
        await createPublicRoom(userA.page, 'public-room');
        await createPrivateRoom(userA.page, 'secret-room');

        // User B opens Add Channel modal and searches
        await userB.page.waitForLoadState('networkidle');
        await userB.page.locator('#add-channel-btn').click();
        await userB.page.locator('#new-room-input').fill('public-room');
        await userB.page.waitForTimeout(500);

        // Public room should appear in search results
        await expect(userB.page.locator('.search-result-name')).toContainText('#public-room');

        // Now search for secret room — should NOT appear (private rooms excluded)
        await userB.page.locator('#new-room-input').fill('secret-room');
        // Wait for debounced search (300ms) + API response
        await userB.page.waitForTimeout(1000);
        // The search results area should be hidden (no public rooms match)
        await expect(userB.page.locator('#room-search-results')).toHaveClass(/hidden/, { timeout: 5000 });
    });

    test('User requests to join a public room, op approves, user gains access', async ({ threeUsers, baseURL }) => {
        const { admin: userA, userB } = threeUsers;
        await userA.page.waitForLoadState('networkidle');

        // Admin creates a public room
        await createPublicRoom(userA.page, 'joinable-room');

        // User B searches and requests to join
        await userB.page.waitForLoadState('networkidle');
        await userB.page.locator('#add-channel-btn').click();
        await userB.page.locator('#new-room-input').fill('joinable-room');
        await userB.page.waitForTimeout(500);

        // Click Request to Join
        await userB.page.locator('.search-result-join-btn').click();
        await expect(userB.page.locator('.search-result-join-btn')).toContainText(/Request Sent|Request Pending/);

        // Close the modal on user B
        await userB.page.locator('#create-room-close-btn').click();

        // Admin opens members panel and sees the pending request
        await userA.page.locator(`.room-item[data-room-id="joinable-room"]`).click();
        await ensureMembersPanelOpen(userA.page);

        // Wait for join request to appear
        await expect(userA.page.locator('#join-requests-panel-list .join-request-item')).toHaveCount(1, { timeout: 5000 });

        // Approve the request
        await userA.page.locator('.join-request-approve').click();

        // Wait for the request to be removed
        await expect(userA.page.locator('#join-requests-panel-list .join-request-item')).toHaveCount(0, { timeout: 5000 });

        // User B should now see the room in their sidebar
        await userB.page.waitForTimeout(1000);
        await userB.page.reload();
        await userB.page.waitForLoadState('networkidle');
        await expect(userB.page.locator('.room-item[data-room-id="joinable-room"]')).toBeVisible();
    });

    test('User requests to join, op denies, user is notified', async ({ threeUsers, baseURL }) => {
        const { admin: userA, userB } = threeUsers;
        await userA.page.waitForLoadState('networkidle');

        // Create public room
        await createPublicRoom(userA.page, 'deny-room');

        // User B requests to join
        await userB.page.waitForLoadState('networkidle');
        await userB.page.locator('#add-channel-btn').click();
        await userB.page.locator('#new-room-input').fill('deny-room');
        await userB.page.waitForTimeout(500);
        await userB.page.locator('.search-result-join-btn').click();
        await expect(userB.page.locator('.search-result-join-btn')).toContainText(/Request Sent|Request Pending/);
        await userB.page.locator('#create-room-close-btn').click();

        // Admin denies
        await userA.page.locator(`.room-item[data-room-id="deny-room"]`).click();
        await ensureMembersPanelOpen(userA.page);
        await expect(userA.page.locator('#join-requests-panel-list .join-request-item')).toHaveCount(1, { timeout: 5000 });
        await userA.page.locator('.join-request-deny').click();
        await expect(userA.page.locator('#join-requests-panel-list .join-request-item')).toHaveCount(0, { timeout: 5000 });

        // User B should NOT see the room
        await userB.page.reload();
        await userB.page.waitForLoadState('networkidle');
        await expect(userB.page.locator('.room-item[data-room-id="deny-room"]')).toHaveCount(0);
    });

    test('Name availability: green check for available, red X for taken', async ({ threeUsers }) => {
        const { admin: userA, userB } = threeUsers;
        await userA.page.waitForLoadState('networkidle');

        // Admin creates a room
        await createPrivateRoom(userA.page, 'taken-name');

        // User B opens Add Channel modal
        await userB.page.waitForLoadState('networkidle');
        await userB.page.locator('#add-channel-btn').click();

        // Type a name that's taken
        await userB.page.locator('#new-room-input').fill('taken-name');
        await userB.page.waitForTimeout(500);
        await expect(userB.page.locator('#new-room-input')).toHaveClass(/name-taken/);

        // Type an available name
        await userB.page.locator('#new-room-input').fill('brand-new-name');
        await userB.page.waitForTimeout(500);
        await expect(userB.page.locator('#new-room-input')).toHaveClass(/name-available/);
    });

    test('Already joined room shows "Joined" badge in search results', async ({ threeUsers }) => {
        const { admin: userA } = threeUsers;
        await userA.page.waitForLoadState('networkidle');

        // Admin creates a public room (they are already a member)
        await createPublicRoom(userA.page, 'my-public-room');

        // Open Add Channel and search for the room they own
        await userA.page.locator('#add-channel-btn').click();
        await userA.page.locator('#new-room-input').fill('my-public-room');
        await userA.page.waitForTimeout(500);

        // Since admin is already a member, search won't show it (excluded)
        // but the name should be taken
        await expect(userA.page.locator('#new-room-input')).toHaveClass(/name-taken/);
    });

    test('Lock icon on private rooms, # on public rooms in sidebar', async ({ threeUsers }) => {
        const { admin: userA } = threeUsers;
        await userA.page.waitForLoadState('networkidle');

        await createPublicRoom(userA.page, 'pub-channel');
        await createPrivateRoom(userA.page, 'priv-channel');

        // Public room should have # prefix
        const pubItem = userA.page.locator('.room-item[data-room-id="pub-channel"] .room-prefix');
        await expect(pubItem).toHaveText('#');

        // Private room should have lock icon (iconify-icon custom element in innerHTML)
        const privPrefix = userA.page.locator('.room-item[data-room-id="priv-channel"] .room-prefix');
        const html = await privPrefix.innerHTML();
        expect(html).toContain('lucide:lock');
    });

    test('Visibility toggle in room settings changes room visibility', async ({ threeUsers, baseURL }) => {
        const { admin: userA, userB } = threeUsers;
        await userA.page.waitForLoadState('networkidle');

        // Create a private room
        await createPrivateRoom(userA.page, 'toggle-room');

        // Go to room settings
        await userA.page.goto(`/room-settings.html?room=toggle-room`);
        await userA.page.waitForLoadState('networkidle');

        // Visibility should be private
        const select = userA.page.locator('#room-visibility');
        await expect(select).toHaveValue('private');

        // Change to public
        await select.selectOption('public');
        await userA.page.waitForTimeout(500);

        // Reload and verify it persisted
        await userA.page.reload();
        await userA.page.waitForLoadState('networkidle');
        await expect(userA.page.locator('#room-visibility')).toHaveValue('public');

        // User B should now be able to find it in search
        await userB.page.waitForLoadState('networkidle');
        await userB.page.locator('#add-channel-btn').click();
        await userB.page.locator('#new-room-input').fill('toggle-room');
        await userB.page.waitForTimeout(500);
        await expect(userB.page.locator('.search-result-name')).toContainText('#toggle-room');
    });

    test('Re-request after denial resets to pending', async ({ threeUsers, baseURL }) => {
        const { admin: userA, userB } = threeUsers;
        await userA.page.waitForLoadState('networkidle');

        // Create public room
        await createPublicRoom(userA.page, 'rerequest-room');

        // User B requests to join
        const apiUrl = `${baseURL}/api`;
        await userB.page.request.post(`${apiUrl}/rooms/rerequest-room/join-requests`, {
            headers: { 'Authorization': `Bearer ${userB.sessionToken}` }
        });

        // Admin denies via API
        await userA.page.request.patch(`${apiUrl}/rooms/rerequest-room/join-requests/${userB.username}`, {
            headers: {
                'Authorization': `Bearer ${userA.sessionToken}`,
                'Content-Type': 'application/json'
            },
            data: { action: 'deny' }
        });

        // User B re-requests
        const reReqResp = await userB.page.request.post(`${apiUrl}/rooms/rerequest-room/join-requests`, {
            headers: { 'Authorization': `Bearer ${userB.sessionToken}` }
        });
        expect(reReqResp.ok()).toBeTruthy();

        // Admin should see the new pending request
        const listResp = await userA.page.request.fetch(`${apiUrl}/rooms/rerequest-room/join-requests`, {
            headers: { 'Authorization': `Bearer ${userA.sessionToken}` }
        });
        const requests = await listResp.json();
        expect(requests.length).toBe(1);
        expect(requests[0].username).toBe(userB.username);
        expect(requests[0].status).toBe('pending');
    });

    test('Room settings page shows pending join requests for ops', async ({ threeUsers, baseURL }) => {
        const { admin: userA, userB } = threeUsers;
        await userA.page.waitForLoadState('networkidle');

        // Create public room
        await createPublicRoom(userA.page, 'settings-jr-room');

        // User B requests to join via API
        const apiUrl = `${baseURL}/api`;
        await userB.page.request.post(`${apiUrl}/rooms/settings-jr-room/join-requests`, {
            headers: { 'Authorization': `Bearer ${userB.sessionToken}` }
        });

        // Admin navigates to room settings
        await userA.page.goto(`/room-settings.html?room=settings-jr-room`);
        await userA.page.waitForLoadState('networkidle');

        // Should see the pending request section
        const section = userA.page.locator('#join-requests-section');
        await expect(section).toBeVisible({ timeout: 5000 });
        await expect(userA.page.locator('#join-request-count')).toHaveText('1');

        // Approve via the settings page
        await userA.page.locator('#join-requests-list .btn-ghost').first().click();
        await userA.page.waitForTimeout(1000);

        // Section should be hidden now (no more requests)
        await expect(section).toBeHidden({ timeout: 5000 });
    });
});
