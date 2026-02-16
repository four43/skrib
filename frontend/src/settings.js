import { API_URL, applyThemeColor } from './utils.js';
import { loadTheme, fetchAvailableThemes, loadThemeCSS, applyUserOverrides, applyColorScheme } from './theme-manager.js';

let sessionToken = null;
let currentUsername = null;
let currentRole = null;
let serverColor = '#6366f1';
let currentThemeName = null;
let currentColorScheme = 'auto';

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

    // Load user settings (sets currentThemeName)
    await loadUserSettings();

    // Load theme list after we know the current theme
    await loadThemeList();

    // Set up event listeners
    setupEventListeners();
}

async function loadUserSettings() {
    try {
        const response = await fetch(`${API_URL}/users/${encodeURIComponent(currentUsername)}`, {
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
            // Track current theme and color scheme
            currentThemeName = data.theme_name || null;
            currentColorScheme = data.color_scheme || 'auto';
            updateColorSchemeUI(currentColorScheme);
            // If no user theme, fetch server default
            if (!currentThemeName) {
                try {
                    const serverResp = await fetch(`${API_URL}/server`);
                    const serverInfo = await serverResp.json();
                    currentThemeName = serverInfo.default_theme || 'com.four43.theme-default';
                    serverColor = serverInfo.server_color || serverColor;
                } catch (e) {
                    currentThemeName = 'com.four43.theme-default';
                }
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
            applyThemeColor(themeColor);
        }
    } catch (error) {
        console.error('[HTTP] Error updating theme color:', error);
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
            // Reset to server color
            const themeInput = document.getElementById('user-theme-color');
            if (themeInput) {
                themeInput.value = serverColor;
            }
            applyThemeColor(serverColor);
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

async function loadThemeList() {
    const container = document.getElementById('theme-list');
    if (!container) return;

    const themes = await fetchAvailableThemes();
    container.innerHTML = '';

    if (themes.length === 0) {
        container.innerHTML = '<p style="color: var(--text-muted); font-size: 14px;">No themes available.</p>';
        return;
    }

    for (const theme of themes) {
        const card = document.createElement('div');
        card.className = 'theme-card' + (theme.id === currentThemeName ? ' active' : '');
        card.dataset.themeId = theme.id;

        const variantText = theme.variants.map(v => v.name).join(', ');

        card.innerHTML = `
            <div class="theme-card-info">
                <div class="theme-card-name">${theme.name}</div>
                <div class="theme-card-meta">${theme.description}</div>
                <div class="theme-card-meta">by ${theme.author} &middot; v${theme.version}${variantText ? ' &middot; ' + variantText : ''}</div>
            </div>
            <div class="theme-card-status">
                ${theme.id === currentThemeName ? '<span class="theme-active-badge">Active</span>' : '<button class="btn-sm theme-select-btn" type="button">Use</button>'}
            </div>
        `;

        card.addEventListener('click', () => selectTheme(theme.id));
        container.appendChild(card);
    }
}

async function selectTheme(themeId) {
    if (themeId === currentThemeName) return;

    // Apply theme CSS live
    loadThemeCSS(themeId);

    // Save to backend
    try {
        const response = await fetch(`${API_URL}/users/${encodeURIComponent(currentUsername)}`, {
            method: 'PATCH',
            headers: {
                'Authorization': `Bearer ${sessionToken}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ theme_name: themeId })
        });
        if (response.ok) {
            currentThemeName = themeId;
            // Re-render theme list to update active state
            await loadThemeList();
        }
    } catch (error) {
        console.error('[HTTP] Error updating theme:', error);
    }
}

function updateColorSchemeUI(scheme) {
    document.querySelectorAll('.color-scheme-option').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.scheme === scheme);
    });
}

async function selectColorScheme(scheme) {
    if (scheme === currentColorScheme) return;

    // Apply immediately
    applyColorScheme(scheme);
    currentColorScheme = scheme;
    updateColorSchemeUI(scheme);

    // Persist to backend
    try {
        await fetch(`${API_URL}/users/${encodeURIComponent(currentUsername)}`, {
            method: 'PATCH',
            headers: {
                'Authorization': `Bearer ${sessionToken}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ color_scheme: scheme })
        });
    } catch (error) {
        console.error('[HTTP] Error updating color scheme:', error);
    }
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

function switchSection(sectionId) {
    // Update nav items
    document.querySelectorAll('.settings-nav-item').forEach(item => {
        item.classList.toggle('active', item.dataset.section === sectionId);
    });
    // Update content panels
    document.querySelectorAll('.settings-panel-section').forEach(panel => {
        panel.classList.toggle('active', panel.id === `section-${sectionId}`);
    });
}

function setupEventListeners() {
    // Nav switching
    document.querySelectorAll('.settings-nav-item').forEach(item => {
        item.addEventListener('click', () => switchSection(item.dataset.section));
    });

    // Color scheme picker
    document.querySelectorAll('.color-scheme-option').forEach(btn => {
        btn.addEventListener('click', () => selectColorScheme(btn.dataset.scheme));
    });

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
