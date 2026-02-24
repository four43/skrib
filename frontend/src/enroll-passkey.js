import { API_URL, showStatus, arrayBufferToBase64, base64ToArrayBuffer, friendlyError } from './utils.js';
import { generateEncryptionKeyPair, exportPublicKey, storePrivateKey, PRF_SALT, deriveWrappingKey, wrapPrivateKey, passphraseWrapPrivateKey } from './crypto.js';
import { loadTheme } from './theme-manager.js';

loadTheme();

const urlParams = new URLSearchParams(window.location.search);
const regToken = urlParams.get('token');
const inviteToken = urlParams.get('invite');

if (!regToken) {
    showStatus('enroll-status', 'Missing registration token. Please start from the registration page.', 'error');
}

// Fetch username from the registration token
let username = null;

async function init() {
    if (!regToken) return;

    try {
        const resp = await fetch(`${API_URL}/auth/register/token-info?token=${encodeURIComponent(regToken)}`);
        if (!resp.ok) {
            showStatus('enroll-status', 'Invalid or expired registration token. Please register again.', 'error');
            document.getElementById('enroll-passkey-button').disabled = true;
            return;
        }
        const data = await resp.json();
        username = data.username;
        document.getElementById('enroll-username').textContent = username;
    } catch (err) {
        showStatus('enroll-status', 'Failed to verify registration token.', 'error');
        document.getElementById('enroll-passkey-button').disabled = true;
    }
}

async function enrollPasskey() {
    const btn = document.getElementById('enroll-passkey-button');
    btn.disabled = true;

    const passphrase = sessionStorage.getItem('reg_passphrase');
    if (!passphrase) {
        showStatus('enroll-status', 'Passphrase not found. Please start registration again.', 'error');
        btn.disabled = false;
        return;
    }

    try {
        showStatus('enroll-status', 'Starting passkey enrollment...', 'info');

        // Begin WebAuthn registration
        const beginUrl = inviteToken
            ? `${API_URL}/auth/register/begin?invite=${encodeURIComponent(inviteToken)}`
            : `${API_URL}/auth/register/begin`;
        const beginResp = await fetch(beginUrl);
        const beginData = await beginResp.json();

        if (beginData.detail) {
            showStatus('enroll-status', beginData.detail, 'error');
            btn.disabled = false;
            return;
        }

        const challenge = base64ToArrayBuffer(beginData.challenge);
        const userId = new TextEncoder().encode(username);

        showStatus('enroll-status', 'Please authenticate with your device...', 'info');

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

        // Generate encryption keys before completing registration
        showStatus('enroll-status', 'Generating encryption keys...', 'info');
        const keyPair = await generateEncryptionKeyPair();
        const publicKeyJwk = await exportPublicKey(keyPair);
        const privateKeyJwk = await crypto.subtle.exportKey('jwk', keyPair.privateKey);

        // Passphrase-wrap the private key
        const passphraseWrapped = await passphraseWrapPrivateKey(passphrase, privateKeyJwk);
        console.log('[E2E] Private key wrapped with passphrase for recovery');

        // Complete registration on the backend (includes encryption keys)
        const completeBody = {
            username: username,
            credentialId: arrayBufferToBase64(credential.rawId),
            publicKey: arrayBufferToBase64(credential.response.getPublicKey()),
            challenge: beginData.challenge,
            encryption_public_key: JSON.stringify(publicKeyJwk),
            passphrase_encrypted_private_key: passphraseWrapped,
        };
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
            showStatus('enroll-status', completeData.detail, 'error');
            btn.disabled = false;
            return;
        }

        // Store private key locally in IndexedDB
        await storePrivateKey(username, keyPair.privateKey);

        if (completeData.status === 'approved') {
            // Login to get a session token
            await loginAndRedirect(prfSupported, privateKeyJwk, passphrase);
        } else {
            // Pending approval — keys are already stored on the server
            sessionStorage.removeItem('reg_passphrase');
            showStatus('enroll-status',
                `<div class="approval-code">
                    <h3>Registration Pending Approval</h3>
                    <p>Please provide this code to the administrator:</p>
                    <div class="code">${completeData.approval_code}</div>
                    <p style="margin-top: 10px; font-size: 12px;">You'll be able to login once approved.</p>
                </div>`,
                'info'
            );
            btn.textContent = 'Return to Login';
            btn.disabled = false;
            btn.onclick = () => { window.location.href = '/login.html'; };
        }
    } catch (error) {
        console.error(error);
        showStatus('enroll-status', friendlyError(error), 'error');
        btn.disabled = false;
    }
}

async function loginAndRedirect(prfSupported, privateKeyJwk, passphrase) {
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
        // Upload PRF-wrapped key if available
        const loginExtensions = loginAssertion.getClientExtensionResults();
        if (prfSupported) {
            const prfResult = loginExtensions?.prf?.results?.first;
            if (prfResult) {
                try {
                    const wrappingKey = await deriveWrappingKey(prfResult);
                    const publicKeyJwk = {
                        kty: privateKeyJwk.kty, n: privateKeyJwk.n, e: privateKeyJwk.e,
                        alg: privateKeyJwk.alg, ext: true, key_ops: ['encrypt'],
                    };
                    await fetch(`${API_URL}/auth/encryption-key`, {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            'Authorization': `Bearer ${loginData.session_token}`,
                        },
                        body: JSON.stringify({
                            public_key: JSON.stringify(publicKeyJwk),
                            encrypted_private_key: await wrapPrivateKey(wrappingKey, privateKeyJwk),
                        }),
                    });
                    console.log('[E2E] Private key also wrapped with PRF');
                } catch (prfErr) {
                    console.warn('[E2E] PRF wrapping failed:', prfErr);
                }
            }
        }

        localStorage.setItem('session_token', loginData.session_token);
        localStorage.setItem('username', loginData.username);
        localStorage.setItem('role', loginData.role);
    }

    // Clean up
    sessionStorage.removeItem('reg_passphrase');

    window.location.href = '/app.html';
}

// Wire up
init();
document.getElementById('enroll-passkey-button').addEventListener('click', enrollPasskey);
