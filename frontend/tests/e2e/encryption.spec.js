/**
 * E2E tests: End-to-end encryption verification.
 *
 * Verifies the zero-knowledge property — messages stored on the server
 * are ciphertext, not plaintext. Tests key distribution on invite,
 * multi-epoch key handling, and encrypted message format.
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

test.describe('Zero-knowledge encryption', () => {

    test('messages stored on server are ciphertext, not plaintext', async ({ threeUsers, baseURL }) => {
        const { admin: userA } = threeUsers;
        await userA.page.waitForLoadState('networkidle');

        const plaintext = 'This is a secret message that should be encrypted';

        await createRoom(userA.page, 'crypto-room');
        await sendMessage(userA.page, plaintext);

        // Fetch messages directly from the server API (plugin route)
        const resp = await userA.page.request.get(
            `${baseURL}/api/plugins/four43.room-type-chat/rooms/crypto-room/messages`,
            { headers: { 'Authorization': `Bearer ${userA.sessionToken}` } },
        );
        expect(resp.ok()).toBeTruthy();
        const messages = await resp.json();

        // Find the user message (not system messages)
        const userMessages = messages.filter(m => m.username === userA.username && !m.deleted);
        expect(userMessages.length).toBeGreaterThan(0);

        const msg = userMessages[userMessages.length - 1];

        // The content should NOT contain the plaintext
        expect(msg.content).not.toContain(plaintext);

        // The content should be a valid encrypted envelope (JSON with v, epoch, iv, ct)
        const envelope = JSON.parse(msg.content);
        expect(envelope.v).toBe(1);
        expect(typeof envelope.epoch).toBe('number');
        expect(envelope.iv).toBeTruthy();
        expect(envelope.ct).toBeTruthy();

        // Content type should indicate encryption
        expect(msg.content_type).toBe('encrypted');
    });

    test('server stores key_epoch on messages', async ({ threeUsers, baseURL }) => {
        const { admin: userA } = threeUsers;
        await userA.page.waitForLoadState('networkidle');

        await createRoom(userA.page, 'epoch-room');
        await sendMessage(userA.page, 'epoch test message');

        const resp = await userA.page.request.get(
            `${baseURL}/api/plugins/four43.room-type-chat/rooms/epoch-room/messages`,
            { headers: { 'Authorization': `Bearer ${userA.sessionToken}` } },
        );
        expect(resp.ok()).toBeTruthy();
        const messages = await resp.json();
        const userMsg = messages.find(m => m.username === userA.username && !m.deleted);

        expect(userMsg.key_epoch).toBeDefined();
        expect(typeof userMsg.key_epoch).toBe('number');
    });
});

test.describe('Key distribution', () => {

    test('room creator has encrypted keys stored on server', async ({ threeUsers, baseURL }) => {
        const { admin: userA } = threeUsers;
        await userA.page.waitForLoadState('networkidle');

        await createRoom(userA.page, 'key-check-room');

        // Fetch keys for the creator
        const resp = await userA.page.request.get(`${baseURL}/api/rooms/key-check-room/keys`, {
            headers: { 'Authorization': `Bearer ${userA.sessionToken}` },
        });
        expect(resp.ok()).toBeTruthy();
        const keys = await resp.json();

        // Should have at least one key epoch
        expect(keys.length).toBeGreaterThan(0);

        // Each key should have epoch and encrypted_key
        for (const key of keys) {
            expect(typeof key.key_epoch).toBe('number');
            expect(key.encrypted_key).toBeTruthy();
            expect(typeof key.encrypted_key).toBe('string');
        }
    });

    test('invited user receives encrypted room keys', async ({ threeUsers, baseURL }) => {
        const { admin: userA, userB } = threeUsers;
        await userA.page.waitForLoadState('networkidle');

        await createRoom(userA.page, 'invite-key-room');
        await inviteUser(userA.page, userB.username);

        // Wait for key distribution to complete
        await userA.page.waitForTimeout(1000);

        // User B should have keys for this room
        const resp = await userB.page.request.get(`${baseURL}/api/rooms/invite-key-room/keys`, {
            headers: { 'Authorization': `Bearer ${userB.sessionToken}` },
        });
        expect(resp.ok()).toBeTruthy();
        const keys = await resp.json();

        expect(keys.length).toBeGreaterThan(0);
    });

    test('invited user can decrypt messages sent before they joined', async ({ threeUsers }) => {
        const { admin: userA, userB } = threeUsers;
        await userA.page.waitForLoadState('networkidle');

        await createRoom(userA.page, 'history-decrypt-room');
        await sendMessage(userA.page, 'Message before invite');

        // Invite User B
        await inviteUser(userA.page, userB.username);

        // User B opens the room and should see the decrypted message
        await navigateToRoom(userB.page, 'history-decrypt-room');
        await expect(userB.page.locator('#messages')).toContainText('Message before invite');
    });

    test('each user has their own encrypted copy of room keys', async ({ threeUsers, baseURL }) => {
        const { admin: userA, userB } = threeUsers;
        await userA.page.waitForLoadState('networkidle');

        await createRoom(userA.page, 'separate-keys-room');
        await inviteUser(userA.page, userB.username);
        await userA.page.waitForTimeout(1000);

        // Fetch keys for both users
        const respA = await userA.page.request.get(`${baseURL}/api/rooms/separate-keys-room/keys`, {
            headers: { 'Authorization': `Bearer ${userA.sessionToken}` },
        });
        const keysA = await respA.json();

        const respB = await userB.page.request.get(`${baseURL}/api/rooms/separate-keys-room/keys`, {
            headers: { 'Authorization': `Bearer ${userB.sessionToken}` },
        });
        const keysB = await respB.json();

        // Both should have keys
        expect(keysA.length).toBeGreaterThan(0);
        expect(keysB.length).toBeGreaterThan(0);

        // Same epochs but different encrypted_key values (encrypted for different RSA public keys)
        expect(keysA[0].key_epoch).toBe(keysB[0].key_epoch);
        expect(keysA[0].encrypted_key).not.toBe(keysB[0].encrypted_key);
    });
});

test.describe('Public key management', () => {

    test('user public key is available via API after registration', async ({ threeUsers, baseURL }) => {
        const { admin: userA, userB } = threeUsers;

        // Fetch User B's encryption public key
        const resp = await userA.page.request.get(`${baseURL}/api/auth/encryption-key/${userB.username}`, {
            headers: { 'Authorization': `Bearer ${userA.sessionToken}` },
        });
        expect(resp.ok()).toBeTruthy();
        const data = await resp.json();

        // Should have a JWK public key
        expect(data.public_key).toBeTruthy();
        expect(typeof data.public_key).toBe('string');
        expect(data.public_key.length).toBeGreaterThan(50); // JWK is substantial
    });
});
