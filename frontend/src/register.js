import { API_URL, showStatus, arrayBufferToBase64, base64ToArrayBuffer, friendlyError } from './utils.js';
import { generateEncryptionKeyPair, exportPublicKey, storePrivateKey, PRF_SALT, deriveWrappingKey, wrapPrivateKey } from './crypto.js';
import { loadTheme } from './theme-manager.js';

const DEBUG = import.meta.env.VITE_DEBUG === 'true';

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
    const registerBtn = document.querySelector('#registerForm button[type="submit"]');
    const usernameInput = document.getElementById('register-username');
    if (registerBtn) registerBtn.disabled = true;
    if (usernameInput) usernameInput.disabled = true;
}

const USERNAME_RE = /^[a-zA-Z0-9_]{4,15}$/;
const RESERVED_WORDS = ['admin', 'skrib', 'system'];

function validateUsername(username) {
    if (!username) return 'Please enter a username';
    if (username.length < 4) return 'Username must be at least 4 characters';
    if (username.length > 15) return 'Username must be 15 characters or fewer';
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
            window.location.href = '/app.html';
        });
    }
}

async function register() {
    const input = document.getElementById('register-username');

    // Let the browser show its native constraint popups first
    if (!input.checkValidity()) {
        input.reportValidity();
        return;
    }

    const username = input.value.trim();

    // JS validation catches reserved words that HTML5 pattern can't express
    const usernameError = validateUsername(username);
    if (usernameError) {
        input.setCustomValidity(usernameError);
        input.reportValidity();
        input.setCustomValidity(''); // reset so native checks work next time
        return;
    }

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
        } else if (completeData.status === 'approved') {
            // Generate E2E encryption key pair and upload public key
            try {
                showStatus('register-status', '🔑 Generating encryption keys...', 'info');
                const keyPair = await generateEncryptionKeyPair();
                const publicKeyJwk = await exportPublicKey(keyPair);
                await storePrivateKey(username, keyPair.privateKey);

                if (debugInfo) {
                    debugInfo['RSA Key Algorithm'] = keyPair.publicKey.algorithm;
                    debugInfo['RSA Key Usages'] = keyPair.publicKey.usages;
                    debugInfo['RSA Key Extractable'] = keyPair.publicKey.extractable;
                    debugInfo['Public Key (JWK)'] = publicKeyJwk;
                }

                // We need a session token to upload the key. Log in first,
                // then upload. For auto-approved users we can do a quick login.
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

                    // If PRF available, wrap the private key for cross-browser recovery
                    const loginExtensions = loginAssertion.getClientExtensionResults();
                    if (prfSupported) {
                        const prfResult = loginExtensions?.prf?.results?.first;
                        if (prfResult) {
                            try {
                                const wrappingKey = await deriveWrappingKey(prfResult);
                                const privateKeyJwk = await crypto.subtle.exportKey('jwk', keyPair.privateKey);
                                encKeyBody.encrypted_private_key = await wrapPrivateKey(wrappingKey, privateKeyJwk);
                                console.log('[E2E] Private key wrapped with PRF for cross-browser recovery');
                                if (debugInfo) {
                                    debugInfo['PRF Output Size (bytes)'] = prfResult.byteLength;
                                    debugInfo['Private Key Wrapped'] = true;
                                    debugInfo['Wrapped Key Size (chars)'] = encKeyBody.encrypted_private_key.length;
                                }
                            } catch (prfErr) {
                                console.warn('[E2E] PRF wrapping failed, private key stays local-only:', prfErr);
                                if (debugInfo) {
                                    debugInfo['PRF Wrapping Error'] = prfErr.message;
                                    debugInfo['Private Key Wrapped'] = false;
                                }
                            }
                        }
                    }
                    if (debugInfo) {
                        debugInfo['Login Extensions'] = loginExtensions;
                    }

                    await fetch(`${API_URL}/auth/encryption-key`, {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            'Authorization': `Bearer ${loginData.session_token}`,
                        },
                        body: JSON.stringify(encKeyBody),
                    });

                    // Store session so login page redirects straight to chat
                    localStorage.setItem('session_token', loginData.session_token);
                    localStorage.setItem('username', loginData.username);
                    localStorage.setItem('role', loginData.role);
                }
            } catch (keyError) {
                console.error('Failed to generate encryption keys:', keyError);
                // Non-fatal: user can still chat, keys will be generated on next login
            }

            if (DEBUG && debugInfo) {
                debugInfo['Registration Status'] = 'approved';
                debugInfo['Encryption Key Uploaded'] = !!localStorage.getItem('session_token');
                showDebugPanel(debugInfo);
                enableDebugContinue();
                showStatus('register-status',
                    `<div class="approval-code">
                        <h3>✅ Registration Complete!</h3>
                        <p>Debug mode — review crypto details below.</p>
                    </div>`,
                    'success'
                );
            } else {
                showStatus('register-status',
                    `<div class="approval-code">
                        <h3>✅ Registration Complete!</h3>
                        <p>Your account has been approved. Redirecting to chat...</p>
                    </div>`,
                    'success'
                );
                setTimeout(() => {
                    window.location.href = '/app.html';
                }, 2000);
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
    }
}

function goToLogin() {
    window.location.href = '/login.html';
}

// Expose functions to window for inline event handlers
window.register = register;
window.goToLogin = goToLogin;

// Real-time validation: red outline on invalid input
document.addEventListener('DOMContentLoaded', () => {
    const input = document.getElementById('register-username');
    if (input) {
        input.addEventListener('input', () => {
            const val = input.value;
            // Empty is neutral (not red), only flag once the user has typed something
            if (!val) {
                input.classList.remove('invalid');
                return;
            }
            const error = validateUsername(val);
            input.classList.toggle('invalid', error !== null);
        });
    }

    // Form submit
    const form = document.getElementById('register-form');
    if (form) {
        form.addEventListener('submit', (e) => {
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
