import { API_URL, escapeHtml } from './utils.js';
import { loadTheme } from './theme-manager.js';
import Sortable from 'sortablejs';
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
let ws = null;  // Single unified WebSocket connection
let reconnectAttempts = 0;
let maxReconnectAttempts = 10;
let reconnectTimeout = null;
let userColors = {};  // Cache of username -> color mappings
let userNicknames = {};  // Cache of username -> nickname (null if not set)
let serverColor = '#6366f1';  // Cached server color for theme reset

let roomMeta = {};  // Cache of room_id -> { room_type, display_name, members }
let privateKey = null;  // User's RSA-OAEP private key (loaded from IndexedDB)
let roomKeys = {};  // room_id -> { epoch: CryptoKey }

// Folder state
let folderData = [];  // Array of folder objects from server
let roomPositions = {};  // room_id -> { folder_id, position }
const COLLAPSED_FOLDERS_KEY = 'skrib_collapsed_folders';
let sortableInstances = [];  // Track SortableJS instances for cleanup

// Local-only UI preferences (localStorage)
const UI_PREFS_KEY = 'skrib_ui_prefs';
function getUiPref(key) {
    try {
        return (JSON.parse(localStorage.getItem(UI_PREFS_KEY) || '{}'))[key] ?? null;
    } catch { return null; }
}
function setUiPref(key, value) {
    try {
        const prefs = JSON.parse(localStorage.getItem(UI_PREFS_KEY) || '{}');
        prefs[key] = value;
        localStorage.setItem(UI_PREFS_KEY, JSON.stringify(prefs));
    } catch {}
}

// Plugin system
const pluginHandlers = {};  // namespace -> handler function
let pluginsLoaded = false;
let availableRoomTypes = [];  // [{room_type, name, description}] from plugins

// Room type handler registry — room-type plugins register here
const roomTypeHandlers = {};  // roomType -> handler object

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
// Plugin system
// ---------------------------------------------------------------------------

/**
 * Register a plugin namespace handler.
 * Called by dynamically loaded plugin scripts.
 *
 * @param {string} namespace - Plugin namespace (e.g., 'typing')
 * @param {function} handler - Handler function(action, data, context)
 */
window.registerPluginHandler = function(namespace, handler) {
    if (pluginHandlers[namespace]) {
        console.warn(`[Plugins] Overwriting existing handler for namespace: ${namespace}`);
    }
    pluginHandlers[namespace] = handler;
    console.log(`[Plugins] Registered handler for namespace: ${namespace}`);
};

/**
 * Register a room type handler.
 * Called by room-type plugins to handle rendering and messaging for specific room types.
 *
 * @param {object} config - { roomTypes: string[], onRoomSelected, onRoomLeft, onRoomAction, onSendMessage }
 */
window.registerRoomTypeHandler = function(config) {
    for (const roomType of config.roomTypes) {
        roomTypeHandlers[roomType] = config;
        console.log(`[Plugins] Registered room type handler for: ${roomType}`);
    }

    // When a pluginId is provided, register a plugin namespace handler so
    // messages arriving as "pluginId:action" are dispatched to onRoomAction.
    if (config.pluginId && config.onRoomAction) {
        pluginHandlers[config.pluginId] = (action, data) => {
            config.onRoomAction(action, data);
        };
        console.log(`[Plugins] Registered plugin namespace handler for: ${config.pluginId}`);
    }
};

function getRoomTypeHandler(roomId) {
    const meta = roomMeta[roomId];
    if (!meta) return null;
    return roomTypeHandlers[meta.room_type] || null;
}

/**
 * Load plugins from the backend manifest.
 * Fetches plugin list and dynamically loads frontend scripts.
 */
async function loadPlugins() {
    if (pluginsLoaded) return;

    try {
        console.log('[Plugins] Fetching plugins...');
        const response = await fetch(`${API_URL}/plugins`);

        if (!response.ok) {
            console.log('[Plugins] No plugins available');
            return;
        }

        const allPlugins = await response.json();
        const plugins = allPlugins.filter(p => p.enabled);
        console.log(`[Plugins] Found ${allPlugins.length} plugins (${plugins.length} enabled):`, plugins.map(p => p.name).join(', '));

        // Extract available room types from plugins
        availableRoomTypes = [];
        for (const plugin of plugins) {
            if (plugin.room_types && plugin.room_types.length > 0) {
                for (const rt of plugin.room_types) {
                    availableRoomTypes.push({
                        room_type: rt,
                        name: plugin.name,
                        description: plugin.description,
                    });
                }
            }
        }

        // Load each enabled plugin
        for (const plugin of plugins) {
            try {
                console.log(`[Plugins] Loading plugin: ${plugin.name} (${plugin.id})`);

                // Load plugin stylesheets
                if (plugin.styles && plugin.styles.length > 0) {
                    for (const styleUrl of plugin.styles) {
                        const link = document.createElement('link');
                        link.rel = 'stylesheet';
                        link.href = styleUrl;
                        document.head.appendChild(link);
                    }
                }

                // Load the main entry file
                const scriptUrl = `${API_URL}/plugins/${plugin.id}/file/${plugin.entry}`;
                console.log(`[Plugins] Loading entry: ${scriptUrl}`);

                // Load the plugin script
                await loadPluginScript(scriptUrl, plugin);

            } catch (error) {
                console.error(`[Plugins] Failed to load plugin ${plugin.id}:`, error);
            }
        }

        pluginsLoaded = true;
        console.log('[Plugins] All plugins loaded');
    } catch (error) {
        console.error('[Plugins] Error loading plugins:', error);
    }
}

/**
 * Load a plugin script and initialize it
 */
function loadPluginScript(scriptUrl, plugin) {
    return new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.type = 'text/javascript';
        script.src = scriptUrl;

        script.onload = () => {
            console.log(`[Plugins] Script loaded: ${plugin.name}`);

            // Try to find and initialize the plugin
            // Plugin exposes itself using its full ID with capitalized first char + "Plugin"
            // E.g., "four43.message-reactions" → window["Four43.message-reactionsPlugin"]
            const pluginNamespace = plugin.id;
            const PluginClass = window[`${pluginNamespace.charAt(0).toUpperCase() + pluginNamespace.slice(1)}Plugin`];

            if (PluginClass && PluginClass.init) {
                PluginClass.init({
                    // Existing (used by typing/reactions plugins too)
                    registerHandler: window.registerPluginHandler,
                    sendMessage: (msg) => ws?.send(JSON.stringify(msg)),
                    sendWs: (msg) => ws?.send(JSON.stringify(msg)),
                    currentRoom: () => currentRoom,
                    currentUsername: () => currentUsername,
                    displaySystemMessage,
                    // Room type handler registration
                    registerRoomTypeHandler: window.registerRoomTypeHandler,
                    // Shared state getters
                    sessionToken: () => sessionToken,
                    roomKeys: () => roomKeys,
                    privateKey: () => privateKey,
                    userColors: () => userColors,
                    userNicknames: () => userNicknames,
                    roomMeta: () => roomMeta,
                    currentRole: () => currentRole,
                    API_URL,
                    loadRooms,
                    loadRoomKeys,
                    escapeHtml,
                    getDisplayName,
                    // Crypto functions (ES module imports, inaccessible to plain scripts)
                    encryptMessage,
                    decryptMessage,
                    isEncryptedMessage,
                    getMessageEpoch,
                }).then(() => {
                    console.log(`[Plugins] Initialized: ${plugin.name}`);
                    resolve();
                }).catch((error) => {
                    console.error(`[Plugins] Failed to initialize ${plugin.name}:`, error);
                    reject(error);
                });
            } else {
                console.warn(`[Plugins] Plugin ${plugin.name} does not expose expected interface`);
                resolve();
            }
        };

        script.onerror = () => {
            console.error(`[Plugins] Failed to load script: ${scriptUrl}`);
            reject(new Error(`Failed to load script: ${scriptUrl}`));
        };

        document.head.appendChild(script);
    });
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
        const response = await fetch(`${API_URL}/users/${encodeURIComponent(currentUsername)}`, {
            method: 'PATCH',
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
                const handler = getRoomTypeHandler(currentRoom);
                if (handler && handler.onRoomSelected) {
                    handler.onRoomSelected(currentRoom);
                }
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
    if (meta && meta.is_dm) {
        displaySystemMessage('You cannot leave a DM.');
        return;
    }

    if (!confirm(`Leave #${currentRoom}? You will need to be re-invited to rejoin.`)) {
        return;
    }

    try {
        const myUsername = localStorage.getItem('username');
        const response = await fetch(
            `${API_URL}/rooms/${encodeURIComponent(currentRoom)}/members/${encodeURIComponent(myUsername)}`,
            {
                method: 'DELETE',
                headers: { 'Authorization': `Bearer ${sessionToken}` },
            }
        );

        if (response.ok) {
            // Leave the room subscription on the unified WS
            if (ws && ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ type: 'room:leave', room_id: currentRoom }));
            }
            const handler = getRoomTypeHandler(currentRoom);
            if (handler && handler.onRoomLeft) {
                handler.onRoomLeft(currentRoom);
            }
            currentRoom = null;
            history.replaceState(null, '', window.location.pathname);
            document.getElementById('chat-header-name').textContent = '[No room selected]';
            document.getElementById('chat-header-topic').textContent = '';
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

// Alias /part for /leave (IRC terminology)
registerCommand('part', async (args) => {
    await slashCommands['leave'].handler(args);
}, 'Leave the current channel (alias for /leave)');

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

    const meta = roomMeta[currentRoom];
    if (meta && meta.is_dm) {
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
}, 'Kick a user from the current channel (room op/owner)');

registerCommand('topic', async (args) => {
    const topic = args.trim();

    if (!currentRoom) {
        displaySystemMessage('Please select a room first.');
        return;
    }

    const meta = roomMeta[currentRoom];
    if (meta && meta.is_dm) {
        displaySystemMessage('Cannot set topic on a DM.');
        return;
    }

    if (!topic) {
        // Show current topic
        const currentTopic = (meta && meta.topic) ? meta.topic : '(no topic set)';
        displaySystemMessage(`Topic: ${currentTopic}`);
        return;
    }

    try {
        const response = await fetch(
            `${API_URL}/rooms/${encodeURIComponent(currentRoom)}`,
            {
                method: 'PATCH',
                headers: {
                    'Authorization': `Bearer ${sessionToken}`,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({ topic }),
            }
        );

        if (response.ok) {
            // Update local cache and header
            if (meta) meta.topic = topic;
            document.getElementById('chat-header-topic').textContent = topic;
            displaySystemMessage(`Topic set to: ${topic}`);
        } else {
            const data = await response.json();
            displaySystemMessage(`Failed to set topic: ${data.detail || 'Unknown error'}`);
        }
    } catch (error) {
        console.error('[CMD] Error setting topic:', error);
        displaySystemMessage('Failed to set topic. Please try again.');
    }
}, 'Set or view the channel topic');

// ---------------------------------------------------------------------------
// E2E helpers
// ---------------------------------------------------------------------------

/** Fetch and decrypt all room keys for the current user in a given room. */
async function loadRoomKeys(roomId) {
    if (!privateKey) {
        console.warn('[E2E] loadRoomKeys skipped — no privateKey available for room:', roomId);
        return;
    }

    try {
        console.log('[E2E] Loading room keys for:', roomId);
        const resp = await fetch(
            `${API_URL}/rooms/${encodeURIComponent(roomId)}/keys`,
            { headers: { 'Authorization': `Bearer ${sessionToken}` } }
        );
        if (!resp.ok) {
            console.warn('[E2E] Room keys fetch failed:', resp.status, 'for room:', roomId);
            return;
        }

        const keys = await resp.json();
        if (!keys || keys.length === 0) {
            console.log('[E2E] No room keys returned from server for:', roomId);
            return;
        }

        console.log('[E2E] Server returned', keys.length, 'key epoch(s) for room:', roomId,
            'epochs:', keys.map(k => k.key_epoch));

        roomKeys[roomId] = {};
        let hadKeys = false;
        for (const entry of keys) {
            hadKeys = true;
            try {
                roomKeys[roomId][entry.key_epoch] = await decryptRoomKey(entry.encrypted_key, privateKey);
                console.log(`[E2E] Decrypted epoch ${entry.key_epoch} for ${roomId}`);
            } catch (e) {
                console.warn(`[E2E] Failed to decrypt epoch ${entry.key_epoch} for ${roomId}:`, e);
            }
        }

        const decryptedCount = Object.keys(roomKeys[roomId]).length;
        console.log(`[E2E] Room ${roomId}: ${decryptedCount}/${keys.length} epochs decrypted`);

        // All existing room key epochs failed to decrypt (key pair was regenerated).
        // Create a new room key epoch so the user can send new messages.
        if (hadKeys && decryptedCount === 0) {
            console.warn(`[E2E] All room key epochs undecryptable for ${roomId}, creating new epoch`);
            const maxEpoch = Math.max(...keys.map(k => k.key_epoch));
            await regenerateRoomKey(roomId, maxEpoch + 1);
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

/**
 * Generate a new room key epoch when the user's key pair was regenerated
 * and old room key epochs can no longer be decrypted.
 * Encrypts the new key for all current room members.
 */
async function regenerateRoomKey(roomId, newEpoch) {
    if (!privateKey) return;

    try {
        // Fetch room detail to get current members
        const detailResp = await fetch(
            `${API_URL}/rooms/${encodeURIComponent(roomId)}`,
            { headers: { 'Authorization': `Bearer ${sessionToken}` } }
        );
        if (!detailResp.ok) return;
        const detail = await detailResp.json();
        const memberUsernames = detail.members.map(m => m.username);

        // Fetch public keys for all members
        const keyResponses = await Promise.all(
            memberUsernames.map(u =>
                fetch(`${API_URL}/auth/encryption-key/${encodeURIComponent(u)}`,
                    { headers: { 'Authorization': `Bearer ${sessionToken}` } })
            )
        );

        const publicKeys = {};
        for (let i = 0; i < memberUsernames.length; i++) {
            if (keyResponses[i].ok) {
                publicKeys[memberUsernames[i]] = JSON.parse((await keyResponses[i].json()).public_key);
            }
        }

        const roomKey = await generateRoomKey();

        // Encrypt and upload for each member
        await Promise.all(
            Object.entries(publicKeys).map(async ([user, pubKeyJwk]) => {
                const encKey = await encryptRoomKey(roomKey, pubKeyJwk);
                return fetch(`${API_URL}/rooms/${encodeURIComponent(roomId)}/keys`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${sessionToken}` },
                    body: JSON.stringify({ username: user, encrypted_key: encKey, key_epoch: newEpoch }),
                });
            })
        );

        roomKeys[roomId] = roomKeys[roomId] || {};
        roomKeys[roomId][newEpoch] = roomKey;
        console.log(`[E2E] Regenerated room key for ${roomId} at epoch ${newEpoch}`);
    } catch (error) {
        console.error('[E2E] Error regenerating room key:', error);
    }
}

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

            // Load E2E encryption private key from IndexedDB
            try {
                console.log('[E2E] Loading private key from IndexedDB for user:', username);
                privateKey = await loadPrivateKey(username);
                if (privateKey) {
                    console.log('[E2E] Private key loaded successfully');
                } else {
                    console.warn('[E2E] No private key found in IndexedDB for user:', username);
                    // Check if server has a passphrase-wrapped key we can recover
                    try {
                        const ekResp = await fetch(
                            `${API_URL}/auth/encryption-key/${encodeURIComponent(username)}`,
                            { headers: { 'Authorization': `Bearer ${token}` } }
                        );
                        const ekData = ekResp.ok ? await ekResp.json() : null;
                        if (ekData?.passphrase_encrypted_private_key || ekData?.encrypted_private_key) {
                            // Key recovery is possible — redirect to dedicated recovery page
                            console.log('[E2E] Server has recoverable key, redirecting to key-recovery...');
                            window.location.href = '/key-recovery.html';
                            return;
                        }
                    } catch (_) { /* best-effort check */ }
                }
            } catch (e) {
                console.error('[E2E] Failed to load private key:', e);
            }

            // Check if key was regenerated during login (old messages will be unreadable)
            if (localStorage.getItem('e2e_key_regenerated')) {
                localStorage.removeItem('e2e_key_regenerated');
                console.warn('[E2E] Encryption key was regenerated. Previous messages may be unreadable.');
                // Defer the system message until chat view is initialized
                setTimeout(() => {
                    displaySystemMessage('Your encryption key was regenerated. Messages from before this session cannot be decrypted.');
                }, 500);
            }

            await loadUserColors();
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
    // Note: settings panel has been moved to settings.html page

    // Update sidebar username and avatar
    const sidebarUsername = document.getElementById('sidebar-username');
    if (sidebarUsername) {
        sidebarUsername.textContent = currentUsername;
    }
    const sidebarAvatar = document.getElementById('sidebar-avatar');
    if (sidebarAvatar) {
        sidebarAvatar.src = `${API_URL}/users/${encodeURIComponent(currentUsername)}/avatar`;
    }

    // Fetch and display server title
    try {
        const response = await fetch(`${API_URL}/server`, {
            headers: { 'Authorization': `Bearer ${sessionToken}` }
        });
        if (response.ok) {
            const serverInfo = await response.json();
            const serverTitleEl = document.getElementById('server-title');
            if (serverTitleEl && serverInfo.name) {
                serverTitleEl.textContent = serverInfo.name;
            }
        }
    } catch (error) {
        console.error('[HTTP] Failed to fetch server info:', error);
    }

    // Request notification permission
    if ('Notification' in window && Notification.permission === 'default') {
        Notification.requestPermission();
    }

    if (currentRole === 'admin' || currentRole === 'moderator') {
        // Show admin panel button
        document.getElementById('admin-panel-btn').classList.remove('hidden');
        // Show folder management button
        document.getElementById('add-folder-btn').classList.remove('hidden');
    }

    await loadRooms();
    await loadPlugins();  // Load plugins before connecting WebSocket
    connectWebSocket();

    // Navigate to a room: hash > last visited > first available
    const roomFromHash = getRoomFromHash();
    if (roomFromHash) {
        selectRoom(roomFromHash);
    } else {
        const lastRoom = getUiPref('lastRoom');
        if (lastRoom && roomMeta[lastRoom]) {
            selectRoom(lastRoom);
        } else {
            const firstRoom = Object.keys(roomMeta)[0];
            if (firstRoom) {
                selectRoom(firstRoom);
            }
        }
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

    // Handle orientation changes and window resizes
    window.addEventListener('resize', () => {
        if (window.innerWidth > 768) {
            // Moved to desktop: dismiss mobile sidebar overlay
            hideSidebar();
        }
    });
}

function logout() {
    sessionToken = null;
    currentUsername = null;
    currentRole = null;
    localStorage.removeItem('session_token');
    localStorage.removeItem('username');
    localStorage.removeItem('role');

    if (ws) {
        ws.close();
        ws = null;
    }
    if (reconnectTimeout) clearTimeout(reconnectTimeout);

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

/**
 * Render a checkbox list of users into a container element.
 * @param {HTMLElement} container - The element to render into
 * @param {Object} options
 * @param {string[]} [options.excludeUsernames] - Usernames to exclude from the list
 * @param {Function} [options.onChange] - Called when any checkbox changes
 * @returns {Promise<void>}
 */
async function renderUserCheckboxList(container, { excludeUsernames = [], onChange } = {}) {
    container.innerHTML = '<p style="color: var(--text-muted);">Loading users...</p>';
    try {
        const response = await fetch(`${API_URL}/users`, {
            headers: { 'Authorization': `Bearer ${sessionToken}` }
        });
        const data = await response.json();

        const users = data.filter(u => !excludeUsernames.includes(u.username));

        if (users.length === 0) {
            container.innerHTML = '<p style="color: var(--text-muted);">No users available</p>';
            return;
        }

        container.innerHTML = '';
        users.forEach(user => {
            const label = document.createElement('label');
            label.className = 'user-select-item';
            const cb = document.createElement('input');
            cb.type = 'checkbox';
            cb.value = user.username;
            if (onChange) cb.addEventListener('change', onChange);
            label.appendChild(cb);

            const info = document.createElement('span');
            info.className = 'user-select-info';
            const displayName = getDisplayName(user.username);
            if (displayName !== user.username) {
                const nameEl = document.createElement('span');
                nameEl.className = 'user-select-name';
                nameEl.textContent = displayName;
                info.appendChild(nameEl);
                const usernameEl = document.createElement('span');
                usernameEl.className = 'user-select-username';
                usernameEl.textContent = user.username;
                info.appendChild(usernameEl);
            } else {
                const nameEl = document.createElement('span');
                nameEl.className = 'user-select-name';
                nameEl.textContent = user.username;
                info.appendChild(nameEl);
            }
            label.appendChild(info);
            container.appendChild(label);
        });
    } catch (error) {
        console.error('Error loading user list:', error);
        container.innerHTML = '<p style="color: var(--text-muted);">Failed to load users</p>';
    }
}

// Expose for plugins
window.getDisplayName = getDisplayName;


async function loadRooms() {
    try {
        const [roomsResponse, foldersResponse] = await Promise.all([
            fetch(`${API_URL}/rooms`, {
                headers: { 'Authorization': `Bearer ${sessionToken}` }
            }),
            fetch(`${API_URL}/room-folders`, {
                headers: { 'Authorization': `Bearer ${sessionToken}` }
            }),
        ]);
        const data = await roomsResponse.json();
        const folderTree = await foldersResponse.json();

        // Update room metadata cache
        roomMeta = {};
        data.forEach(room => {
            roomMeta[room.room_id] = room;
        });

        // Store folder data
        folderData = folderTree.folders || [];
        roomPositions = {};
        (folderTree.room_positions || []).forEach(rp => {
            roomPositions[rp.room_id] = { folder_id: rp.folder_id, position: rp.position };
        });

        const channels = data.filter(r => !r.is_dm);
        const dms = data.filter(r => r.is_dm);

        renderFolderTree('channel-list', folderData, channels);

        const dmList = document.getElementById('dm-list');
        dmList.innerHTML = '';
        dms.forEach(room => {
            dmList.appendChild(createRoomItem(room));
        });

        initDragAndDrop();
    } catch (error) {
        console.error('Error loading rooms:', error);
    }
}

function getCollapsedFolders() {
    try {
        return JSON.parse(localStorage.getItem(COLLAPSED_FOLDERS_KEY) || '[]');
    } catch { return []; }
}

function setCollapsedFolders(ids) {
    localStorage.setItem(COLLAPSED_FOLDERS_KEY, JSON.stringify(ids));
}

function toggleFolder(folderId) {
    const collapsed = getCollapsedFolders();
    const idx = collapsed.indexOf(folderId);
    if (idx >= 0) {
        collapsed.splice(idx, 1);
    } else {
        collapsed.push(folderId);
    }
    setCollapsedFolders(collapsed);

    const content = document.querySelector(`.folder-content[data-folder-id="${folderId}"]`);
    const toggle = document.querySelector(`.folder-toggle[data-folder-id="${folderId}"]`);
    const badge = document.querySelector(`.folder-badge[data-folder-id="${folderId}"]`);
    if (content) content.classList.toggle('collapsed');
    if (toggle) toggle.textContent = content?.classList.contains('collapsed') ? '\u25B6' : '\u25BC';
    if (badge) updateFolderBadge(folderId);
}

function buildFolderTree(folders, channels) {
    const folderMap = {};
    folders.forEach(f => {
        folderMap[f.folder_id] = { ...f, children: [], rooms: [] };
    });

    const rootFolders = [];
    folders.forEach(f => {
        if (f.parent_folder_id && folderMap[f.parent_folder_id]) {
            folderMap[f.parent_folder_id].children.push(folderMap[f.folder_id]);
        } else {
            rootFolders.push(folderMap[f.folder_id]);
        }
    });

    // Sort children by position
    Object.values(folderMap).forEach(f => {
        f.children.sort((a, b) => a.position - b.position);
    });
    rootFolders.sort((a, b) => a.position - b.position);

    // Assign rooms to folders
    const unfiled = [];
    channels.forEach(room => {
        const pos = roomPositions[room.room_id];
        const fid = pos?.folder_id || room.folder_id;
        if (fid && folderMap[fid]) {
            folderMap[fid].rooms.push(room);
        } else {
            unfiled.push(room);
        }
    });

    // Sort rooms within each folder by position
    Object.values(folderMap).forEach(f => {
        f.rooms.sort((a, b) => {
            const posA = roomPositions[a.room_id]?.position ?? a.sort_position ?? 0;
            const posB = roomPositions[b.room_id]?.position ?? b.sort_position ?? 0;
            return posA - posB;
        });
    });
    unfiled.sort((a, b) => {
        const posA = roomPositions[a.room_id]?.position ?? a.sort_position ?? 0;
        const posB = roomPositions[b.room_id]?.position ?? b.sort_position ?? 0;
        return posA - posB;
    });

    return { rootFolders, unfiled, folderMap };
}

function renderFolderTree(containerId, folders, channels) {
    const container = document.getElementById(containerId);
    container.innerHTML = '';

    const { rootFolders, unfiled } = buildFolderTree(folders, channels);

    rootFolders.forEach(folder => {
        container.appendChild(createFolderElement(folder));
    });

    // Render unfiled rooms at root level
    unfiled.forEach(room => {
        container.appendChild(createRoomItem(room));
    });
}

function createFolderElement(folder) {
    const collapsed = getCollapsedFolders();
    const isCollapsed = collapsed.includes(folder.folder_id);
    const isAdmin = currentRole === 'admin' || currentRole === 'moderator';

    const wrapper = document.createElement('div');
    wrapper.className = 'folder-item';
    wrapper.dataset.folderId = folder.folder_id;

    // Header
    const header = document.createElement('div');
    header.className = 'folder-header';

    const toggle = document.createElement('span');
    toggle.className = 'folder-toggle';
    toggle.dataset.folderId = folder.folder_id;
    toggle.textContent = isCollapsed ? '\u25B6' : '\u25BC';
    toggle.onclick = (e) => { e.stopPropagation(); toggleFolder(folder.folder_id); };

    const name = document.createElement('span');
    name.className = 'folder-name';
    name.textContent = folder.name;
    name.onclick = () => toggleFolder(folder.folder_id);

    // Unread badge for collapsed folder
    const badge = document.createElement('span');
    badge.className = 'folder-badge';
    badge.dataset.folderId = folder.folder_id;
    badge.style.display = 'none';

    header.appendChild(toggle);
    header.appendChild(name);
    header.appendChild(badge);

    if (isAdmin) {
        const actions = document.createElement('span');
        actions.className = 'folder-actions';

        const renameBtn = document.createElement('button');
        renameBtn.className = 'folder-action-btn';
        renameBtn.textContent = '\u270E';
        renameBtn.title = 'Rename folder';
        renameBtn.onclick = (e) => { e.stopPropagation(); renameFolder(folder.folder_id, folder.name); };

        const deleteBtn = document.createElement('button');
        deleteBtn.className = 'folder-action-btn';
        deleteBtn.textContent = '\u2715';
        deleteBtn.title = 'Delete folder';
        deleteBtn.onclick = (e) => { e.stopPropagation(); deleteFolder(folder.folder_id, folder.name); };

        actions.appendChild(renameBtn);
        actions.appendChild(deleteBtn);
        header.appendChild(actions);
    }

    wrapper.appendChild(header);

    // Content (collapsible)
    const content = document.createElement('div');
    content.className = 'folder-content' + (isCollapsed ? ' collapsed' : '');
    content.dataset.folderId = folder.folder_id;

    // Nested folders
    folder.children.forEach(child => {
        content.appendChild(createFolderElement(child));
    });

    // Rooms in this folder
    folder.rooms.forEach(room => {
        content.appendChild(createRoomItem(room));
    });

    wrapper.appendChild(content);

    // Update badge after rendering
    if (isCollapsed) {
        requestAnimationFrame(() => updateFolderBadge(folder.folder_id));
    }

    return wrapper;
}

function getUnreadCountInFolder(folderId) {
    // Recursively sum unread counts for all rooms in a folder and its children
    let count = 0;
    const folderMap = {};
    folderData.forEach(f => { folderMap[f.folder_id] = f; });

    function sumFolder(fid) {
        // Count rooms in this folder
        Object.values(roomMeta).forEach(room => {
            if (room.is_dm) return;
            const pos = roomPositions[room.room_id];
            const roomFolderId = pos?.folder_id || room.folder_id;
            if (roomFolderId === fid && room.room_id !== currentRoom) {
                count += room.unread_count || 0;
            }
        });
        // Count child folders
        folderData.forEach(f => {
            if (f.parent_folder_id === fid) {
                sumFolder(f.folder_id);
            }
        });
    }
    sumFolder(folderId);
    return count;
}

function updateFolderBadge(folderId) {
    const badge = document.querySelector(`.folder-badge[data-folder-id="${folderId}"]`);
    const content = document.querySelector(`.folder-content[data-folder-id="${folderId}"]`);
    if (!badge) return;

    const isCollapsed = content?.classList.contains('collapsed');
    if (!isCollapsed) {
        badge.style.display = 'none';
        return;
    }

    const count = getUnreadCountInFolder(folderId);
    if (count > 0) {
        badge.textContent = count > 99 ? '99+' : count;
        badge.style.display = '';
    } else {
        badge.style.display = 'none';
    }
}

function initDragAndDrop() {
    const isAdmin = currentRole === 'admin' || currentRole === 'moderator';
    if (!isAdmin) return;

    // Destroy old instances
    sortableInstances.forEach(s => s.destroy());
    sortableInstances = [];

    // Make the root channel-list sortable
    const channelList = document.getElementById('channel-list');
    if (channelList) {
        sortableInstances.push(new Sortable(channelList, {
            group: 'rooms-and-folders',
            animation: 150,
            fallbackOnBody: true,
            ghostClass: 'drag-ghost',
            chosenClass: 'drag-chosen',
            draggable: '.room-item, .folder-item',
            onEnd: handleDragEnd,
        }));
    }

    // Make each folder-content sortable
    document.querySelectorAll('.folder-content').forEach(el => {
        sortableInstances.push(new Sortable(el, {
            group: 'rooms-and-folders',
            animation: 150,
            fallbackOnBody: true,
            ghostClass: 'drag-ghost',
            chosenClass: 'drag-chosen',
            draggable: '.room-item, .folder-item',
            onEnd: handleDragEnd,
        }));
    });
}

async function handleDragEnd() {
    // Collect new order from DOM
    const folders = [];
    const rooms = [];

    function collectFromContainer(container, parentFolderId) {
        let position = 0;
        Array.from(container.children).forEach(child => {
            if (child.classList.contains('folder-item')) {
                const folderId = child.dataset.folderId;
                folders.push({
                    folder_id: folderId,
                    parent_folder_id: parentFolderId || null,
                    position: position,
                });
                position++;
                // Recurse into folder content
                const content = child.querySelector(':scope > .folder-content');
                if (content) {
                    collectFromContainer(content, folderId);
                }
            } else if (child.classList.contains('room-item')) {
                const roomId = child.dataset.roomId;
                if (roomId) {
                    rooms.push({
                        room_id: roomId,
                        folder_id: parentFolderId || null,
                        position: position,
                    });
                    position++;
                }
            }
        });
    }

    const channelList = document.getElementById('channel-list');
    collectFromContainer(channelList, null);

    try {
        await fetch(`${API_URL}/room-folders/reorder`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${sessionToken}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ folders, rooms }),
        });
    } catch (error) {
        console.error('Error saving reorder:', error);
        loadRooms();  // Reload on failure
    }
}

// Folder CRUD
function openCreateFolderModal() {
    const modal = document.getElementById('create-folder-modal');
    modal.classList.add('open');
    document.getElementById('new-folder-input').value = '';
    document.getElementById('new-folder-input').focus();
}

function closeCreateFolderModal() {
    document.getElementById('create-folder-modal').classList.remove('open');
}

async function createFolder() {
    const input = document.getElementById('new-folder-input');
    const name = input.value.trim();
    if (!name) return;

    try {
        const response = await fetch(`${API_URL}/room-folders`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${sessionToken}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ name }),
        });
        if (response.ok) {
            closeCreateFolderModal();
            await loadRooms();
        } else {
            const data = await response.json();
            alert(data.detail || 'Failed to create folder');
        }
    } catch (error) {
        console.error('Error creating folder:', error);
    }
}

async function renameFolder(folderId, currentName) {
    const newName = prompt('Rename folder:', currentName);
    if (!newName || newName.trim() === currentName) return;

    try {
        await fetch(`${API_URL}/room-folders/${folderId}`, {
            method: 'PATCH',
            headers: {
                'Authorization': `Bearer ${sessionToken}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ name: newName.trim() }),
        });
        await loadRooms();
    } catch (error) {
        console.error('Error renaming folder:', error);
    }
}

async function deleteFolder(folderId, folderName) {
    if (!confirm(`Delete folder "${folderName}"? Rooms inside will become unfiled.`)) return;

    try {
        await fetch(`${API_URL}/room-folders/${folderId}`, {
            method: 'DELETE',
            headers: { 'Authorization': `Bearer ${sessionToken}` },
        });
        await loadRooms();
    } catch (error) {
        console.error('Error deleting folder:', error);
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
    if (room.is_dm) {
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

function connectWebSocket() {
    // Don't create a new connection if one is already open or in progress
    if (ws && (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN)) {
        return;
    }

    // Clear any pending reconnect to avoid duplicate attempts
    if (reconnectTimeout) {
        clearTimeout(reconnectTimeout);
        reconnectTimeout = null;
    }

    if (ws) {
        ws.close();
        ws = null;
    }

    const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsHost = window.location.host;
    const wsUrl = `${wsProtocol}//${wsHost}/api/ws?token=${encodeURIComponent(sessionToken)}`;

    console.log('[WS] Connecting...');
    ws = new WebSocket(wsUrl);

    ws.onopen = async () => {
        console.log('[WS] Connected');
        reconnectAttempts = 0;
        // Re-join current room if we're reconnecting
        if (currentRoom) {
            // Reload keys before rejoining to handle any new epochs created while disconnected
            await loadRoomKeys(currentRoom);
            ws.send(JSON.stringify({ type: 'room:join', room_id: currentRoom }));
        }
    };

    ws.onmessage = (event) => {
        try {
            const data = JSON.parse(event.data);
            dispatchMessage(data);
        } catch (error) {
            console.error('[WS] Error parsing message:', error);
        }
    };

    ws.onclose = () => {
        console.log('[WS] Disconnected');
        ws = null;
        if (sessionToken && reconnectAttempts < maxReconnectAttempts) {
            reconnectAttempts++;
            const delay = Math.min(1000 * Math.pow(2, reconnectAttempts - 1), 10000);
            console.log(`[WS] Reconnecting in ${delay}ms (attempt ${reconnectAttempts}/${maxReconnectAttempts})...`);
            reconnectTimeout = setTimeout(connectWebSocket, delay);
        }
    };

    ws.onerror = (error) => {
        console.error('[WS] Error:', error);
    };
}

function dispatchMessage(data) {
    const type = data.type || '';
    const colonIdx = type.indexOf(':');
    if (colonIdx === -1) {
        console.warn('[WS] No namespace in type:', type);
        return;
    }

    const namespace = type.substring(0, colonIdx);
    const action = type.substring(colonIdx + 1);

    // Core namespaces
    if (namespace === 'system') {
        handleSystemMessage(action, data);
        return;
    }
    if (namespace === 'room') {
        handleRoomMessage(action, data);
        return;
    }

    // Plugin namespaces
    const handler = pluginHandlers[namespace];
    if (handler) {
        try {
            handler(action, data, {
                currentRoom: () => currentRoom,
                currentUsername: () => currentUsername,
                displaySystemMessage,
                sendMessage: (msg) => ws?.send(JSON.stringify(msg)),
            });
        } catch (error) {
            console.error(`[WS] Error in plugin handler for ${namespace}:`, error);
        }
        return;
    }

    console.warn('[WS] Unknown namespace:', namespace);
}

function handleSystemMessage(action, data) {
    switch (action) {
        case 'connected':
            console.log(`[WS] Authenticated as ${data.username}`);
            break;
        case 'pong':
            break;
        case 'error':
            console.error('[WS] System error:', data.message);
            break;
        default:
            console.warn('[WS] Unknown system action:', action);
    }
}

function handleRoomMessage(action, data) {
    switch (action) {
        case 'joined':
            console.log(`[WS] Joined room ${data.room_id}`);
            break;

        case 'left':
            console.log(`[WS] Left room ${data.room_id}`);
            break;

        case 'update':
            console.log('[WS] Room list updated, reloading...');
            loadRooms();
            break;

        case 'folders_updated':
            console.log('[WS] Folder structure updated, reloading...');
            loadRooms();
            break;

        case 'members_updated':
            if (data.room_id === currentRoom) {
                const panel = document.getElementById('members-panel');
                if (panel && panel.classList.contains('open')) {
                    openMembersPanel();
                }
            }
            break;

        case 'topic':
            if (data.room_id === currentRoom) {
                if (roomMeta[currentRoom]) {
                    roomMeta[currentRoom].topic = data.topic;
                }
                document.getElementById('chat-header-topic').textContent = data.topic || '';
                displaySystemMessage(`${data.set_by} set the topic: ${data.topic}`);
            }
            break;

        case 'error':
            console.error(`[WS] Room error (${data.room_id}):`, data.message);
            break;

        default:
            console.warn('[WS] Unknown room action:', action);
            break;
    }
}

function renderRoomTypeList(containerId, radioName) {
    const container = document.getElementById(containerId);
    if (!container) return;
    container.innerHTML = '';

    if (availableRoomTypes.length === 0) {
        container.innerHTML = '<p class="form-hint">No room types available</p>';
        return;
    }

    availableRoomTypes.forEach((rt, i) => {
        const label = document.createElement('label');
        label.className = 'room-type-option';

        const radio = document.createElement('input');
        radio.type = 'radio';
        radio.name = radioName;
        radio.value = rt.room_type;
        if (i === 0) radio.checked = true;

        const info = document.createElement('div');
        info.className = 'room-type-info';

        const name = document.createElement('span');
        name.className = 'room-type-name';
        name.textContent = rt.name;

        const desc = document.createElement('span');
        desc.className = 'room-type-desc';
        desc.textContent = rt.description;

        info.appendChild(name);
        info.appendChild(desc);
        label.appendChild(radio);
        label.appendChild(info);
        container.appendChild(label);
    });
}

function openCreateRoomModal() {
    const modal = document.getElementById('create-room-modal');
    const input = document.getElementById('new-room-input');
    input.value = '';
    renderRoomTypeList('room-type-list', 'create-room-type');
    modal.classList.add('open');
    setTimeout(() => input.focus(), 100);
}

function closeCreateRoomModal() {
    const modal = document.getElementById('create-room-modal');
    modal.classList.remove('open');
}

async function createRoom() {
    const input = document.getElementById('new-room-input');
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
            body: JSON.stringify({
                room_id: roomId,
                room_type: document.querySelector('input[name="create-room-type"]:checked')?.value || 'chat',
            })
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

async function selectRoom(roomId) {
    // Don't do anything if already in this room
    if (currentRoom === roomId) {
        // Just hide sidebar on mobile if clicking the same room
        if (window.innerWidth <= 768) {
            hideSidebar();
        }
        return;
    }

    // Notify old room type handler before leaving
    if (currentRoom) {
        const oldHandler = getRoomTypeHandler(currentRoom);
        if (oldHandler && oldHandler.onRoomLeft) {
            oldHandler.onRoomLeft(currentRoom);
        }
    }

    // Leave previous room subscription on unified WS
    if (currentRoom && ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'room:leave', room_id: currentRoom }));
    }

    // Switching to a different room
    currentRoom = roomId;
    setUiPref('lastRoom', roomId);

    // Update URL hash
    window.location.hash = `#/r/${encodeURIComponent(roomId)}`;

    // Use display_name from metadata for header
    const meta = roomMeta[roomId];
    let displayName = meta ? meta.display_name : roomId;
    if (meta && meta.is_dm) {
        const parts = displayName.split(', ');
        displayName = parts.map(u => getDisplayName(u)).join(', ');
    }
    document.getElementById('chat-header-name').textContent = displayName;
    const topicEl = document.getElementById('chat-header-topic');
    topicEl.textContent = (meta && meta.topic) ? meta.topic : '';

    // Show members button; auto-open panel on wide screens unless user closed it
    const membersBtn = document.getElementById('members-toggle-btn');
    if (membersBtn) membersBtn.classList.remove('hidden');
    closeMembersPanel();
    const membersPref = getUiPref('members_panel');
    if (membersPref === true || (membersPref === null && window.innerWidth > 1024)) {
        openMembersPanel();
    }

    document.querySelectorAll('.room-item').forEach(item => {
        item.classList.toggle('active', item.dataset.roomId === roomId);
    });

    // Load encryption keys BEFORE joining so incoming WS messages can decrypt
    await loadRoomKeys(roomId);

    // Join new room on unified WS (after keys are ready)
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'room:join', room_id: roomId }));
    }

    // Delegate to room type handler for content rendering
    const handler = getRoomTypeHandler(roomId);
    if (handler && handler.onRoomSelected) {
        handler.onRoomSelected(roomId);
    }

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

function setupSidebarSwipe() {
    if (window.innerWidth > 768) return;

    const sidebar = document.querySelector('.sidebar');
    const overlay = document.querySelector('.sidebar-overlay');
    const EDGE_ZONE = 30; // px from left edge to start swipe-open
    const THRESHOLD = 60; // px of travel to commit open/close
    let touch = null; // { startX, startY, sidebarOpen }

    document.addEventListener('touchstart', (e) => {
        const x = e.touches[0].clientX;
        const sidebarOpen = sidebar.classList.contains('show');

        // Swipe-open: must start near left edge when sidebar is hidden
        // Swipe-close: can start anywhere when sidebar is visible
        if (!sidebarOpen && x > EDGE_ZONE) return;

        touch = {
            startX: x,
            startY: e.touches[0].clientY,
            sidebarOpen,
            sidebarWidth: sidebar.offsetWidth,
            moved: false,
        };
    }, { passive: true });

    document.addEventListener('touchmove', (e) => {
        if (!touch) return;

        const dx = e.touches[0].clientX - touch.startX;
        const dy = e.touches[0].clientY - touch.startY;

        // On first significant movement, decide if this is a horizontal swipe
        if (!touch.moved) {
            if (Math.abs(dy) > Math.abs(dx) && Math.abs(dy) > 10) {
                // Vertical scroll — bail out
                touch = null;
                return;
            }
            if (Math.abs(dx) > 10) {
                touch.moved = true;
                sidebar.classList.add('swiping');
                overlay.classList.add('swiping');
            }
            return;
        }

        touch.lastDx = dx;
        const w = touch.sidebarWidth;
        let progress; // 0 = fully hidden, 1 = fully shown
        if (touch.sidebarOpen) {
            progress = Math.max(0, Math.min(1, 1 + dx / w));
        } else {
            progress = Math.max(0, Math.min(1, dx / w));
        }

        sidebar.style.left = `${-(1 - progress) * 100}%`;
        overlay.style.opacity = progress;
    }, { passive: true });

    const endSwipe = () => {
        if (!touch || !touch.moved) {
            touch = null;
            return;
        }

        sidebar.classList.remove('swiping');
        overlay.classList.remove('swiping');
        sidebar.style.left = '';
        overlay.style.opacity = '';

        const dx = touch.lastDx || 0;

        if (touch.sidebarOpen) {
            // Was open — close if swiped left enough
            if (dx < -THRESHOLD) {
                hideSidebar();
            }
        } else {
            // Was closed — open if swiped right enough
            if (dx > THRESHOLD) {
                sidebar.classList.add('show');
                overlay.classList.add('show');
            }
        }

        touch = null;
    };

    document.addEventListener('touchend', endSwipe);
    document.addEventListener('touchcancel', endSwipe);
}

// ---------------------------------------------------------------------------
// Members Panel
// ---------------------------------------------------------------------------

async function openMembersPanel() {
    if (!currentRoom) return;

    const panel = document.getElementById('members-panel');
    const btn = document.getElementById('members-toggle-btn');

    panel.classList.add('open');
    if (btn) btn.classList.add('active');

    const listEl = document.getElementById('members-panel-list');
    const countEl = document.getElementById('members-panel-count');
    listEl.innerHTML = '<p style="color: var(--text-muted); text-align: center; padding: 20px;">Loading...</p>';
    countEl.textContent = '';

    try {
        const response = await fetch(`${API_URL}/rooms/${encodeURIComponent(currentRoom)}`, {
            headers: { 'Authorization': `Bearer ${sessionToken}` }
        });

        if (!response.ok) {
            listEl.innerHTML = '<p style="color: var(--text-muted); text-align: center; padding: 20px;">Failed to load members</p>';
            return;
        }

        const roomData = await response.json();
        const members = roomData.members || [];
        countEl.textContent = `(${members.length})`;

        listEl.innerHTML = '';
        members.forEach(member => {
            const memberDiv = document.createElement('div');
            memberDiv.className = 'member-item';

            const memberInfo = document.createElement('div');
            memberInfo.className = 'member-info';

            const avatar = document.createElement('img');
            avatar.className = 'user-avatar';
            avatar.src = `${API_URL}/users/${encodeURIComponent(member.username)}/avatar`;
            avatar.width = 28;
            avatar.height = 28;
            avatar.alt = '';
            memberInfo.appendChild(avatar);

            const memberName = document.createElement('span');
            memberName.className = 'member-name';
            memberName.style.color = member.color || 'var(--theme-color)';
            memberName.textContent = member.nickname || member.username;
            memberName.title = member.username;

            memberInfo.appendChild(memberName);

            if (member.room_role && member.room_role !== 'member') {
                const memberRole = document.createElement('span');
                memberRole.className = 'member-role';
                memberRole.textContent = member.room_role;
                memberInfo.appendChild(memberRole);
            }

            memberDiv.appendChild(memberInfo);
            listEl.appendChild(memberDiv);
        });

        if (members.length === 0) {
            listEl.innerHTML = '<p style="color: var(--text-muted); text-align: center; padding: 20px;">No members</p>';
        }
    } catch (error) {
        console.error('[HTTP] Error loading members:', error);
        listEl.innerHTML = '<p style="color: var(--text-muted); text-align: center; padding: 20px;">Failed to load members</p>';
    }
}

function closeMembersPanel() {
    const panel = document.getElementById('members-panel');
    const btn = document.getElementById('members-toggle-btn');

    panel.classList.remove('open');
    if (btn) btn.classList.remove('active');
}

function toggleMembersPanel() {
    const panel = document.getElementById('members-panel');
    if (panel.classList.contains('open')) {
        closeMembersPanel();
        setUiPref('members_panel', false);
    } else {
        openMembersPanel();
        setUiPref('members_panel', true);
    }
}

function handleSendInput() {
    const inputEl = document.getElementById('message-input');
    if (!inputEl) return;

    const message = inputEl.value.trim();

    if (!currentRoom) {
        alert('Please select a room first');
        return;
    }

    if (!message) return;

    // Slash command interception (core responsibility)
    if (message.startsWith('/')) {
        inputEl.value = '';
        parseAndExecuteCommand(message);
        return;
    }

    // Check if WebSocket is connected
    if (!ws || ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING) {
        alert('Not connected to chat. Reconnecting...');
        connectWebSocket();
        return;
    }
    if (ws.readyState === WebSocket.CONNECTING) {
        alert('Still connecting, please try again in a moment.');
        return;
    }

    // Delegate to room type handler
    const handler = getRoomTypeHandler(currentRoom);
    if (handler && handler.onSendMessage) {
        inputEl.value = '';
        handler.onSendMessage(message);
    } else {
        console.warn('[Chat] No room type handler for current room');
    }
}

function openRoomSettings(roomId) {
    // Navigate to dedicated room settings page
    window.location.href = `/room-settings.html?room=${encodeURIComponent(roomId)}`;
}

function closeRoomSettings() {
    const modal = document.getElementById('room-settings-modal');
    modal.classList.remove('open');
}

async function updateNotifyLevel() {
    const modal = document.getElementById('room-settings-modal');
    const roomId = modal.dataset.roomId;
    const level = document.getElementById('notify-level-select').value;

    try {
        const resp = await fetch(`${API_URL}/rooms/${encodeURIComponent(roomId)}/members/${encodeURIComponent(currentUsername)}`, {
            method: 'PATCH',
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
    const modal = document.getElementById('room-settings-modal');
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
                const handler = getRoomTypeHandler(roomId);
                if (handler && handler.onRoomLeft) {
                    handler.onRoomLeft(roomId);
                }
                if (ws && ws.readyState === WebSocket.OPEN) {
                    ws.send(JSON.stringify({ type: 'room:leave', room_id: roomId }));
                }
                currentRoom = null;
                history.replaceState(null, '', window.location.pathname);
                document.getElementById('chat-header-name').textContent = '[No room selected]';
            document.getElementById('chat-header-topic').textContent = '';
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
    const modal = document.getElementById('dm-modal');
    const userList = document.getElementById('dm-user-list');
    renderRoomTypeList('dm-room-type-list', 'dm-room-type');
    modal.classList.add('open');
    document.getElementById('dm-start-btn').classList.add('hidden');
    renderUserCheckboxList(userList, {
        excludeUsernames: [currentUsername],
        onChange: updateDMStartButton,
    });
}

function closeDMModal() {
    const modal = document.getElementById('dm-modal');
    modal.classList.remove('open');
}

function updateDMStartButton() {
    const btn = document.getElementById('dm-start-btn');
    const checked = document.querySelectorAll('#dm-user-list .user-select-item input[type="checkbox"]:checked');
    btn.classList.toggle('hidden', checked.length === 0);
}


async function startDMFromModal() {
    const checked = document.querySelectorAll('#dm-user-list .user-select-item input[type="checkbox"]:checked');
    const targets = Array.from(checked).map(cb => cb.value);
    if (targets.length === 0) return;
    const roomType = document.querySelector('input[name="dm-room-type"]:checked')?.value || 'chat';
    await startDM(targets, roomType);
}

async function startDM(targetUsernames, roomType = 'chat') {
    // Accept a single string for backwards compat (e.g. from slash command)
    if (typeof targetUsernames === 'string') targetUsernames = [targetUsernames];

    try {
        const response = await fetch(`${API_URL}/rooms/dm`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${sessionToken}`
            },
            body: JSON.stringify({ usernames: targetUsernames, room_type: roomType })
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

// --- Add Member Modal ---

function openAddMemberModal() {
    if (!currentRoom) return;
    const modal = document.getElementById('add-member-modal');
    const userList = document.getElementById('add-member-user-list');
    modal.classList.add('open');
    document.getElementById('add-member-btn-confirm').classList.add('hidden');

    // Get current members so we can exclude them
    const meta = roomMeta[currentRoom];
    const currentMembers = meta?.members?.map(m => m.username) || [];

    renderUserCheckboxList(userList, {
        excludeUsernames: currentMembers,
        onChange: updateAddMemberButton,
    });
}

function closeAddMemberModal() {
    document.getElementById('add-member-modal').classList.remove('open');
}

function updateAddMemberButton() {
    const btn = document.getElementById('add-member-btn-confirm');
    const checked = document.querySelectorAll('#add-member-user-list .user-select-item input[type="checkbox"]:checked');
    btn.classList.toggle('hidden', checked.length === 0);
}

async function addMembersFromModal() {
    if (!currentRoom) return;
    const checked = document.querySelectorAll('#add-member-user-list .user-select-item input[type="checkbox"]:checked');
    const usernames = Array.from(checked).map(cb => cb.value);
    if (usernames.length === 0) return;

    const btn = document.getElementById('add-member-btn-confirm');
    btn.disabled = true;
    btn.textContent = 'Adding...';

    try {
        for (const username of usernames) {
            const response = await fetch(`${API_URL}/rooms/${encodeURIComponent(currentRoom)}/members`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${sessionToken}`
                },
                body: JSON.stringify({ username })
            });
            if (!response.ok) {
                const data = await response.json();
                console.error(`Failed to add ${username}:`, data.detail);
            }
        }
        closeAddMemberModal();
        // Refresh the members panel
        openMembersPanel();
    } catch (error) {
        console.error('Error adding members:', error);
        alert('Failed to add some users');
    } finally {
        btn.disabled = false;
        btn.textContent = 'Add Selected';
    }
}

// Expose functions to window for inline event handlers
// Note: Settings functions moved to settings.js
window.logout = logout;
window.openCreateRoomModal = openCreateRoomModal;
window.closeCreateRoomModal = closeCreateRoomModal;
window.createRoom = createRoom;
window.openDMModal = openDMModal;
window.closeDMModal = closeDMModal;
window.startDMFromModal = startDMFromModal;
window.sendMessage = handleSendInput;
window.selectRoom = selectRoom;
window.toggleSidebar = toggleSidebar;
window.closeRoomSettings = closeRoomSettings;
window.deleteRoomAction = deleteRoomAction;
window.updateNotifyLevel = updateNotifyLevel;
window.openAddMemberModal = openAddMemberModal;
window.closeAddMemberModal = closeAddMemberModal;
window.addMembersFromModal = addMembersFromModal;
window.toggleMembersPanel = toggleMembersPanel;
window.closeMembersPanel = closeMembersPanel;

// Event listeners
document.addEventListener('DOMContentLoaded', () => {
    // Note: #message-input and #send-button are now created dynamically
    // by room type plugins (e.g. chat plugin). Their event listeners are
    // bound by the plugin when the input area is created.

    // Menu toggle (mobile)
    const menuToggle = document.getElementById('menu-toggle');
    if (menuToggle) {
        menuToggle.addEventListener('click', toggleSidebar);
    }

    // Sidebar overlay (mobile)
    const sidebarOverlay = document.getElementById('sidebar-overlay');
    if (sidebarOverlay) {
        sidebarOverlay.addEventListener('click', toggleSidebar);
    }

    // Swipe to open/close sidebar (mobile)
    setupSidebarSwipe();

    // Add channel button
    const addChannelBtn = document.getElementById('add-channel-btn');
    if (addChannelBtn) {
        addChannelBtn.addEventListener('click', openCreateRoomModal);
    }

    // Add folder button
    const addFolderBtn = document.getElementById('add-folder-btn');
    if (addFolderBtn) {
        addFolderBtn.addEventListener('click', openCreateFolderModal);
    }

    // Create folder modal
    const createFolderCloseBtn = document.getElementById('create-folder-close-btn');
    if (createFolderCloseBtn) {
        createFolderCloseBtn.addEventListener('click', closeCreateFolderModal);
    }
    const createFolderBackdrop = document.getElementById('create-folder-backdrop');
    if (createFolderBackdrop) {
        createFolderBackdrop.addEventListener('click', closeCreateFolderModal);
    }
    const createFolderSubmitBtn = document.getElementById('create-folder-submit-btn');
    if (createFolderSubmitBtn) {
        createFolderSubmitBtn.addEventListener('click', createFolder);
    }
    const newFolderInput = document.getElementById('new-folder-input');
    if (newFolderInput) {
        newFolderInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') createFolder();
        });
    }

    // Add DM button
    const addDmBtn = document.getElementById('add-dm-btn');
    if (addDmBtn) {
        addDmBtn.addEventListener('click', openDMModal);
    }

    // Note: Settings panel has been moved to settings.html page
    // sidebar-settings-btn is now a link to /settings.html

    // Create room modal - input enter key
    const newRoomInput = document.getElementById('new-room-input');
    if (newRoomInput) {
        newRoomInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') createRoom();
        });
    }

    // Create room modal - close button
    const createRoomCloseBtn = document.getElementById('create-room-close-btn');
    if (createRoomCloseBtn) {
        createRoomCloseBtn.addEventListener('click', closeCreateRoomModal);
    }

    // Create room modal - backdrop
    const createRoomBackdrop = document.getElementById('create-room-backdrop');
    if (createRoomBackdrop) {
        createRoomBackdrop.addEventListener('click', closeCreateRoomModal);
    }

    // Create room modal - submit button
    const createRoomSubmitBtn = document.getElementById('create-room-submit-btn');
    if (createRoomSubmitBtn) {
        createRoomSubmitBtn.addEventListener('click', createRoom);
    }

    // Room settings modal - close button
    const roomSettingsCloseBtn = document.getElementById('room-settings-close-btn');
    if (roomSettingsCloseBtn) {
        roomSettingsCloseBtn.addEventListener('click', closeRoomSettings);
    }

    // Room settings modal - backdrop
    const roomSettingsBackdrop = document.getElementById('room-settings-backdrop');
    if (roomSettingsBackdrop) {
        roomSettingsBackdrop.addEventListener('click', closeRoomSettings);
    }

    // Room settings - notify level select
    const notifyLevelSelect = document.getElementById('notify-level-select');
    if (notifyLevelSelect) {
        notifyLevelSelect.addEventListener('change', updateNotifyLevel);
    }

    // Room settings - delete button
    const deleteRoomBtn = document.getElementById('delete-room-btn');
    if (deleteRoomBtn) {
        deleteRoomBtn.addEventListener('click', deleteRoomAction);
    }

    // DM modal - close button
    const dmModalCloseBtn = document.getElementById('dm-modal-close-btn');
    if (dmModalCloseBtn) {
        dmModalCloseBtn.addEventListener('click', closeDMModal);
    }

    // DM modal - backdrop
    const dmModalBackdrop = document.getElementById('dm-modal-backdrop');
    if (dmModalBackdrop) {
        dmModalBackdrop.addEventListener('click', closeDMModal);
    }

    // DM modal - start button
    const dmStartBtn = document.getElementById('dm-start-btn');
    if (dmStartBtn) {
        dmStartBtn.addEventListener('click', startDMFromModal);
    }

    // Members panel
    const membersToggleBtn = document.getElementById('members-toggle-btn');
    if (membersToggleBtn) {
        membersToggleBtn.addEventListener('click', toggleMembersPanel);
    }

    const membersPanelCloseBtn = document.getElementById('members-panel-close-btn');
    if (membersPanelCloseBtn) {
        membersPanelCloseBtn.addEventListener('click', () => {
            closeMembersPanel();
            setUiPref('members_panel', false);
        });
    }
});
