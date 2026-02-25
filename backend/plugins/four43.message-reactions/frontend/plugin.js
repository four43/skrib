/**
 * Message Reactions Plugin
 *
 * Adds emoji reactions to messages with real-time updates.
 * Injects emoji buttons into the hover bar owned by room-type-chat.
 */

const ReactionsPlugin = (function() {
    let context = null;
    const COMMON_EMOJIS = ['👍', '❤️', '😂', '😮', '😢', '🎉', '🚀', '👀'];
    const PLUGIN_ID = 'four43.message-reactions';
    const API_BASE = `/api/plugins/${PLUGIN_ID}/reactions`;

    // Batch reaction loading — track min/max message IDs from MutationObserver
    // and load them as a range query after a short debounce.
    let pendingMinId = null;
    let pendingMaxId = null;
    let batchTimer = null;
    const BATCH_DEBOUNCE_MS = 50;

    /**
     * Initialize the plugin
     */
    async function init(ctx) {
        context = ctx;
        console.log('[Reactions] Initializing...');

        // Register WebSocket handler for real-time updates
        // Use full plugin ID as namespace to avoid conflicts
        ctx.registerHandler(PLUGIN_ID, handleReactionMessage);

        // Set up reactions UI for messages
        setupReactionUI();

        console.log('[Reactions] Initialized');
    }

    /**
     * Handle incoming WebSocket messages
     */
    function handleReactionMessage(action, msg, ctx) {
        const data = msg.data || msg;
        if (action === 'added') {
            addReactionToUI(data.message_id, data.emoji, data.username);
        } else if (action === 'removed') {
            removeReactionFromUI(data.message_id, data.emoji, data.username);
        }
    }

    /**
     * Set up reaction UI for all messages
     */
    function setupReactionUI() {
        const messageArea = document.getElementById('messages');
        if (!messageArea) {
            console.warn('[Reactions] Message area not found, will retry when available');
            // Retry after a short delay in case DOM isn't ready yet
            setTimeout(setupReactionUI, 500);
            return;
        }

        // Observe new messages being added to the DOM
        const observer = new MutationObserver(mutations => {
            mutations.forEach(mutation => {
                mutation.addedNodes.forEach(node => {
                    if (node.classList && node.classList.contains('message')) {
                        attachReactionButton(node);
                    }
                });
            });
        });

        observer.observe(messageArea, { childList: true });

        // Attach to existing messages
        document.querySelectorAll('.message').forEach(attachReactionButton);
    }

    /**
     * Attach reaction UI to a message element
     */
    function attachReactionButton(messageElement) {
        const messageId = messageElement.dataset.messageId;
        if (!messageId || messageElement.querySelector('.four43-reactions-container')) {
            return;
        }

        // Skip deleted messages
        if (messageElement.classList.contains('message-deleted')) {
            return;
        }

        // Find the existing hover bar created by room-type-chat
        const hoverBar = messageElement.querySelector('.message-hover-bar');
        if (hoverBar) {
            // Prepend emoji buttons before the edit/"..." buttons
            const firstExistingBtn = hoverBar.firstChild;
            COMMON_EMOJIS.forEach(emoji => {
                const btn = document.createElement('button');
                btn.className = 'four43-hover-emoji-btn';
                btn.textContent = emoji;
                btn.title = emoji;
                btn.onclick = (e) => {
                    e.stopPropagation();
                    addReaction(messageId, emoji);
                    // Dismiss the hover bar after selecting
                    hoverBar.classList.remove('active');
                };
                hoverBar.insertBefore(btn, firstExistingBtn);
            });
        }

        // Create reactions container (shows existing reaction pills below message)
        const container = document.createElement('div');
        container.className = 'four43-reactions-container';
        container.dataset.messageId = messageId;
        messageElement.appendChild(container);

        // Queue this message for batch reaction loading
        queueReactionLoad(messageId);
    }

    /**
     * Queue a message ID for batch reaction loading.
     * Expands the pending min/max range; after a short debounce the range
     * is fetched in a single request scoped to room + ID range.
     */
    function queueReactionLoad(messageId) {
        const id = parseInt(messageId);
        if (pendingMinId === null || id < pendingMinId) pendingMinId = id;
        if (pendingMaxId === null || id > pendingMaxId) pendingMaxId = id;
        if (batchTimer) clearTimeout(batchTimer);
        batchTimer = setTimeout(flushReactionQueue, BATCH_DEBOUNCE_MS);
    }

    /**
     * Fetch reactions for the pending message-ID range in the current room.
     */
    async function flushReactionQueue() {
        const minId = pendingMinId;
        const maxId = pendingMaxId;
        pendingMinId = null;
        pendingMaxId = null;
        batchTimer = null;

        if (minId === null || maxId === null) return;

        const roomId = context.currentRoom();
        if (!roomId) return;

        try {
            const url = `${API_BASE}/room/${encodeURIComponent(roomId)}?min_id=${minId}&max_id=${maxId}`;
            const response = await fetch(url);
            if (!response.ok) return;

            // Response: { messageId: [{emoji, usernames, count}], ... }
            const byMessage = await response.json();
            for (const [msgId, reactions] of Object.entries(byMessage)) {
                for (const reaction of reactions) {
                    updateReactionDisplay(msgId, reaction.emoji, reaction.usernames);
                }
            }
        } catch (error) {
            console.error('[Reactions] Failed to load reactions:', error);
        }
    }

    /**
     * Add a reaction via WebSocket
     */
    async function addReaction(messageId, emoji) {
        try {
            context.sendMessage({
                type: `${PLUGIN_ID}:add`,
                room_id: context.currentRoom(),
                message_id: parseInt(messageId),
                emoji: emoji
            });
        } catch (error) {
            console.error('[Reactions] Failed to add:', error);
            context.displaySystemMessage('Failed to add reaction', 'error');
        }
    }

    /**
     * Remove a reaction via WebSocket
     */
    async function removeReaction(messageId, emoji) {
        try {
            context.sendMessage({
                type: `${PLUGIN_ID}:remove`,
                room_id: context.currentRoom(),
                message_id: parseInt(messageId),
                emoji: emoji
            });
        } catch (error) {
            console.error('[Reactions] Failed to remove:', error);
            context.displaySystemMessage('Failed to remove reaction', 'error');
        }
    }

    /**
     * Add reaction to UI (real-time update)
     */
    function addReactionToUI(messageId, emoji, username) {
        const container = document.querySelector(`.four43-reactions-container[data-message-id="${messageId}"]`);
        if (!container) return;

        let reactionBtn = container.querySelector(`[data-emoji="${emoji}"]`);
        if (reactionBtn) {
            // Update existing reaction
            const usernames = JSON.parse(reactionBtn.dataset.usernames || '[]');
            if (!usernames.includes(username)) {
                usernames.push(username);
                reactionBtn.dataset.usernames = JSON.stringify(usernames);
                reactionBtn.querySelector('.count').textContent = usernames.length;
                reactionBtn.title = usernames.join(', ');
                updateReactionHighlight(reactionBtn, usernames);
            }
        } else {
            // Create new reaction button
            updateReactionDisplay(messageId, emoji, [username]);
        }
    }

    /**
     * Remove reaction from UI (real-time update)
     */
    function removeReactionFromUI(messageId, emoji, username) {
        const container = document.querySelector(`.four43-reactions-container[data-message-id="${messageId}"]`);
        if (!container) return;

        const reactionBtn = container.querySelector(`[data-emoji="${emoji}"]`);
        if (reactionBtn) {
            const usernames = JSON.parse(reactionBtn.dataset.usernames || '[]');
            const index = usernames.indexOf(username);
            if (index > -1) {
                usernames.splice(index, 1);
                if (usernames.length === 0) {
                    reactionBtn.remove();
                } else {
                    reactionBtn.dataset.usernames = JSON.stringify(usernames);
                    reactionBtn.querySelector('.count').textContent = usernames.length;
                    reactionBtn.title = usernames.join(', ');
                    updateReactionHighlight(reactionBtn, usernames);
                }
            }
        }
    }

    /**
     * Update or create reaction display
     */
    function updateReactionDisplay(messageId, emoji, usernames) {
        const container = document.querySelector(`.four43-reactions-container[data-message-id="${messageId}"]`);
        if (!container) return;

        let reactionBtn = container.querySelector(`[data-emoji="${emoji}"]`);
        if (!reactionBtn) {
            // Create new reaction button
            reactionBtn = document.createElement('button');
            reactionBtn.className = 'four43-reaction-btn';
            reactionBtn.dataset.emoji = emoji;
            reactionBtn.dataset.usernames = JSON.stringify(usernames);

            const emojiSpan = document.createElement('span');
            emojiSpan.className = 'emoji';
            emojiSpan.textContent = emoji;

            const countSpan = document.createElement('span');
            countSpan.className = 'count';
            countSpan.textContent = usernames.length;

            reactionBtn.appendChild(emojiSpan);
            reactionBtn.appendChild(countSpan);

            reactionBtn.title = usernames.join(', ');
            reactionBtn.onclick = () => toggleReaction(messageId, emoji);

            container.appendChild(reactionBtn);
        } else {
            // Update existing button
            reactionBtn.dataset.usernames = JSON.stringify(usernames);
            reactionBtn.querySelector('.count').textContent = usernames.length;
            reactionBtn.title = usernames.join(', ');
        }

        updateReactionHighlight(reactionBtn, usernames);
    }

    /**
     * Highlight reaction if current user has reacted
     */
    function updateReactionHighlight(reactionBtn, usernames) {
        const currentUser = context.currentUsername();
        if (usernames.includes(currentUser)) {
            reactionBtn.classList.add('reacted');
        } else {
            reactionBtn.classList.remove('reacted');
        }
    }

    /**
     * Toggle reaction on click
     */
    function toggleReaction(messageId, emoji) {
        const currentUser = context.currentUsername();
        const reactionBtn = document.querySelector(
            `.four43-reactions-container[data-message-id="${messageId}"] [data-emoji="${emoji}"]`
        );

        if (reactionBtn) {
            const usernames = JSON.parse(reactionBtn.dataset.usernames || '[]');
            if (usernames.includes(currentUser)) {
                removeReaction(messageId, emoji);
            } else {
                addReaction(messageId, emoji);
            }
        }
    }

    /**
     * Called when room changes
     */
    function onRoomChange() {
        // No cleanup needed - hover bar is CSS-only visibility
    }

    // Public API
    return {
        init,
        onRoomChange
    };
})();

// Export for plugin loader using full namespaced ID to prevent collisions
// The loader capitalizes the first character of the namespace and adds "Plugin"
// For namespace "four43.message-reactions" → "Four43.message-reactionsPlugin"
// @ts-ignore - Dynamic property access is intentional for namespacing
window["Four43.message-reactionsPlugin"] = ReactionsPlugin;
