import './style.css';
import { API_URL, showStatus, arrayBufferToBase64, base64ToArrayBuffer, friendlyError } from './utils.js';
import { loadPrivateKey, generateEncryptionKeyPair, exportPublicKey, storePrivateKey, exportStoredPublicKey } from './crypto.js';
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
            window.location.href = '/chat.html';
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
                timeout: 60000,
                userVerification: "preferred"
            }
        });

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

            // Ensure encryption keys exist and server has the public key
            try {
                let privKey = await loadPrivateKey(completeData.username);
                let publicKeyJwk;
                if (!privKey) {
                    const keyPair = await generateEncryptionKeyPair();
                    publicKeyJwk = await exportPublicKey(keyPair);
                    await storePrivateKey(completeData.username, keyPair.privateKey);
                } else {
                    // Derive public key from stored private key
                    publicKeyJwk = await exportStoredPublicKey(completeData.username);
                }
                // Always upload to ensure server has the public key
                if (publicKeyJwk) {
                    await fetch(`${API_URL}/auth/encryption-key`, {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            'Authorization': `Bearer ${completeData.session_token}`,
                        },
                        body: JSON.stringify({ public_key: JSON.stringify(publicKeyJwk) }),
                    });
                }
            } catch (keyError) {
                console.error('Failed to load/generate encryption keys:', keyError);
            }

            // Redirect to chat
            window.location.href = '/chat.html';
        }

    } catch (error) {
        console.error(error);
        showStatus('auth-status', `❌ ${friendlyError(error)}`, 'error');
    }
}

async function checkRegistrationMode() {
    try {
        const resp = await fetch(`${API_URL}/server`);
        const data = await resp.json();
        // Show register button for approval_required and open modes
        if (data.registration_mode === 'approval_required' || data.registration_mode === 'open') {
            document.getElementById('register-section').classList.remove('hidden');
        }
        // For closed and invite_only, register section stays hidden
    } catch (error) {
        console.error('Failed to check registration status:', error);
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
