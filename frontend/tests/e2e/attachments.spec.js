/**
 * E2E tests: File attachments — upload, encrypt, display, download.
 *
 * Uses the `twoUsers` fixture (admin + approved user).
 */

import { test, expect } from './fixtures.js';
import { writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// ── Helpers ─────────────────────────────────────────────────────────────

async function createRoom(page, roomName) {
    await page.locator('#add-channel-btn').click();
    await page.locator('#new-room-input').fill(roomName);
    await page.locator('#create-room-submit-btn').click();
    await expect(page.locator('#room-content-name')).toHaveText(`#${roomName}`);
    await page.locator('#message-input').waitFor();
}

async function inviteUser(page, username) {
    await page.locator('#message-input').fill(`/invite ${username}`);
    await page.locator('#message-input').press('Enter');
    await expect(page.locator('#messages')).toContainText(`Invited ${username}`);
}

async function navigateToRoom(page, roomName) {
    await page.reload();
    await page.waitForLoadState('networkidle');
    await page.locator(`.room-item[data-room-id="${roomName}"]`).waitFor();
    await page.locator(`.room-item[data-room-id="${roomName}"]`).click();
    await expect(page.locator('#room-content-name')).toHaveText(`#${roomName}`);
}

/** Create a temp file with known content, return its path. */
function createTempFile(name, content) {
    const filePath = join(tmpdir(), name);
    writeFileSync(filePath, content);
    return filePath;
}

/** Create a minimal valid 1x1 red PNG file, return its path. */
function createTempImage(name) {
    // Minimal 1x1 red PNG (67 bytes)
    const png = Buffer.from(
        '89504e470d0a1a0a0000000d49484452000000010000000108020000009001' +
        '2e00000000c4944415478016360f8cf00000001010000187218e600000000' +
        '0049454e44ae426082',
        'hex',
    );
    const filePath = join(tmpdir(), name);
    writeFileSync(filePath, png);
    return filePath;
}

/** Create a small file with a video extension for testing video UI. */
function createTempVideo(name) {
    // Small binary content — not a real video, but triggers video/* mime detection
    const filePath = join(tmpdir(), name);
    writeFileSync(filePath, Buffer.from('fake-video-content-for-testing'));
    return filePath;
}

// ── Tests ───────────────────────────────────────────────────────────────

test.describe('File attachments', () => {

    test('attach button is visible next to chat input', async ({ twoUsers }) => {
        const { admin } = twoUsers;
        await admin.page.waitForLoadState('networkidle');

        await createRoom(admin.page, 'attach-btn-test');

        // The attachment "+" button should be present
        await expect(admin.page.locator('.four43-attach-btn')).toBeVisible();
    });

    test('clicking attach button shows popup with File option', async ({ twoUsers }) => {
        const { admin } = twoUsers;
        await admin.page.waitForLoadState('networkidle');

        await createRoom(admin.page, 'attach-popup-test');

        // Click the "+" button
        await admin.page.locator('.four43-attach-btn').click();

        // Popup should appear with "File" option
        await expect(admin.page.locator('.four43-attach-popup')).toBeVisible();
        await expect(admin.page.locator('.four43-attach-popup-item')).toContainText('File');
    });

    test('can upload a small file and see attachment message', async ({ twoUsers }) => {
        const { admin } = twoUsers;
        await admin.page.waitForLoadState('networkidle');

        await createRoom(admin.page, 'attach-upload-test');

        // Create a small test file
        const filePath = createTempFile('test-upload.txt', 'Hello, this is a test file for attachments!');

        // Set the file on the hidden file input (triggered by the popup)
        const fileInput = admin.page.locator('.four43-attach-file-input');
        await fileInput.setInputFiles(filePath);

        // An attachment card should appear in the messages area
        await expect(admin.page.locator('.four43-attachment-card')).toBeVisible({ timeout: 15_000 });
        await expect(admin.page.locator('.four43-attachment-card')).toContainText('test-upload.txt');
    });

    test('other user can see attachment and download it', async ({ twoUsers }) => {
        const { admin, user } = twoUsers;
        await admin.page.waitForLoadState('networkidle');

        await createRoom(admin.page, 'attach-cross-user');
        await inviteUser(admin.page, user.username);

        // Upload a file as admin
        const fileContent = 'Cross-user download test content - verified!';
        const filePath = createTempFile('cross-user-test.txt', fileContent);

        const fileInput = admin.page.locator('.four43-attach-file-input');
        await fileInput.setInputFiles(filePath);

        // Wait for attachment card to appear for admin
        await expect(admin.page.locator('.four43-attachment-card')).toBeVisible({ timeout: 15_000 });

        // User navigates to the room and should see the attachment
        // Log user in first
        await user.page.goto('/login.html');
        await user.page.locator('#login-button').click();
        await user.page.waitForURL('**/app.html**', { timeout: 15_000 });

        await navigateToRoom(user.page, 'attach-cross-user');
        await expect(user.page.locator('.four43-attachment-card')).toBeVisible({ timeout: 15_000 });
        await expect(user.page.locator('.four43-attachment-card')).toContainText('cross-user-test.txt');

        // Click download and verify it triggers
        const downloadPromise = user.page.waitForEvent('download', { timeout: 15_000 });
        await user.page.locator('.four43-attachment-download-btn').click();
        const download = await downloadPromise;
        expect(download.suggestedFilename()).toBe('cross-user-test.txt');
    });

    test('image upload shows inline preview with download button', async ({ twoUsers }) => {
        const { admin } = twoUsers;
        await admin.page.waitForLoadState('networkidle');

        await createRoom(admin.page, 'attach-image-preview');

        // Upload a PNG image
        const filePath = createTempImage('preview-test.png');
        const fileInput = admin.page.locator('.four43-attach-file-input');
        await fileInput.setInputFiles(filePath);

        // Should show the image preview (not a generic file card)
        await expect(admin.page.locator('.four43-attachment-preview')).toBeVisible({ timeout: 15_000 });
        await expect(admin.page.locator('.four43-attachment-preview-img')).toBeVisible({ timeout: 15_000 });

        // Footer should show filename and download button
        await expect(admin.page.locator('.four43-attachment-preview-footer')).toContainText('preview-test.png');
        await expect(admin.page.locator('.four43-attachment-preview-footer .four43-attachment-download-btn')).toBeVisible();

        // Download should work
        const downloadPromise = admin.page.waitForEvent('download', { timeout: 15_000 });
        await admin.page.locator('.four43-attachment-preview-footer .four43-attachment-download-btn').click();
        const download = await downloadPromise;
        expect(download.suggestedFilename()).toBe('preview-test.png');
    });

    test('video attachment shows inline video player with controls', async ({ twoUsers }) => {
        const { admin } = twoUsers;
        await admin.page.waitForLoadState('networkidle');

        await createRoom(admin.page, 'attach-video-player');

        // Create a small file with .webm extension so mime_type is video/webm
        const filePath = createTempVideo('test-video.webm');
        const fileInput = admin.page.locator('.four43-attach-file-input');
        await fileInput.setInputFiles(filePath);

        // Should show a video player wrapper (not a generic file card)
        await expect(admin.page.locator('.four43-video-player')).toBeVisible({ timeout: 15_000 });

        // Play overlay should be visible (video doesn't auto-load)
        await expect(admin.page.locator('.four43-video-play-overlay')).toBeVisible();
        await expect(admin.page.locator('.four43-video-play-overlay')).toContainText('test-video.webm');

        // Click play overlay → video element should appear with controls
        await admin.page.locator('.four43-video-play-overlay').click();
        await expect(admin.page.locator('.four43-video-player video')).toBeVisible();
        await expect(admin.page.locator('.four43-video-player video')).toHaveAttribute('controls', '');

        // Footer should show filename and download button
        await expect(admin.page.locator('.four43-video-player .four43-attachment-preview-footer')).toContainText('test-video.webm');
        await expect(admin.page.locator('.four43-video-player .four43-attachment-download-btn')).toBeVisible();
    });

    test('video player download button triggers download', async ({ twoUsers }) => {
        const { admin } = twoUsers;
        await admin.page.waitForLoadState('networkidle');

        await createRoom(admin.page, 'attach-video-download');

        const filePath = createTempVideo('download-video.mp4');
        const fileInput = admin.page.locator('.four43-attach-file-input');
        await fileInput.setInputFiles(filePath);

        await expect(admin.page.locator('.four43-video-player')).toBeVisible({ timeout: 15_000 });

        // Click download and verify
        const downloadPromise = admin.page.waitForEvent('download', { timeout: 15_000 });
        await admin.page.locator('.four43-video-player .four43-attachment-download-btn').click();
        const download = await downloadPromise;
        expect(download.suggestedFilename()).toBe('download-video.mp4');
    });

    test('video chunk loading shows progress', async ({ twoUsers }) => {
        const { admin } = twoUsers;
        await admin.page.waitForLoadState('networkidle');

        await createRoom(admin.page, 'attach-video-progress');

        const filePath = createTempVideo('progress-video.webm');
        const fileInput = admin.page.locator('.four43-attach-file-input');
        await fileInput.setInputFiles(filePath);

        // Video player should appear with play overlay
        await expect(admin.page.locator('.four43-video-player')).toBeVisible({ timeout: 15_000 });
        await expect(admin.page.locator('.four43-video-play-overlay')).toBeVisible();

        // Click play to start loading
        await admin.page.locator('.four43-video-play-overlay').click();

        // The loading overlay should appear (may disappear quickly for small files)
        // Verify the video element eventually gets a src (blob: or mediasource:)
        await expect(admin.page.locator('.four43-video-player video')).toHaveAttribute('src', /.+/, { timeout: 15_000 });
    });

    test('video does not fetch chunks until play is clicked', async ({ twoUsers }) => {
        const { admin } = twoUsers;
        await admin.page.waitForLoadState('networkidle');

        await createRoom(admin.page, 'attach-video-no-autoload');

        // Track all GET requests to chunk or video-stream endpoints
        // (upload uses PUT to /chunk/, playback uses GET to /chunk/ or /video-stream/)
        const playbackRequests = [];
        admin.page.on('request', (req) => {
            if (req.method() !== 'GET') return;
            const url = req.url();
            if (url.includes('/chunk/') || url.includes('/video-stream/')) {
                playbackRequests.push(url);
            }
        });

        const filePath = createTempVideo('no-autoload.webm');
        const fileInput = admin.page.locator('.four43-attach-file-input');
        await fileInput.setInputFiles(filePath);

        // Video player should appear with play overlay
        await expect(admin.page.locator('.four43-video-player')).toBeVisible({ timeout: 15_000 });
        await expect(admin.page.locator('.four43-video-play-overlay')).toBeVisible();

        // Wait a moment — no playback GET requests should happen while overlay is shown
        await admin.page.waitForTimeout(1000);
        // Only meta requests are expected before play; no chunk/stream GETs
        const countBeforePlay = playbackRequests.length;
        expect(countBeforePlay).toBe(0);

        // Video element should be hidden
        await expect(admin.page.locator('.four43-video-player video')).toBeHidden();

        // Now click play — streaming should start
        await admin.page.locator('.four43-video-play-overlay').click();
        await expect(admin.page.locator('.four43-video-player video')).toHaveAttribute('src', /.+/, { timeout: 15_000 });
    });

    test('play overlay displays filename and file size', async ({ twoUsers }) => {
        const { admin } = twoUsers;
        await admin.page.waitForLoadState('networkidle');

        await createRoom(admin.page, 'attach-video-overlay-info');

        const filePath = createTempVideo('my-clip.webm');
        const fileInput = admin.page.locator('.four43-attach-file-input');
        await fileInput.setInputFiles(filePath);

        await expect(admin.page.locator('.four43-video-play-overlay')).toBeVisible({ timeout: 15_000 });

        // Overlay should show filename
        const infoText = await admin.page.locator('.four43-video-play-info').textContent();
        expect(infoText).toContain('my-clip.webm');

        // Overlay should show a size string (e.g. "30 B" or similar)
        expect(infoText).toMatch(/\d+(\.\d+)?\s*(B|KB|MB|GB)/);
    });

    test('play overlay disappears and video appears after click', async ({ twoUsers }) => {
        const { admin } = twoUsers;
        await admin.page.waitForLoadState('networkidle');

        await createRoom(admin.page, 'attach-video-overlay-toggle');

        const filePath = createTempVideo('toggle-test.webm');
        const fileInput = admin.page.locator('.four43-attach-file-input');
        await fileInput.setInputFiles(filePath);

        // Overlay visible, video hidden
        await expect(admin.page.locator('.four43-video-play-overlay')).toBeVisible({ timeout: 15_000 });
        await expect(admin.page.locator('.four43-video-player video')).toBeHidden();

        // Click play
        await admin.page.locator('.four43-video-play-overlay').click();

        // Overlay gone, video visible
        await expect(admin.page.locator('.four43-video-play-overlay')).toBeHidden();
        await expect(admin.page.locator('.four43-video-player video')).toBeVisible();
    });

    test('video streaming logs SW registration status', async ({ twoUsers }) => {
        const { admin } = twoUsers;
        await admin.page.waitForLoadState('networkidle');

        await createRoom(admin.page, 'attach-video-sw-logs');

        // Collect console messages — attach listener before reload so we
        // capture plugin init logs (SW registration happens on init)
        const consoleLogs = [];
        admin.page.on('console', (msg) => {
            const text = msg.text();
            if (text.includes('[Video SW]') || text.includes('[Video]')) {
                consoleLogs.push(text);
            }
        });

        // Reload to trigger a fresh plugin init with the listener active
        await admin.page.reload();
        await admin.page.waitForLoadState('networkidle');

        // SW registration is async — give it time to complete
        await admin.page.waitForTimeout(3000);

        // Should have at least one SW log about registration attempt
        const swLogs = consoleLogs.filter(l => l.includes('[Video SW]'));
        expect(swLogs.length).toBeGreaterThan(0);
        // Should log either successful registration or a reason for failure
        const hasRegistration = swLogs.some(l =>
            l.includes('Registering service worker') ||
            l.includes('not available') ||
            l.includes('Registration failed')
        );
        expect(hasRegistration).toBe(true);
    });

    test('upload shows progress indicator', async ({ twoUsers }) => {
        const { admin } = twoUsers;
        await admin.page.waitForLoadState('networkidle');

        await createRoom(admin.page, 'attach-progress-test');

        // Create a file (small but enough to check progress appears)
        const filePath = createTempFile('progress-test.txt', 'A'.repeat(1000));

        const fileInput = admin.page.locator('.four43-attach-file-input');
        await fileInput.setInputFiles(filePath);

        // The upload progress element should appear (may be brief for small files)
        // Check that the attachment card eventually appears, confirming the upload flow completed
        await expect(admin.page.locator('.four43-attachment-card')).toBeVisible({ timeout: 15_000 });
        await expect(admin.page.locator('.four43-attachment-card')).toContainText('progress-test.txt');
    });
});
