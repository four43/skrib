import './style.css'

const API_URL = import.meta.env.VITE_API_URL || '/api';
let sessionToken = null;
let currentUsername = null;
let currentRole = null;
let currentRoom = null;
let messageCount = 0;
let pollInterval = null;
let adminPollInterval = null;

checkSession();

function showStatus(elementId, message, type) {
    const statusDiv = document.getElementById(elementId);
    statusDiv.className = `status ${type}`;
    statusDiv.innerHTML = message;
}

function showLogin() {
    document.getElementById('loginForm').classList.remove('hidden');
    document.getElementById('registerForm').classList.add('hidden');
}

function showRegister() {
    document.getElementById('registerForm').classList.remove('hidden');
    document.getElementById('loginForm').classList.add('hidden');
}

async function register() {
    const username = document.getElementById('registerUsername').value.trim();

    if (!username) {
        showStatus('registerStatus', '❌ Please enter a username', 'error');
        return;
    }

    try {
        showStatus('registerStatus', 'Starting registration...', 'info');

        const beginResp = await fetch(`${API_URL}/auth/register/begin`);
        const beginData = await beginResp.json();

        if (beginData.detail) {
            showStatus('registerStatus', `❌ ${beginData.detail}`, 'error');
            return;
        }

        const challenge = base64ToArrayBuffer(beginData.challenge);
        const userId = new TextEncoder().encode(username);

        showStatus('registerStatus', '🔐 Please authenticate with your device...', 'info');

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
                attestation: "none"
            }
        });

        const completeResp = await fetch(`${API_URL}/auth/register/complete`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                username: username,
                credentialId: arrayBufferToBase64(credential.rawId),
                publicKey: arrayBufferToBase64(credential.response.getPublicKey()),
                challenge: beginData.challenge
            })
        });

        const completeData = await completeResp.json();

        if (completeData.detail) {
            showStatus('registerStatus', `❌ ${completeData.detail}`, 'error');
        } else if (completeData.status === 'approved') {
            showStatus('registerStatus',
                `<div class="approval-code">
                    <h3>✅ Registration Complete!</h3>
                    <p>You are the first user and have been automatically approved as an admin.</p>
                    <p style="margin-top: 10px; font-size: 12px;">You can now login!</p>
                </div>`,
                'success'
            );
            // Auto-switch to login after 2 seconds
            setTimeout(() => {
                showLogin();
            }, 2000);
        } else {
            showStatus('registerStatus',
                `<div class="approval-code">
                    <h3>⏳ Registration Pending Approval</h3>
                    <p>Please provide this code to the administrator:</p>
                    <div class="code">${completeData.approval_code}</div>
                    <p style="margin-top: 10px; font-size: 12px;">You'll be able to login once approved.</p>
                </div>`,
                'success'
            );
        }

    } catch (error) {
        console.error(error);
        showStatus('registerStatus', `❌ ${friendlyError(error)}`, 'error');
    }
}

async function login() {
    try {
        showStatus('authStatus', 'Starting login...', 'info');

        const beginResp = await fetch(`${API_URL}/auth/login/begin`);
        const beginData = await beginResp.json();

        if (beginData.detail) {
            showStatus('authStatus', `❌ ${beginData.detail}`, 'error');
            return;
        }

        showStatus('authStatus', '🔐 Please authenticate with your device...', 'info');

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
            showStatus('authStatus', `❌ ${completeData.detail}`, 'error');
        } else {
            sessionToken = completeData.session_token;
            currentUsername = completeData.username;
            currentRole = completeData.role;
            localStorage.setItem('session_token', sessionToken);
            localStorage.setItem('username', currentUsername);
            localStorage.setItem('role', currentRole);
            showChatView();
        }

    } catch (error) {
        console.error(error);
        showStatus('authStatus', `❌ ${friendlyError(error)}`, 'error');
    }
}

async function checkSession() {
    const token = localStorage.getItem('session_token');
    const username = localStorage.getItem('username');
    const role = localStorage.getItem('role');

    if (!token || !username) return;

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
            showChatView();
        } else {
            localStorage.removeItem('session_token');
            localStorage.removeItem('username');
            localStorage.removeItem('role');
        }
    } catch (error) {
        console.error('Session check failed:', error);
    }
}

function logout() {
    sessionToken = null;
    currentUsername = null;
    currentRole = null;
    localStorage.removeItem('session_token');
    localStorage.removeItem('username');
    localStorage.removeItem('role');

    if (pollInterval) clearInterval(pollInterval);
    if (adminPollInterval) clearInterval(adminPollInterval);

    document.getElementById('authView').classList.remove('hidden');
    document.getElementById('chat-view').classList.add('hidden');
    document.getElementById('adminPanel').classList.remove('open');
    showLogin();
}

function showChatView() {
    document.getElementById('authView').classList.add('hidden');
    document.getElementById('chat-view').classList.remove('hidden');
    document.getElementById('currentUser').textContent = `👤 ${currentUsername}`;

    if (currentRole === 'admin') {
        document.getElementById('adminBadge').classList.remove('hidden');
        document.getElementById('adminPanelBtn').classList.remove('hidden');
        loadAdminSettings();
        adminPollInterval = setInterval(loadPendingUsers, 5000);
    }

    loadRooms();
}

function toggleAdminPanel() {
    document.getElementById('adminPanel').classList.toggle('open');
}

async function loadAdminSettings() {
    try {
        const resp = await fetch(`${API_URL}/server`, {
            headers: { 'Authorization': `Bearer ${sessionToken}` }
        });
        const data = await resp.json();

        updateRegistrationToggle(data.registration_enabled);
        loadPendingUsers();
        loadAllUsers();
    } catch (error) {
        console.error('Failed to load admin settings:', error);
    }
}

function updateRegistrationToggle(enabled) {
    const toggle = document.getElementById('regToggle');
    const status = document.getElementById('regStatus');

    if (enabled) {
        toggle.classList.add('active');
        status.textContent = 'Registration Enabled';
    } else {
        toggle.classList.remove('active');
        status.textContent = 'Registration Disabled';
    }
}

async function toggleRegistration() {
    const toggle = document.getElementById('regToggle');
    const enabled = !toggle.classList.contains('active');
    const mode = enabled ? 'approval_required' : 'closed';

    try {
        const resp = await fetch(`${API_URL}/server`, {
            method: 'PATCH',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${sessionToken}`
            },
            body: JSON.stringify({ registration_mode: mode })
        });
        if (!resp.ok) {
            console.error('Failed to update registration mode');
            return;
        }

        updateRegistrationToggle(enabled);
    } catch (error) {
        console.error('Failed to toggle registration:', error);
    }
}

async function loadPendingUsers() {
    try {
        const resp = await fetch(`${API_URL}/users?status=pending`, {
            headers: { 'Authorization': `Bearer ${sessionToken}` }
        });
        const data = await resp.json();

        const pendingList = document.getElementById('pendingList');
        const pendingCount = document.getElementById('pendingCount');

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
            loadAllUsers();  // Refresh user list
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
                            ? `<button class="promote-btn btn-sm" onclick="window.setUserRole('${user.username}', 'admin')">Make Admin</button>`
                            : `<button class="demote-btn btn-sm" onclick="window.setUserRole('${user.username}', 'user')">Remove Admin</button>`
                        }
                        ${user.username !== currentUsername
                            ? `<button class="reject-btn btn-sm" onclick="window.deleteUser('${user.username}')">Delete</button>`
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

async function loadRooms() {
    try {
        const response = await fetch(`${API_URL}/rooms`);
        const data = await response.json();

        const roomList = document.getElementById('room-list');
        roomList.innerHTML = '';

        data.rooms.forEach(room => {
            const item = document.createElement('div');
            item.className = 'room-item';
            item.textContent = room;
            item.onclick = () => selectRoom(room);
            roomList.appendChild(item);
        });
    } catch (error) {
        console.error('Error loading rooms:', error);
    }
}

async function createRoom() {
    const input = document.getElementById('newRoomInput');
    const roomId = input.value.trim();

    if (!roomId) {
        alert('Please enter a room name');
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
            input.value = '';
            loadRooms();
            selectRoom(roomId);
        }
    } catch (error) {
        console.error('Error creating room:', error);
        alert('Failed to create room');
    }
}

function selectRoom(roomId) {
    currentRoom = roomId;
    messageCount = 0;

    document.getElementById('chatHeader').textContent = roomId;
    document.querySelectorAll('.room-item').forEach(item => {
        item.classList.toggle('active', item.textContent === roomId);
    });

    loadMessages();

    if (pollInterval) clearInterval(pollInterval);
    pollInterval = setInterval(loadMessages, 2000);
}

async function loadMessages() {
    if (!currentRoom) return;

    try {
        const response = await fetch(`${API_URL}/rooms/${encodeURIComponent(currentRoom)}/messages?since=${messageCount}`);
        const data = await response.json();

        if (data.messages && data.messages.length > 0) {
            const messagesDiv = document.getElementById('messages');

            if (messageCount === 0) {
                messagesDiv.innerHTML = '';
            }

            data.messages.forEach(msg => {
                const messageDiv = document.createElement('div');
                messageDiv.className = 'message';

                const date = new Date(msg.timestamp);
                const timeStr = date.toLocaleTimeString();

                messageDiv.innerHTML = `
                    <div class="message-header">
                        <span class="username">${escapeHtml(msg.username)}</span>
                        <span class="timestamp">${timeStr}</span>
                    </div>
                    <div class="message-text">${escapeHtml(msg.content)}</div>
                `;

                messagesDiv.appendChild(messageDiv);
            });

            messageCount += data.messages.length;
            messagesDiv.scrollTop = messagesDiv.scrollHeight;
        }
    } catch (error) {
        console.error('Error loading messages:', error);
    }
}

async function sendMessage() {
    const message = document.getElementById('message-input').value.trim();

    if (!currentRoom) {
        alert('Please select a room first');
        return;
    }

    if (!message) return;

    try {
        const response = await fetch(`${API_URL}/rooms/${encodeURIComponent(currentRoom)}/messages`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${sessionToken}`
            },
            body: JSON.stringify({
                content: message,
                content_type: 'text'
            })
        });

        const data = await response.json();

        if (data.detail) {
            if (data.detail === 'Unauthorized') {
                alert('Session expired. Please login again.');
                logout();
            } else {
                alert(data.detail);
            }
        } else {
            document.getElementById('message-input').value = '';
            loadMessages();
        }
    } catch (error) {
        console.error('Error sending message:', error);
        alert('Failed to send message');
    }
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

function arrayBufferToBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    let binary = '';
    for (let i = 0; i < bytes.byteLength; i++) {
        binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

function base64ToArrayBuffer(base64) {
    base64 = base64.replace(/-/g, '+').replace(/_/g, '/');
    while (base64.length % 4) base64 += '=';
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
    }
    return bytes.buffer;
}

// Expose functions to window for inline event handlers
window.showLogin = showLogin;
window.showRegister = showRegister;
window.register = register;
window.login = login;
window.logout = logout;
window.toggleAdminPanel = toggleAdminPanel;
window.toggleRegistration = toggleRegistration;
window.approveUser = approveUser;
window.rejectUser = rejectUser;
window.setUserRole = setUserRole;
window.deleteUser = deleteUser;
window.createRoom = createRoom;
window.sendMessage = sendMessage;

// Event listeners
document.addEventListener('DOMContentLoaded', () => {
    const messageInput = document.getElementById('message-input');
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
