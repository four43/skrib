import { showStatus } from './utils.js';
import { validatePassphrase } from './crypto.js';
import { loadTheme } from './theme-manager.js';

// Get invite token from URL if present
const urlParams = new URLSearchParams(window.location.search);
const inviteToken = urlParams.get('invite');

// Load default theme (no authentication on register page)
loadTheme();
checkRegistrationAccess();

// Populate the hidden invite field
const inviteField = document.getElementById('invite-token-field');
if (inviteField && inviteToken) {
    inviteField.value = inviteToken;
}

async function checkRegistrationAccess() {
    try {
        const resp = await fetch('/api/server');
        const data = await resp.json();

        if (data.registration_mode === 'closed') {
            showStatus('register-status', 'Registration is currently closed', 'error');
            disableRegistration();
        } else if (data.registration_mode === 'invite_only' && !inviteToken) {
            showStatus('register-status', 'Registration requires an invite link', 'error');
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

document.addEventListener('DOMContentLoaded', () => {
    const usernameInput = document.getElementById('register-username');
    if (usernameInput) {
        usernameInput.addEventListener('input', () => {
            const val = usernameInput.value;
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

    // Form submit: validate client-side, store passphrase, then allow native POST
    const form = document.getElementById('register-form');
    if (form) {
        form.addEventListener('submit', (e) => {
            const username = usernameInput.value.trim();
            const passphrase = passphraseInput.value;
            const confirmInput = document.getElementById('recovery-passphrase-confirm');
            const passphraseConfirm = confirmInput.value;

            // Validate username
            const usernameError = validateUsername(username);
            if (usernameError) {
                e.preventDefault();
                usernameInput.setCustomValidity(usernameError);
                usernameInput.reportValidity();
                usernameInput.setCustomValidity('');
                return;
            }

            // Validate passphrase
            const passphraseError = validatePassphrase(passphrase);
            if (passphraseError) {
                e.preventDefault();
                showStatus('passphrase-status', passphraseError, 'error');
                return;
            }
            if (passphrase !== passphraseConfirm) {
                e.preventDefault();
                showStatus('passphrase-status', 'Passwords do not match', 'error');
                return;
            }

            // Store passphrase in sessionStorage for the enroll-passkey page
            sessionStorage.setItem('reg_passphrase', passphrase);

            // Allow native form POST to proceed — this triggers password manager save
        });
    }

    // Go to login button
    const goToLoginButton = document.getElementById('go-to-login-button');
    if (goToLoginButton) {
        goToLoginButton.addEventListener('click', () => {
            window.location.href = '/login.html';
        });
    }
});
