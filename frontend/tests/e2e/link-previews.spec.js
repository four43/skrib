/**
 * E2E tests: Link previews in chat messages.
 *
 * Tests URL linkification, image previews, and OpenGraph preview cards.
 */

import { test, expect } from './fixtures.js';

// ── Helpers ─────────────────────────────────────────────────────────────

async function createRoom(page, roomName) {
    await page.locator('#add-channel-btn').click();
    await page.locator('#new-room-input').fill(roomName);
    await page.locator('#create-room-submit-btn').click();
    await expect(page.locator('#room-content-name')).toHaveText(`#${roomName}`);
    await page.locator('#message-input').waitFor();
}

async function sendMessage(page, text) {
    await page.locator('#message-input').fill(text);
    await page.locator('#message-input').press('Enter');
}

// 1x1 transparent PNG as a data buffer for mocking image responses
const TINY_PNG = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVQI12NgAAIABQAB' +
    'Nl7BcQAAAABJRU5ErkJggg==',
    'base64',
);

// ── Tests ───────────────────────────────────────────────────────────────

test.describe('Link previews', () => {

    test('URLs in messages become clickable links', async ({ threeUsers }) => {
        const { admin: userA } = threeUsers;
        await userA.page.waitForLoadState('networkidle');

        await createRoom(userA.page, 'link-room');
        await sendMessage(userA.page, 'Check out https://example.com for details');

        // Wait for the message to appear
        await expect(userA.page.locator('#messages')).toContainText('Check out');

        // The URL should be wrapped in an <a> tag
        const link = userA.page.locator('#messages a[href="https://example.com"]');
        await expect(link).toBeVisible();
        await expect(link).toHaveText('https://example.com');
        await expect(link).toHaveAttribute('target', '_blank');
        await expect(link).toHaveAttribute('rel', /noopener/);
    });

    test('Multiple URLs in a single message all become links', async ({ threeUsers }) => {
        const { admin: userA } = threeUsers;
        await userA.page.waitForLoadState('networkidle');

        await createRoom(userA.page, 'multi-link-room');
        await sendMessage(userA.page, 'Visit https://example.com and http://test.org today');

        await expect(userA.page.locator('#messages')).toContainText('Visit');

        const links = userA.page.locator('#messages .message-text a');
        await expect(links).toHaveCount(2);
        await expect(links.nth(0)).toHaveAttribute('href', 'https://example.com');
        await expect(links.nth(1)).toHaveAttribute('href', 'http://test.org');
    });

    test('Image URLs render as inline image previews', async ({ threeUsers, baseURL }) => {
        const { admin: userA } = threeUsers;
        await userA.page.waitForLoadState('networkidle');

        await createRoom(userA.page, 'image-link-room');

        // Use a real image URL from the test server (avatar endpoint returns PNG)
        // Append .png so client-side isImageUrl() detects it as an image
        const imageUrl = `${baseURL}/api/users/${encodeURIComponent(userA.username)}/avatar`;
        // Route the avatar URL with .png suffix to the real avatar endpoint
        await userA.page.route(`${imageUrl}.png`, route =>
            route.fetch({ url: imageUrl }).then(resp =>
                route.fulfill({ response: resp }),
            ),
        );
        await sendMessage(userA.page, `Look at this: ${imageUrl}.png`);

        await expect(userA.page.locator('#messages')).toContainText('Look at this');

        const preview = userA.page.locator('#messages .link-preview-image');
        await expect(preview).toBeVisible({ timeout: 5000 });

        // The image should have loaded successfully (no error class)
        await expect(preview).not.toHaveClass(/link-preview-error/);
    });

    test('Link preview card appears for web page URLs', async ({ threeUsers, baseURL }) => {
        const { admin: userA } = threeUsers;
        await userA.page.waitForLoadState('networkidle');

        // Mock the backend link-preview API to return OG data
        await userA.page.route(`${baseURL}/api/plugins/four43.room-type-chat/link-preview**`, route =>
            route.fulfill({
                contentType: 'application/json',
                body: JSON.stringify({
                    url: 'http://example.com',
                    content_type: 'webpage',
                    title: 'Example Domain',
                    description: 'This domain is for use in illustrative examples.',
                    image: '',
                    site_name: 'Example',
                }),
            }),
        );

        await createRoom(userA.page, 'preview-card-room');
        await sendMessage(userA.page, 'Check http://example.com');

        await expect(userA.page.locator('#messages')).toContainText('Check');

        // The URL should be a clickable link
        const link = userA.page.locator('#messages .message-text a[href="http://example.com"]');
        await expect(link).toBeVisible({ timeout: 10000 });

        // A preview card should appear
        const previewCard = userA.page.locator('#messages .link-preview-card');
        await expect(previewCard).toBeVisible({ timeout: 10000 });

        // Card should contain the title
        await expect(previewCard.locator('.link-preview-card-title')).toHaveText('Example Domain');
    });

    test('Link preview is visible to other users in real-time', async ({ threeUsers }) => {
        const { admin: userA, userB } = threeUsers;
        await userA.page.waitForLoadState('networkidle');

        await createRoom(userA.page, 'preview-realtime');

        // Invite user B
        await userA.page.locator('#message-input').fill(`/invite ${userB.username}`);
        await userA.page.locator('#message-input').press('Enter');
        await expect(userA.page.locator('#messages')).toContainText(`Invited ${userB.username}`);

        // User B navigates to the room
        await userB.page.reload();
        await userB.page.waitForLoadState('networkidle');
        await userB.page.locator('.room-item[data-room-id="preview-realtime"]').waitFor();
        await userB.page.locator('.room-item[data-room-id="preview-realtime"]').click();
        await expect(userB.page.locator('#room-content-name')).toHaveText('#preview-realtime');

        // User A sends a message with a URL
        await sendMessage(userA.page, 'See https://example.com');

        // User B should see the link
        const link = userB.page.locator('#messages a[href="https://example.com"]');
        await expect(link).toBeVisible({ timeout: 5000 });
    });

    test('Link preview API endpoint returns preview data', async ({ threeUsers, baseURL }) => {
        const { admin: userA } = threeUsers;

        // Call the link preview API directly with an external URL
        const resp = await userA.page.request.get(
            `${baseURL}/api/plugins/four43.room-type-chat/link-preview?url=${encodeURIComponent('http://example.com')}`,
            {
                headers: {
                    'Authorization': `Bearer ${userA.sessionToken}`,
                },
            }
        );

        expect(resp.ok()).toBeTruthy();
        const data = await resp.json();
        expect(data).toHaveProperty('url');
        expect(data).toHaveProperty('title');
        expect(data.title).toBeTruthy();
    });

    test('GIF URLs render as inline image previews', async ({ threeUsers }) => {
        const { admin: userA } = threeUsers;
        await userA.page.waitForLoadState('networkidle');

        // Mock the GIF URL so the <img> loads
        await userA.page.route('**/cat.gif', route =>
            route.fulfill({ contentType: 'image/gif', body: TINY_PNG }),
        );

        await createRoom(userA.page, 'gif-room');
        await sendMessage(userA.page, 'Funny gif: https://example.com/cat.gif');

        await expect(userA.page.locator('#messages')).toContainText('Funny gif');

        const preview = userA.page.locator('#messages .link-preview-image');
        await expect(preview).toBeVisible({ timeout: 5000 });
        await expect(preview).not.toHaveClass(/link-preview-error/);
    });

    test('Preview toggle button hides and shows preview', async ({ threeUsers }) => {
        const { admin: userA } = threeUsers;
        await userA.page.waitForLoadState('networkidle');

        // Mock the image so it loads
        await userA.page.route('**/photo.jpg', route =>
            route.fulfill({ contentType: 'image/jpeg', body: TINY_PNG }),
        );

        await createRoom(userA.page, 'toggle-room');
        await sendMessage(userA.page, 'Photo: https://example.com/photo.jpg');

        await expect(userA.page.locator('#messages')).toContainText('Photo');

        const preview = userA.page.locator('#messages .link-preview-image');
        await expect(preview).toBeVisible({ timeout: 5000 });

        // Toggle button should be visible
        const toggleBtn = userA.page.locator('#messages .link-preview-toggle');
        await expect(toggleBtn).toBeVisible();
        await expect(toggleBtn).toContainText('Hide preview');

        // Click to hide
        await toggleBtn.click();
        await expect(preview).not.toBeVisible();
        await expect(toggleBtn).toContainText('Show preview');

        // Click to show again
        await toggleBtn.click();
        await expect(preview).toBeVisible();
        await expect(toggleBtn).toContainText('Hide preview');
    });
});
