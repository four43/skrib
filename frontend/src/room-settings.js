import { API_URL, escapeHtml } from './utils.js';
import { loadTheme } from './theme-manager.js';

let sessionToken = null;
let currentUsername = null;
let currentRole = null;
let currentRoomId = null;
let currentRoom = null;
let userRole = null; // User's role in this room

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

            // Get room ID from URL
            const urlParams = new URLSearchParams(window.location.search);
            currentRoomId = urlParams.get('room');

            if (!currentRoomId) {
                alert('No room specified');
                window.location.href = '/app.html';
                return;
            }

            // Initialize room settings page
            await initializeRoomSettings();
        } else {
            // Session invalid
            window.location.href = '/login.html';
        }
    } catch (error) {
        console.error('Session check failed:', error);
        window.location.href = '/login.html';
    }
}

async function initializeRoomSettings() {
    try {
        // Fetch room details
        const roomResponse = await fetch(`${API_URL}/rooms/${encodeURIComponent(currentRoomId)}`, {
            headers: { 'Authorization': `Bearer ${sessionToken}` }
        });

        if (!roomResponse.ok) {
            if (roomResponse.status === 404) {
                alert('Room not found');
            } else {
                alert('Failed to load room settings');
            }
            window.location.href = '/app.html';
            return;
        }

        currentRoom = await roomResponse.json();

        // Update back button to navigate to this room
        const backBtn = document.querySelector('.admin-back-btn');
        if (backBtn) {
            backBtn.href = `/app.html#/r/${encodeURIComponent(currentRoomId)}`;
        }

        // Update page title
        const pageTitle = document.getElementById('room-settings-title');
        if (pageTitle) {
            const displayName = !currentRoom.is_dm ? `#${currentRoom.room_id}` : currentRoom.room_id;
            pageTitle.textContent = `${displayName} Settings`;
        }

        // Display room name
        const roomNameDisplay = document.getElementById('room-name-display');
        if (roomNameDisplay) {
            const displayName = !currentRoom.is_dm ? `#${currentRoom.room_id}` : currentRoom.room_id;
            roomNameDisplay.textContent = displayName;
        }

        // Display topic
        const topicInput = document.getElementById('room-topic');
        if (topicInput) {
            topicInput.value = currentRoom.topic || '';
        }

        // Display members (already included in room response)
        displayMembers(currentRoom.members || []);

        // Set up event listeners
        setupEventListeners();

        // Show/hide danger zone based on permissions
        updateDangerZone();

    } catch (error) {
        console.error('[HTTP] Error initializing room settings:', error);
        alert('Failed to load room settings');
        window.location.href = '/app.html';
    }
}

async function reloadRoomData() {
    try {
        const roomResponse = await fetch(`${API_URL}/rooms/${encodeURIComponent(currentRoomId)}`, {
            headers: { 'Authorization': `Bearer ${sessionToken}` }
        });

        if (roomResponse.ok) {
            currentRoom = await roomResponse.json();
            displayMembers(currentRoom.members || []);
        }
    } catch (error) {
        console.error('[HTTP] Error reloading room data:', error);
    }
}

function displayMembers(members) {
    // Find current user's role in this room
    const currentMember = members.find(m => m.username === currentUsername);
    userRole = currentMember ? currentMember.room_role : 'member';

    // Update danger zone visibility now that we know the role
    updateDangerZone();

    const membersList = document.getElementById('members-list');
    const memberCount = document.getElementById('member-count');

    if (!membersList || !memberCount) return;

    memberCount.textContent = members.length;

    membersList.innerHTML = '';

    members.forEach(member => {
        const memberDiv = document.createElement('div');
        memberDiv.className = 'member-item';

        const memberInfo = document.createElement('div');
        memberInfo.className = 'member-info';

        const memberName = document.createElement('span');
        memberName.className = 'member-name';
        memberName.style.color = member.color || '#1976d2';
        memberName.textContent = member.nickname || member.username;

        const memberRole = document.createElement('span');
        memberRole.className = 'member-role';
        memberRole.textContent = member.room_role === 'owner' ? 'Owner' : member.room_role === 'op' ? 'Op' : '';

        memberInfo.appendChild(memberName);
        if (memberRole.textContent) {
            memberInfo.appendChild(memberRole);
        }

        memberDiv.appendChild(memberInfo);

        // Add action buttons if user has permission
        if (canManageMember(member)) {
            const actionsDiv = document.createElement('div');
            actionsDiv.className = 'member-actions';

            // Only show role buttons for channels
            if (!currentRoom.is_dm) {
                if (member.room_role !== 'owner') {
                    const opBtn = document.createElement('button');
                    opBtn.className = 'btn-ghost';
                    opBtn.textContent = member.room_role === 'op' ? 'Remove Op' : 'Make Op';
                    opBtn.onclick = () => toggleOp(member.username, member.room_role !== 'op');
                    actionsDiv.appendChild(opBtn);
                }

                if (member.username !== currentUsername) {
                    const removeBtn = document.createElement('button');
                    removeBtn.className = 'btn-ghost member-remove-btn';
                    removeBtn.textContent = 'Remove';
                    removeBtn.onclick = () => removeMember(member.username);
                    actionsDiv.appendChild(removeBtn);
                }
            }

            memberDiv.appendChild(actionsDiv);
        }

        membersList.appendChild(memberDiv);
    });
}

function canManageMember(member) {
    // Admin can manage anyone
    if (currentRole === 'admin') return true;

    // For channels, owner and ops can manage regular members
    if (!currentRoom.is_dm) {
        if (userRole === 'owner') {
            return member.room_role !== 'owner'; // Owner can manage everyone except themselves
        }
        if (userRole === 'op') {
            return member.room_role === 'member'; // Ops can only manage regular members
        }
    }

    return false;
}

async function saveTopic() {
    const topicInput = document.getElementById('room-topic');
    if (!topicInput) return;

    const newTopic = topicInput.value.trim();

    try {
        const response = await fetch(`${API_URL}/rooms/${encodeURIComponent(currentRoomId)}`, {
            method: 'PATCH',
            headers: {
                'Authorization': `Bearer ${sessionToken}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ topic: newTopic })
        });

        if (response.ok) {
            alert('Topic updated successfully!');
            currentRoom.topic = newTopic;
        } else {
            const error = await response.json();
            alert(`Failed to update topic: ${error.detail || 'Unknown error'}`);
        }
    } catch (error) {
        console.error('[HTTP] Error updating topic:', error);
        alert('Failed to update topic');
    }
}

async function toggleOp(username, makeOp) {
    try {
        const response = await fetch(
            `${API_URL}/rooms/${encodeURIComponent(currentRoomId)}/members/${encodeURIComponent(username)}/op`,
            {
                method: makeOp ? 'PUT' : 'DELETE',
                headers: { 'Authorization': `Bearer ${sessionToken}` }
            }
        );

        if (response.ok) {
            alert(`${username} ${makeOp ? 'promoted to' : 'removed from'} op`);
            await reloadRoomData();
        } else {
            const error = await response.json();
            alert(`Failed to update role: ${error.detail || 'Unknown error'}`);
        }
    } catch (error) {
        console.error('[HTTP] Error updating member role:', error);
        alert('Failed to update member role');
    }
}

async function removeMember(username) {
    if (!confirm(`Remove ${username} from this room?`)) {
        return;
    }

    try {
        const response = await fetch(
            `${API_URL}/rooms/${encodeURIComponent(currentRoomId)}/members/${encodeURIComponent(username)}`,
            {
                method: 'DELETE',
                headers: { 'Authorization': `Bearer ${sessionToken}` }
            }
        );

        if (response.ok) {
            alert(`${username} removed from room`);
            await reloadRoomData();
        } else {
            const error = await response.json();
            alert(`Failed to remove member: ${error.detail || 'Unknown error'}`);
        }
    } catch (error) {
        console.error('[HTTP] Error removing member:', error);
        alert('Failed to remove member');
    }
}

async function deleteRoom() {
    if (!confirm(`Are you sure you want to delete "${currentRoom.display_name || currentRoom.room_id}"? This action cannot be undone.`)) {
        return;
    }

    try {
        const response = await fetch(`${API_URL}/rooms/${encodeURIComponent(currentRoomId)}`, {
            method: 'DELETE',
            headers: { 'Authorization': `Bearer ${sessionToken}` }
        });

        if (response.ok) {
            alert('Room deleted successfully');
            window.location.href = '/app.html';
        } else {
            const error = await response.json();
            alert(`Failed to delete room: ${error.detail || 'Unknown error'}`);
        }
    } catch (error) {
        console.error('[HTTP] Error deleting room:', error);
        alert('Failed to delete room');
    }
}

function updateDangerZone() {
    const dangerZone = document.getElementById('danger-zone');
    if (!dangerZone) return;

    // Show danger zone for admins, or room owners/ops for channels
    const canDelete = currentRole === 'admin' ||
                     (!currentRoom.is_dm && (userRole === 'owner' || userRole === 'op'));

    if (canDelete) {
        dangerZone.classList.remove('hidden');
    } else {
        dangerZone.classList.add('hidden');
    }
}

function setupEventListeners() {
    // Save topic button
    const saveTopicBtn = document.getElementById('save-topic-btn');
    if (saveTopicBtn) {
        saveTopicBtn.addEventListener('click', saveTopic);
    }

    // Delete room button
    const deleteRoomBtn = document.getElementById('delete-room-btn');
    if (deleteRoomBtn) {
        deleteRoomBtn.addEventListener('click', deleteRoom);
    }

    // Topic input - Enter key to save
    const topicInput = document.getElementById('room-topic');
    if (topicInput) {
        topicInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') {
                saveTopic();
            }
        });
    }
}
