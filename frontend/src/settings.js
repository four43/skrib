import { API_URL } from './utils.js';
import { loadTheme, fetchAvailableThemes, loadThemeCSS, applyColorScheme } from './theme-manager.js';
import { createThemePreviewHTML } from './theme-preview.js';
import {
    getServers, getCurrentServerUrl, normalizeUrl,
    validateServer, addServer, removeServer,
} from './server-selector.js';

let sessionToken = null;
let currentUsername = null;
let currentRole = null;
let currentThemeName = null;
let currentColorScheme = 'auto';

// Load emoji picker plugin (for status emoji button)
(function loadEmojiPicker() {
    const pluginId = 'four43.emoji-picker';
    const css = document.createElement('link');
    css.rel = 'stylesheet';
    css.href = `/api/plugins/${pluginId}/file/frontend/plugin.css`;
    document.head.appendChild(css);

    const script = document.createElement('script');
    script.src = `/api/plugins/${pluginId}/file/frontend/dist/plugin.js`;
    document.head.appendChild(script);
})();

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
    document.getElementById('current-user').innerHTML = `<iconify-icon icon="lucide:user" inline></iconify-icon> ${currentUsername}`;

    // Show admin badge if applicable
    if (currentRole === 'admin' || currentRole === 'moderator') {
        const badge = document.getElementById('admin-badge');
        badge.textContent = currentRole === 'admin' ? 'ADMIN' : 'MOD';
        badge.classList.remove('hidden');
    }

    // Inject theme preview
    const previewContainer = document.getElementById('theme-preview-container');
    if (previewContainer) {
        previewContainer.innerHTML = createThemePreviewHTML();
    }

    // Load user settings (sets currentThemeName)
    await loadUserSettings();

    // Load theme list after we know the current theme
    await loadThemeList();

    // Render server list
    renderSettingsServerList();
    setupAddServerInSettings();

    // Set up event listeners
    setupEventListeners();

    // Restore section from URL hash (e.g. #appearance)
    const hashSection = location.hash.replace('#', '');
    if (hashSection && document.getElementById(`section-${hashSection}`)) {
        switchSection(hashSection);
    }
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
            const statusEmojiInput = document.getElementById('user-status-emoji');
            if (statusEmojiInput) {
                statusEmojiInput.value = data.status_emoji || '';
            }
            const statusTextInput = document.getElementById('user-status-text');
            if (statusTextInput) {
                statusTextInput.value = data.status_text || '';
            }
            updateStatusEmojiDisplay();
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
                    currentThemeName = serverInfo.default_theme || 'four43.theme-default';
                } catch (e) {
                    currentThemeName = 'four43.theme-default';
                }
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
        if (!response.ok) {
            alert('Failed to update color preference');
        }
    } catch (error) {
        console.error('[HTTP] Error updating color:', error);
        alert('Failed to update color preference');
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
        if (!response.ok) {
            alert('Failed to update nickname');
        }
    } catch (error) {
        console.error('[HTTP] Error updating nickname:', error);
        alert('Failed to update nickname');
    }
}

function updateStatusEmojiDisplay() {
    const emoji = document.getElementById('user-status-emoji').value.trim();
    const display = document.getElementById('status-emoji-display');
    if (display) {
        display.textContent = emoji || '☺';
    }
}

async function promptStatusEmoji() {
    const btn = document.getElementById('status-emoji-btn');
    if (window.SkribEmojiPicker) {
        const result = await window.SkribEmojiPicker.open({ anchor: btn });
        if (result) {
            const value = result.isCustom ? `:${result.shortcode}:` : result.emoji;
            document.getElementById('user-status-emoji').value = value;
            updateStatusEmojiDisplay();
            updateUserStatus();
        }
    } else {
        const current = document.getElementById('user-status-emoji').value;
        const result = prompt('Enter an emoji for your status:', current);
        if (result !== null) {
            document.getElementById('user-status-emoji').value = result.trim();
            updateStatusEmojiDisplay();
            updateUserStatus();
        }
    }
}

async function updateUserStatus() {
    const emoji = document.getElementById('user-status-emoji').value.trim();
    const text = document.getElementById('user-status-text').value.trim();
    try {
        const response = await fetch(`${API_URL}/users/${encodeURIComponent(currentUsername)}`, {
            method: 'PATCH',
            headers: {
                'Authorization': `Bearer ${sessionToken}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ status_emoji: emoji || '', status_text: text || '' })
        });
        if (!response.ok) {
            alert('Failed to update status');
        }
    } catch (error) {
        console.error('[HTTP] Error updating status:', error);
        alert('Failed to update status');
    }
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
    // Persist in URL hash so refresh returns to this tab
    history.replaceState(null, '', `#${sectionId}`);
}

function renderSettingsServerList() {
    const container = document.getElementById('settings-server-list');
    if (!container) return;

    const servers = getServers();
    const currentUrl = normalizeUrl(getCurrentServerUrl());

    container.innerHTML = '';

    // Sort: current server first, then the rest in order
    const sorted = [...servers].sort((a, b) => {
        const aActive = normalizeUrl(a.url) === currentUrl;
        const bActive = normalizeUrl(b.url) === currentUrl;
        if (aActive && !bActive) return -1;
        if (!aActive && bActive) return 1;
        return 0;
    });

    sorted.forEach(server => {
        const isActive = normalizeUrl(server.url) === currentUrl;

        const row = document.createElement('div');
        row.className = 'server-list-row';

        const icon = document.createElement('img');
        icon.src = `${server.iconUrl}?t=${Math.floor(Date.now() / 60000)}`;
        icon.alt = server.name;
        icon.width = 32;
        icon.height = 32;
        icon.className = 'server-list-icon';
        icon.onerror = () => {
            icon.style.display = 'none';
            const fallback = document.createElement('div');
            fallback.className = 'server-list-icon-fallback';
            fallback.textContent = server.name.charAt(0).toUpperCase();
            row.prepend(fallback);
        };
        row.appendChild(icon);

        const info = document.createElement('div');
        info.className = 'server-list-info';
        const name = document.createElement('span');
        name.className = 'server-list-name';
        name.textContent = server.name;
        info.appendChild(name);
        const url = document.createElement('span');
        url.className = 'server-list-url';
        url.textContent = server.url;
        info.appendChild(url);
        row.appendChild(info);

        if (isActive) {
            const badge = document.createElement('span');
            badge.className = 'server-list-badge';
            badge.textContent = 'Current';
            row.appendChild(badge);
        } else {
            const removeBtn = document.createElement('button');
            removeBtn.className = 'reject-btn btn-sm';
            removeBtn.textContent = 'Remove';
            removeBtn.addEventListener('click', () => {
                if (confirm(`Remove "${server.name}" from your server list?`)) {
                    removeServer(server.url);
                    renderSettingsServerList();
                }
            });
            row.appendChild(removeBtn);
        }

        container.appendChild(row);
    });

    if (servers.length === 0) {
        container.innerHTML = '<p style="color: var(--text-muted); font-size: 14px;">No servers saved yet. Add one below or visit your chat app to auto-register this server.</p>';
    }
}

function setupAddServerInSettings() {
    const urlInput = document.getElementById('settings-add-server-url');
    const addBtn = document.getElementById('settings-add-server-btn');
    const statusDiv = document.getElementById('settings-add-server-status');
    if (!urlInput || !addBtn) return;

    let validateTimeout = null;
    let validatedServer = null;

    urlInput.addEventListener('input', () => {
        clearTimeout(validateTimeout);
        addBtn.disabled = true;
        statusDiv.innerHTML = '';
        validatedServer = null;

        const raw = urlInput.value.trim();
        if (!raw) return;

        let url = raw;
        if (!url.match(/^https?:\/\//i)) {
            url = 'https://' + url;
        }

        validateTimeout = setTimeout(async () => {
            statusDiv.innerHTML = '<span class="status info">Checking server...</span>';
            const result = await validateServer(url);
            if (result.ok) {
                const servers = getServers();
                const normalized = normalizeUrl(url);
                if (servers.some(s => normalizeUrl(s.url) === normalized)) {
                    statusDiv.innerHTML = '<span class="status info">This server is already in your list.</span>';
                    return;
                }
                validatedServer = {
                    url: url.replace(/\/+$/, ''),
                    name: result.name,
                    iconUrl: result.iconUrl,
                };
                statusDiv.innerHTML = `<span class="status success">Found: ${result.name}</span>`;
                addBtn.disabled = false;
            } else {
                statusDiv.innerHTML = `<span class="status error">${result.error}</span>`;
            }
        }, 600);
    });

    urlInput.addEventListener('keypress', (e) => {
        if (e.key === 'Enter' && validatedServer) {
            addBtn.click();
        }
    });

    addBtn.addEventListener('click', () => {
        if (!validatedServer) return;
        const added = addServer(validatedServer);
        if (added) {
            urlInput.value = '';
            addBtn.disabled = true;
            statusDiv.innerHTML = '<span class="status success">Server added!</span>';
            validatedServer = null;
            renderSettingsServerList();
        } else {
            statusDiv.innerHTML = '<span class="status info">This server is already in your list.</span>';
        }
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

    // Nickname input - change and search (native clear X) events
    const nicknameInput = document.getElementById('user-nickname');
    if (nicknameInput) {
        nicknameInput.addEventListener('change', updateUserNickname);
        nicknameInput.addEventListener('search', updateUserNickname);
    }

    // Status text input - change and search (native clear X) events
    const statusTextInput = document.getElementById('user-status-text');
    if (statusTextInput) {
        statusTextInput.addEventListener('change', updateUserStatus);
        statusTextInput.addEventListener('search', () => {
            if (!statusTextInput.value) {
                document.getElementById('user-status-emoji').value = '';
                updateStatusEmojiDisplay();
            }
            updateUserStatus();
        });
    }

    // Status emoji button
    const statusEmojiBtn = document.getElementById('status-emoji-btn');
    if (statusEmojiBtn) {
        statusEmojiBtn.addEventListener('click', promptStatusEmoji);
    }
}
