import { API_URL, showStatus, arrayBufferToBase64, base64ToArrayBuffer, friendlyError } from './utils.js';
import { loadPrivateKey, loadPrivateKeyJwk, generateEncryptionKeyPair, exportPublicKey, storePrivateKey, exportStoredPublicKey, PRF_SALT, deriveWrappingKey, wrapPrivateKey, unwrapPrivateKey, passphraseUnwrapPrivateKey } from './crypto.js';
import { loadTheme } from './theme-manager.js';

// Load default theme (no authentication on login page)
loadTheme();
checkSession().then(() => checkRegistrationMode());

async function checkSession() {
    const token = localStorage.getItem('session_token');
    const username = localStorage.getItem('username');

    if (!token || !username) return;

    try {
        const resp = await fetch(`${API_URL}/auth/session`, {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        const data = await resp.json();

        if (data.authenticated) {
            // Redirect to chat if already logged in
            window.location.href = '/app.html';
        } else {
            // Clear invalid session
            localStorage.removeItem('session_token');
            localStorage.removeItem('username');
            localStorage.removeItem('role');
        }
    } catch (error) {
        console.error('Session check failed:', error);
    }
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
                    // Branch 1: Have local private key — re-upload matching public key
                    const publicKeyJwk = await exportStoredPublicKey(completeData.username);
                    if (publicKeyJwk) {
                        const encKeyBody = { public_key: JSON.stringify(publicKeyJwk) };

                        // If PRF available and server has no wrapped key, upload as backup
                        if (prfResult) {
                            try {
                                const ekResp = await fetch(
                                    `${API_URL}/auth/encryption-key/${encodeURIComponent(completeData.username)}`,
                                    { headers: { 'Authorization': `Bearer ${completeData.session_token}` } }
                                );
                                const ekData = ekResp.ok ? await ekResp.json() : null;
                                if (ekData && !ekData.encrypted_private_key) {
                                    const wrappingKey = await deriveWrappingKey(prfResult);
                                    const fullPrivJwk = await loadPrivateKeyJwk(completeData.username);
                                    encKeyBody.encrypted_private_key = await wrapPrivateKey(wrappingKey, fullPrivJwk);
                                    console.log('[E2E] Uploaded PRF-wrapped private key backup');
                                }
                            } catch (prfErr) {
                                console.warn('[E2E] PRF backup upload failed:', prfErr);
                            }
                        }

                        await fetch(`${API_URL}/auth/encryption-key`, {
                            method: 'POST',
                            headers: authHeaders,
                            body: JSON.stringify(encKeyBody),
                        });
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

                    // Try PRF recovery first
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

                    // Try passphrase recovery
                    if (!recovered && ekData?.passphrase_encrypted_private_key) {
                        console.log('[E2E] Passphrase-wrapped key available, showing recovery UI...');
                        recovered = await showPassphraseRecovery(
                            ekData.passphrase_encrypted_private_key,
                            completeData.username,
                            authHeaders,
                        );
                        console.log('[E2E] Passphrase recovery result:', recovered);
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

            // Redirect to chat — submit recovery form if shown (triggers password manager save)
            const recoveryForm = document.getElementById('passphrase-recovery');
            if (recoveryForm && !recoveryForm.classList.contains('hidden')) {
                recoveryForm.action = '/app.html';
                recoveryForm.method = 'POST';
                recoveryForm.submit();
            } else {
                window.location.href = '/app.html';
            }
        }

    } catch (error) {
        console.error(error);
        showStatus('auth-status', `❌ ${friendlyError(error)}`, 'error');
    }
}

/**
 * Show the passphrase recovery UI and wait for the user to enter their passphrase
 * or skip. Returns true if recovery succeeded, false if skipped/failed.
 */
function showPassphraseRecovery(encryptedBlob, username, authHeaders) {
    return new Promise((resolve) => {
        // Hide login form, show recovery UI
        document.getElementById('login-form').classList.add('hidden');
        const recoveryDiv = document.getElementById('passphrase-recovery');
        recoveryDiv.classList.remove('hidden');

        // Populate hidden username so password managers can match the credential
        const usernameField = document.getElementById('recovery-username');
        if (usernameField) usernameField.value = username;

        const input = document.getElementById('login-recovery-passphrase');
        const submitBtn = document.getElementById('recovery-submit-button');
        const skipBtn = document.getElementById('recovery-skip-button');

        input.focus();

        async function attemptRecovery() {
            const passphrase = input.value;
            if (!passphrase) {
                showStatus('recovery-status', '❌ Please enter your password', 'error');
                return;
            }

            submitBtn.disabled = true;
            showStatus('recovery-status', 'Recovering encryption key...', 'info');

            try {
                console.log('[E2E] Attempting passphrase unwrap for user:', username);
                const privateKeyJwk = await passphraseUnwrapPrivateKey(passphrase, encryptedBlob);
                console.log('[E2E] Passphrase unwrap succeeded, key modulus prefix:', privateKeyJwk.n?.slice(0, 20));
                const importedKey = await crypto.subtle.importKey(
                    'jwk', privateKeyJwk,
                    { name: 'RSA-OAEP', hash: 'SHA-256' },
                    true, ['decrypt'],
                );
                console.log('[E2E] CryptoKey imported, storing in IndexedDB for user:', username);
                await storePrivateKey(username, importedKey);

                // Verify the key was actually stored
                const verifyKey = await loadPrivateKey(username);
                console.log('[E2E] IndexedDB store verification:', !!verifyKey);
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
                resolve(true);
            } catch (err) {
                console.warn('[E2E] Passphrase recovery failed:', err);
                showStatus('recovery-status', '❌ Wrong password. Please try again.', 'error');
                submitBtn.disabled = false;
                input.value = '';
                input.focus();
            }
        }

        recoveryDiv.addEventListener('submit', (e) => {
            e.preventDefault();
            attemptRecovery();
        });
        skipBtn.addEventListener('click', () => {
            console.log('[E2E] User skipped passphrase recovery');
            resolve(false);
        });
    });
}

async function checkRegistrationMode() {
    try {
        const resp = await fetch(`${API_URL}/server`);
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const data = await resp.json();
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
