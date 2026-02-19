/**
 * Chat Room Type Plugin (four43.room-type-chat)
 *
 * Handles message rendering, history loading, sending, read receipts,
 * notifications, and message edit/delete for chat room types.
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

        // Dismiss hover bars and menus when clicking outside messages
        document.addEventListener('click', (e) => {
            if (!e.target.closest('.message')) {
                document.querySelectorAll('.message-hover-bar.active').forEach(bar => {
                    bar.classList.remove('active');
                });
                dismissMoreMenu();
            }
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
        input.setAttribute('enterkeyhint', 'send');
        input.setAttribute('autocapitalize', 'sentences');
        input.setAttribute('autocorrect', 'off');

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

            case 'message_edited':
                handleMessageEdited(data.data);
                break;

            case 'message_deleted':
                handleMessageDeleted(data.data);
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
    // Encryption helpers
    // -----------------------------------------------------------------------

    async function encryptContent(plaintext) {
        const currentRoom = ctx.currentRoom();
        const roomKeys = ctx.roomKeys();
        const epochs = roomKeys[currentRoom];
        if (epochs) {
            const epochNums = Object.keys(epochs).map(Number);
            const latestEpoch = Math.max(...epochNums);
            const encrypted = await ctx.encryptMessage(epochs[latestEpoch], plaintext, latestEpoch);
            return { content: encrypted, contentType: 'encrypted', keyEpoch: latestEpoch };
        }
        return { content: plaintext, contentType: 'text', keyEpoch: undefined };
    }

    async function decryptContent(msg) {
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

        return plaintext;
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
        messageDiv.dataset.username = msg.username;

        const date = new Date(msg.timestamp);
        const timeStr = date.toLocaleTimeString();

        // Get user's color preference, default to blue
        const userColors = ctx.userColors();
        const userColor = userColors[msg.username] || '#1976d2';
        const displayName = ctx.getDisplayName(msg.username);
        const avatarUrl = `${ctx.API_URL}/users/${encodeURIComponent(msg.username)}/avatar`;

        const isDeleted = msg.deleted;

        if (isDeleted) {
            messageDiv.classList.add('message-deleted');
            messageDiv.innerHTML = `
                <img class="user-avatar" src="${avatarUrl}" alt="">
                <div class="message-header">
                    <span class="username" style="color: ${userColor};" title="${ctx.escapeHtml(msg.username)}">${ctx.escapeHtml(displayName)}</span>
                    <span class="timestamp">${timeStr}</span>
                </div>
                <div class="message-text deleted-text">[deleted]</div>
            `;
        } else {
            const plaintext = await decryptContent(msg);
            const messageBody = linkifyRoomRefs(ctx.escapeHtml(plaintext));

            // Store plaintext for editing
            messageDiv.dataset.plaintext = plaintext;

            const editedHtml = msg.edited_at
                ? '<span class="edited-indicator">(edited)</span>'
                : '';

            messageDiv.innerHTML = `
                <img class="user-avatar" src="${avatarUrl}" alt="">
                <div class="message-header">
                    <span class="username" style="color: ${userColor};" title="${ctx.escapeHtml(msg.username)}">${ctx.escapeHtml(displayName)}</span>
                    <span class="timestamp">${timeStr}</span>
                    ${editedHtml}
                </div>
                <div class="message-text">${messageBody}</div>
            `;

            // Add hover bar with action buttons
            createHoverBar(messageDiv, msg);
        }

        messagesDiv.appendChild(messageDiv);

        // Update lastMessageId
        if (msg.id > lastMessageId) {
            lastMessageId = msg.id;
        }

        // Scroll to bottom
        messagesDiv.scrollTop = messagesDiv.scrollHeight;
    }

    // -----------------------------------------------------------------------
    // Hover bar
    // -----------------------------------------------------------------------

    function createHoverBar(messageDiv, msg) {
        const hoverBar = document.createElement('div');
        hoverBar.className = 'message-hover-bar';

        const isAuthor = msg.username === ctx.currentUsername();
        const isAdmin = ctx.currentRole() === 'admin';

        // Edit button — author only
        if (isAuthor) {
            const editBtn = document.createElement('button');
            editBtn.className = 'message-hover-btn';
            editBtn.innerHTML = '&#9998;'; // ✎ pencil
            editBtn.title = 'Edit';
            editBtn.onclick = (e) => {
                e.stopPropagation();
                hoverBar.classList.remove('active');
                startEditMode(messageDiv);
            };
            hoverBar.appendChild(editBtn);
        }

        // "..." more button — author or admin
        if (isAuthor || isAdmin) {
            const moreBtn = document.createElement('button');
            moreBtn.className = 'message-hover-btn message-more-btn';
            moreBtn.textContent = '\u22EF'; // ⋯ midline horizontal ellipsis
            moreBtn.title = 'More';
            moreBtn.onclick = (e) => {
                e.stopPropagation();
                toggleMoreMenu(moreBtn, messageDiv);
            };
            hoverBar.appendChild(moreBtn);
        }

        messageDiv.appendChild(hoverBar);

        // Mobile: tap message to toggle hover bar
        messageDiv.addEventListener('click', (e) => {
            if (e.target.closest('.message-hover-bar') ||
                e.target.closest('.message-more-menu') ||
                e.target.closest('.four43-reaction-btn') ||
                e.target.closest('.message-edit-input')) {
                return;
            }
            // Dismiss other hover bars
            document.querySelectorAll('.message-hover-bar.active').forEach(bar => {
                if (bar !== hoverBar) bar.classList.remove('active');
            });
            dismissMoreMenu();
            hoverBar.classList.add('active');
        });
    }

    // -----------------------------------------------------------------------
    // "..." more menu
    // -----------------------------------------------------------------------

    function toggleMoreMenu(moreBtn, messageDiv) {
        // If a menu is already open, dismiss it
        const existing = document.querySelector('.message-more-menu');
        if (existing) {
            existing.remove();
            return;
        }

        const menu = document.createElement('div');
        menu.className = 'message-more-menu';

        const deleteItem = document.createElement('button');
        deleteItem.className = 'message-more-menu-item';
        deleteItem.textContent = 'Delete message';
        deleteItem.onclick = (e) => {
            e.stopPropagation();
            menu.remove();
            deleteMessage(messageDiv);
        };

        menu.appendChild(deleteItem);
        moreBtn.parentElement.appendChild(menu);
    }

    function dismissMoreMenu() {
        document.querySelectorAll('.message-more-menu').forEach(m => m.remove());
    }

    // -----------------------------------------------------------------------
    // Edit mode
    // -----------------------------------------------------------------------

    function startEditMode(messageDiv) {
        const textEl = messageDiv.querySelector('.message-text');
        if (!textEl || messageDiv.classList.contains('editing')) return;

        dismissMoreMenu();
        messageDiv.classList.add('editing');

        const originalPlaintext = messageDiv.dataset.plaintext || '';
        const originalHtml = textEl.innerHTML;

        const input = document.createElement('input');
        input.type = 'text';
        input.className = 'message-edit-input';
        input.value = originalPlaintext;

        // Replace message text with input
        textEl.innerHTML = '';
        textEl.appendChild(input);
        input.focus();
        input.setSelectionRange(input.value.length, input.value.length);

        let saved = false;

        function saveEdit() {
            if (saved) return;
            saved = true;

            const newText = input.value.trim();
            if (newText && newText !== originalPlaintext) {
                // Send edit via WebSocket (encryption handled async)
                sendEdit(messageDiv, newText);
            } else {
                // No change or empty — restore original
                cancelEdit(messageDiv, textEl, originalHtml);
            }
        }

        function cancel() {
            if (saved) return;
            saved = true;
            cancelEdit(messageDiv, textEl, originalHtml);
        }

        input.addEventListener('blur', () => {
            // Small delay to allow click events on other elements to fire first
            setTimeout(() => { if (!saved) saveEdit(); }, 100);
        });

        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                input.blur();
            } else if (e.key === 'Escape') {
                e.preventDefault();
                cancel();
            }
        });
    }

    function cancelEdit(messageDiv, textEl, originalHtml) {
        messageDiv.classList.remove('editing');
        textEl.innerHTML = originalHtml;
    }

    async function sendEdit(messageDiv, newText) {
        const messageId = parseInt(messageDiv.dataset.messageId);
        const currentRoom = ctx.currentRoom();

        try {
            const { content, contentType, keyEpoch } = await encryptContent(newText);

            const payload = {
                type: 'room:edit_message',
                room_id: currentRoom,
                message_id: messageId,
                content: content,
                content_type: contentType,
            };
            if (keyEpoch !== undefined) {
                payload.key_epoch = keyEpoch;
            }

            ctx.sendWs(payload);

            // Optimistic update
            messageDiv.classList.remove('editing');
            messageDiv.dataset.plaintext = newText;
            const textEl = messageDiv.querySelector('.message-text');
            textEl.innerHTML = linkifyRoomRefs(ctx.escapeHtml(newText));

            // Add/update edited indicator
            let indicator = messageDiv.querySelector('.edited-indicator');
            if (!indicator) {
                indicator = document.createElement('span');
                indicator.className = 'edited-indicator';
                indicator.textContent = '(edited)';
                messageDiv.querySelector('.message-header').appendChild(indicator);
            }
        } catch (error) {
            console.error('[RoomTypeChat] Error sending edit:', error);
            // Restore original on failure
            const textEl = messageDiv.querySelector('.message-text');
            const originalPlaintext = messageDiv.dataset.plaintext || newText;
            textEl.innerHTML = linkifyRoomRefs(ctx.escapeHtml(originalPlaintext));
            messageDiv.classList.remove('editing');
        }
    }

    // -----------------------------------------------------------------------
    // Delete
    // -----------------------------------------------------------------------

    function deleteMessage(messageDiv) {
        const messageId = parseInt(messageDiv.dataset.messageId);
        const currentRoom = ctx.currentRoom();

        ctx.sendWs({
            type: 'room:delete_message',
            room_id: currentRoom,
            message_id: messageId,
        });
    }

    // -----------------------------------------------------------------------
    // Real-time edit/delete handlers
    // -----------------------------------------------------------------------

    async function handleMessageEdited(data) {
        const messageDiv = document.querySelector(`.message[data-message-id="${data.message_id}"]`);
        if (!messageDiv) return;

        // Decrypt new content
        const plaintext = await decryptContent({
            content: data.content,
            content_type: data.content_type,
            key_epoch: data.key_epoch,
        });

        messageDiv.dataset.plaintext = plaintext;
        messageDiv.classList.remove('editing');

        const textEl = messageDiv.querySelector('.message-text');
        if (textEl) {
            textEl.innerHTML = linkifyRoomRefs(ctx.escapeHtml(plaintext));
        }

        // Add/update edited indicator
        let indicator = messageDiv.querySelector('.edited-indicator');
        if (!indicator) {
            indicator = document.createElement('span');
            indicator.className = 'edited-indicator';
            indicator.textContent = '(edited)';
            messageDiv.querySelector('.message-header').appendChild(indicator);
        }
    }

    function handleMessageDeleted(data) {
        const messageDiv = document.querySelector(`.message[data-message-id="${data.message_id}"]`);
        if (!messageDiv) return;

        messageDiv.classList.add('message-deleted');
        delete messageDiv.dataset.plaintext;

        // Replace message text
        const textEl = messageDiv.querySelector('.message-text');
        if (textEl) {
            textEl.className = 'message-text deleted-text';
            textEl.textContent = '[deleted]';
        }

        // Remove hover bar and reactions
        const hoverBar = messageDiv.querySelector('.message-hover-bar');
        if (hoverBar) hoverBar.remove();

        const reactions = messageDiv.querySelector('.four43-reactions-container');
        if (reactions) reactions.remove();
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
