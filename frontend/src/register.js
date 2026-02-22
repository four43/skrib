import { API_URL, showStatus, arrayBufferToBase64, base64ToArrayBuffer, friendlyError } from './utils.js';
import { generateEncryptionKeyPair, exportPublicKey, storePrivateKey, PRF_SALT, deriveWrappingKey, wrapPrivateKey, validatePassphrase, passphraseWrapPrivateKey } from './crypto.js';
import { loadTheme } from './theme-manager.js';

const DEBUG = import.meta.env.VITE_DEBUG === 'true';

// After registration succeeds, allow native form submit so password managers
// (Bitwarden, 1Password, etc.) detect the submission and offer to save credentials.
let registrationComplete = false;

// Get invite token from URL if present
const urlParams = new URLSearchParams(window.location.search);
const inviteToken = urlParams.get('invite');

// Load default theme (no authentication on register page)
loadTheme();
checkRegistrationAccess();

async function checkRegistrationAccess() {
    try {
        const resp = await fetch(`${API_URL}/server`);
        const data = await resp.json();

        if (data.registration_mode === 'closed') {
            showStatus('register-status', '❌ Registration is currently closed', 'error');
            disableRegistration();
        } else if (data.registration_mode === 'invite_only' && !inviteToken) {
            showStatus('register-status', '❌ Registration requires an invite link', 'error');
            disableRegistration();
        }
    } catch (error) {
        console.error('Failed to check registration status:', error);
    }
}

function disableRegistration() {
    const registerBtn = document.querySelector('#register-form button[type="submit"]');
    const usernameInput = document.getElementById('register-username');
    if (registerBtn) registerBtn.disabled = true;
    if (usernameInput) usernameInput.disabled = true;
}

const USERNAME_RE = /^[a-zA-Z0-9_]{4,15}$/;
const RESERVED_WORDS = ['admin', 'skrib', 'system'];

function validateUsername(username) {
    if (!username) return 'Please enter a username';
    if (username.length < 3) return 'Username must be at least 3 characters';
    if (username.length > 16) return 'Username must be 16 characters or fewer';
    if (!USERNAME_RE.test(username)) return 'Username can only contain letters, numbers, and underscores';
    const lower = username.toLowerCase();
    for (const word of RESERVED_WORDS) {
        if (lower.includes(word)) return `Username cannot contain '${word}'`;
    }
    return null;
}

// ---------------------------------------------------------------------------
// Crypto debug panel (only active when VITE_DEBUG=true)
// ---------------------------------------------------------------------------

function showDebugPanel(info) {
    const panel = document.getElementById('crypto-debug-panel');
    const tbody = document.querySelector('#crypto-debug-table tbody');
    if (!panel || !tbody) return;

    tbody.innerHTML = '';
    for (const [label, value] of Object.entries(info)) {
        const tr = document.createElement('tr');
        const th = document.createElement('td');
        th.textContent = label;
        th.style.fontWeight = '600';
        const td = document.createElement('td');
        if (typeof value === 'object' && value !== null) {
            const pre = document.createElement('pre');
            pre.textContent = JSON.stringify(value, null, 2);
            td.appendChild(pre);
        } else {
            td.textContent = String(value);
        }
        tr.appendChild(th);
        tr.appendChild(td);
        tbody.appendChild(tr);
    }

    panel.hidden = false;
}

function enableDebugContinue() {
    const btn = document.getElementById('debug-continue-button');
    if (btn) {
        btn.hidden = false;
        btn.addEventListener('click', () => {
            registrationComplete = true;
            const form = document.getElementById('register-form');
            form.action = '/app.html';
            form.method = 'POST';
            form.requestSubmit();
        });
    }
}

async function register() {
    const usernameInput = document.getElementById('register-username');
    const passphraseInput = document.getElementById('recovery-passphrase');
    const confirmInput = document.getElementById('recovery-passphrase-confirm');
    const submitBtn = document.getElementById('register-submit-button');

    // Let the browser show its native constraint popups first
    if (!usernameInput.checkValidity()) {
        usernameInput.reportValidity();
        return;
    }

    const username = usernameInput.value.trim();
    const passphrase = passphraseInput.value;
    const passphraseConfirm = confirmInput.value;

    // Validate username
    const usernameError = validateUsername(username);
    if (usernameError) {
        usernameInput.setCustomValidity(usernameError);
        usernameInput.reportValidity();
        usernameInput.setCustomValidity(''); // reset so native checks work next time
        return;
    }

    // Validate passphrase
    const passphraseError = validatePassphrase(passphrase);
    if (passphraseError) {
        showStatus('passphrase-status', `❌ ${passphraseError}`, 'error');
        return;
    }
    if (passphrase !== passphraseConfirm) {
        showStatus('passphrase-status', '❌ Passwords do not match', 'error');
        return;
    }

    submitBtn.disabled = true;

    try {
        showStatus('register-status', 'Starting registration...', 'info');

        // Pass invite token as query param if present
        const beginUrl = inviteToken
            ? `${API_URL}/auth/register/begin?invite=${encodeURIComponent(inviteToken)}`
            : `${API_URL}/auth/register/begin`;
        const beginResp = await fetch(beginUrl);
        const beginData = await beginResp.json();

        if (beginData.detail) {
            showStatus('register-status', `❌ ${beginData.detail}`, 'error');
            submitBtn.disabled = false;
            return;
        }

        const challenge = base64ToArrayBuffer(beginData.challenge);
        const userId = new TextEncoder().encode(username);

        showStatus('register-status', '🔐 Please authenticate with your device...', 'info');

        const credential = await navigator.credentials.create({
            publicKey: {
                challenge: challenge,
                rp: {
                    name: beginData.rp.name,
                    id: beginData.rp.id
                },
                user: {
                    id: userId,
                    name: username,
                    displayName: username
                },
                pubKeyCredParams: [
                    { type: "public-key", alg: -7 },
                    { type: "public-key", alg: -257 }
                ],
                authenticatorSelection: {
                    authenticatorAttachment: "platform",
                    requireResidentKey: true,
                    residentKey: "required",
                    userVerification: "preferred"
                },
                timeout: 60000,
                attestation: "none",
                extensions: { prf: {} }
            }
        });

        const clientExtensions = credential.getClientExtensionResults();
        const prfSupported = clientExtensions?.prf?.enabled === true;
        console.log('[E2E] PRF supported by authenticator:', prfSupported);

        // Collect debug info as we go
        const debugInfo = DEBUG ? {
            'WebAuthn Credential ID': arrayBufferToBase64(credential.rawId),
            'Authenticator Attachment': credential.authenticatorAttachment ?? 'unknown',
            'Client Extensions': clientExtensions,
            'PRF Supported': prfSupported,
            'RP ID': beginData.rp.id,
            'RP Name': beginData.rp.name,
        } : null;

        const completeBody = {
            username: username,
            credentialId: arrayBufferToBase64(credential.rawId),
            publicKey: arrayBufferToBase64(credential.response.getPublicKey()),
            challenge: beginData.challenge
        };

        // Include invite token in complete request if present
        if (inviteToken) {
            completeBody.invite_token = inviteToken;
        }

        const completeResp = await fetch(`${API_URL}/auth/register/complete`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(completeBody)
        });

        const completeData = await completeResp.json();

        if (completeData.detail) {
            showStatus('register-status', `❌ ${completeData.detail}`, 'error');
            submitBtn.disabled = false;
        } else if (completeData.status === 'approved') {
            showStatus('passphrase-status', '🔑 Generating encryption keys...', 'info');
            try {
                await generateAndUploadKeys(username, passphrase, prfSupported, debugInfo);
            } catch (keyError) {
                console.error('Failed to generate encryption keys:', keyError);
                showStatus('passphrase-status', '❌ Key generation failed. You can set this up later.', 'error');
                setTimeout(() => { window.location.href = '/app.html'; }, 3000);
            }
        } else {
            showStatus('register-status',
                `<div class="approval-code">
                    <h3>⏳ Registration Pending Approval</h3>
                    <p>Please provide this code to the administrator:</p>
                    <div class="code">${completeData.approval_code}</div>
                    <p style="margin-top: 10px; font-size: 12px;">You'll be able to login once approved.</p>
                </div>`,
                'info'
            );
        }

    } catch (error) {
        console.error(error);
        showStatus('register-status', `❌ ${friendlyError(error)}`, 'error');
        submitBtn.disabled = false;
    }
}

async function generateAndUploadKeys(username, passphrase, prfSupported, debugInfo) {
    const keyPair = await generateEncryptionKeyPair();
    const publicKeyJwk = await exportPublicKey(keyPair);
    await storePrivateKey(username, keyPair.privateKey);

    if (debugInfo) {
        debugInfo['RSA Key Algorithm'] = keyPair.publicKey.algorithm;
        debugInfo['RSA Key Usages'] = keyPair.publicKey.usages;
        debugInfo['RSA Key Extractable'] = keyPair.publicKey.extractable;
        debugInfo['Public Key (JWK)'] = publicKeyJwk;
    }

    // We need a session token to upload the key. Log in first.
    const loginBegin = await fetch(`${API_URL}/auth/login/begin`);
    const loginBeginData = await loginBegin.json();
    const loginChallenge = base64ToArrayBuffer(loginBeginData.challenge);
    const loginGetOptions = {
        publicKey: {
            challenge: loginChallenge,
            rpId: loginBeginData.rpId,
            timeout: 60000,
            userVerification: "preferred",
        }
    };
    if (prfSupported) {
        loginGetOptions.publicKey.extensions = {
            prf: { eval: { first: PRF_SALT } },
        };
    }
    const loginAssertion = await navigator.credentials.get(loginGetOptions);
    const loginResp = await fetch(`${API_URL}/auth/login/complete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            credentialId: arrayBufferToBase64(loginAssertion.rawId),
            challenge: loginBeginData.challenge,
        })
    });
    const loginData = await loginResp.json();

    if (loginData.session_token) {
        const encKeyBody = { public_key: JSON.stringify(publicKeyJwk) };

        // Passphrase-wrap the private key (always — this is the primary recovery method)
        const privateKeyJwk = await crypto.subtle.exportKey('jwk', keyPair.privateKey);
        encKeyBody.passphrase_encrypted_private_key = await passphraseWrapPrivateKey(passphrase, privateKeyJwk);
        console.log('[E2E] Private key wrapped with passphrase for recovery');

        // Also PRF-wrap if available
        const loginExtensions = loginAssertion.getClientExtensionResults();
        if (prfSupported) {
            const prfResult = loginExtensions?.prf?.results?.first;
            if (prfResult) {
                try {
                    const wrappingKey = await deriveWrappingKey(prfResult);
                    encKeyBody.encrypted_private_key = await wrapPrivateKey(wrappingKey, privateKeyJwk);
                    console.log('[E2E] Private key also wrapped with PRF');
                    if (debugInfo) {
                        debugInfo['PRF Output Size (bytes)'] = prfResult.byteLength;
                        debugInfo['Private Key PRF Wrapped'] = true;
                    }
                } catch (prfErr) {
                    console.warn('[E2E] PRF wrapping failed:', prfErr);
                }
            }
        }
        if (debugInfo) {
            debugInfo['Login Extensions'] = loginExtensions;
            debugInfo['Passphrase Wrapped'] = true;
        }

        await fetch(`${API_URL}/auth/encryption-key`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${loginData.session_token}`,
            },
            body: JSON.stringify(encKeyBody),
        });

        localStorage.setItem('session_token', loginData.session_token);
        localStorage.setItem('username', loginData.username);
        localStorage.setItem('role', loginData.role);
    }

    if (DEBUG && debugInfo) {
        debugInfo['Registration Status'] = 'approved';
        debugInfo['Encryption Key Uploaded'] = !!localStorage.getItem('session_token');
        showDebugPanel(debugInfo);
        enableDebugContinue();
        showStatus('passphrase-status',
            `<div class="approval-code">
                <h3>✅ Registration Complete!</h3>
                <p>Debug mode — review crypto details below.</p>
            </div>`,
            'success'
        );
    } else {
        showStatus('passphrase-status',
            `<div class="approval-code">
                <h3>✅ Registration Complete!</h3>
                <p>Your encryption key has been saved. Redirecting to chat...</p>
            </div>`,
            'success'
        );
        setTimeout(() => {
            // Submit form natively to trigger password manager save prompt
            registrationComplete = true;
            const form = document.getElementById('register-form');
            form.action = '/app.html';
            form.method = 'POST';
            form.requestSubmit();
        }, 2000);
    }
}

function goToLogin() {
    window.location.href = '/login.html';
}

// Expose functions to window for inline event handlers
window.register = register;
window.goToLogin = goToLogin;

// Real-time validation
document.addEventListener('DOMContentLoaded', () => {
    const usernameInput = document.getElementById('register-username');
    if (usernameInput) {
        usernameInput.addEventListener('input', () => {
            const val = usernameInput.value;
            // Empty is neutral (not red), only flag once the user has typed something
            if (!val) {
                usernameInput.classList.remove('invalid');
                return;
            }
            const error = validateUsername(val);
            usernameInput.classList.toggle('invalid', error !== null);
        });
    }

    // Real-time passphrase validation hint
    const passphraseInput = document.getElementById('recovery-passphrase');
    if (passphraseInput) {
        passphraseInput.addEventListener('input', () => {
            const err = validatePassphrase(passphraseInput.value);
            const hint = document.getElementById('passphrase-hint');
            if (passphraseInput.value && err) {
                hint.textContent = err;
                hint.style.color = 'var(--color-error)';
            } else {
                hint.textContent = 'At least 32 characters with uppercase, lowercase, number, and special character';
                hint.style.color = '';
            }
        });
    }

    // Form submit
    const form = document.getElementById('register-form');
    if (form) {
        form.addEventListener('submit', (e) => {
            if (registrationComplete) return; // native submit for password manager save
            e.preventDefault();
            register();
        });
    }

    // Go to login button
    const goToLoginButton = document.getElementById('go-to-login-button');
    if (goToLoginButton) {
        goToLoginButton.addEventListener('click', goToLogin);
    }
});
