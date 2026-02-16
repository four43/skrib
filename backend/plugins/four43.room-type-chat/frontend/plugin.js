/**
 * Chat Room Type Plugin (four43.room-type-chat)
 *
 * Handles message rendering, history loading, sending, read receipts,
 * and notifications for chat room types.
 */

const RoomTypeChatPlugin = (function() {
    let ctx = null;

    // Plugin-owned state
    let lastMessageId = 0;
    let isLoadingMessages = false;
    const PLUGIN_ID = 'four43.room-type-chat';
    let PLUGIN_API = '';

    const USE_NOTIFICATION_TAG = false;

    async function init(pluginCtx) {
        ctx = pluginCtx;
        PLUGIN_API = `${ctx.API_URL}/plugins/${PLUGIN_ID}`;

        console.log('[RoomTypeChat] Initializing...');

        ctx.registerRoomTypeHandler({
            roomTypes: ['chat'],
            onRoomSelected,
            onRoomLeft,
            onRoomAction,
            onSendMessage,
        });

        console.log('[RoomTypeChat] Initialized successfully');
    }

    // -----------------------------------------------------------------------
    // Room type handler interface
    // -----------------------------------------------------------------------

    async function onRoomSelected(roomId) {
        lastMessageId = 0;
        const messagesDiv = document.getElementById('messages');
        messagesDiv.className = 'messages';
        messagesDiv.innerHTML = '';

        createInputArea();

        await ctx.loadRoomKeys(roomId);
        await loadMessages(roomId);
        await markRoomAsRead(roomId, lastMessageId);
        ctx.loadRooms();
    }

    function onRoomLeft(roomId) {
        lastMessageId = 0;
        removeInputArea();
    }

    // -----------------------------------------------------------------------
    // Input area (owned by this plugin)
    // -----------------------------------------------------------------------

    function createInputArea() {
        // Remove any existing input area first
        removeInputArea();

        const chatArea = document.querySelector('.chat-area');
        if (!chatArea) return;

        const inputArea = document.createElement('div');
        inputArea.className = 'input-area';
        inputArea.id = 'chat-input-area';

        const input = document.createElement('input');
        input.type = 'text';
        input.id = 'message-input';
        input.className = 'message-input';
        input.placeholder = 'Type a message...';

        const button = document.createElement('button');
        button.id = 'send-button';
        button.className = 'send-button';
        button.textContent = 'Send';

        inputArea.appendChild(input);
        inputArea.appendChild(button);
        chatArea.appendChild(inputArea);

        // Bind event listeners — delegates through core's handleSendInput
        // which handles slash commands and then calls onSendMessage
        input.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') window.sendMessage();
        });
        button.addEventListener('click', () => window.sendMessage());

        input.focus();
    }

    function removeInputArea() {
        const existing = document.getElementById('chat-input-area');
        if (existing) existing.remove();
    }

    function onRoomAction(action, data) {
        switch (action) {
            case 'message':
                if (data.room_id === ctx.currentRoom()) {
                    displayMessage(data.data);
                    if (data.data.id) {
                        markRoomAsRead(ctx.currentRoom(), data.data.id);
                    }
                }
                break;

            case 'new_message':
                console.log('[RoomTypeChat] New message notification:', data);
                ctx.loadRooms();
                if (data.room_id !== ctx.currentRoom()) {
                    showNotification(data);
                }
                break;

            default:
                console.warn('[RoomTypeChat] Unknown room action:', action);
        }
    }

    async function onSendMessage(text) {
        const currentRoom = ctx.currentRoom();

        if (!currentRoom) {
            alert('Please select a room first');
            return;
        }

        try {
            let content = text;
            let contentType = 'text';
            let keyEpoch = undefined;

            // Encrypt if we have a room key
            const roomKeys = ctx.roomKeys();
            const epochs = roomKeys[currentRoom];
            if (epochs) {
                const epochNums = Object.keys(epochs).map(Number);
                const latestEpoch = Math.max(...epochNums);
                content = await ctx.encryptMessage(epochs[latestEpoch], text, latestEpoch);
                contentType = 'encrypted';
                keyEpoch = latestEpoch;
            }

            const payload = {
                type: 'room:message',
                room_id: currentRoom,
                content: content,
                content_type: contentType,
            };

            if (keyEpoch !== undefined) {
                payload.key_epoch = keyEpoch;
            }

            ctx.sendWs(payload);
        } catch (error) {
            console.error('[RoomTypeChat] Error sending message:', error);
            alert('Failed to send message');
        }
    }

    // -----------------------------------------------------------------------
    // Message display
    // -----------------------------------------------------------------------

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
        messageDiv.dataset.messageId = msg.id;

        const date = new Date(msg.timestamp);
        const timeStr = date.toLocaleTimeString();

        // Get user's color preference, default to blue
        const userColors = ctx.userColors();
        const userColor = userColors[msg.username] || '#1976d2';

        // Decrypt if encrypted
        let plaintext = msg.content;
        const contentType = msg.content_type || 'text';

        if (contentType === 'encrypted') {
            const epoch = msg.key_epoch !== undefined && msg.key_epoch !== null
                ? msg.key_epoch
                : ctx.getMessageEpoch(msg.content);
            const roomKeys = ctx.roomKeys();
            const epochs = roomKeys[ctx.currentRoom()];
            const key = epochs && epochs[epoch];
            if (key) {
                try {
                    plaintext = await ctx.decryptMessage(key, msg.content);
                } catch (e) {
                    console.warn('[E2E] Failed to decrypt message:', e);
                    plaintext = '[encrypted message \u2014 cannot decrypt]';
                }
            } else {
                plaintext = '[encrypted message \u2014 no key for this room]';
            }
        } else if (contentType === 'text' && ctx.isEncryptedMessage(msg.content)) {
            // Backward compatibility: old messages with ENC: prefix but content_type='text'
            const epoch = ctx.getMessageEpoch(msg.content);
            const roomKeys = ctx.roomKeys();
            const epochs = roomKeys[ctx.currentRoom()];
            const key = epochs && epochs[epoch];
            if (key) {
                try {
                    plaintext = await ctx.decryptMessage(key, msg.content);
                } catch (e) {
                    console.warn('[E2E] Failed to decrypt legacy message:', e);
                    plaintext = '[encrypted message \u2014 cannot decrypt]';
                }
            } else {
                plaintext = '[encrypted message \u2014 no key for this room]';
            }
        }

        const messageBody = linkifyRoomRefs(ctx.escapeHtml(plaintext));
        const displayName = ctx.getDisplayName(msg.username);

        messageDiv.innerHTML = `
            <div class="message-header">
                <span class="username" style="color: ${userColor};" title="${ctx.escapeHtml(msg.username)}">${ctx.escapeHtml(displayName)}</span>
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

    // -----------------------------------------------------------------------
    // Message loading
    // -----------------------------------------------------------------------

    async function loadMessages(roomId) {
        if (!roomId || isLoadingMessages) return;

        isLoadingMessages = true;

        try {
            console.log(`[RoomTypeChat] Loading message history since=${lastMessageId}`);
            const response = await fetch(
                `${PLUGIN_API}/rooms/${encodeURIComponent(roomId)}/messages?since=${lastMessageId}`,
                { headers: { 'Authorization': `Bearer ${ctx.sessionToken()}` } }
            );
            const data = await response.json();

            if (data.messages && data.messages.length > 0) {
                console.log(`[RoomTypeChat] Loaded ${data.messages.length} messages from history`);
                for (const msg of data.messages) {
                    await displayMessage(msg);
                }
            } else {
                console.log('[RoomTypeChat] No message history');
            }
        } catch (error) {
            console.error('[RoomTypeChat] Error loading messages:', error);
        } finally {
            isLoadingMessages = false;
        }
    }

    // -----------------------------------------------------------------------
    // Read receipts
    // -----------------------------------------------------------------------

    async function markRoomAsRead(roomId, messageId) {
        if (!messageId || messageId <= 0) return;
        try {
            await fetch(`${PLUGIN_API}/rooms/${encodeURIComponent(roomId)}/read`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${ctx.sessionToken()}`,
                },
                body: JSON.stringify({ last_read_message_id: messageId }),
            });
        } catch (error) {
            console.error('[RoomTypeChat] Error marking room as read:', error);
        }
    }

    // -----------------------------------------------------------------------
    // Notifications
    // -----------------------------------------------------------------------

    function showNotification(data) {
        if (!('Notification' in window)) return;
        if (Notification.permission !== 'granted') return;
        if (document.hasFocus()) return;

        const roomMeta = ctx.roomMeta();
        const meta = roomMeta[data.room_id];
        const roomLabel = meta ? meta.display_name : data.room_id;
        const senderName = ctx.getDisplayName(data.sender);

        const opts = { body: `${senderName} in ${roomLabel}` };
        if (USE_NOTIFICATION_TAG) {
            opts.tag = data.room_id;
            opts.renotify = true;
        }
        const notification = new Notification('New message', opts);

        notification.onclick = () => {
            window.focus();
            if (window.selectRoom) {
                window.selectRoom(data.room_id);
            }
            notification.close();
        };
    }

    // Public API
    return {
        init,
    };
})();

// Export for module loading
if (typeof module !== 'undefined' && module.exports) {
    module.exports = RoomTypeChatPlugin;
}

// Export for plugin loader
// ID "four43.room-type-chat" -> "Four43.room-type-chatPlugin"
window["Four43.room-type-chatPlugin"] = RoomTypeChatPlugin;
