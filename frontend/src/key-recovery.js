/**
 * Key recovery page — reached when a logged-in user has no local private key
 * but the server holds a passphrase-wrapped (or PRF-wrapped) backup.
 *
 * The user is already authenticated (session_token in localStorage).
 * On success the private key is restored to IndexedDB and the user is
 * redirected to /app.html.
 */

import { API_URL, showStatus } from './utils.js';
import {
    loadPrivateKey,
    storePrivateKey,
    generateEncryptionKeyPair,
    exportPublicKey,
    passphraseUnwrapPrivateKey,
    PRF_SALT,
    deriveWrappingKey,
    unwrapPrivateKey,
    wrapPrivateKey,
} from './crypto.js';
import { loadTheme } from './theme-manager.js';

loadTheme();

const sessionToken = localStorage.getItem('session_token');
const username = localStorage.getItem('username');

if (!sessionToken || !username) {
    // Not logged in — send back to login
    window.location.href = '/login.html';
}

// Populate hidden username field for password manager matching
const usernameField = document.getElementById('recovery-username');
if (usernameField) usernameField.value = username;

const input = document.getElementById('recovery-passphrase');
const submitBtn = document.getElementById('recovery-submit-button');
const skipBtn = document.getElementById('recovery-skip-button');
const form = document.getElementById('passphrase-recovery');

if (input) input.focus();

// ─── Recovery attempt ───────────────────────────────────────────────────

async function attemptRecovery() {
    const passphrase = input.value;
    if (!passphrase) {
        showStatus('recovery-status', '❌ Please enter your password', 'error');
        return;
    }

    submitBtn.disabled = true;
    showStatus('recovery-status', 'Recovering encryption key...', 'info');

    const authHeaders = {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${sessionToken}`,
    };

    try {
        // Fetch the encrypted blob from the server
        const ekResp = await fetch(
            `${API_URL}/auth/encryption-key/${encodeURIComponent(username)}`,
            { headers: { 'Authorization': `Bearer ${sessionToken}` } }
        );
        if (!ekResp.ok) throw new Error('Could not fetch encryption key from server');
        const ekData = await ekResp.json();

        if (!ekData.passphrase_encrypted_private_key) {
            showStatus('recovery-status', '❌ No passphrase-wrapped key on the server.', 'error');
            submitBtn.disabled = false;
            return;
        }

        console.log('[E2E] Attempting passphrase unwrap for user:', username);
        const privateKeyJwk = await passphraseUnwrapPrivateKey(passphrase, ekData.passphrase_encrypted_private_key);
        const importedKey = await crypto.subtle.importKey(
            'jwk', privateKeyJwk,
            { name: 'RSA-OAEP', hash: 'SHA-256' },
            true, ['decrypt'],
        );
        await storePrivateKey(username, importedKey);

        // Verify it was stored
        const verifyKey = await loadPrivateKey(username);
        if (!verifyKey) {
            console.error('[E2E] CRITICAL: Key was stored but could not be read back!');
        }

        // Re-upload public key to ensure consistency
        const publicKeyJwk = {
            kty: privateKeyJwk.kty, n: privateKeyJwk.n, e: privateKeyJwk.e,
            alg: privateKeyJwk.alg, ext: true, key_ops: ['encrypt'],
        };
        await fetch(`${API_URL}/auth/encryption-key`, {
            method: 'POST',
            headers: authHeaders,
            body: JSON.stringify({ public_key: JSON.stringify(publicKeyJwk) }),
        });

        console.log('[E2E] Private key recovered from server via passphrase');

        // Redirect to app via form submit (triggers password manager save)
        form.action = '/app.html';
        form.method = 'GET';
        form.submit();
    } catch (err) {
        console.warn('[E2E] Passphrase recovery failed:', err);
        showStatus('recovery-status', '❌ Wrong password. Please try again.', 'error');
        submitBtn.disabled = false;
        input.value = '';
        input.focus();
    }
}

// ─── Skip — generate fresh key pair ─────────────────────────────────────

async function skipRecovery() {
    console.log('[E2E] User skipped passphrase recovery, generating fresh key pair');
    const authHeaders = {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${sessionToken}`,
    };

    const keyPair = await generateEncryptionKeyPair();
    const publicKeyJwk = await exportPublicKey(keyPair);
    await storePrivateKey(username, keyPair.privateKey);

    await fetch(`${API_URL}/auth/encryption-key`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({ public_key: JSON.stringify(publicKeyJwk) }),
    });

    localStorage.setItem('e2e_key_regenerated', 'true');
    window.location.href = '/app.html';
}

// ─── Event listeners ────────────────────────────────────────────────────

form.addEventListener('submit', (e) => {
    e.preventDefault();
    attemptRecovery();
});

skipBtn.addEventListener('click', skipRecovery);
