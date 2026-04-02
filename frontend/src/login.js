import { API_URL, showStatus, arrayBufferToBase64, base64ToArrayBuffer, friendlyError } from './utils.js';
import { loadPrivateKey, loadPrivateKeyJwk, generateEncryptionKeyPair, exportPublicKey, storePrivateKey, exportStoredPublicKey, PRF_SALT, deriveWrappingKey, wrapPrivateKey, unwrapPrivateKey, passphraseUnwrapPrivateKey } from './crypto.js';
import { loadTheme } from './theme-manager.js';

// Load default theme (no authentication on login page)
loadTheme();
checkSession().then(() => checkRegistrationMode());

async function checkSession() {
    const token = localStorage.getItem('session_token');
    const username = localStorage.getItem('username');

    if (!token || !username) {
        showAuthView();
        return;
    }

    try {
        const resp = await fetch(`${API_URL}/auth/session`, {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        const data = await resp.json();

        if (data.authenticated) {
            // Redirect to chat if already logged in
            window.location.href = '/app.html';
            return;
        } else {
            // Clear invalid session
            localStorage.removeItem('session_token');
            localStorage.removeItem('username');
            localStorage.removeItem('role');
        }
    } catch (error) {
        console.error('Session check failed:', error);
    }
    showAuthView();
}

function showAuthView() {
    const loading = document.getElementById('auth-loading');
    const actions = document.getElementById('auth-actions');
    if (loading) loading.style.display = 'none';
    if (actions) actions.style.display = '';
}

async function login() {
    try {
        showStatus('auth-status', 'Starting login...', 'info');

        const beginResp = await fetch(`${API_URL}/auth/login/begin`);
        const beginData = await beginResp.json();

        if (beginData.detail) {
            showStatus('auth-status', `❌ ${beginData.detail}`, 'error');
            return;
        }

        showStatus('auth-status', '🔐 Please authenticate with your device...', 'info');

        const challenge = base64ToArrayBuffer(beginData.challenge);

        // Use usernameless flow - let the authenticator pick the credential
        const assertion = await navigator.credentials.get({
            publicKey: {
                challenge: challenge,
                rpId: beginData.rpId,
                timeout: 60000,
                userVerification: "preferred",
                extensions: { prf: { eval: { first: PRF_SALT } } },
            }
        });

        // Extract PRF output if available (not all authenticators support it)
        const prfResult = assertion.getClientExtensionResults()?.prf?.results?.first;
        console.log('[E2E] PRF available:', !!prfResult);

        const completeResp = await fetch(`${API_URL}/auth/login/complete`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                credentialId: arrayBufferToBase64(assertion.rawId),
                challenge: beginData.challenge
            })
        });

        const completeData = await completeResp.json();

        if (completeData.detail) {
            showStatus('auth-status', `❌ ${completeData.detail}`, 'error');
        } else {
            // Store session data
            localStorage.setItem('session_token', completeData.session_token);
            localStorage.setItem('username', completeData.username);
            localStorage.setItem('role', completeData.role);

            // Ensure encryption keys exist and server has the public key.
            // 4 branches handle cross-browser key portability via PRF.
            try {
                const authHeaders = {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${completeData.session_token}`,
                };
                let privKey = await loadPrivateKey(completeData.username);

                if (privKey) {
                    // Branch 1: Have local private key — only upload PRF backup if needed
                    const prfBackupKey = `prf_backup_uploaded_${completeData.username}`;
                    if (prfResult && !localStorage.getItem(prfBackupKey)) {
                        try {
                            const ekResp = await fetch(
                                `${API_URL}/auth/encryption-key/${encodeURIComponent(completeData.username)}`,
                                { headers: { 'Authorization': `Bearer ${completeData.session_token}` } }
                            );
                            const ekData = ekResp.ok ? await ekResp.json() : null;
                            if (ekData && !ekData.encrypted_private_key) {
                                const publicKeyJwk = await exportStoredPublicKey(completeData.username);
                                const wrappingKey = await deriveWrappingKey(prfResult);
                                const fullPrivJwk = await loadPrivateKeyJwk(completeData.username);
                                const encKeyBody = {
                                    public_key: JSON.stringify(publicKeyJwk),
                                    encrypted_private_key: await wrapPrivateKey(wrappingKey, fullPrivJwk),
                                };
                                await fetch(`${API_URL}/auth/encryption-key`, {
                                    method: 'POST',
                                    headers: authHeaders,
                                    body: JSON.stringify(encKeyBody),
                                });
                                console.log('[E2E] Uploaded PRF-wrapped private key backup');
                            }
                            localStorage.setItem(prfBackupKey, '1');
                        } catch (prfErr) {
                            console.warn('[E2E] PRF backup upload failed:', prfErr);
                        }
                    }
                } else {
                    // No local private key — check server state
                    console.log('[E2E] No local private key found, checking server for recovery options...');
                    const ekResp = await fetch(
                        `${API_URL}/auth/encryption-key/${encodeURIComponent(completeData.username)}`,
                        { headers: { 'Authorization': `Bearer ${completeData.session_token}` } }
                    );

                    const ekData = ekResp.ok ? await ekResp.json() : null;
                    console.log('[E2E] Server encryption key state:', {
                        hasPublicKey: !!ekData?.public_key,
                        hasPrfWrappedKey: !!ekData?.encrypted_private_key,
                        hasPassphraseWrappedKey: !!ekData?.passphrase_encrypted_private_key,
                    });
                    let recovered = false;

                    // Try PRF recovery first (automatic, no user interaction)
                    if (ekData?.encrypted_private_key && prfResult) {
                        try {
                            const wrappingKey = await deriveWrappingKey(prfResult);
                            const privateKeyJwk = await unwrapPrivateKey(wrappingKey, ekData.encrypted_private_key);
                            const importedKey = await crypto.subtle.importKey(
                                'jwk', privateKeyJwk,
                                { name: 'RSA-OAEP', hash: 'SHA-256' },
                                true, ['decrypt'],
                            );
                            await storePrivateKey(completeData.username, importedKey);
                            const publicKeyJwk = {
                                kty: privateKeyJwk.kty, n: privateKeyJwk.n, e: privateKeyJwk.e,
                                alg: privateKeyJwk.alg, ext: true, key_ops: ['encrypt'],
                            };
                            await fetch(`${API_URL}/auth/encryption-key`, {
                                method: 'POST',
                                headers: authHeaders,
                                body: JSON.stringify({ public_key: JSON.stringify(publicKeyJwk) }),
                            });
                            console.log('[E2E] Private key recovered from server via PRF');
                            recovered = true;
                        } catch (prfErr) {
                            console.warn('[E2E] PRF recovery failed:', prfErr);
                        }
                    }

                    // Passphrase recovery needed — show inline recovery form
                    if (!recovered && ekData?.passphrase_encrypted_private_key) {
                        console.log('[E2E] Passphrase-wrapped key available, showing inline recovery...');
                        showInlineRecovery(completeData, authHeaders, prfResult);
                        return;
                    }

                    // No recovery possible — generate fresh pair
                    if (!recovered) {
                        console.warn('[E2E] No recovery method succeeded. Generating fresh key pair.');
                        const keyPair = await generateEncryptionKeyPair();
                        const publicKeyJwk = await exportPublicKey(keyPair);
                        await storePrivateKey(completeData.username, keyPair.privateKey);

                        const encKeyBody = { public_key: JSON.stringify(publicKeyJwk) };
                        if (prfResult) {
                            try {
                                const wrappingKey = await deriveWrappingKey(prfResult);
                                const privJwk = await crypto.subtle.exportKey('jwk', keyPair.privateKey);
                                encKeyBody.encrypted_private_key = await wrapPrivateKey(wrappingKey, privJwk);
                            } catch (prfErr) {
                                console.warn('[E2E] PRF wrapping failed:', prfErr);
                            }
                        }
                        await fetch(`${API_URL}/auth/encryption-key`, {
                            method: 'POST',
                            headers: authHeaders,
                            body: JSON.stringify(encKeyBody),
                        });
                        localStorage.setItem('e2e_key_regenerated', 'true');
                    }
                }
            } catch (keyError) {
                console.error('[E2E] Failed to load/generate encryption keys:', keyError);
            }

            // Verify key state before redirect
            try {
                const verifyKey = await loadPrivateKey(completeData.username);
                console.log('[E2E] Pre-redirect key verification:', {
                    username: completeData.username,
                    keyInIndexedDB: !!verifyKey,
                });
            } catch (verifyErr) {
                console.error('[E2E] Pre-redirect key verification failed:', verifyErr);
            }

            // Redirect to chat
            window.location.href = '/app.html';
        }

    } catch (error) {
        console.error(error);
        showStatus('auth-status', `❌ ${friendlyError(error)}`, 'error');
    }
}

async function checkRegistrationMode() {
    try {
        const resp = await fetch(`${API_URL}/server`);
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const data = await resp.json();
        // Populate server name
        const nameEl = document.getElementById('server-name');
        if (nameEl && data.name) {
            nameEl.textContent = data.name;
            document.title = `Login - ${data.name}`;
        }
        // Show register button for approval_required and open modes
        if (data.registration_mode === 'approval_required' || data.registration_mode === 'open') {
            document.getElementById('register-section').classList.remove('hidden');
        }
        // For closed and invite_only, register section stays hidden
    } catch (error) {
        console.error('Server unavailable:', error);
        showStatus('auth-status', 'Unable to connect to the server. Please try again later.', 'error');
        document.getElementById('login-button').disabled = true;
    }
}

/**
 * Show inline passphrase recovery form on the login page.
 * Replaces the old redirect to key-recovery.html.
 */
function showInlineRecovery(completeData, authHeaders, prfResult) {
    const loginForm = document.getElementById('login-form');
    const recoveryForm = document.getElementById('login-recovery-form');
    const authActions = document.getElementById('auth-actions');

    // Hide login buttons, show recovery form
    if (authActions) authActions.style.display = 'none';
    if (recoveryForm) recoveryForm.style.display = '';

    // Populate hidden username for password managers
    const usernameField = document.getElementById('login-recovery-username');
    if (usernameField) usernameField.value = completeData.username;

    const input = document.getElementById('login-recovery-passphrase');
    if (input) input.focus();

    // Handle passphrase submit
    recoveryForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const passphrase = input.value;
        if (!passphrase) {
            showStatus('login-recovery-status', '❌ Please enter your password', 'error');
            return;
        }

        const submitBtn = document.getElementById('login-recovery-submit');
        submitBtn.disabled = true;
        showStatus('login-recovery-status', 'Recovering encryption key...', 'info');

        try {
            const ekResp = await fetch(
                `${API_URL}/auth/encryption-key/${encodeURIComponent(completeData.username)}`,
                { headers: { 'Authorization': `Bearer ${completeData.session_token}` } }
            );
            if (!ekResp.ok) throw new Error('Could not fetch encryption key from server');
            const ekData = await ekResp.json();

            if (!ekData.passphrase_encrypted_private_key) {
                showStatus('login-recovery-status', '❌ No passphrase-wrapped key on the server.', 'error');
                submitBtn.disabled = false;
                return;
            }

            const privateKeyJwk = await passphraseUnwrapPrivateKey(passphrase, ekData.passphrase_encrypted_private_key);
            const importedKey = await crypto.subtle.importKey(
                'jwk', privateKeyJwk,
                { name: 'RSA-OAEP', hash: 'SHA-256' },
                true, ['decrypt'],
            );
            await storePrivateKey(completeData.username, importedKey);

            // Re-upload public key for consistency
            const publicKeyJwk = {
                kty: privateKeyJwk.kty, n: privateKeyJwk.n, e: privateKeyJwk.e,
                alg: privateKeyJwk.alg, ext: true, key_ops: ['encrypt'],
            };
            await fetch(`${API_URL}/auth/encryption-key`, {
                method: 'POST',
                headers: authHeaders,
                body: JSON.stringify({ public_key: JSON.stringify(publicKeyJwk) }),
            });

            console.log('[E2E] Private key recovered from server via passphrase (inline)');
            window.location.href = '/app.html';
        } catch (err) {
            console.warn('[E2E] Passphrase recovery failed:', err);
            showStatus('login-recovery-status', '❌ Wrong password. Please try again.', 'error');
            submitBtn.disabled = false;
            input.value = '';
            input.focus();
        }
    });

    // Handle skip — generate fresh key pair
    document.getElementById('login-recovery-skip').addEventListener('click', async () => {
        console.log('[E2E] User skipped passphrase recovery, generating fresh key pair');
        const keyPair = await generateEncryptionKeyPair();
        const publicKeyJwk = await exportPublicKey(keyPair);
        await storePrivateKey(completeData.username, keyPair.privateKey);

        const encKeyBody = { public_key: JSON.stringify(publicKeyJwk) };
        if (prfResult) {
            try {
                const wrappingKey = await deriveWrappingKey(prfResult);
                const privJwk = await crypto.subtle.exportKey('jwk', keyPair.privateKey);
                encKeyBody.encrypted_private_key = await wrapPrivateKey(wrappingKey, privJwk);
            } catch (prfErr) {
                console.warn('[E2E] PRF wrapping failed:', prfErr);
            }
        }
        await fetch(`${API_URL}/auth/encryption-key`, {
            method: 'POST',
            headers: authHeaders,
            body: JSON.stringify(encKeyBody),
        });
        localStorage.setItem('e2e_key_regenerated', 'true');
        window.location.href = '/app.html';
    });
}

function goToRegister() {
    window.location.href = '/register.html';
}

// Expose functions to window for inline event handlers (backwards compatibility)
window.login = login;
window.goToRegister = goToRegister;

// Event listeners
document.addEventListener('DOMContentLoaded', () => {
    const loginButton = document.getElementById('login-button');
    if (loginButton) {
        loginButton.addEventListener('click', login);
    }

    const goToRegisterButton = document.getElementById('go-to-register-button');
    if (goToRegisterButton) {
        goToRegisterButton.addEventListener('click', goToRegister);
    }
});
