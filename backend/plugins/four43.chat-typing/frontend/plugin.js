/**
 * Typing Indicators Plugin (four43.chat-typing)
 *
 * Displays real-time typing indicators showing which users are currently typing in the active room.
 */

// Plugin-scoped variables (namespaced)
const TypingPlugin = (function() {
    let typingUsers = new Set();
    let typingTimer = null;
    let lastTypingSent = 0;
    const TYPING_DEBOUNCE_MS = 500;
    const TYPING_TIMEOUT_MS = 3000;

    let context = null;
    let messageInput = null;
    let observer = null;

    /**
     * Plugin initialization
     * @param {object} ctx - Plugin context from chat.js
     */
    async function init(ctx) {
        context = ctx;

        console.log('[Typing Plugin] Initializing...');

        // Register the namespace handler
        ctx.registerHandler('four43.chat-typing', handleTypingMessage);

        // The message input is now created dynamically by room type plugins.
        // Use a MutationObserver to attach/detach when #message-input appears/disappears.
        observeInputElement();

        console.log('[Typing Plugin] Initialized successfully');
    }

    /**
     * Watch for #message-input to be added/removed from the DOM.
     * When it appears, attach typing listeners and create the indicator.
     * When it disappears, clean up.
     */
    function observeInputElement() {
        // Check if already present (in case plugin loads after chat plugin created it)
        const existing = document.getElementById('message-input');
        if (existing) {
            attachToInput(existing);
        }

        observer = new MutationObserver((mutations) => {
            for (const mutation of mutations) {
                // Check added nodes
                for (const node of mutation.addedNodes) {
                    if (node.nodeType !== Node.ELEMENT_NODE) continue;
                    const input = node.id === 'message-input' ? node : node.querySelector?.('#message-input');
                    if (input) {
                        attachToInput(input);
                        return;
                    }
                }
                // Check removed nodes
                for (const node of mutation.removedNodes) {
                    if (node.nodeType !== Node.ELEMENT_NODE) continue;
                    const wasInput = node.id === 'message-input' || node.querySelector?.('#message-input');
                    if (wasInput) {
                        detachFromInput();
                        return;
                    }
                }
            }
        });

        observer.observe(document.body, { childList: true, subtree: true });
    }

    /**
     * Attach typing listeners to the message input and create the indicator.
     */
    function attachToInput(input) {
        // Detach from previous input if any
        detachFromInput();

        messageInput = input;
        messageInput.addEventListener('input', handleInputEvent);
        messageInput.addEventListener('blur', stopTyping);

        createTypingIndicatorUI();
        console.log('[Typing Plugin] Attached to message input');
    }

    /**
     * Detach typing listeners and remove the indicator.
     */
    function detachFromInput() {
        if (messageInput) {
            messageInput.removeEventListener('input', handleInputEvent);
            messageInput.removeEventListener('blur', stopTyping);
            messageInput = null;
        }

        // Remove typing indicator
        const indicator = document.getElementById('four43-chat-typing-indicator');
        if (indicator) indicator.remove();

        // Clear state
        typingUsers.clear();
        clearTimeout(typingTimer);
        typingTimer = null;
    }

    /**
     * Handle incoming typing messages from WebSocket
     */
    function handleTypingMessage(action, data, ctx) {
        console.log('[Typing Plugin] Received message:', action, data);

        if (action === 'user_typing' && data.room_id === ctx.currentRoom()) {
            const currentUser = ctx.currentUsername();

            // Ignore self
            if (data.username === currentUser) {
                console.log('[Typing Plugin] Ignoring own typing event');
                return;
            }

            if (data.is_typing) {
                console.log(`[Typing Plugin] ${data.username} started typing`);
                typingUsers.add(data.username);
            } else {
                console.log(`[Typing Plugin] ${data.username} stopped typing`);
                typingUsers.delete(data.username);
            }

            updateTypingIndicator();
        }
    }

    /**
     * Handle input event - send typing.start with debouncing
     */
    function handleInputEvent() {
        const now = Date.now();
        const room = context.currentRoom();

        if (!room) return;

        // Debounce: only send if enough time has passed
        if (now - lastTypingSent >= TYPING_DEBOUNCE_MS) {
            context.sendMessage({
                type: 'four43.chat-typing:start',
                room_id: room
            });
            lastTypingSent = now;
        }

        // Reset the auto-stop timer
        clearTimeout(typingTimer);
        typingTimer = setTimeout(stopTyping, TYPING_TIMEOUT_MS);
    }

    /**
     * Send typing.stop event
     */
    function stopTyping() {
        const room = context?.currentRoom();

        if (!room) return;

        clearTimeout(typingTimer);
        typingTimer = null;

        context.sendMessage({
            type: 'four43.chat-typing:stop',
            room_id: room
        });
    }

    /**
     * Update the typing indicator display
     */
    function updateTypingIndicator() {
        const indicator = document.getElementById('four43-chat-typing-indicator');

        if (!indicator) return;

        console.log(`[Typing Plugin] Updating indicator, ${typingUsers.size} users typing:`, Array.from(typingUsers));

        if (typingUsers.size === 0) {
            indicator.textContent = '';
            indicator.style.display = 'none';
        } else if (typingUsers.size === 1) {
            const user = Array.from(typingUsers)[0];
            const displayName = getDisplayName(user);
            indicator.textContent = `${displayName} is typing...`;
            indicator.style.display = 'block';
            console.log('[Typing Plugin] Showing:', indicator.textContent);
        } else if (typingUsers.size === 2) {
            const users = Array.from(typingUsers);
            const name1 = getDisplayName(users[0]);
            const name2 = getDisplayName(users[1]);
            indicator.textContent = `${name1} and ${name2} are typing...`;
            indicator.style.display = 'block';
            console.log('[Typing Plugin] Showing:', indicator.textContent);
        } else {
            indicator.textContent = `${typingUsers.size} people are typing...`;
            indicator.style.display = 'block';
            console.log('[Typing Plugin] Showing:', indicator.textContent);
        }
    }

    /**
     * Get display name for a user (nickname or username)
     */
    function getDisplayName(username) {
        // Access global function if available
        if (window.getDisplayName) {
            return window.getDisplayName(username);
        }
        return username;
    }

    /**
     * Create the typing indicator UI element
     */
    function createTypingIndicatorUI() {
        // Check if already exists
        if (document.getElementById('four43-chat-typing-indicator')) {
            console.log('[Typing Plugin] Typing indicator already exists');
            return;
        }

        // Find the chat area and input area
        const chatArea = document.querySelector('.room-content');
        const inputArea = document.querySelector('.input-area');

        if (!chatArea || !inputArea) {
            return;
        }

        // Create the typing indicator element with namespaced ID
        const indicator = document.createElement('div');
        indicator.id = 'four43-chat-typing-indicator';
        indicator.className = 'typing-indicator';
        indicator.style.display = 'none';
        indicator.style.padding = '8px 16px';
        indicator.style.fontSize = '0.875rem';
        indicator.style.color = '#9ca3af';
        indicator.style.fontStyle = 'italic';
        indicator.style.borderTop = '1px solid rgba(255, 255, 255, 0.1)';

        // Insert before the input area (so it appears right above the input field)
        chatArea.insertBefore(indicator, inputArea);
        console.log('[Typing Plugin] Created typing indicator element');
    }

    /**
     * Clean up when room changes
     */
    function onRoomChange() {
        // Clear typing users when switching rooms
        typingUsers.clear();
        updateTypingIndicator();

        // Stop our own typing indicator
        stopTyping();
    }

    // Public API
    return {
        init,
        onRoomChange
    };
})();

// Export for module loading
if (typeof module !== 'undefined' && module.exports) {
    module.exports = TypingPlugin;
}

// Export for plugin loader using full namespaced ID to prevent collisions
// The loader capitalizes the first character of the ID and adds "Plugin"
// For ID "four43.chat-typing" → "Four43.chat-typingPlugin"
// @ts-ignore - Dynamic property access is intentional for namespacing
window["Four43.chat-typingPlugin"] = TypingPlugin;
