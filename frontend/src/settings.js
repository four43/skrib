import { API_URL, applyThemeColor } from './utils.js';
import { loadTheme } from './theme-manager.js';

let sessionToken = null;
let currentUsername = null;
let currentRole = null;
let serverColor = '#6366f1';

// Check session and redirect if not authenticated
checkSession();

async function checkSession() {
    const token = localStorage.getItem('session_token');
    const username = localStorage.getItem('username');
    const role = localStorage.getItem('role');

    if (!token || !username) {
        // Not logged in, redirect to login
        window.location.href = '/login.html';
        return;
    }

    try {
        const resp = await fetch(`${API_URL}/auth/session`, {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        const data = await resp.json();

        if (data.authenticated) {
            sessionToken = token;
            currentUsername = username;
            currentRole = data.role;
            localStorage.setItem('role', data.role);

            // Load user's theme preferences
            await loadTheme(username, sessionToken);

            // Initialize settings page
            await initializeSettingsPage();
        } else {
            // Session invalid
            window.location.href = '/login.html';
        }
    } catch (error) {
        console.error('Session check failed:', error);
        window.location.href = '/login.html';
    }
}

async function initializeSettingsPage() {
    // Display username
    document.getElementById('current-user').textContent = `👤 ${currentUsername}`;

    // Show admin badge if applicable
    if (currentRole === 'admin' || currentRole === 'moderator') {
        const badge = document.getElementById('admin-badge');
        badge.textContent = currentRole === 'admin' ? 'ADMIN' : 'MOD';
        badge.classList.remove('hidden');
    }

    // Load user settings
    await loadUserSettings();

    // Set up event listeners
    setupEventListeners();
}

async function loadUserSettings() {
    try {
        const response = await fetch(`${API_URL}/users/${currentUsername}/preferences`, {
            headers: {
                'Authorization': `Bearer ${sessionToken}`
            }
        });
        if (response.ok) {
            const data = await response.json();
            const nicknameInput = document.getElementById('user-nickname');
            if (nicknameInput) {
                nicknameInput.value = data.nickname || '';
            }
            const colorInput = document.getElementById('user-color');
            if (colorInput) {
                colorInput.value = data.color;
            }
            // Apply user's theme color override if set
            const themeInput = document.getElementById('user-theme-color');
            if (themeInput) {
                themeInput.value = data.theme_color || serverColor;
            }
            if (data.theme_color) {
                applyThemeColor(data.theme_color);
            }
        }
    } catch (error) {
        console.error('[HTTP] Error loading settings:', error);
    }
}

async function updateUserColor() {
    const color = document.getElementById('user-color').value;
    try {
        const response = await fetch(`${API_URL}/users/${encodeURIComponent(currentUsername)}`, {
            method: 'PATCH',
            headers: {
                'Authorization': `Bearer ${sessionToken}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ color })
        });
        if (response.ok) {
            alert('Color updated successfully! Return to chat to see the changes.');
        }
    } catch (error) {
        console.error('[HTTP] Error updating color:', error);
        alert('Failed to update color preference');
    }
}

async function updateUserThemeColor() {
    const themeColor = document.getElementById('user-theme-color').value;
    try {
        const response = await fetch(`${API_URL}/users/${encodeURIComponent(currentUsername)}`, {
            method: 'PATCH',
            headers: {
                'Authorization': `Bearer ${sessionToken}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ theme_color: themeColor })
        });
        if (response.ok) {
            window.location.reload();
        }
    } catch (error) {
        console.error('[HTTP] Error updating theme color:', error);
        alert('Failed to update theme color');
    }
}

async function resetUserThemeColor() {
    try {
        const response = await fetch(`${API_URL}/users/${encodeURIComponent(currentUsername)}`, {
            method: 'PATCH',
            headers: {
                'Authorization': `Bearer ${sessionToken}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ theme_color: '' })
        });
        if (response.ok) {
            window.location.reload();
        }
    } catch (error) {
        console.error('[HTTP] Error resetting theme color:', error);
    }
}

async function updateUserNickname() {
    const nickname = document.getElementById('user-nickname').value.trim();
    try {
        const response = await fetch(`${API_URL}/users/${encodeURIComponent(currentUsername)}`, {
            method: 'PATCH',
            headers: {
                'Authorization': `Bearer ${sessionToken}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ nickname: nickname || '' })
        });
        if (response.ok) {
            alert('Nickname updated successfully! Return to chat to see the changes.');
        }
    } catch (error) {
        console.error('[HTTP] Error updating nickname:', error);
        alert('Failed to update nickname');
    }
}

async function clearUserNickname() {
    document.getElementById('user-nickname').value = '';
    await updateUserNickname();
}

function logout() {
    sessionToken = null;
    currentUsername = null;
    currentRole = null;
    localStorage.removeItem('session_token');
    localStorage.removeItem('username');
    localStorage.removeItem('role');
    window.location.href = '/login.html';
}

function setupEventListeners() {
    // Logout button
    const logoutBtn = document.getElementById('settings-logout-btn');
    if (logoutBtn) {
        logoutBtn.addEventListener('click', logout);
    }

    // User color input
    const userColorInput = document.getElementById('user-color');
    if (userColorInput) {
        userColorInput.addEventListener('change', updateUserColor);
    }

    // User theme color input
    const userThemeColorInput = document.getElementById('user-theme-color');
    if (userThemeColorInput) {
        userThemeColorInput.addEventListener('change', updateUserThemeColor);
    }

    // Reset theme color button
    const resetThemeColorBtn = document.getElementById('reset-theme-color-btn');
    if (resetThemeColorBtn) {
        resetThemeColorBtn.addEventListener('click', resetUserThemeColor);
    }

    // Clear nickname button
    const clearNicknameBtn = document.getElementById('clear-nickname-btn');
    if (clearNicknameBtn) {
        clearNicknameBtn.addEventListener('click', clearUserNickname);
    }

    // Nickname input - change event
    const nicknameInput = document.getElementById('user-nickname');
    if (nicknameInput) {
        nicknameInput.addEventListener('change', updateUserNickname);
    }
}
