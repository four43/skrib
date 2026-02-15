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

let isLoadingMessages = false;
let reconnectAttempts = 0;
let maxReconnectAttempts = 5;
let reconnectTimeout = null;
let userColors = {};  // Cache of username -> color mappings
let userNicknames = {};  // Cache of username -> nickname (null if not set)
let serverColor = '#6366f1';  // Cached server color for theme reset

let roomMeta = {};  // Cache of room_id -> { room_type, display_name, members }
const USE_NOTIFICATION_TAG = false;  // Group notifications per room (browser may throttle)
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

registerCommand('nick', async (args) => {
    const nickname = args.trim();

    if (!nickname) {
        const current = userNicknames[currentUsername];
        if (current) {
            displaySystemMessage(`Your nickname is "${current}". Use /nick <name> to change it, or /nick clear to remove.`);
        } else {
            displaySystemMessage('You have no nickname set. Use /nick <name> to set one.');
        }
        return;
    }

    const clearAliases = ['clear', 'reset', 'remove'];
    const isClearing = clearAliases.includes(nickname.toLowerCase());

    if (!isClearing && nickname.length > 32) {
        displaySystemMessage('Nickname must be 32 characters or fewer.');
        return;
    }

    try {
        const response = await fetch(`${API_URL}/users/${currentUsername}/preferences`, {
            method: 'PUT',
            headers: {
                'Authorization': `Bearer ${sessionToken}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ nickname: isClearing ? '' : nickname })
        });

        if (response.ok) {
            if (isClearing) {
                delete userNicknames[currentUsername];
                displaySystemMessage('Nickname cleared. Your username will be displayed.');
            } else {
                userNicknames[currentUsername] = nickname;
                displaySystemMessage(`Nickname set to "${nickname}".`);
            }
            // Reload messages to reflect change
            if (currentRoom) {
                document.getElementById('messages').innerHTML = '';
                lastMessageId = 0;
                await loadMessages();
            }
        } else {
            const data = await response.json();
            displaySystemMessage(`Failed to set nickname: ${data.detail || 'Unknown error'}`);
        }
    } catch (error) {
        console.error('[CMD] Error setting nickname:', error);
        displaySystemMessage('Failed to set nickname. Please try again.');
    }
}, 'Set your display nickname (/nick <name>, /nick clear)');

registerCommand('leave', async () => {
    if (!currentRoom) {
        displaySystemMessage('Please select a room first.');
        return;
    }

    const meta = roomMeta[currentRoom];
    if (meta && meta.room_type === 'dm') {
        displaySystemMessage('You cannot leave a DM.');
        return;
    }

    if (!confirm(`Leave #${currentRoom}? You will need to be re-invited to rejoin.`)) {
        return;
    }

    try {
        const response = await fetch(
            `${API_URL}/rooms/${encodeURIComponent(currentRoom)}/members/me`,
            {
                method: 'DELETE',
                headers: { 'Authorization': `Bearer ${sessionToken}` },
            }
        );

        if (response.ok) {
            // Disconnect from room
            if (websocket) {
                websocket.close();
                websocket = null;
            }
            currentRoom = null;
            lastMessageId = 0;
            history.replaceState(null, '', window.location.pathname);
            document.getElementById('chatHeader').textContent = '[No room selected]';
            document.getElementById('messages').innerHTML = '<div class="empty-state"><p>Select a chat room to start</p></div>';
            await loadRooms();
        } else {
            const data = await response.json();
            displaySystemMessage(`Failed to leave: ${data.detail || 'Unknown error'}`);
        }
    } catch (error) {
        console.error('[CMD] Error leaving room:', error);
        displaySystemMessage('Failed to leave room. Please try again.');
    }
}, 'Leave the current channel');

registerCommand('kick', async (args) => {
    const targetUsername = args.trim();

    if (!targetUsername) {
        displaySystemMessage('Usage: /kick <username>');
        return;
    }

    if (!currentRoom) {
        displaySystemMessage('Please select a room first.');
        return;
    }

    if (currentRole !== 'admin' && currentRole !== 'moderator') {
        displaySystemMessage('Only admins and moderators can kick users.');
        return;
    }

    const meta = roomMeta[currentRoom];
    if (meta && meta.room_type === 'dm') {
        displaySystemMessage('You cannot kick users from a DM.');
        return;
    }

    try {
        const response = await fetch(
            `${API_URL}/rooms/${encodeURIComponent(currentRoom)}/members/${encodeURIComponent(targetUsername)}`,
            {
                method: 'DELETE',
                headers: { 'Authorization': `Bearer ${sessionToken}` },
            }
        );

        if (response.ok) {
            displaySystemMessage(`Kicked ${targetUsername} from this room.`);
        } else {
            const data = await response.json();
            displaySystemMessage(`Failed to kick ${targetUsername}: ${data.detail || 'Unknown error'}`);
        }
    } catch (error) {
        console.error('[CMD] Error kicking user:', error);
        displaySystemMessage('Failed to kick user. Please try again.');
    }
}, 'Kick a user from the current channel (admin/mod only)');

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

/** Generate a room key for a DM and encrypt for all participants. */
async function initDMRoomKey(roomId, otherUsernames) {
    if (!privateKey) return;
    if (typeof otherUsernames === 'string') otherUsernames = [otherUsernames];

    try {
        const allUsers = [currentUsername, ...otherUsernames];

        // Fetch public keys for all participants
        const keyResponses = await Promise.all(
            allUsers.map(u =>
                fetch(`${API_URL}/auth/encryption-key/${encodeURIComponent(u)}`,
                    { headers: { 'Authorization': `Bearer ${sessionToken}` } })
            )
        );

        if (keyResponses.some(r => !r.ok)) return;

        const publicKeys = {};
        for (let i = 0; i < allUsers.length; i++) {
            publicKeys[allUsers[i]] = JSON.parse((await keyResponses[i].json()).public_key);
        }

        const roomKey = await generateRoomKey();

        // Encrypt and upload for each participant
        await Promise.all(
            allUsers.map(async (user) => {
                const encKey = await encryptRoomKey(roomKey, publicKeys[user]);
                return fetch(`${API_URL}/rooms/${encodeURIComponent(roomId)}/keys`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${sessionToken}` },
                    body: JSON.stringify({ username: user, encrypted_key: encKey, key_epoch: 0 }),
                });
            })
        );

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

    // Request notification permission
    if ('Notification' in window && Notification.permission === 'default') {
        Notification.requestPermission();
    }

    if (currentRole === 'admin' || currentRole === 'moderator') {
        const badge = document.getElementById('adminBadge');
        badge.textContent = currentRole === 'admin' ? 'ADMIN' : 'MOD';
        badge.classList.remove('hidden');
        document.getElementById('adminPanelBtn').classList.remove('hidden');
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

    history.replaceState(null, '', window.location.pathname);
    window.location.href = '/login.html';
}

async function loadUserColors() {
    try {
        const response = await fetch(`${API_URL}/users/preferences/colors`, {
            headers: {
                'Authorization': `Bearer ${sessionToken}`
            }
        });
        if (response.ok) {
            const data = await response.json();
            userColors = {};
            userNicknames = {};
            for (const [username, prefs] of Object.entries(data)) {
                userColors[username] = prefs.color;
                if (prefs.nickname) {
                    userNicknames[username] = prefs.nickname;
                }
            }
        }
    } catch (error) {
        console.error('[HTTP] Error loading user colors:', error);
    }
}

function getDisplayName(username) {
    return userNicknames[username] || username;
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
            const nicknameInput = document.getElementById('userNickname');
            if (nicknameInput) {
                nicknameInput.value = data.nickname || '';
            }
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

async function updateUserNickname() {
    const nickname = document.getElementById('userNickname').value.trim();
    try {
        const response = await fetch(`${API_URL}/users/${currentUsername}/preferences`, {
            method: 'PUT',
            headers: {
                'Authorization': `Bearer ${sessionToken}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ nickname: nickname || '' })
        });
        if (response.ok) {
            if (nickname) {
                userNicknames[currentUsername] = nickname;
            } else {
                delete userNicknames[currentUsername];
            }
            // Refresh messages to show new nickname
            if (currentRoom) {
                document.getElementById('messages').innerHTML = '';
                lastMessageId = 0;
                await loadMessages();
            }
        }
    } catch (error) {
        console.error('[HTTP] Error updating nickname:', error);
        alert('Failed to update nickname');
    }
}

async function clearUserNickname() {
    document.getElementById('userNickname').value = '';
    await updateUserNickname();
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
    if (room.room_type === 'dm') {
        const parts = room.display_name.split(', ');
        nameSpan.textContent = parts.map(u => getDisplayName(u)).join(', ');
    } else {
        nameSpan.textContent = room.display_name;
    }
    nameSpan.onclick = () => selectRoom(room.room_id);

    item.appendChild(nameSpan);

    // Unread badge
    if (room.unread_count > 0 && currentRoom !== room.room_id) {
        const badge = document.createElement('span');
        badge.className = 'unread-badge';
        badge.textContent = room.unread_count > 99 ? '99+' : room.unread_count;
        item.appendChild(badge);
    }

    const settingsBtn = document.createElement('button');
    settingsBtn.className = 'room-settings-btn';
    settingsBtn.textContent = '\u2699';
    settingsBtn.title = 'Room settings';
    settingsBtn.onclick = (e) => {
        e.stopPropagation();
        openRoomSettings(room.room_id);
    };
    item.appendChild(settingsBtn);

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
            } else if (data.type === 'new_message') {
                console.log('[WS:rooms] New message notification:', data);
                loadRooms();
                // Show toast if the message is not in the currently active room
                if (data.room_id !== currentRoom) {
                    showNotification(data);
                }
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

function showNotification(data) {
    console.log('[Notification] permission:', Notification.permission, 'hasFocus:', document.hasFocus(), 'room:', data.room_id);
    if (Notification.permission !== 'granted') return;
    if (document.hasFocus()) return;

    const meta = roomMeta[data.room_id];
    let roomLabel = data.room_id;
    if (meta) {
        roomLabel = meta.display_name;
        if (meta.room_type === 'dm') {
            const parts = roomLabel.split(', ');
            roomLabel = parts.map(u => getDisplayName(u)).join(', ');
        }
    }

    const senderName = getDisplayName(data.sender);
    const title = data.room_type === 'dm' ? senderName : `${senderName} in ${roomLabel}`;
    console.log('[Notification] Showing:', title);

    const opts = { body: 'New message' };
    if (USE_NOTIFICATION_TAG) {
        opts.tag = data.room_id;
        opts.renotify = true;
    }
    const notification = new Notification(title, opts);

    notification.onclick = () => {
        window.focus();
        selectRoom(data.room_id);
        notification.close();
    };
}

async function markRoomAsRead(roomId, messageId) {
    if (!messageId || messageId <= 0) return;
    try {
        await fetch(`${API_URL}/rooms/${encodeURIComponent(roomId)}/read`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${sessionToken}`,
            },
            body: JSON.stringify({ last_read_message_id: messageId }),
        });
    } catch (error) {
        console.error('[HTTP] Error marking room as read:', error);
    }
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
    let displayName = meta ? meta.display_name : roomId;
    if (meta && meta.room_type === 'dm') {
        const parts = displayName.split(', ');
        displayName = parts.map(u => getDisplayName(u)).join(', ');
    }
    document.getElementById('chatHeader').textContent = displayName;

    document.querySelectorAll('.room-item').forEach(item => {
        item.classList.toggle('active', item.dataset.roomId === roomId);
    });

    // Clear messages div when switching rooms
    document.getElementById('messages').innerHTML = '';

    // Load room encryption keys, then message history, then connect WebSocket
    loadRoomKeys(roomId).then(() => {
        loadMessages().then(async () => {
            await markRoomAsRead(roomId, lastMessageId);
            loadRooms();
        });
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
            if (data.data.id && currentRoom) {
                markRoomAsRead(currentRoom, data.data.id);
            }
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
    const displayName = getDisplayName(msg.username);

    messageDiv.innerHTML = `
        <div class="message-header">
            <span class="username" style="color: ${userColor};" title="${escapeHtml(msg.username)}">${escapeHtml(displayName)}</span>
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

    // Set current notification level
    const meta = roomMeta[roomId];
    const select = document.getElementById('notifyLevelSelect');
    select.value = (meta && meta.notify_level) || 'all';

    // Only show danger zone for admin/moderator
    const dangerSection = document.getElementById('roomSettingsDanger');
    if (currentRole === 'admin' || currentRole === 'moderator') {
        dangerSection.style.display = '';
    } else {
        dangerSection.style.display = 'none';
    }

    modal.classList.add('open');
}

function closeRoomSettings() {
    const modal = document.getElementById('roomSettingsModal');
    modal.classList.remove('open');
}

async function updateNotifyLevel() {
    const modal = document.getElementById('roomSettingsModal');
    const roomId = modal.dataset.roomId;
    const level = document.getElementById('notifyLevelSelect').value;

    try {
        const resp = await fetch(`${API_URL}/rooms/${encodeURIComponent(roomId)}/notify`, {
            method: 'PUT',
            headers: {
                'Authorization': `Bearer ${sessionToken}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ notify_level: level }),
        });

        if (resp.ok) {
            // Update local cache
            if (roomMeta[roomId]) {
                roomMeta[roomId].notify_level = level;
            }
        } else {
            console.error('Failed to update notify level');
        }
    } catch (error) {
        console.error('Failed to update notify level:', error);
    }
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

function updateDMStartButton() {
    const btn = document.getElementById('dmStartBtn');
    const checked = document.querySelectorAll('#dmUserList input[type="checkbox"]:checked');
    btn.style.display = checked.length > 0 ? '' : 'none';
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
            const label = document.createElement('label');
            label.className = 'dm-user-item';
            const cb = document.createElement('input');
            cb.type = 'checkbox';
            cb.value = username;
            cb.addEventListener('change', updateDMStartButton);
            label.appendChild(cb);
            label.appendChild(document.createTextNode(` ${username}`));
            userList.appendChild(label);
        });

        document.getElementById('dmStartBtn').style.display = 'none';
    } catch (error) {
        console.error('Error loading user list:', error);
        document.getElementById('dmUserList').innerHTML = '<p style="color: #999;">Failed to load users</p>';
    }
}

async function startDMFromModal() {
    const checked = document.querySelectorAll('#dmUserList input[type="checkbox"]:checked');
    const targets = Array.from(checked).map(cb => cb.value);
    if (targets.length === 0) return;
    await startDM(targets);
}

async function startDM(targetUsernames) {
    // Accept a single string for backwards compat (e.g. from slash command)
    if (typeof targetUsernames === 'string') targetUsernames = [targetUsernames];

    try {
        const response = await fetch(`${API_URL}/rooms/dm`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${sessionToken}`
            },
            body: JSON.stringify({ usernames: targetUsernames })
        });

        const data = await response.json();

        if (data.detail) {
            alert(data.detail);
            return;
        }

        // Generate E2E room key for all DM participants
        if (!roomKeys[data.room.room_id]) {
            await initDMRoomKey(data.room.room_id, targetUsernames);
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
window.toggleSettingsPanel = toggleSettingsPanel;
window.updateUserColor = updateUserColor;
window.updateUserThemeColor = updateUserThemeColor;
window.resetUserThemeColor = resetUserThemeColor;
window.updateUserNickname = updateUserNickname;
window.clearUserNickname = clearUserNickname;
window.openCreateRoomModal = openCreateRoomModal;
window.closeCreateRoomModal = closeCreateRoomModal;
window.createRoom = createRoom;
window.openDMModal = openDMModal;
window.closeDMModal = closeDMModal;
window.startDMFromModal = startDMFromModal;
window.sendMessage = sendMessage;
window.toggleSidebar = toggleSidebar;
window.closeRoomSettings = closeRoomSettings;
window.deleteRoomAction = deleteRoomAction;
window.updateNotifyLevel = updateNotifyLevel;

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

    const nicknameInput = document.getElementById('userNickname');
    if (nicknameInput) {
        nicknameInput.addEventListener('change', updateUserNickname);
    }
});
