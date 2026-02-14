import './style.css';
import { API_URL, escapeHtml, loadAndApplyTheme, applyThemeColor } from './utils.js';
import {
    loadPrivateKey,
    generateRoomKey,
    encryptRoomKey,
    decryptRoomKey,
    encryptMessage,
    decryptMessage,
    isEncryptedMessage,
    getMessageEpoch,
} from './crypto.js';

let sessionToken = null;
let currentUsername = null;
let currentRole = null;
let currentRoom = null;
let lastMessageId = 0;
let websocket = null;
let adminPollInterval = null;
let isLoadingMessages = false;
let reconnectAttempts = 0;
let maxReconnectAttempts = 5;
let reconnectTimeout = null;
let userColors = {};  // Cache of username -> color mappings
let serverColor = '#6366f1';  // Cached server color for theme reset
let currentRegMode = 'closed';  // Current registration mode
let roomMeta = {};  // Cache of room_id -> { room_type, display_name, members }
let roomsWs = null;  // WebSocket subscription for room list updates
let roomsWsReconnectTimeout = null;
let privateKey = null;  // User's RSA-OAEP private key (loaded from IndexedDB)
let roomKeys = {};  // room_id -> { epoch: CryptoKey }

// ---------------------------------------------------------------------------
// Slash command framework
// ---------------------------------------------------------------------------

const slashCommands = {};

function registerCommand(name, handler, description) {
    slashCommands[name] = { handler, description };
}

function parseAndExecuteCommand(input) {
    const parts = input.substring(1).split(/\s+/);
    const commandName = parts[0].toLowerCase();
    const args = parts.slice(1).join(' ').trim();

    const command = slashCommands[commandName];
    if (!command) {
        displaySystemMessage(`Unknown command: /${commandName}. Type /help for available commands.`);
        return;
    }

    command.handler(args);
}

function displaySystemMessage(text) {
    const messagesDiv = document.getElementById('messages');
    if (!messagesDiv) return;

    if (messagesDiv.querySelector('.empty-state')) {
        messagesDiv.innerHTML = '';
    }

    const messageDiv = document.createElement('div');
    messageDiv.className = 'message system-message';
    messageDiv.innerHTML = `
        <div class="message-text system-message-text">${escapeHtml(text).replace(/\n/g, '<br>')}</div>
    `;

    messagesDiv.appendChild(messageDiv);
    messagesDiv.scrollTop = messagesDiv.scrollHeight;
}

// ---------------------------------------------------------------------------
// Commands: /help, /invite
// ---------------------------------------------------------------------------

registerCommand('help', () => {
    const lines = ['Available commands:'];
    for (const [name, cmd] of Object.entries(slashCommands)) {
        lines.push(`  /${name} — ${cmd.description}`);
    }
    displaySystemMessage(lines.join('\n'));
}, 'Show available commands');

registerCommand('invite', async (args) => {
    const targetUsername = args.trim();

    if (!targetUsername) {
        displaySystemMessage('Usage: /invite <username>');
        return;
    }

    if (!currentRoom) {
        displaySystemMessage('Please select a room first.');
        return;
    }

    if (!privateKey) {
        displaySystemMessage('Encryption keys not loaded. Please log out and back in.');
        return;
    }

    const currentEpochs = roomKeys[currentRoom];
    if (!currentEpochs || Object.keys(currentEpochs).length === 0) {
        displaySystemMessage('No room key available. Cannot invite to an unencrypted room.');
        return;
    }

    try {
        // 1. Add member to room
        const memberResp = await fetch(
            `${API_URL}/rooms/${encodeURIComponent(currentRoom)}/members`,
            {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${sessionToken}`,
                },
                body: JSON.stringify({ username: targetUsername }),
            }
        );

        if (!memberResp.ok) {
            const data = await memberResp.json();
            displaySystemMessage(`Could not invite ${targetUsername}: ${data.detail || 'Unknown error'}`);
            return;
        }

        // 2. Fetch their encryption public key
        const keyResp = await fetch(
            `${API_URL}/auth/encryption-key/${encodeURIComponent(targetUsername)}`,
            { headers: { 'Authorization': `Bearer ${sessionToken}` } }
        );

        if (!keyResp.ok) {
            displaySystemMessage(`${targetUsername} has no encryption key. They need to log in first.`);
            return;
        }

        const { public_key: publicKeyJson } = await keyResp.json();
        const publicKeyJwk = JSON.parse(publicKeyJson);

        // 3. Encrypt room key for each epoch the invitee should have access to
        const epochs = Object.keys(currentEpochs).map(Number);
        for (const epoch of epochs) {
            const encKey = await encryptRoomKey(currentEpochs[epoch], publicKeyJwk);
            await fetch(
                `${API_URL}/rooms/${encodeURIComponent(currentRoom)}/keys`,
                {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${sessionToken}`,
                    },
                    body: JSON.stringify({
                        username: targetUsername,
                        encrypted_key: encKey,
                        key_epoch: epoch,
                    }),
                }
            );
        }

        displaySystemMessage(`Invited ${targetUsername} to this room.`);
    } catch (error) {
        console.error('[CMD] Error inviting user:', error);
        displaySystemMessage('Failed to invite user. Please try again.');
    }
}, 'Invite a user to the current room');

// ---------------------------------------------------------------------------
// E2E helpers
// ---------------------------------------------------------------------------

/** Fetch and decrypt all room keys for the current user in a given room. */
async function loadRoomKeys(roomId) {
    if (!privateKey) return;

    try {
        const resp = await fetch(
            `${API_URL}/rooms/${encodeURIComponent(roomId)}/keys`,
            { headers: { 'Authorization': `Bearer ${sessionToken}` } }
        );
        if (!resp.ok) return;

        const { keys } = await resp.json();
        if (!keys || keys.length === 0) return;

        roomKeys[roomId] = {};
        for (const entry of keys) {
            try {
                roomKeys[roomId][entry.key_epoch] = await decryptRoomKey(entry.encrypted_key, privateKey);
            } catch (e) {
                console.warn(`[E2E] Failed to decrypt epoch ${entry.key_epoch} for ${roomId}:`, e);
            }
        }
    } catch (error) {
        console.error('[E2E] Error loading room keys:', error);
    }
}

/** Generate a room key, encrypt for self, and upload to server. */
async function initRoomKey(roomId) {
    if (!privateKey) return;

    try {
        // Fetch our own public key
        const pkResp = await fetch(
            `${API_URL}/auth/encryption-key/${encodeURIComponent(currentUsername)}`,
            { headers: { 'Authorization': `Bearer ${sessionToken}` } }
        );
        if (!pkResp.ok) return;

        const { public_key: myPublicKeyJson } = await pkResp.json();
        const myPublicKeyJwk = JSON.parse(myPublicKeyJson);

        const roomKey = await generateRoomKey();
        const encKey = await encryptRoomKey(roomKey, myPublicKeyJwk);

        await fetch(
            `${API_URL}/rooms/${encodeURIComponent(roomId)}/keys`,
            {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${sessionToken}`,
                },
                body: JSON.stringify({
                    username: currentUsername,
                    encrypted_key: encKey,
                    key_epoch: 0,
                }),
            }
        );

        roomKeys[roomId] = { 0: roomKey };
        return roomKey;
    } catch (error) {
        console.error('[E2E] Error initializing room key:', error);
    }
}

/** Generate a room key for a DM and encrypt for both users. */
async function initDMRoomKey(roomId, otherUsername) {
    if (!privateKey) return;

    try {
        // Fetch both public keys
        const [myResp, otherResp] = await Promise.all([
            fetch(`${API_URL}/auth/encryption-key/${encodeURIComponent(currentUsername)}`,
                { headers: { 'Authorization': `Bearer ${sessionToken}` } }),
            fetch(`${API_URL}/auth/encryption-key/${encodeURIComponent(otherUsername)}`,
                { headers: { 'Authorization': `Bearer ${sessionToken}` } }),
        ]);

        if (!myResp.ok || !otherResp.ok) return;

        const myPk = JSON.parse((await myResp.json()).public_key);
        const otherPk = JSON.parse((await otherResp.json()).public_key);

        const roomKey = await generateRoomKey();

        const [encForMe, encForOther] = await Promise.all([
            encryptRoomKey(roomKey, myPk),
            encryptRoomKey(roomKey, otherPk),
        ]);

        // Upload both encrypted keys
        await Promise.all([
            fetch(`${API_URL}/rooms/${encodeURIComponent(roomId)}/keys`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${sessionToken}` },
                body: JSON.stringify({ username: currentUsername, encrypted_key: encForMe, key_epoch: 0 }),
            }),
            fetch(`${API_URL}/rooms/${encodeURIComponent(roomId)}/keys`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${sessionToken}` },
                body: JSON.stringify({ username: otherUsername, encrypted_key: encForOther, key_epoch: 0 }),
            }),
        ]);

        roomKeys[roomId] = { 0: roomKey };
    } catch (error) {
        console.error('[E2E] Error initializing DM room key:', error);
    }
}

// Load server theme immediately (before auth check) so page renders with correct color
loadAndApplyTheme().then(color => { serverColor = color; });

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

            // Load E2E encryption private key from IndexedDB
            try {
                privateKey = await loadPrivateKey(username);
                if (!privateKey) {
                    console.warn('[E2E] No private key found in IndexedDB');
                }
            } catch (e) {
                console.error('[E2E] Failed to load private key:', e);
            }

            await loadUserColors();
            await loadUserSettings();
            initializeChatView();
        } else {
            // Session invalid, clear and redirect
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

async function initializeChatView() {
    document.getElementById('currentUser').textContent = `👤 ${currentUsername}`;

    if (currentRole === 'admin') {
        document.getElementById('adminBadge').classList.remove('hidden');
        document.getElementById('adminPanelBtn').classList.remove('hidden');
        loadAdminSettings();
    }

    await loadRooms();
    connectRoomsSubscription();

    // Navigate to room from hash if present
    const roomFromHash = getRoomFromHash();
    if (roomFromHash) {
        selectRoom(roomFromHash);
    }

    // Listen for hash changes (back/forward navigation, clicking room links)
    window.addEventListener('hashchange', () => {
        const room = getRoomFromHash();
        if (room) {
            selectRoom(room);
        }
    });

    // Show sidebar on mobile if no room is selected
    if (window.innerWidth <= 768 && !currentRoom) {
        const sidebar = document.querySelector('.sidebar');
        const overlay = document.querySelector('.sidebar-overlay');
        sidebar.classList.add('show');
        overlay.classList.add('show');
    }
}

function logout() {
    sessionToken = null;
    currentUsername = null;
    currentRole = null;
    localStorage.removeItem('session_token');
    localStorage.removeItem('username');
    localStorage.removeItem('role');

    if (websocket) {
        websocket.close();
        websocket = null;
    }
    if (roomsWs) {
        roomsWs.close();
        roomsWs = null;
    }
    if (reconnectTimeout) clearTimeout(reconnectTimeout);
    if (roomsWsReconnectTimeout) clearTimeout(roomsWsReconnectTimeout);
    if (adminPollInterval) clearInterval(adminPollInterval);

    history.replaceState(null, '', window.location.pathname);
    window.location.href = '/login.html';
}

function toggleAdminPanel() {
    document.getElementById('adminPanel').classList.toggle('open');
    updatePendingPoll();
}

function updatePendingPoll() {
    const panelOpen = document.getElementById('adminPanel').classList.contains('open');
    const shouldPoll = panelOpen && currentRegMode === 'approval_required';

    if (shouldPoll && !adminPollInterval) {
        loadPendingUsers();
        adminPollInterval = setInterval(loadPendingUsers, 5000);
    } else if (!shouldPoll && adminPollInterval) {
        clearInterval(adminPollInterval);
        adminPollInterval = null;
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
        // Set server color picker
        const serverColorPicker = document.getElementById('serverColorPicker');
        if (serverColorPicker && data.server_color) {
            serverColorPicker.value = data.server_color;
            serverColor = data.server_color;
        }
    } catch (error) {
        console.error('Failed to load admin settings:', error);
    }
}

async function loadUserColors() {
    try {
        const response = await fetch(`${API_URL}/users/preferences/colors`, {
            headers: {
                'Authorization': `Bearer ${sessionToken}`
            }
        });
        if (response.ok) {
            userColors = await response.json();
        }
    } catch (error) {
        console.error('[HTTP] Error loading user colors:', error);
    }
}

function toggleSettingsPanel() {
    const panel = document.getElementById('settingsPanel');
    panel.classList.toggle('open');
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
            const colorInput = document.getElementById('userColor');
            if (colorInput) {
                colorInput.value = data.color;
            }
            // Apply user's theme color override if set
            const themeInput = document.getElementById('userThemeColor');
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
    const color = document.getElementById('userColor').value;
    try {
        const response = await fetch(`${API_URL}/users/${currentUsername}/preferences`, {
            method: 'PUT',
            headers: {
                'Authorization': `Bearer ${sessionToken}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ color })
        });
        if (response.ok) {
            // Update local cache
            userColors[currentUsername] = color;
            // Refresh messages to show new color
            if (currentRoom) {
                await loadMessages();
            }
        }
    } catch (error) {
        console.error('[HTTP] Error updating color:', error);
        alert('Failed to update color preference');
    }
}

async function updateUserThemeColor() {
    const themeColor = document.getElementById('userThemeColor').value;
    try {
        const response = await fetch(`${API_URL}/users/${currentUsername}/preferences`, {
            method: 'PUT',
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
        const response = await fetch(`${API_URL}/users/${currentUsername}/preferences`, {
            method: 'PUT',
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

async function updateServerColor() {
    const color = document.getElementById('serverColorPicker').value;
    try {
        const response = await fetch(`${API_URL}/server/color`, {
            method: 'PUT',
            headers: {
                'Authorization': `Bearer ${sessionToken}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ server_color: color })
        });
        if (response.ok) {
            serverColor = color;
            // Apply immediately if user has no override
            const themeInput = document.getElementById('userThemeColor');
            if (themeInput && themeInput.value === serverColor) {
                applyThemeColor(color);
            }
        }
    } catch (error) {
        console.error('[HTTP] Error updating server color:', error);
        alert('Failed to update server color');
    }
}

const REG_MODES = ['closed', 'invite_only', 'approval_required', 'open'];
const REG_MODE_DESCRIPTIONS = {
    closed: 'No new registrations allowed',
    invite_only: 'Users can register with an invite link',
    approval_required: 'Users register and wait for admin approval',
    open: 'Anyone can register and immediately join'
};

function updateRegModeSlider(mode) {
    const slider = document.getElementById('regModeSlider');
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
    const slider = document.getElementById('regModeSlider');
    const desc = document.getElementById('regModeDescription');
    const mode = REG_MODES[slider.value];
    desc.textContent = REG_MODE_DESCRIPTIONS[mode];

    // Update label highlighting
    const labels = document.querySelectorAll('.reg-mode-labels span');
    labels.forEach((label, i) => {
        label.classList.toggle('active', i == slider.value);
    });
}

async function setRegistrationMode() {
    const slider = document.getElementById('regModeSlider');
    const mode = REG_MODES[slider.value];

    try {
        const resp = await fetch(`${API_URL}/server/registration`, {
            method: 'PUT',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${sessionToken}`
            },
            body: JSON.stringify({ mode })
        });
        const data = await resp.json();
        updateRegModeSlider(data.mode);
    } catch (error) {
        console.error('Failed to set registration mode:', error);
    }
}

function updateInviteSectionVisibility(mode) {
    const section = document.getElementById('inviteSection');
    if (mode === 'invite_only') {
        section.classList.remove('hidden');
        loadInviteTokens();
    } else {
        section.classList.add('hidden');
    }
}

async function generateInviteLink() {
    try {
        const resp = await fetch(`${API_URL}/server/invites`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${sessionToken}`
            }
        });
        const data = await resp.json();
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

        const inviteList = document.getElementById('inviteList');

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
                        ${!inv.used_by ? `<button class="delete-btn invite-delete-btn" onclick="deleteInvite('${inv.token}')">✕</button>` : ''}
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
        // Brief visual feedback
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

async function loadPendingUsers() {
    try {
        const resp = await fetch(`${API_URL}/users/pending`, {
            headers: { 'Authorization': `Bearer ${sessionToken}` }
        });
        const data = await resp.json();

        const pendingList = document.getElementById('pendingList');
        const pendingCount = document.getElementById('pendingCount');

        pendingCount.textContent = data.pending.length;

        if (data.pending.length === 0) {
            pendingList.innerHTML = '<p style="color: #999;">No pending approvals</p>';
        } else {
            pendingList.innerHTML = data.pending.map(user => `
                <div class="pending-user">
                    <h4>👤 ${user.username}</h4>
                    <div class="code">Code: ${user.approval_code}</div>
                    <div style="font-size: 12px; color: #666;">${new Date(user.registered_at).toLocaleString()}</div>
                    <div class="pending-user-actions">
                        <button class="approve-btn" onclick="window.approveUser('${user.approval_code}')">✓ Approve</button>
                        <button class="reject-btn" onclick="window.rejectUser('${user.approval_code}')">✕ Reject</button>
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
        const resp = await fetch(`${API_URL}/users/pending/approve`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${sessionToken}`
            },
            body: JSON.stringify({ approval_code: code })
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
        const resp = await fetch(`${API_URL}/users/pending/reject`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${sessionToken}`
            },
            body: JSON.stringify({ approval_code: code })
        });

        if (resp.ok) {
            loadPendingUsers();
        }
    } catch (error) {
        console.error('Failed to reject user:', error);
    }
}

async function loadAllUsers() {
    try {
        const resp = await fetch(`${API_URL}/users`, {
            headers: { 'Authorization': `Bearer ${sessionToken}` }
        });
        const data = await resp.json();

        const usersList = document.getElementById('usersList');
        const userCount = document.getElementById('userCount');

        userCount.textContent = data.users.length;

        if (data.users.length === 0) {
            usersList.innerHTML = '<p style="color: #999;">No users</p>';
        } else {
            usersList.innerHTML = data.users.map(user => `
                <div class="user-item">
                    <div class="user-info">
                        <span class="user-name">${user.username}</span>
                        <span class="user-role ${user.role}">${user.role.toUpperCase()}</span>
                    </div>
                    <div class="user-actions">
                        ${user.role === 'user'
                            ? `<button class="promote-btn" onclick="window.setUserRole('${user.username}', 'admin')">Make Admin</button>`
                            : `<button class="demote-btn" onclick="window.setUserRole('${user.username}', 'user')">Remove Admin</button>`
                        }
                        ${user.username !== currentUsername
                            ? `<button class="delete-btn" onclick="window.deleteUser('${user.username}')">Delete</button>`
                            : ''
                        }
                    </div>
                </div>
            `).join('');
        }
    } catch (error) {
        console.error('Failed to load users:', error);
    }
}

async function setUserRole(username, role) {
    if (!confirm(`Are you sure you want to ${role === 'admin' ? 'promote' : 'demote'} ${username}?`)) {
        return;
    }

    try {
        const resp = await fetch(`${API_URL}/users/${encodeURIComponent(username)}/role`, {
            method: 'PUT',
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

async function loadUserPreferences() {
    try {
        const response = await fetch(`${API_URL}/users`, {
            headers: {
                'Authorization': `Bearer ${sessionToken}`
            }
        });
        if (!response.ok) return;

        const data = await response.json();
        const preferencesList = document.getElementById('userPreferencesList');

        // Fetch preferences for each user
        const prefsPromises = data.users.map(async (user) => {
            const prefsResponse = await fetch(`${API_URL}/users/${user.username}/preferences`, {
                headers: {
                    'Authorization': `Bearer ${sessionToken}`
                }
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
        const response = await fetch(`${API_URL}/users/${username}/preferences`, {
            method: 'PUT',
            headers: {
                'Authorization': `Bearer ${sessionToken}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ color })
        });
        if (response.ok) {
            userColors[username] = color;
            // Refresh messages if this user has messages in current room
            if (currentRoom) {
                await loadMessages();
            }
        }
    } catch (error) {
        console.error('[HTTP] Error updating user color:', error);
        alert('Failed to update user color');
    }
}

async function loadRooms() {
    try {
        const response = await fetch(`${API_URL}/rooms`, {
            headers: { 'Authorization': `Bearer ${sessionToken}` }
        });
        const data = await response.json();

        const channelList = document.getElementById('channelList');
        const dmList = document.getElementById('dmList');
        channelList.innerHTML = '';
        dmList.innerHTML = '';

        // Update room metadata cache
        roomMeta = {};
        data.rooms.forEach(room => {
            roomMeta[room.room_id] = room;
        });

        const channels = data.rooms.filter(r => r.room_type === 'channel');
        const dms = data.rooms.filter(r => r.room_type === 'dm');

        channels.forEach(room => {
            channelList.appendChild(createRoomItem(room));
        });

        dms.forEach(room => {
            dmList.appendChild(createRoomItem(room));
        });
    } catch (error) {
        console.error('Error loading rooms:', error);
    }
}

function createRoomItem(room) {
    const item = document.createElement('div');
    item.className = 'room-item';
    item.dataset.roomId = room.room_id;
    if (currentRoom === room.room_id) {
        item.classList.add('active');
    }

    const nameSpan = document.createElement('span');
    nameSpan.className = 'room-name';
    nameSpan.textContent = room.display_name;
    nameSpan.onclick = () => selectRoom(room.room_id);

    item.appendChild(nameSpan);

    if (currentRole === 'admin' && room.room_type === 'channel') {
        const settingsBtn = document.createElement('button');
        settingsBtn.className = 'room-settings-btn';
        settingsBtn.textContent = '\u2699';
        settingsBtn.title = 'Room settings';
        settingsBtn.onclick = (e) => {
            e.stopPropagation();
            openRoomSettings(room.room_id);
        };
        item.appendChild(settingsBtn);
    }

    return item;
}

function connectRoomsSubscription() {
    if (roomsWs) {
        roomsWs.close();
        roomsWs = null;
    }

    const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsHost = window.location.host;
    const wsUrl = `${wsProtocol}//${wsHost}/api/rooms?token=${encodeURIComponent(sessionToken)}`;

    console.log('[WS:rooms] Connecting to room list subscription...');
    roomsWs = new WebSocket(wsUrl);

    roomsWs.onopen = () => {
        console.log('[WS:rooms] Connected');
    };

    roomsWs.onmessage = (event) => {
        try {
            const data = JSON.parse(event.data);
            if (data.type === 'update') {
                console.log('[WS:rooms] Room list updated, reloading...');
                loadRooms();
            }
        } catch (error) {
            console.error('[WS:rooms] Error parsing message:', error);
        }
    };

    roomsWs.onclose = () => {
        console.log('[WS:rooms] Disconnected');
        roomsWs = null;
        // Reconnect after a delay if we're still logged in
        if (sessionToken) {
            roomsWsReconnectTimeout = setTimeout(connectRoomsSubscription, 5000);
        }
    };

    roomsWs.onerror = (error) => {
        console.error('[WS:rooms] Error:', error);
    };
}

function openCreateRoomModal() {
    const modal = document.getElementById('createRoomModal');
    const input = document.getElementById('newRoomInput');
    input.value = '';
    modal.classList.add('open');
    setTimeout(() => input.focus(), 100);
}

function closeCreateRoomModal() {
    const modal = document.getElementById('createRoomModal');
    modal.classList.remove('open');
}

async function createRoom() {
    const input = document.getElementById('newRoomInput');
    const roomId = input.value.trim().toLowerCase();

    if (!roomId) {
        alert('Please enter a channel name');
        return;
    }

    if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(roomId)) {
        alert('Channel name must be lowercase letters, numbers, and hyphens only (e.g. "my-channel")');
        return;
    }

    try {
        const response = await fetch(`${API_URL}/rooms`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${sessionToken}`
            },
            body: JSON.stringify({ room_id: roomId })
        });

        const data = await response.json();

        if (data.detail) {
            alert(data.detail);
        } else {
            // Generate E2E room key for this new channel
            await initRoomKey(roomId);

            input.value = '';
            closeCreateRoomModal();
            await loadRooms();
            selectRoom(roomId);
        }
    } catch (error) {
        console.error('Error creating room:', error);
        alert('Failed to create room');
    }
}

function getRoomFromHash() {
    const match = window.location.hash.match(/^#\/r\/(.+)$/);
    return match ? decodeURIComponent(match[1]) : null;
}

function selectRoom(roomId) {
    // Don't do anything if already in this room
    if (currentRoom === roomId) {
        // Just hide sidebar on mobile if clicking the same room
        if (window.innerWidth <= 768) {
            hideSidebar();
        }
        return;
    }

    // Close existing WebSocket if any
    if (websocket) {
        websocket.close();
        websocket = null;
    }
    if (reconnectTimeout) {
        clearTimeout(reconnectTimeout);
        reconnectTimeout = null;
    }

    // Switching to a different room
    currentRoom = roomId;
    lastMessageId = 0;
    reconnectAttempts = 0;

    // Update URL hash
    window.location.hash = `#/r/${encodeURIComponent(roomId)}`;

    // Use display_name from metadata for header
    const meta = roomMeta[roomId];
    const displayName = meta ? meta.display_name : roomId;
    document.getElementById('chatHeader').textContent = displayName;

    document.querySelectorAll('.room-item').forEach(item => {
        item.classList.toggle('active', item.dataset.roomId === roomId);
    });

    // Clear messages div when switching rooms
    document.getElementById('messages').innerHTML = '';

    // Load room encryption keys, then message history, then connect WebSocket
    loadRoomKeys(roomId).then(() => {
        loadMessages();
        connectWebSocket(roomId);
    });

    // Auto-hide sidebar on mobile after selecting a room
    if (window.innerWidth <= 768) {
        hideSidebar();
    }
}

function toggleSidebar() {
    const sidebar = document.querySelector('.sidebar');
    const overlay = document.querySelector('.sidebar-overlay');

    sidebar.classList.toggle('show');
    overlay.classList.toggle('show');
}

function hideSidebar() {
    const sidebar = document.querySelector('.sidebar');
    const overlay = document.querySelector('.sidebar-overlay');

    sidebar.classList.remove('show');
    overlay.classList.remove('show');
}

function connectWebSocket(roomId) {
    // Get WebSocket URL
    const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsHost = window.location.host;
    const wsUrl = `${wsProtocol}//${wsHost}/api/rooms/${encodeURIComponent(roomId)}/ws?token=${encodeURIComponent(sessionToken)}`;

    console.log(`[WS] Connecting to room ${roomId}...`);

    websocket = new WebSocket(wsUrl);

    websocket.onopen = () => {
        console.log(`[WS] Connected to room ${roomId}`);
        reconnectAttempts = 0;
    };

    websocket.onmessage = (event) => {
        try {
            const data = JSON.parse(event.data);
            handleWebSocketMessage(data);
        } catch (error) {
            console.error('[WS] Error parsing message:', error);
        }
    };

    websocket.onerror = (error) => {
        console.error('[WS] WebSocket error:', error);
    };

    websocket.onclose = (event) => {
        console.log('[WS] WebSocket closed:', event.code, event.reason);
        websocket = null;

        // Attempt to reconnect if the room is still active
        if (currentRoom === roomId && reconnectAttempts < maxReconnectAttempts) {
            reconnectAttempts++;
            const delay = Math.min(1000 * Math.pow(2, reconnectAttempts), 10000);
            console.log(`[WS] Reconnecting in ${delay}ms (attempt ${reconnectAttempts}/${maxReconnectAttempts})...`);

            reconnectTimeout = setTimeout(() => {
                if (currentRoom === roomId) {
                    connectWebSocket(roomId);
                }
            }, delay);
        }
    };
}

function handleWebSocketMessage(data) {
    console.log('[WS] Received:', data);

    switch (data.type) {
        case 'connected':
            console.log(`[WS] Connection confirmed for room ${data.room}`);
            break;

        case 'message':
            displayMessage(data.data);
            break;

        case 'error':
            console.error('[WS] Server error:', data.message);
            break;

        default:
            console.warn('[WS] Unknown message type:', data.type);
    }
}

function linkifyRoomRefs(text) {
    return text.replace(/#\/r\/(\S+)/g, (match, room) => {
        return `<a href="#/r/${room}" class="room-link">#/r/${room}</a>`;
    });
}

async function displayMessage(msg) {
    const messagesDiv = document.getElementById('messages');

    // Clear empty state if present
    if (messagesDiv.querySelector('.empty-state')) {
        messagesDiv.innerHTML = '';
    }

    const messageDiv = document.createElement('div');
    messageDiv.className = 'message';

    const date = new Date(msg.timestamp);
    const timeStr = date.toLocaleTimeString();

    // Get user's color preference, default to blue
    const userColor = userColors[msg.username] || '#1976d2';

    // Decrypt if encrypted
    let plaintext = msg.message;
    if (isEncryptedMessage(msg.message)) {
        const epoch = getMessageEpoch(msg.message);
        const epochs = roomKeys[currentRoom];
        const key = epochs && epochs[epoch];
        if (key) {
            try {
                plaintext = await decryptMessage(key, msg.message);
            } catch (e) {
                console.warn('[E2E] Failed to decrypt message:', e);
                plaintext = '[encrypted message — cannot decrypt]';
            }
        } else {
            plaintext = '[encrypted message — no key for this room]';
        }
    }

    const messageBody = linkifyRoomRefs(escapeHtml(plaintext));

    messageDiv.innerHTML = `
        <div class="message-header">
            <span class="username" style="color: ${userColor};">${escapeHtml(msg.username)}</span>
            <span class="timestamp">${timeStr}</span>
        </div>
        <div class="message-text">${messageBody}</div>
    `;

    messagesDiv.appendChild(messageDiv);

    // Update lastMessageId
    if (msg.id > lastMessageId) {
        lastMessageId = msg.id;
    }

    // Scroll to bottom
    messagesDiv.scrollTop = messagesDiv.scrollHeight;
}

async function loadMessages() {
    if (!currentRoom || isLoadingMessages) return;

    isLoadingMessages = true;

    try {
        console.log(`[HTTP] Loading message history since=${lastMessageId}`);
        const response = await fetch(`${API_URL}/rooms/${encodeURIComponent(currentRoom)}/messages?since=${lastMessageId}`, {
            headers: { 'Authorization': `Bearer ${sessionToken}` }
        });
        const data = await response.json();

        if (data.messages && data.messages.length > 0) {
            console.log(`[HTTP] Loaded ${data.messages.length} messages from history`);

            // Use displayMessage for each message (async for decryption)
            for (const msg of data.messages) {
                await displayMessage(msg);
            }
        } else {
            console.log(`[HTTP] No message history`);
        }
    } catch (error) {
        console.error('Error loading messages:', error);
    } finally {
        isLoadingMessages = false;
    }
}

async function sendMessage() {
    const message = document.getElementById('messageInput').value.trim();

    if (!currentRoom) {
        alert('Please select a room first');
        return;
    }

    if (!message) return;

    // Slash command interception
    if (message.startsWith('/')) {
        document.getElementById('messageInput').value = '';
        parseAndExecuteCommand(message);
        return;
    }

    // Check if WebSocket is connected
    if (!websocket || websocket.readyState !== WebSocket.OPEN) {
        alert('Not connected to chat. Reconnecting...');
        connectWebSocket(currentRoom);
        return;
    }

    try {
        let payload = message;

        // Encrypt if we have a room key
        const epochs = roomKeys[currentRoom];
        if (epochs) {
            const epochNums = Object.keys(epochs).map(Number);
            const latestEpoch = Math.max(...epochNums);
            payload = await encryptMessage(epochs[latestEpoch], message, latestEpoch);
        }

        websocket.send(JSON.stringify({
            type: 'message',
            message: payload
        }));

        // Clear input
        document.getElementById('messageInput').value = '';
    } catch (error) {
        console.error('Error sending message:', error);
        alert('Failed to send message');
    }
}

function openRoomSettings(roomId) {
    const modal = document.getElementById('roomSettingsModal');
    const roomName = document.getElementById('roomSettingsName');
    modal.dataset.roomId = roomId;
    roomName.textContent = roomId;
    modal.classList.add('open');
}

function closeRoomSettings() {
    const modal = document.getElementById('roomSettingsModal');
    modal.classList.remove('open');
}

async function deleteRoomAction() {
    const modal = document.getElementById('roomSettingsModal');
    const roomId = modal.dataset.roomId;

    if (!confirm(`Are you sure you want to delete room "${roomId}"? The room will be hidden but messages are preserved.`)) {
        return;
    }

    try {
        const resp = await fetch(`${API_URL}/rooms/${encodeURIComponent(roomId)}`, {
            method: 'DELETE',
            headers: { 'Authorization': `Bearer ${sessionToken}` }
        });

        if (resp.ok) {
            closeRoomSettings();
            // If we were in the deleted room, clear the chat area
            if (currentRoom === roomId) {
                if (websocket) {
                    websocket.close();
                    websocket = null;
                }
                currentRoom = null;
                lastMessageId = 0;
                history.replaceState(null, '', window.location.pathname);
                document.getElementById('chatHeader').textContent = '[No room selected]';
                document.getElementById('messages').innerHTML = '<div class="empty-state"><p>Select a chat room to start</p></div>';
            }
            loadRooms();
        } else {
            const data = await resp.json();
            alert(`Failed: ${data.detail || 'Unknown error'}`);
        }
    } catch (error) {
        console.error('Failed to delete room:', error);
        alert('Failed to delete room');
    }
}

// --- DM Modal ---

function openDMModal() {
    const modal = document.getElementById('dmModal');
    const userList = document.getElementById('dmUserList');
    userList.innerHTML = '<p style="color: #999;">Loading users...</p>';
    modal.classList.add('open');
    loadDMUserList();
}

function closeDMModal() {
    const modal = document.getElementById('dmModal');
    modal.classList.remove('open');
}

async function loadDMUserList() {
    try {
        const response = await fetch(`${API_URL}/users/list`, {
            headers: { 'Authorization': `Bearer ${sessionToken}` }
        });
        const data = await response.json();

        const userList = document.getElementById('dmUserList');
        const otherUsers = data.usernames.filter(u => u !== currentUsername);

        if (otherUsers.length === 0) {
            userList.innerHTML = '<p style="color: #999;">No other users to message</p>';
            return;
        }

        userList.innerHTML = '';
        otherUsers.forEach(username => {
            const item = document.createElement('div');
            item.className = 'dm-user-item';
            item.textContent = username;
            item.onclick = () => startDM(username);
            userList.appendChild(item);
        });
    } catch (error) {
        console.error('Error loading user list:', error);
        document.getElementById('dmUserList').innerHTML = '<p style="color: #999;">Failed to load users</p>';
    }
}

async function startDM(targetUsername) {
    try {
        const response = await fetch(`${API_URL}/rooms/dm`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${sessionToken}`
            },
            body: JSON.stringify({ username: targetUsername })
        });

        const data = await response.json();

        if (data.detail) {
            alert(data.detail);
            return;
        }

        // Generate E2E room key for both DM participants
        // Only init if this is a brand new DM (no keys yet)
        if (!roomKeys[data.room.room_id]) {
            await initDMRoomKey(data.room.room_id, targetUsername);
        }

        closeDMModal();
        await loadRooms();
        selectRoom(data.room.room_id);
    } catch (error) {
        console.error('Error creating DM:', error);
        alert('Failed to start direct message');
    }
}

// Expose functions to window for inline event handlers
window.logout = logout;
window.toggleAdminPanel = toggleAdminPanel;
window.toggleSettingsPanel = toggleSettingsPanel;
window.updateRegModeLabel = updateRegModeLabel;
window.setRegistrationMode = setRegistrationMode;
window.generateInviteLink = generateInviteLink;
window.copyInviteLink = copyInviteLink;
window.deleteInvite = deleteInvite;
window.approveUser = approveUser;
window.rejectUser = rejectUser;
window.setUserRole = setUserRole;
window.deleteUser = deleteUser;
window.updateUserColor = updateUserColor;
window.updateUserThemeColor = updateUserThemeColor;
window.resetUserThemeColor = resetUserThemeColor;
window.updateServerColor = updateServerColor;
window.updateUserColorAdmin = updateUserColorAdmin;
window.openCreateRoomModal = openCreateRoomModal;
window.closeCreateRoomModal = closeCreateRoomModal;
window.createRoom = createRoom;
window.openDMModal = openDMModal;
window.closeDMModal = closeDMModal;
window.sendMessage = sendMessage;
window.toggleSidebar = toggleSidebar;
window.closeRoomSettings = closeRoomSettings;
window.deleteRoomAction = deleteRoomAction;

// Event listeners
document.addEventListener('DOMContentLoaded', () => {
    const messageInput = document.getElementById('messageInput');
    if (messageInput) {
        messageInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') sendMessage();
        });
    }

    const newRoomInput = document.getElementById('newRoomInput');
    if (newRoomInput) {
        newRoomInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') createRoom();
        });
    }
});
