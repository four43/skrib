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

const DB_NAME = 'skrib-keys';
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
    console.log('[E2E] storePrivateKey: writing to IndexedDB, key id:', `private:${username}`);
    await idbPut(`private:${username}`, jwk);
    console.log('[E2E] storePrivateKey: write complete');
}

/** Load the private key from IndexedDB (returns CryptoKey or null). */
export async function loadPrivateKey(username) {
    const jwk = await idbGet(`private:${username}`);
    if (!jwk) {
        console.log('[E2E] loadPrivateKey: no JWK found for key id:', `private:${username}`);
        return null;
    }
    console.log('[E2E] loadPrivateKey: JWK found, importing CryptoKey for:', username);
    return await crypto.subtle.importKey(
        'jwk',
        jwk,
        { name: 'RSA-OAEP', hash: 'SHA-256' },
        false,
        ['decrypt'],
    );
}

/** Load the raw private key JWK from IndexedDB (without importing into a CryptoKey). */
export async function loadPrivateKeyJwk(username) {
    return await idbGet(`private:${username}`);
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

// ---------------------------------------------------------------------------
// PRF (Pseudo-Random Function) key wrapping for cross-browser key portability
// ---------------------------------------------------------------------------

/** Fixed salt for WebAuthn PRF evaluation. */
export const PRF_SALT = new TextEncoder().encode('skrib-e2e-key-wrapping');

/** Derive an AES-256-GCM wrapping key from raw PRF output via HKDF. */
export async function deriveWrappingKey(prfOutput) {
    const keyMaterial = await crypto.subtle.importKey(
        'raw', prfOutput, 'HKDF', false, ['deriveKey'],
    );
    return await crypto.subtle.deriveKey(
        { name: 'HKDF', salt: PRF_SALT, info: new TextEncoder().encode('skrib-wrap'), hash: 'SHA-256' },
        keyMaterial,
        { name: 'AES-GCM', length: 256 },
        false,
        ['wrapKey', 'unwrapKey', 'encrypt', 'decrypt'],
    );
}

/** Wrap (encrypt) a private key JWK with an AES-GCM wrapping key. Returns a JSON blob string. */
export async function wrapPrivateKey(wrappingKey, privateKeyJwk) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const encoded = new TextEncoder().encode(JSON.stringify(privateKeyJwk));
    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, wrappingKey, encoded);
    return JSON.stringify({ iv: arrayBufferToBase64(iv.buffer), ct: arrayBufferToBase64(ct) });
}

/** Unwrap (decrypt) a private key blob back to a JWK object. */
export async function unwrapPrivateKey(wrappingKey, blob) {
    const { iv, ct } = JSON.parse(blob);
    const decrypted = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: new Uint8Array(base64ToArrayBuffer(iv)) },
        wrappingKey,
        base64ToArrayBuffer(ct),
    );
    return JSON.parse(new TextDecoder().decode(decrypted));
}

// ---------------------------------------------------------------------------
// Passphrase-based key wrapping (domain-independent recovery)
// ---------------------------------------------------------------------------

const PASSPHRASE_PBKDF2_ITERATIONS = 600_000;

/**
 * Validate a recovery passphrase for strength.
 * Returns null if valid, or an error message string.
 */
export function validatePassphrase(passphrase) {
    if (!passphrase || passphrase.length < 32) {
        return 'Passphrase must be at least 32 characters';
    }
    if (!/[a-z]/.test(passphrase)) {
        return 'Password must contain a lowercase letter';
    }
    if (!/[A-Z]/.test(passphrase)) {
        return 'Password must contain an uppercase letter';
    }
    if (!/[0-9]/.test(passphrase)) {
        return 'Password must contain a number';
    }
    if (!/[^a-zA-Z0-9]/.test(passphrase)) {
        return 'Password must contain a special character';
    }
    return null;
}

/**
 * Derive an AES-256-GCM wrapping key from a passphrase and salt via PBKDF2.
 * @param {string} passphrase - User-provided passphrase
 * @param {Uint8Array} salt - Random salt (16 bytes recommended)
 * @returns {Promise<CryptoKey>}
 */
export async function derivePassphraseWrappingKey(passphrase, salt) {
    const keyMaterial = await crypto.subtle.importKey(
        'raw',
        new TextEncoder().encode(passphrase),
        'PBKDF2',
        false,
        ['deriveKey'],
    );
    return await crypto.subtle.deriveKey(
        {
            name: 'PBKDF2',
            salt,
            iterations: PASSPHRASE_PBKDF2_ITERATIONS,
            hash: 'SHA-256',
        },
        keyMaterial,
        { name: 'AES-GCM', length: 256 },
        false,
        ['encrypt', 'decrypt'],
    );
}

/**
 * Wrap a private key JWK with a passphrase. Returns a JSON blob string
 * containing salt, iv, ciphertext, and iteration count.
 */
export async function passphraseWrapPrivateKey(passphrase, privateKeyJwk) {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const wrappingKey = await derivePassphraseWrappingKey(passphrase, salt);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const encoded = new TextEncoder().encode(JSON.stringify(privateKeyJwk));
    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, wrappingKey, encoded);
    return JSON.stringify({
        v: 1,
        salt: arrayBufferToBase64(salt.buffer),
        iv: arrayBufferToBase64(iv.buffer),
        ct: arrayBufferToBase64(ct),
        iterations: PASSPHRASE_PBKDF2_ITERATIONS,
    });
}

/**
 * Unwrap a private key JWK from a passphrase-wrapped blob.
 * Throws on wrong passphrase (AES-GCM authentication will fail).
 */
export async function passphraseUnwrapPrivateKey(passphrase, blob) {
    const { salt, iv, ct, iterations } = JSON.parse(blob);
    const saltBytes = new Uint8Array(base64ToArrayBuffer(salt));
    const keyMaterial = await crypto.subtle.importKey(
        'raw',
        new TextEncoder().encode(passphrase),
        'PBKDF2',
        false,
        ['deriveKey'],
    );
    const wrappingKey = await crypto.subtle.deriveKey(
        {
            name: 'PBKDF2',
            salt: saltBytes,
            iterations: iterations || PASSPHRASE_PBKDF2_ITERATIONS,
            hash: 'SHA-256',
        },
        keyMaterial,
        { name: 'AES-GCM', length: 256 },
        false,
        ['decrypt'],
    );
    const decrypted = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: new Uint8Array(base64ToArrayBuffer(iv)) },
        wrappingKey,
        base64ToArrayBuffer(ct),
    );
    return JSON.parse(new TextDecoder().decode(decrypted));
}
