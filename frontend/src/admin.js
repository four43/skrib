import { API_URL, escapeHtml } from './utils.js';
import { loadTheme } from './theme-manager.js';

let sessionToken = null;
let currentUsername = null;
let currentRole = null;
let adminPollInterval = null;
let currentRegMode = 'closed';

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
                window.location.href = '/chat.html';
                return;
            }

            // Load user's theme preferences
            await loadTheme(username, sessionToken);

            // Hide admin-only sections for moderators
            if (currentRole === 'moderator') {
                document.querySelectorAll('.admin-only').forEach(el => el.style.display = 'none');
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

async function loadAdminSettings() {
    try {
        const resp = await fetch(`${API_URL}/server`, {
            headers: { 'Authorization': `Bearer ${sessionToken}` }
        });
        const data = await resp.json();

        updateRegModeSlider(data.registration_mode);
        loadPendingUsers();
        loadAllUsers();
        loadUserPreferences();
        if (data.registration_mode === 'invite_only') {
            loadInviteTokens();
        }
        const serverColorPicker = document.getElementById('server-color-picker');
        if (serverColorPicker && data.server_color) {
            serverColorPicker.value = data.server_color;
        }
    } catch (error) {
        console.error('Failed to load admin settings:', error);
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
    const section = document.getElementById('invite-section');
    if (mode === 'invite_only') {
        section.classList.remove('hidden');
        loadInviteTokens();
    } else {
        section.classList.add('hidden');
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

// Server color

async function updateServerColor() {
    const color = document.getElementById('server-color-picker').value;
    try {
        const response = await fetch(`${API_URL}/server`, {
            method: 'PATCH',
            headers: {
                'Authorization': `Bearer ${sessionToken}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ server_color: color })
        });
        if (!response.ok) {
            alert('Failed to update server color');
        }
    } catch (error) {
        console.error('[HTTP] Error updating server color:', error);
        alert('Failed to update server color');
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

        if (data.invites.length === 0) {
            inviteList.innerHTML = '<p style="color: #999; font-size: 13px;">No invite links yet</p>';
        } else {
            inviteList.innerHTML = data.invites.map(inv => {
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
                        ${!inv.used_by ? `<button class="reject-btn btn-sm invite-delete-btn" onclick="deleteInvite('${inv.token}')">✕</button>` : ''}
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

        pendingCount.textContent = data.users.length;

        if (data.users.length === 0) {
            pendingList.innerHTML = '<p style="color: #999;">No pending approvals</p>';
        } else {
            pendingList.innerHTML = data.users.map(user => `
                <div class="pending-user">
                    <h4>👤 ${user.username}</h4>
                    <div class="code">Code: ${user.approval_code}</div>
                    <div style="font-size: 12px; color: #666;">${new Date(user.created_at).toLocaleString()}</div>
                    <div class="pending-user-actions">
                        <button class="approve-btn btn-sm" onclick="window.approveUser('${user.approval_code}')">✓ Approve</button>
                        <button class="reject-btn btn-sm" onclick="window.rejectUser('${user.approval_code}')">✕ Reject</button>
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

        userCount.textContent = data.users.length;

        if (data.users.length === 0) {
            usersList.innerHTML = '<p style="color: #999;">No users</p>';
        } else {
            const isAdmin = currentRole === 'admin';
            usersList.innerHTML = data.users.map(user => {
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
        const response = await fetch(`${API_URL}/users`, {
            headers: { 'Authorization': `Bearer ${sessionToken}` }
        });
        if (!response.ok) return;

        const data = await response.json();
        const preferencesList = document.getElementById('user-preferences-list');

        const prefsPromises = data.users.map(async (user) => {
            const prefsResponse = await fetch(`${API_URL}/users/${user.username}/preferences`, {
                headers: { 'Authorization': `Bearer ${sessionToken}` }
            });
            if (prefsResponse.ok) {
                const prefs = await prefsResponse.json();
                return { ...user, color: prefs.color };
            }
            return { ...user, color: '#1976d2' };
        });

        const usersWithPrefs = await Promise.all(prefsPromises);

        preferencesList.innerHTML = usersWithPrefs.map(user => `
            <div class="preference-item">
                <span class="user-name" style="color: ${user.color};">${user.username}</span>
                <input type="color"
                       id="color-${user.username}"
                       value="${user.color}"
                       onchange="updateUserColorAdmin('${user.username}')">
            </div>
        `).join('');

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
window.updateServerColor = updateServerColor;
window.updateUserColorAdmin = updateUserColorAdmin;

// Event listeners
document.addEventListener('DOMContentLoaded', () => {
    // Server color picker
    const serverColorPicker = document.getElementById('server-color-picker');
    if (serverColorPicker) {
        serverColorPicker.addEventListener('change', updateServerColor);
    }

    // Registration mode slider
    const regModeSlider = document.getElementById('reg-mode-slider');
    if (regModeSlider) {
        regModeSlider.addEventListener('input', updateRegModeLabel);
        regModeSlider.addEventListener('change', setRegistrationMode);
    }

    // Generate invite button
    const generateInviteBtn = document.getElementById('generate-invite-btn');
    if (generateInviteBtn) {
        generateInviteBtn.addEventListener('click', generateInviteLink);
    }
});
