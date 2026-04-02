/**
 * E2E tests: Emoji picker plugin — custom emoji CRUD via API,
 * picker UI open/search/select, integration with reactions and settings.
 *
 * Uses the `twoUsers` fixture (admin + regular user).
 */

import { test, expect } from './fixtures.js';
import { join } from 'path';

// 1x1 red PNG pixel (68 bytes)
const TINY_PNG = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==',
    'base64'
);

// 1x1 GIF
const TINY_GIF = Buffer.from(
    'R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==',
    'base64'
);

// ── API Helpers ─────────────────────────────────────────────────────────

async function uploadEmoji(page, baseURL, token, { shortcode, displayName, category, fileBuffer, contentType }) {
    const formData = new URLSearchParams();
    // Use fetch with FormData via page.evaluate for multipart
    return await page.evaluate(async ({ baseURL, token, shortcode, displayName, category, fileBase64, contentType }) => {
        const fileBytes = Uint8Array.from(atob(fileBase64), c => c.charCodeAt(0));
        const blob = new Blob([fileBytes], { type: contentType });
        const form = new FormData();
        form.append('shortcode', shortcode);
        form.append('display_name', displayName);
        form.append('category', category || 'custom');
        form.append('file', blob, `${shortcode}.${contentType === 'image/png' ? 'png' : 'gif'}`);

        const resp = await fetch(`${baseURL}/api/plugins/four43.emoji-picker/custom-emoji`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${token}` },
            body: form,
        });
        return { status: resp.status, body: await resp.json().catch(() => null) };
    }, {
        baseURL, token, shortcode, displayName, category,
        fileBase64: fileBuffer.toString('base64'),
        contentType: contentType || 'image/png',
    });
}

async function listEmoji(page, baseURL, token) {
    return await page.evaluate(async ({ baseURL, token }) => {
        const resp = await fetch(`${baseURL}/api/plugins/four43.emoji-picker/custom-emoji`, {
            headers: { 'Authorization': `Bearer ${token}` },
        });
        return { status: resp.status, body: await resp.json() };
    }, { baseURL, token });
}

async function deleteEmoji(page, baseURL, token, shortcode) {
    return await page.evaluate(async ({ baseURL, token, shortcode }) => {
        const resp = await fetch(`${baseURL}/api/plugins/four43.emoji-picker/custom-emoji/${shortcode}`, {
            method: 'DELETE',
            headers: { 'Authorization': `Bearer ${token}` },
        });
        return { status: resp.status };
    }, { baseURL, token, shortcode });
}

async function patchEmoji(page, baseURL, token, shortcode, updates) {
    return await page.evaluate(async ({ baseURL, token, shortcode, updates }) => {
        const resp = await fetch(`${baseURL}/api/plugins/four43.emoji-picker/custom-emoji/${shortcode}`, {
            method: 'PATCH',
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(updates),
        });
        return { status: resp.status, body: await resp.json().catch(() => null) };
    }, { baseURL, token, shortcode, updates });
}

async function getEmojiImage(page, baseURL, token, shortcode) {
    return await page.evaluate(async ({ baseURL, token, shortcode }) => {
        const resp = await fetch(`${baseURL}/api/plugins/four43.emoji-picker/custom-emoji/${shortcode}`, {
            headers: { 'Authorization': `Bearer ${token}` },
        });
        return {
            status: resp.status,
            contentType: resp.headers.get('content-type'),
            size: parseInt(resp.headers.get('content-length') || '0'),
        };
    }, { baseURL, token, shortcode });
}

// ── Tests: Custom Emoji CRUD ────────────────────────────────────────────

test.describe('Custom Emoji CRUD', () => {
    test('admin can upload a custom PNG emoji', async ({ twoUsers, baseURL }) => {
        const { admin } = twoUsers;

        const result = await uploadEmoji(admin.page, baseURL, admin.sessionToken, {
            shortcode: 'test-emoji',
            displayName: 'Test Emoji',
            fileBuffer: TINY_PNG,
            contentType: 'image/png',
        });

        expect(result.status).toBe(201);
        expect(result.body.shortcode).toBe('test-emoji');
        expect(result.body.display_name).toBe('Test Emoji');
        expect(result.body.category).toBe('custom');
        expect(result.body.url).toContain('/custom-emoji/test-emoji');
    });

    test('admin can upload a custom GIF emoji', async ({ twoUsers, baseURL }) => {
        const { admin } = twoUsers;

        const result = await uploadEmoji(admin.page, baseURL, admin.sessionToken, {
            shortcode: 'party-parrot',
            displayName: 'Party Parrot',
            fileBuffer: TINY_GIF,
            contentType: 'image/gif',
        });

        expect(result.status).toBe(201);
        expect(result.body.shortcode).toBe('party-parrot');
    });

    test('non-admin cannot upload custom emoji', async ({ twoUsers, baseURL }) => {
        const { user } = twoUsers;

        // Log in the regular user first
        await user.page.goto('/login.html');
        await user.page.locator('#login-button').click();
        await user.page.waitForURL('**/app.html**', { timeout: 15_000 });
        user.sessionToken = await user.page.evaluate(() => localStorage.getItem('session_token'));

        const result = await uploadEmoji(user.page, baseURL, user.sessionToken, {
            shortcode: 'sneaky',
            displayName: 'Sneaky',
            fileBuffer: TINY_PNG,
            contentType: 'image/png',
        });

        expect(result.status).toBe(403);
    });

    test('rejects invalid shortcode with uppercase', async ({ twoUsers, baseURL }) => {
        const { admin } = twoUsers;

        const result = await uploadEmoji(admin.page, baseURL, admin.sessionToken, {
            shortcode: 'Bad-Code',
            displayName: 'Bad',
            fileBuffer: TINY_PNG,
            contentType: 'image/png',
        });

        expect(result.status).toBe(400);
    });

    test('rejects shortcode with underscores', async ({ twoUsers, baseURL }) => {
        const { admin } = twoUsers;

        const result = await uploadEmoji(admin.page, baseURL, admin.sessionToken, {
            shortcode: 'bad_code',
            displayName: 'Bad',
            fileBuffer: TINY_PNG,
            contentType: 'image/png',
        });

        expect(result.status).toBe(400);
    });

    test('rejects duplicate shortcode', async ({ twoUsers, baseURL }) => {
        const { admin } = twoUsers;

        // Upload first
        await uploadEmoji(admin.page, baseURL, admin.sessionToken, {
            shortcode: 'dupe-test',
            displayName: 'First',
            fileBuffer: TINY_PNG,
            contentType: 'image/png',
        });

        // Upload same shortcode
        const result = await uploadEmoji(admin.page, baseURL, admin.sessionToken, {
            shortcode: 'dupe-test',
            displayName: 'Second',
            fileBuffer: TINY_PNG,
            contentType: 'image/png',
        });

        expect(result.status).toBe(400);
        expect(result.body.detail).toContain('already exists');
    });

    test('rejects non-image file type', async ({ twoUsers, baseURL }) => {
        const { admin } = twoUsers;

        const result = await uploadEmoji(admin.page, baseURL, admin.sessionToken, {
            shortcode: 'not-image',
            displayName: 'Not Image',
            fileBuffer: Buffer.from('hello world'),
            contentType: 'text/plain',
        });

        expect(result.status).toBe(400);
    });

    test('can list uploaded custom emoji', async ({ twoUsers, baseURL }) => {
        const { admin } = twoUsers;

        // Upload two emoji
        await uploadEmoji(admin.page, baseURL, admin.sessionToken, {
            shortcode: 'alpha',
            displayName: 'Alpha',
            fileBuffer: TINY_PNG,
            contentType: 'image/png',
        });
        await uploadEmoji(admin.page, baseURL, admin.sessionToken, {
            shortcode: 'beta',
            displayName: 'Beta',
            fileBuffer: TINY_GIF,
            contentType: 'image/gif',
        });

        const result = await listEmoji(admin.page, baseURL, admin.sessionToken);

        expect(result.status).toBe(200);
        expect(result.body).toHaveLength(2);
        expect(result.body[0].shortcode).toBe('alpha');
        expect(result.body[1].shortcode).toBe('beta');
    });

    test('can serve custom emoji image', async ({ twoUsers, baseURL }) => {
        const { admin } = twoUsers;

        await uploadEmoji(admin.page, baseURL, admin.sessionToken, {
            shortcode: 'serve-test',
            displayName: 'Serve Test',
            fileBuffer: TINY_PNG,
            contentType: 'image/png',
        });

        const result = await getEmojiImage(admin.page, baseURL, admin.sessionToken, 'serve-test');
        expect(result.status).toBe(200);
        expect(result.contentType).toContain('image/png');
    });

    test('admin can update emoji metadata', async ({ twoUsers, baseURL }) => {
        const { admin } = twoUsers;

        await uploadEmoji(admin.page, baseURL, admin.sessionToken, {
            shortcode: 'update-me',
            displayName: 'Old Name',
            fileBuffer: TINY_PNG,
            contentType: 'image/png',
        });

        const result = await patchEmoji(admin.page, baseURL, admin.sessionToken, 'update-me', {
            display_name: 'New Name',
            category: 'reactions',
        });

        expect(result.status).toBe(200);
        expect(result.body.display_name).toBe('New Name');
        expect(result.body.category).toBe('reactions');
    });

    test('admin can delete custom emoji', async ({ twoUsers, baseURL }) => {
        const { admin } = twoUsers;

        await uploadEmoji(admin.page, baseURL, admin.sessionToken, {
            shortcode: 'delete-me',
            displayName: 'Delete Me',
            fileBuffer: TINY_PNG,
            contentType: 'image/png',
        });

        const deleteResult = await deleteEmoji(admin.page, baseURL, admin.sessionToken, 'delete-me');
        expect(deleteResult.status).toBe(204);

        // Verify it's gone
        const listResult = await listEmoji(admin.page, baseURL, admin.sessionToken);
        expect(listResult.body.find(e => e.shortcode === 'delete-me')).toBeUndefined();
    });

    test('returns 404 for non-existent emoji image', async ({ twoUsers, baseURL }) => {
        const { admin } = twoUsers;

        const result = await getEmojiImage(admin.page, baseURL, admin.sessionToken, 'does-not-exist');
        expect(result.status).toBe(404);
    });

    test('non-admin cannot delete custom emoji', async ({ twoUsers, baseURL }) => {
        const { admin, user } = twoUsers;

        // Upload as admin
        await uploadEmoji(admin.page, baseURL, admin.sessionToken, {
            shortcode: 'protected',
            displayName: 'Protected',
            fileBuffer: TINY_PNG,
            contentType: 'image/png',
        });

        // Log in regular user
        await user.page.goto('/login.html');
        await user.page.locator('#login-button').click();
        await user.page.waitForURL('**/app.html**', { timeout: 15_000 });
        user.sessionToken = await user.page.evaluate(() => localStorage.getItem('session_token'));

        // Try to delete as regular user
        const result = await deleteEmoji(user.page, baseURL, user.sessionToken, 'protected');
        expect(result.status).toBe(403);
    });
});

// ── Tests: Picker UI ────────────────────────────────────────────────

// Helpers for picker UI tests
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
    await expect(page.locator('#messages')).toContainText(text);
}

test.describe('Emoji Picker UI', () => {
    test('picker opens from reactions + button and shows categories', async ({ registeredUser }) => {
        const { page } = registeredUser;

        await createRoom(page, 'picker-test');
        await sendMessage(page, 'test message for picker');

        // Click message to show hover bar
        const msg = page.locator('.message', { hasText: 'test message for picker' }).first();
        await msg.click();
        await expect(msg.locator('.message-hover-bar')).toHaveClass(/active/);

        // Click the "+" button
        await msg.locator('.four43-hover-emoji-plus').click();

        // Picker should appear
        const picker = page.locator('.emoji-picker');
        await expect(picker).toBeVisible();

        // Should have category tabs
        await expect(picker.locator('.emoji-picker-cat-btn').first()).toBeVisible();

        // Should have emoji buttons in the grid
        await expect(picker.locator('.emoji-picker-emoji-btn').first()).toBeVisible();

        // Close with Escape
        await page.keyboard.press('Escape');
        await expect(picker).not.toBeVisible();
    });

    test('picker search filters emoji', async ({ registeredUser }) => {
        const { page } = registeredUser;

        await createRoom(page, 'search-test');
        await sendMessage(page, 'search test message');

        // Open picker
        const msg = page.locator('.message', { hasText: 'search test message' }).first();
        await msg.click();
        await msg.locator('.four43-hover-emoji-plus').click();

        const picker = page.locator('.emoji-picker');
        await expect(picker).toBeVisible();

        // Search for "heart"
        await picker.locator('input').fill('heart');
        await page.waitForTimeout(200); // debounce

        // Should show heart-related emoji
        const results = picker.locator('.emoji-picker-emoji-btn');
        const count = await results.count();
        expect(count).toBeGreaterThan(0);
        expect(count).toBeLessThan(50); // filtered, not all emoji

        // Close
        await page.keyboard.press('Escape');
    });

    test('selecting emoji from picker adds reaction', async ({ registeredUser }) => {
        const { page } = registeredUser;

        await createRoom(page, 'select-test');
        await sendMessage(page, 'reaction select test');

        // Open picker via + button
        const msg = page.locator('.message', { hasText: 'reaction select test' }).first();
        await msg.click();
        await msg.locator('.four43-hover-emoji-plus').click();

        const picker = page.locator('.emoji-picker');
        await expect(picker).toBeVisible();

        // Click the first emoji button
        await picker.locator('.emoji-picker-emoji-btn').first().click();

        // Picker should close
        await expect(picker).not.toBeVisible();

        // A reaction should appear on the message
        await expect(msg.locator('.four43-reaction-btn')).toBeVisible({ timeout: 5000 });
    });

    test('picker closes on outside click', async ({ registeredUser }) => {
        const { page } = registeredUser;

        await createRoom(page, 'outside-click-test');
        await sendMessage(page, 'outside click test');

        // Open picker
        const msg = page.locator('.message', { hasText: 'outside click test' }).first();
        await msg.click();
        await msg.locator('.four43-hover-emoji-plus').click();

        const picker = page.locator('.emoji-picker');
        await expect(picker).toBeVisible();

        // Click outside the picker
        await page.locator('#room-content-name').click({ force: true });
        await expect(picker).not.toBeVisible();
    });
});
