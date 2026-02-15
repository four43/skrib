import './style.css';
import { API_URL, showStatus, arrayBufferToBase64, base64ToArrayBuffer, friendlyError, loadAndApplyTheme } from './utils.js';
import { generateEncryptionKeyPair, exportPublicKey, storePrivateKey } from './crypto.js';

// Get invite token from URL if present
const urlParams = new URLSearchParams(window.location.search);
const inviteToken = urlParams.get('invite');

// Load theme and check if registration is allowed
loadAndApplyTheme();
checkRegistrationAccess();

async function checkRegistrationAccess() {
    try {
        const resp = await fetch(`${API_URL}/server`);
        const data = await resp.json();

        if (data.registration_mode === 'closed') {
            showStatus('registerStatus', '❌ Registration is currently closed', 'error');
            disableRegistration();
        } else if (data.registration_mode === 'invite_only' && !inviteToken) {
            showStatus('registerStatus', '❌ Registration requires an invite link', 'error');
            disableRegistration();
        }
    } catch (error) {
        console.error('Failed to check registration status:', error);
    }
}

function disableRegistration() {
    const registerBtn = document.querySelector('#registerForm button[type="submit"]');
    const usernameInput = document.getElementById('registerUsername');
    if (registerBtn) registerBtn.disabled = true;
    if (usernameInput) usernameInput.disabled = true;
}

const USERNAME_RE = /^[a-zA-Z0-9_]{4,15}$/;
const RESERVED_WORDS = ['admin', 'minichat', 'system'];

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

async function register() {
    const input = document.getElementById('registerUsername');

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
        showStatus('registerStatus', 'Starting registration...', 'info');

        // Pass invite token as query param if present
        const beginUrl = inviteToken
            ? `${API_URL}/auth/register/begin?invite=${encodeURIComponent(inviteToken)}`
            : `${API_URL}/auth/register/begin`;
        const beginResp = await fetch(beginUrl);
        const beginData = await beginResp.json();

        if (beginData.detail) {
            showStatus('registerStatus', `❌ ${beginData.detail}`, 'error');
            return;
        }

        const challenge = base64ToArrayBuffer(beginData.challenge);
        const userId = new TextEncoder().encode(username);

        showStatus('registerStatus', '🔐 Please authenticate with your device...', 'info');

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
                attestation: "none"
            }
        });

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
            showStatus('registerStatus', `❌ ${completeData.detail}`, 'error');
        } else if (completeData.status === 'approved') {
            // Generate E2E encryption key pair and upload public key
            try {
                showStatus('registerStatus', '🔑 Generating encryption keys...', 'info');
                const keyPair = await generateEncryptionKeyPair();
                const publicKeyJwk = await exportPublicKey(keyPair);
                await storePrivateKey(username, keyPair.privateKey);

                // We need a session token to upload the key. Log in first,
                // then upload. For auto-approved users we can do a quick login.
                const loginBegin = await fetch(`${API_URL}/auth/login/begin`);
                const loginBeginData = await loginBegin.json();
                const loginChallenge = base64ToArrayBuffer(loginBeginData.challenge);
                const loginAssertion = await navigator.credentials.get({
                    publicKey: {
                        challenge: loginChallenge,
                        timeout: 60000,
                        userVerification: "preferred"
                    }
                });
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
                    await fetch(`${API_URL}/auth/encryption-key`, {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            'Authorization': `Bearer ${loginData.session_token}`,
                        },
                        body: JSON.stringify({ public_key: JSON.stringify(publicKeyJwk) }),
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

            showStatus('registerStatus',
                `<div class="approval-code">
                    <h3>✅ Registration Complete!</h3>
                    <p>Your account has been approved. Redirecting to chat...</p>
                </div>`,
                'success'
            );
            setTimeout(() => {
                window.location.href = '/chat.html';
            }, 2000);
        } else {
            showStatus('registerStatus',
                `<div class="approval-code">
                    <h3>⏳ Registration Pending Approval</h3>
                    <p>Please provide this code to the administrator:</p>
                    <div class="code">${completeData.approval_code}</div>
                    <p style="margin-top: 10px; font-size: 12px;">You'll be able to login once approved.</p>
                </div>`,
                'success'
            );
        }

    } catch (error) {
        console.error(error);
        showStatus('registerStatus', `❌ ${friendlyError(error)}`, 'error');
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
    const input = document.getElementById('registerUsername');
    if (!input) return;

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
});
