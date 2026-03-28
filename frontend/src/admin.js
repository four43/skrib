import { API_URL, escapeHtml } from './utils.js';
import { loadTheme, fetchAvailableThemes, loadThemeCSS } from './theme-manager.js';
import { createThemePreviewHTML } from './theme-preview.js';

let sessionToken = null;
let currentUsername = null;
let currentRole = null;
let adminPollInterval = null;
let currentRegMode = 'closed';
let currentDefaultTheme = null;
let currentDmRoomType = null;
let currentSection = 'server';

// Check session and redirect if not authenticated or not admin/mod
checkSession();

async function checkSession() {
    const token = localStorage.getItem('session_token');
    const username = localStorage.getItem('username');

    if (!token || !username) {
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

            if (currentRole !== 'admin' && currentRole !== 'moderator') {
                window.location.href = '/app.html';
                return;
            }

            // Load user's theme preferences
            await loadTheme(username, sessionToken);

            // Hide admin-only sections for moderators and default to Users
            if (currentRole === 'moderator') {
                document.querySelectorAll('.admin-only').forEach(el => el.style.display = 'none');
                switchSection('users');
            }

            // Restore section from URL hash (e.g. #backups)
            const hashSection = location.hash.replace('#', '');
            if (hashSection && document.getElementById(`section-${hashSection}`)) {
                switchSection(hashSection);
            }

            // Inject theme preview
            const previewContainer = document.getElementById('admin-theme-preview-container');
            if (previewContainer) {
                previewContainer.innerHTML = createThemePreviewHTML();
            }

            loadAdminSettings();
        } else {
            localStorage.removeItem('session_token');
            localStorage.removeItem('username');
            localStorage.removeItem('role');
            window.location.href = '/login.html';
        }
    } catch (error) {
        console.error('Session check failed:', error);
        window.location.href = '/login.html';
    }
}

// Section navigation

function switchSection(sectionId, { updateHash = true } = {}) {
    currentSection = sectionId;
    // Update nav items
    document.querySelectorAll('.settings-nav-item').forEach(item => {
        item.classList.toggle('active', item.dataset.section === sectionId);
    });
    // Update content panels
    document.querySelectorAll('.settings-panel-section').forEach(panel => {
        panel.classList.toggle('active', panel.id === `section-${sectionId}`);
    });
    // Persist in URL hash so refresh returns to this tab
    if (updateHash) {
        history.replaceState(null, '', `#${sectionId}`);
    }
    // Lazy-load data for sections
    if (sectionId === 'logs') loadSystemLog(1);
    if (sectionId === 'backups') loadBackups();
}

// Admin settings

async function loadAdminSettings() {
    try {
        const resp = await fetch(`${API_URL}/server`, {
            headers: { 'Authorization': `Bearer ${sessionToken}` }
        });
        const data = await resp.json();

        // Server name
        const nameInput = document.getElementById('server-name-input');
        if (nameInput) {
            nameInput.value = data.name || '';
        }

        // Server icon
        loadServerIcon(data.icon_custom);

        // Registration mode
        updateRegModeSlider(data.registration_mode);

        // Default theme
        currentDefaultTheme = data.default_theme || 'four43.theme-default';
        loadAdminThemeList();

        // DM room type
        currentDmRoomType = data.dm_room_type || 'four43.room-type-chat';
        loadDmRoomTypeList();

        // Users
        loadPendingUsers();
        loadAllUsers();
        loadUserPreferences();

        // Invites
        if (data.registration_mode === 'invite_only') {
            loadInviteTokens();
        }

        // Backups
        loadBackups();
        loadBackupConfig();
    } catch (error) {
        console.error('Failed to load admin settings:', error);
    }
}

// Server name

async function updateServerName() {
    const name = document.getElementById('server-name-input').value.trim();
    try {
        const resp = await fetch(`${API_URL}/server`, {
            method: 'PATCH',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${sessionToken}`
            },
            body: JSON.stringify({ name })
        });
        if (resp.ok) {
            const data = await resp.json();
            // Refresh icon preview (auto-generated icon depends on server name)
            loadServerIcon(data.icon_custom);
        } else {
            console.error('Failed to update server name');
        }
    } catch (error) {
        console.error('[HTTP] Error updating server name:', error);
    }
}

// Server icon

function loadServerIcon(isCustom) {
    const img = document.getElementById('server-icon-img');
    const label = document.getElementById('server-icon-label');
    const resetBtn = document.getElementById('server-icon-reset-btn');

    if (img) {
        // Cache-bust with timestamp
        img.src = `${API_URL}/server/icon?t=${Date.now()}`;
    }
    if (label) {
        label.textContent = isCustom ? 'Custom' : 'Auto-generated';
    }
    if (resetBtn) {
        resetBtn.style.display = isCustom ? '' : 'none';
    }
}

async function uploadServerIcon(file) {
    const formData = new FormData();
    formData.append('file', file);

    try {
        const resp = await fetch(`${API_URL}/server/icon`, {
            method: 'PUT',
            headers: { 'Authorization': `Bearer ${sessionToken}` },
            body: formData,
        });

        if (resp.ok) {
            loadServerIcon(true);
        } else {
            const data = await resp.json();
            alert(`Failed to upload icon: ${data.detail || 'Unknown error'}`);
        }
    } catch (error) {
        console.error('[HTTP] Error uploading server icon:', error);
        alert('Failed to upload server icon');
    }
}

async function resetServerIcon() {
    try {
        const resp = await fetch(`${API_URL}/server/icon`, {
            method: 'DELETE',
            headers: { 'Authorization': `Bearer ${sessionToken}` },
        });

        if (resp.ok) {
            loadServerIcon(false);
        }
    } catch (error) {
        console.error('[HTTP] Error resetting server icon:', error);
    }
}

// DM room type

async function loadDmRoomTypeList() {
    const container = document.getElementById('dm-room-type-select');
    if (!container) return;

    try {
        const resp = await fetch(`${API_URL}/plugins`, {
            headers: { 'Authorization': `Bearer ${sessionToken}` }
        });
        const plugins = await resp.json();

        // Filter to plugins that provide room types
        const roomTypePlugins = plugins.filter(p => p.enabled && p.room_types && p.room_types.length > 0);
        container.innerHTML = '';

        if (roomTypePlugins.length === 0) {
            container.innerHTML = '<p style="color: var(--text-muted); font-size: 14px;">No room type plugins available.</p>';
            return;
        }

        for (const plugin of roomTypePlugins) {
            const isSelected = plugin.id === currentDmRoomType;
            const card = document.createElement('div');
            card.className = 'theme-card' + (isSelected ? ' active' : '');
            card.dataset.pluginId = plugin.id;

            card.innerHTML = `
                <div class="theme-card-info">
                    <div class="theme-card-name">${escapeHtml(plugin.name)}</div>
                    <div class="theme-card-meta">${escapeHtml(plugin.id)}</div>
                    <div class="theme-card-meta">${escapeHtml(plugin.description)}</div>
                </div>
                <div class="theme-card-status">
                    ${isSelected ? '<span class="theme-active-badge">Active</span>' : '<button class="btn-sm theme-select-btn" type="button">Select</button>'}
                </div>
            `;

            card.addEventListener('click', () => selectDmRoomType(plugin.id));
            container.appendChild(card);
        }
    } catch (error) {
        console.error('[HTTP] Error loading room type plugins:', error);
    }
}

async function selectDmRoomType(pluginId) {
    if (pluginId === currentDmRoomType) return;

    try {
        const resp = await fetch(`${API_URL}/server`, {
            method: 'PATCH',
            headers: {
                'Authorization': `Bearer ${sessionToken}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ dm_room_type: pluginId })
        });
        if (resp.ok) {
            currentDmRoomType = pluginId;
            loadDmRoomTypeList();
        } else {
            const data = await resp.json();
            alert(`Failed: ${data.detail || 'Unknown error'}`);
        }
    } catch (error) {
        console.error('[HTTP] Error updating DM room type:', error);
    }
}

// Registration mode

const REG_MODES = ['closed', 'invite_only', 'approval_required', 'open'];
const REG_MODE_DESCRIPTIONS = {
    closed: 'No new registrations allowed',
    invite_only: 'Users can register with an invite link',
    approval_required: 'Users register and wait for admin approval',
    open: 'Anyone can register and immediately join'
};

function updateRegModeSlider(mode) {
    const slider = document.getElementById('reg-mode-slider');
    const index = REG_MODES.indexOf(mode);
    if (index >= 0) {
        slider.value = index;
    }
    currentRegMode = mode;
    updateRegModeLabel();
    updateInviteSectionVisibility(mode);
    updatePendingPoll();
}

function updateRegModeLabel() {
    const slider = document.getElementById('reg-mode-slider');
    const desc = document.getElementById('reg-mode-description');
    const mode = REG_MODES[slider.value];
    desc.textContent = REG_MODE_DESCRIPTIONS[mode];

    const labels = document.querySelectorAll('.reg-mode-labels span');
    labels.forEach((label, i) => {
        label.classList.toggle('active', i == slider.value);
    });
}

async function setRegistrationMode() {
    const slider = document.getElementById('reg-mode-slider');
    const mode = REG_MODES[slider.value];

    try {
        const resp = await fetch(`${API_URL}/server`, {
            method: 'PATCH',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${sessionToken}`
            },
            body: JSON.stringify({ registration_mode: mode })
        });
        const data = await resp.json();
        updateRegModeSlider(data.registration_mode);
    } catch (error) {
        console.error('Failed to set registration mode:', error);
    }
}

function updateInviteSectionVisibility(mode) {
    const navItem = document.getElementById('invites-nav-item');
    if (mode === 'invite_only') {
        if (navItem) navItem.classList.remove('hidden');
        loadInviteTokens();
    } else {
        if (navItem) navItem.classList.add('hidden');
        // If currently viewing invites, switch away
        if (currentSection === 'invites') {
            switchSection('server');
        }
    }
}

function updatePendingPoll() {
    const shouldPoll = currentRegMode === 'approval_required';

    if (shouldPoll && !adminPollInterval) {
        loadPendingUsers();
        adminPollInterval = setInterval(loadPendingUsers, 5000);
    } else if (!shouldPoll && adminPollInterval) {
        clearInterval(adminPollInterval);
        adminPollInterval = null;
    }
}

// Default theme management

async function loadAdminThemeList() {
    const container = document.getElementById('admin-theme-list');
    if (!container) return;

    const themes = await fetchAvailableThemes();
    container.innerHTML = '';

    if (themes.length === 0) {
        container.innerHTML = '<p style="color: var(--text-muted); font-size: 14px;">No themes available.</p>';
        return;
    }

    for (const theme of themes) {
        const card = document.createElement('div');
        card.className = 'theme-card' + (theme.id === currentDefaultTheme ? ' active' : '');
        card.dataset.themeId = theme.id;

        const variantText = theme.variants.map(v => v.name).join(', ');

        card.innerHTML = `
            <div class="theme-card-info">
                <div class="theme-card-name">${theme.name}</div>
                <div class="theme-card-meta">${theme.description}</div>
                <div class="theme-card-meta">by ${theme.author} &middot; v${theme.version}${variantText ? ' &middot; ' + variantText : ''}</div>
            </div>
            <div class="theme-card-status">
                ${theme.id === currentDefaultTheme ? '<span class="theme-active-badge">Default</span>' : '<button class="btn-sm theme-select-btn" type="button">Set Default</button>'}
            </div>
        `;

        card.addEventListener('click', () => selectDefaultTheme(theme.id));
        container.appendChild(card);
    }
}

async function selectDefaultTheme(themeId) {
    if (themeId === currentDefaultTheme) return;

    // Preview live
    loadThemeCSS(themeId);

    // Save to backend
    try {
        const response = await fetch(`${API_URL}/server`, {
            method: 'PATCH',
            headers: {
                'Authorization': `Bearer ${sessionToken}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ default_theme: themeId })
        });
        if (response.ok) {
            currentDefaultTheme = themeId;
            await loadAdminThemeList();
        }
    } catch (error) {
        console.error('[HTTP] Error updating default theme:', error);
    }
}

// Invite links

async function generateInviteLink() {
    try {
        await fetch(`${API_URL}/server/invites`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${sessionToken}` }
        });
        loadInviteTokens();
    } catch (error) {
        console.error('Failed to generate invite:', error);
    }
}

async function loadInviteTokens() {
    try {
        const resp = await fetch(`${API_URL}/server/invites`, {
            headers: { 'Authorization': `Bearer ${sessionToken}` }
        });
        const data = await resp.json();
        const inviteList = document.getElementById('invite-list');

        if (data.length === 0) {
            inviteList.innerHTML = '<p style="color: #999; font-size: 13px;">No invite links yet</p>';
        } else {
            inviteList.innerHTML = data.map(inv => {
                const inviteUrl = `${window.location.origin}/register.html?invite=${inv.token}`;
                const status = inv.used_by
                    ? `<span class="invite-used">Used by ${escapeHtml(inv.used_by)}</span>`
                    : `<span class="invite-available">Available</span>`;
                return `
                    <div class="invite-item">
                        <div class="invite-info">
                            <div class="invite-url" onclick="copyInviteLink('${inviteUrl}')" title="Click to copy">${inviteUrl}</div>
                            <div class="invite-meta">${status} &middot; by ${escapeHtml(inv.created_by)}</div>
                        </div>
                        ${!inv.used_by ? `<button class="reject-btn btn-sm invite-delete-btn" onclick="deleteInvite('${inv.token}')"><iconify-icon icon="lucide:x"></iconify-icon></button>` : ''}
                    </div>
                `;
            }).join('');
        }
    } catch (error) {
        console.error('Failed to load invites:', error);
    }
}

function copyInviteLink(url) {
    navigator.clipboard.writeText(url).then(() => {
        const el = event.target;
        const original = el.textContent;
        el.textContent = 'Copied!';
        setTimeout(() => { el.textContent = original; }, 1500);
    });
}

async function deleteInvite(token) {
    try {
        await fetch(`${API_URL}/server/invites/${encodeURIComponent(token)}`, {
            method: 'DELETE',
            headers: { 'Authorization': `Bearer ${sessionToken}` }
        });
        loadInviteTokens();
    } catch (error) {
        console.error('Failed to delete invite:', error);
    }
}

// Pending users

async function loadPendingUsers() {
    try {
        const resp = await fetch(`${API_URL}/users?status=pending`, {
            headers: { 'Authorization': `Bearer ${sessionToken}` }
        });
        const data = await resp.json();

        const pendingList = document.getElementById('pending-list');
        const pendingCount = document.getElementById('pending-count');

        pendingCount.textContent = data.length;

        if (data.length === 0) {
            pendingList.innerHTML = '<p style="color: #999;">No pending approvals</p>';
        } else {
            pendingList.innerHTML = data.map(user => `
                <div class="pending-user">
                    <h4><iconify-icon icon="lucide:user" inline></iconify-icon> ${user.username}</h4>
                    <div class="code">Code: ${user.approval_code}</div>
                    <div style="font-size: 12px; color: #666;">${new Date(user.created_at).toLocaleString()}</div>
                    <div class="pending-user-actions">
                        <button class="approve-btn btn-sm" onclick="window.approveUser('${user.approval_code}')"><iconify-icon icon="lucide:check" inline></iconify-icon> Approve</button>
                        <button class="reject-btn btn-sm" onclick="window.rejectUser('${user.approval_code}')"><iconify-icon icon="lucide:x" inline></iconify-icon> Reject</button>
                    </div>
                </div>
            `).join('');
        }
    } catch (error) {
        console.error('Failed to load pending users:', error);
    }
}

async function approveUser(code) {
    try {
        const resp = await fetch(`${API_URL}/users/pending/${encodeURIComponent(code)}`, {
            method: 'PATCH',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${sessionToken}`
            },
            body: JSON.stringify({ status: 'approved' })
        });

        if (resp.ok) {
            loadPendingUsers();
            loadAllUsers();
        }
    } catch (error) {
        console.error('Failed to approve user:', error);
    }
}

async function rejectUser(code) {
    try {
        const resp = await fetch(`${API_URL}/users/pending/${encodeURIComponent(code)}`, {
            method: 'PATCH',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${sessionToken}`
            },
            body: JSON.stringify({ status: 'rejected' })
        });

        if (resp.ok) {
            loadPendingUsers();
        }
    } catch (error) {
        console.error('Failed to reject user:', error);
    }
}

// User management

async function loadAllUsers() {
    try {
        const resp = await fetch(`${API_URL}/users`, {
            headers: { 'Authorization': `Bearer ${sessionToken}` }
        });
        const data = await resp.json();

        const usersList = document.getElementById('users-list');
        const userCount = document.getElementById('user-count');

        userCount.textContent = data.length;

        if (data.length === 0) {
            usersList.innerHTML = '<p style="color: #999;">No users</p>';
        } else {
            const isAdmin = currentRole === 'admin';
            usersList.innerHTML = data.map(user => {
                let actions = '';
                if (isAdmin && user.username !== currentUsername) {
                    if (user.role === 'user') {
                        actions += `<button class="promote-btn btn-sm" onclick="window.setUserRole('${user.username}', 'moderator')">Make Mod</button>`;
                        actions += `<button class="promote-btn btn-sm" onclick="window.setUserRole('${user.username}', 'admin')">Make Admin</button>`;
                    } else if (user.role === 'moderator') {
                        actions += `<button class="demote-btn btn-sm" onclick="window.setUserRole('${user.username}', 'user')">Remove Mod</button>`;
                        actions += `<button class="promote-btn btn-sm" onclick="window.setUserRole('${user.username}', 'admin')">Make Admin</button>`;
                    } else {
                        actions += `<button class="demote-btn btn-sm" onclick="window.setUserRole('${user.username}', 'user')">Remove Admin</button>`;
                    }
                    actions += `<button class="reject-btn btn-sm" onclick="window.deleteUser('${user.username}')">Delete</button>`;
                }
                return `
                    <div class="user-item">
                        <div class="user-info">
                            <span class="user-name">${user.username}</span>
                            <span class="user-role ${user.role}">${user.role.toUpperCase()}</span>
                        </div>
                        <div class="user-actions">${actions}</div>
                    </div>
                `;
            }).join('');
        }
    } catch (error) {
        console.error('Failed to load users:', error);
    }
}

async function setUserRole(username, role) {
    const action = role === 'user' ? 'demote' : 'promote';
    if (!confirm(`Are you sure you want to ${action} ${username} to ${role}?`)) {
        return;
    }

    try {
        const resp = await fetch(`${API_URL}/users/${encodeURIComponent(username)}`, {
            method: 'PATCH',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${sessionToken}`
            },
            body: JSON.stringify({ role })
        });

        if (resp.ok) {
            loadAllUsers();
        } else {
            const data = await resp.json();
            alert(`Failed: ${data.detail || 'Unknown error'}`);
        }
    } catch (error) {
        console.error('Failed to set user role:', error);
        alert('Failed to change user role');
    }
}

async function deleteUser(username) {
    if (!confirm(`Are you sure you want to delete user "${username}"? This cannot be undone.`)) {
        return;
    }

    try {
        const resp = await fetch(`${API_URL}/users/${encodeURIComponent(username)}`, {
            method: 'DELETE',
            headers: { 'Authorization': `Bearer ${sessionToken}` }
        });

        if (resp.ok) {
            loadAllUsers();
        } else {
            const data = await resp.json();
            alert(`Failed: ${data.detail || 'Unknown error'}`);
        }
    } catch (error) {
        console.error('Failed to delete user:', error);
        alert('Failed to delete user');
    }
}

// User preferences

async function loadUserPreferences() {
    try {
        const [usersResponse, colorsResponse] = await Promise.all([
            fetch(`${API_URL}/users`, {
                headers: { 'Authorization': `Bearer ${sessionToken}` }
            }),
            fetch(`${API_URL}/users/preferences/colors`, {
                headers: { 'Authorization': `Bearer ${sessionToken}` }
            }),
        ]);
        if (!usersResponse.ok) return;

        const users = await usersResponse.json();
        const colors = colorsResponse.ok ? await colorsResponse.json() : {};
        const preferencesList = document.getElementById('user-preferences-list');

        preferencesList.innerHTML = users.map(user => {
            const color = colors[user.username]?.color || '#1976d2';
            return `
            <div class="preference-item">
                <span class="user-name" style="color: ${color};">${user.username}</span>
                <input type="color"
                       id="color-${user.username}"
                       value="${color}"
                       onchange="updateUserColorAdmin('${user.username}')">
            </div>
        `;
        }).join('');

    } catch (error) {
        console.error('[HTTP] Error loading user preferences:', error);
    }
}

async function updateUserColorAdmin(username) {
    const color = document.getElementById(`color-${username}`).value;
    try {
        const response = await fetch(`${API_URL}/users/${encodeURIComponent(username)}`, {
            method: 'PATCH',
            headers: {
                'Authorization': `Bearer ${sessionToken}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ color })
        });
        if (!response.ok) {
            alert('Failed to update user color');
        }
    } catch (error) {
        console.error('[HTTP] Error updating user color:', error);
        alert('Failed to update user color');
    }
}

// ── Backups ────────────────────────────────────────────────────────────

async function loadBackups() {
    try {
        const resp = await fetch(`${API_URL}/admin/backups`, {
            headers: { 'Authorization': `Bearer ${sessionToken}` }
        });
        if (!resp.ok) return;
        const data = await resp.json();
        const list = document.getElementById('backup-list');
        if (!list) return;

        if (data.backups.length === 0) {
            list.innerHTML = '<p style="color: var(--text-muted, #999); font-size: 13px;">No backups yet</p>';
        } else {
            list.innerHTML = data.backups.map(b => `
                <div class="backup-item">
                    <div class="backup-info">
                        <div class="backup-filename">${escapeHtml(b.filename)}</div>
                        <div class="backup-meta">${formatBytes(b.size)} &middot; ${new Date(b.created_at).toLocaleString()}</div>
                    </div>
                    <div class="backup-actions">
                        <a class="btn-sm demote-btn" href="${API_URL}/admin/backups/${encodeURIComponent(b.filename)}" onclick="event.stopPropagation();" title="Download">
                            <iconify-icon icon="lucide:download"></iconify-icon>
                        </a>
                        <button class="reject-btn btn-sm" onclick="window.deleteBackup('${escapeHtml(b.filename)}')" title="Delete">
                            <iconify-icon icon="lucide:trash-2"></iconify-icon>
                        </button>
                    </div>
                </div>
            `).join('');
        }
    } catch (error) {
        console.error('[HTTP] Error loading backups:', error);
    }
}

async function triggerBackup() {
    const btn = document.getElementById('trigger-backup-btn');
    const status = document.getElementById('backup-status');
    if (btn) btn.disabled = true;
    if (status) {
        status.style.display = '';
        status.textContent = 'Creating backup...';
        status.className = 'backup-status';
    }

    try {
        const resp = await fetch(`${API_URL}/admin/backups`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${sessionToken}` }
        });

        if (resp.ok) {
            const data = await resp.json();
            if (status) {
                status.textContent = `Backup created: ${data.filename} (${formatBytes(data.size)}, ${data.duration_seconds}s)`;
                status.className = 'backup-status success';
            }
            loadBackups();
        } else {
            const err = await resp.json();
            if (status) {
                status.textContent = `Backup failed: ${err.detail || 'Unknown error'}`;
                status.className = 'backup-status error';
            }
        }
    } catch (error) {
        console.error('[HTTP] Error triggering backup:', error);
        if (status) {
            status.textContent = 'Backup failed: network error';
            status.className = 'backup-status error';
        }
    } finally {
        if (btn) btn.disabled = false;
    }
}

async function deleteBackup(filename) {
    if (!confirm(`Delete backup "${filename}"?`)) return;
    try {
        await fetch(`${API_URL}/admin/backups/${encodeURIComponent(filename)}`, {
            method: 'DELETE',
            headers: { 'Authorization': `Bearer ${sessionToken}` }
        });
        loadBackups();
    } catch (error) {
        console.error('[HTTP] Error deleting backup:', error);
    }
}

async function loadBackupConfig() {
    try {
        const resp = await fetch(`${API_URL}/admin/backups/config`, {
            headers: { 'Authorization': `Bearer ${sessionToken}` }
        });
        if (!resp.ok) return;
        const config = await resp.json();

        const enabledToggle = document.getElementById('backup-enabled-toggle');
        const scheduleInput = document.getElementById('backup-schedule-input');
        const directoryInput = document.getElementById('backup-directory-input');

        if (enabledToggle) enabledToggle.checked = config.enabled;
        if (scheduleInput) scheduleInput.value = config.schedule;
        if (directoryInput) directoryInput.value = config.directory;
    } catch (error) {
        console.error('[HTTP] Error loading backup config:', error);
    }
}

async function saveBackupConfig(field, value) {
    try {
        await fetch(`${API_URL}/admin/backups/config`, {
            method: 'PATCH',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${sessionToken}`
            },
            body: JSON.stringify({ [field]: value })
        });
    } catch (error) {
        console.error('[HTTP] Error saving backup config:', error);
    }
}

function formatBytes(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

// ── System Log ────────────────────────────────────────────────────────

let logPage = 1;

async function loadSystemLog(page = 1) {
    logPage = page;
    const category = document.getElementById('log-category-filter')?.value || '';
    const level = document.getElementById('log-level-filter')?.value || '';

    try {
        const params = new URLSearchParams({ page, page_size: 50 });
        if (category) params.set('category', category);
        if (level) params.set('level', level);

        const resp = await fetch(`${API_URL}/admin/logs?${params}`, {
            headers: { 'Authorization': `Bearer ${sessionToken}` }
        });
        if (!resp.ok) return;
        const data = await resp.json();

        const list = document.getElementById('log-list');
        if (!list) return;

        if (data.entries.length === 0) {
            list.innerHTML = '<p style="color: var(--text-muted, #999); font-size: 13px;">No log entries</p>';
        } else {
            list.innerHTML = data.entries.map(e => `
                <div class="log-entry log-level-${escapeHtml(e.level)}">
                    <div class="log-entry-header">
                        <span class="log-level-badge">${escapeHtml(e.level)}</span>
                        <span class="log-category">${escapeHtml(e.category)}</span>
                        <span class="log-time">${new Date(e.timestamp).toLocaleString()}</span>
                        ${e.username ? `<span class="log-user">${escapeHtml(e.username)}</span>` : ''}
                    </div>
                    <div class="log-message">${escapeHtml(e.message)}</div>
                </div>
            `).join('');
        }

        // Pagination
        const pagination = document.getElementById('log-pagination');
        if (pagination) {
            const totalPages = Math.ceil(data.total / data.page_size);
            if (totalPages <= 1) {
                pagination.innerHTML = '';
            } else {
                pagination.innerHTML = `
                    <button class="btn-sm" ${page <= 1 ? 'disabled' : ''} onclick="window.loadSystemLog(${page - 1})">Prev</button>
                    <span style="font-size: 13px; color: var(--text-muted, #999);">Page ${page} of ${totalPages}</span>
                    <button class="btn-sm" ${page >= totalPages ? 'disabled' : ''} onclick="window.loadSystemLog(${page + 1})">Next</button>
                `;
            }
        }
    } catch (error) {
        console.error('[HTTP] Error loading system log:', error);
    }
}

// Expose functions to window for inline event handlers
window.updateRegModeLabel = updateRegModeLabel;
window.setRegistrationMode = setRegistrationMode;
window.generateInviteLink = generateInviteLink;
window.copyInviteLink = copyInviteLink;
window.deleteInvite = deleteInvite;
window.approveUser = approveUser;
window.rejectUser = rejectUser;
window.setUserRole = setUserRole;
window.deleteUser = deleteUser;
window.updateUserColorAdmin = updateUserColorAdmin;
window.triggerBackup = triggerBackup;
window.deleteBackup = deleteBackup;
window.loadSystemLog = loadSystemLog;

// Event listeners
document.addEventListener('DOMContentLoaded', () => {
    // Nav switching
    document.querySelectorAll('.settings-nav-item').forEach(item => {
        item.addEventListener('click', () => switchSection(item.dataset.section));
    });

    // Server name input
    const serverNameInput = document.getElementById('server-name-input');
    if (serverNameInput) {
        serverNameInput.addEventListener('change', updateServerName);
    }

    // Registration mode slider
    const regModeSlider = document.getElementById('reg-mode-slider');
    if (regModeSlider) {
        regModeSlider.addEventListener('input', updateRegModeLabel);
        regModeSlider.addEventListener('change', setRegistrationMode);
    }

    // Server icon upload
    const iconUpload = document.getElementById('server-icon-upload');
    if (iconUpload) {
        iconUpload.addEventListener('change', (e) => {
            const file = e.target.files[0];
            if (file) {
                uploadServerIcon(file);
                e.target.value = '';  // Reset so same file can be re-selected
            }
        });
    }

    // Server icon reset
    const iconResetBtn = document.getElementById('server-icon-reset-btn');
    if (iconResetBtn) {
        iconResetBtn.addEventListener('click', resetServerIcon);
    }

    // Generate invite button
    const generateInviteBtn = document.getElementById('generate-invite-btn');
    if (generateInviteBtn) {
        generateInviteBtn.addEventListener('click', generateInviteLink);
    }

    // Backup controls
    const triggerBackupBtn = document.getElementById('trigger-backup-btn');
    if (triggerBackupBtn) {
        triggerBackupBtn.addEventListener('click', triggerBackup);
    }

    const backupEnabledToggle = document.getElementById('backup-enabled-toggle');
    if (backupEnabledToggle) {
        backupEnabledToggle.addEventListener('change', () => saveBackupConfig('enabled', backupEnabledToggle.checked));
    }

    const backupScheduleInput = document.getElementById('backup-schedule-input');
    if (backupScheduleInput) {
        backupScheduleInput.addEventListener('change', () => saveBackupConfig('schedule', backupScheduleInput.value));
    }

    const backupDirectoryInput = document.getElementById('backup-directory-input');
    if (backupDirectoryInput) {
        backupDirectoryInput.addEventListener('change', () => saveBackupConfig('directory', backupDirectoryInput.value));
    }

    // System log filters
    const logCategoryFilter = document.getElementById('log-category-filter');
    if (logCategoryFilter) {
        logCategoryFilter.addEventListener('change', () => loadSystemLog(1));
    }

    const logLevelFilter = document.getElementById('log-level-filter');
    if (logLevelFilter) {
        logLevelFilter.addEventListener('change', () => loadSystemLog(1));
    }
});
