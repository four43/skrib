/**
 * E2E encryption module for Skrīb.
 *
 * Handles RSA-OAEP key pairs (per user), AES-GCM room keys,
 * message encryption/decryption, and IndexedDB key storage.
 * The server never sees plaintext keys or messages.
 */

import { arrayBufferToBase64, base64ToArrayBuffer } from './utils.js';

// ---------------------------------------------------------------------------
// IndexedDB helpers
// ---------------------------------------------------------------------------

const DB_NAME = 'mini-chat-keys';
const DB_VERSION = 1;
const STORE_NAME = 'keys';

function openDB() {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = () => {
            const db = req.result;
            if (!db.objectStoreNames.contains(STORE_NAME)) {
                db.createObjectStore(STORE_NAME, { keyPath: 'id' });
            }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}

async function idbGet(id) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readonly');
        const req = tx.objectStore(STORE_NAME).get(id);
        req.onsuccess = () => resolve(req.result?.value ?? null);
        req.onerror = () => reject(req.error);
    });
}

async function idbPut(id, value) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        tx.objectStore(STORE_NAME).put({ id, value });
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
    });
}

// ---------------------------------------------------------------------------
// RSA-OAEP key pair (per user)
// ---------------------------------------------------------------------------

const RSA_PARAMS = {
    name: 'RSA-OAEP',
    modulusLength: 2048,
    publicExponent: new Uint8Array([1, 0, 1]),
    hash: 'SHA-256',
};

/** Generate a new RSA-OAEP key pair for encryption. */
export async function generateEncryptionKeyPair() {
    return await crypto.subtle.generateKey(
        RSA_PARAMS,
        true, // extractable so we can export
        ['encrypt', 'decrypt'],
    );
}

/** Export the public key as a JWK object. */
export async function exportPublicKey(keyPair) {
    return await crypto.subtle.exportKey('jwk', keyPair.publicKey);
}

/** Import a JWK public key for encryption. */
export async function importPublicKey(jwk) {
    return await crypto.subtle.importKey(
        'jwk',
        jwk,
        { name: 'RSA-OAEP', hash: 'SHA-256' },
        false,
        ['encrypt'],
    );
}

/** Store the private key in IndexedDB. */
export async function storePrivateKey(username, privateKey) {
    const jwk = await crypto.subtle.exportKey('jwk', privateKey);
    await idbPut(`private:${username}`, jwk);
}

/** Load the private key from IndexedDB (returns CryptoKey or null). */
export async function loadPrivateKey(username) {
    const jwk = await idbGet(`private:${username}`);
    if (!jwk) return null;
    return await crypto.subtle.importKey(
        'jwk',
        jwk,
        { name: 'RSA-OAEP', hash: 'SHA-256' },
        false,
        ['decrypt'],
    );
}

/** Derive the public key JWK from the stored private key (for re-uploading). */
export async function exportStoredPublicKey(username) {
    const jwk = await idbGet(`private:${username}`);
    if (!jwk) return null;
    return {
        kty: jwk.kty,
        n: jwk.n,
        e: jwk.e,
        alg: jwk.alg,
        ext: true,
        key_ops: ['encrypt'],
    };
}

// ---------------------------------------------------------------------------
// AES-GCM room keys
// ---------------------------------------------------------------------------

/** Generate a new AES-GCM 256-bit room key. */
export async function generateRoomKey() {
    return await crypto.subtle.generateKey(
        { name: 'AES-GCM', length: 256 },
        true, // extractable so we can wrap for other users
        ['encrypt', 'decrypt'],
    );
}

/**
 * Encrypt a room key for a recipient using their RSA-OAEP public key.
 * Returns a base64url string of the encrypted key bytes.
 */
export async function encryptRoomKey(roomKey, recipientPublicKeyJwk) {
    const publicKey = await importPublicKey(recipientPublicKeyJwk);
    const rawKey = await crypto.subtle.exportKey('raw', roomKey);
    const encrypted = await crypto.subtle.encrypt(
        { name: 'RSA-OAEP' },
        publicKey,
        rawKey,
    );
    return arrayBufferToBase64(encrypted);
}

/**
 * Decrypt a room key using your RSA-OAEP private key.
 * Takes a base64url-encoded encrypted key, returns a CryptoKey.
 */
export async function decryptRoomKey(encryptedKeyBase64, privateKey) {
    const encrypted = base64ToArrayBuffer(encryptedKeyBase64);
    const rawKey = await crypto.subtle.decrypt(
        { name: 'RSA-OAEP' },
        privateKey,
        encrypted,
    );
    return await crypto.subtle.importKey(
        'raw',
        rawKey,
        { name: 'AES-GCM', length: 256 },
        true,
        ['encrypt', 'decrypt'],
    );
}

// ---------------------------------------------------------------------------
// Message encryption / decryption
// ---------------------------------------------------------------------------

/**
 * Encrypt a plaintext message with a room AES-GCM key.
 * Returns a JSON string: {"v":1,"epoch":<n>,"iv":"<b64>","ct":"<b64>"}
 */
export async function encryptMessage(roomKey, plaintext, keyEpoch = 0) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const encoded = new TextEncoder().encode(plaintext);
    const ciphertext = await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv },
        roomKey,
        encoded,
    );
    return JSON.stringify({
        v: 1,
        epoch: keyEpoch,
        iv: arrayBufferToBase64(iv.buffer),
        ct: arrayBufferToBase64(ciphertext),
    });
}

/**
 * Decrypt an encrypted message JSON string.
 * Returns the plaintext string.
 */
export async function decryptMessage(roomKey, ciphertextJson) {
    const { iv, ct } = JSON.parse(ciphertextJson);
    const decrypted = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: new Uint8Array(base64ToArrayBuffer(iv)) },
        roomKey,
        base64ToArrayBuffer(ct),
    );
    return new TextDecoder().decode(decrypted);
}

/** Parse the key epoch from an encrypted message without decrypting. */
export function getMessageEpoch(ciphertextJson) {
    try {
        const parsed = JSON.parse(ciphertextJson);
        return parsed.v === 1 ? (parsed.epoch ?? 0) : null;
    } catch {
        return null;
    }
}

/** Check if a message string is an encrypted payload. */
export function isEncryptedMessage(messageStr) {
    return messageStr && messageStr.startsWith('{"v":1');
}
