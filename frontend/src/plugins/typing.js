/**
 * Typing Indicators Plugin
 *
 * Displays real-time typing indicators showing which users are currently typing in the active room.
 */

let typingUsers = new Set();
let typingTimer = null;
let lastTypingSent = 0;
const TYPING_DEBOUNCE_MS = 500;
const TYPING_TIMEOUT_MS = 3000;

let context = null;
let messageInput = null;

/**
 * Plugin initialization
 * @param {object} ctx - Plugin context from chat.js
 */
export async function init(ctx) {
    context = ctx;

    console.log('[Typing Plugin] Initializing...');

    // Register the 'typing' namespace handler
    ctx.registerHandler('typing', handleTypingMessage);

    // Set up message input listeners (DOM might not be ready yet, retry if needed)
    const setupWithRetry = () => {
        const success = setupInputListeners();
        if (!success) {
            console.log('[Typing Plugin] DOM not ready, retrying in 100ms...');
            setTimeout(setupWithRetry, 100);
        } else {
            // Create typing indicator UI element after inputs are set up
            createTypingIndicatorUI();
            console.log('[Typing Plugin] Initialized successfully');
        }
    };

    setupWithRetry();
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
 * Set up event listeners on the message input field
 * @returns {boolean} True if setup succeeded, false if DOM not ready
 */
function setupInputListeners() {
    // Find the message input element
    messageInput = document.getElementById('messageInput');

    if (!messageInput) {
        return false;
    }

    // Listen for input events (user typing)
    messageInput.addEventListener('input', handleInputEvent);

    // Stop typing indicator when input loses focus
    messageInput.addEventListener('blur', stopTyping);

    // Note: There's no form element, the send is triggered by a button onclick
    // We'll rely on the WebSocket handler or the blur event
    console.log('[Typing Plugin] Input listeners attached');
    return true;
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
            type: 'typing.start',
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
        type: 'typing.stop',
        room_id: room
    });
}

/**
 * Update the typing indicator display
 */
function updateTypingIndicator() {
    const indicator = document.getElementById('typingIndicator');

    if (!indicator) {
        console.error('[Typing Plugin] Typing indicator element not found in DOM');
        return;
    }

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
    if (document.getElementById('typingIndicator')) {
        console.log('[Typing Plugin] Typing indicator already exists');
        return;
    }

    // Find the chat area and input area
    const chatArea = document.querySelector('.chat-area');
    const inputArea = document.querySelector('.input-area');

    if (!chatArea || !inputArea) {
        console.error('[Typing Plugin] Could not find chat elements to insert typing indicator');
        console.error('[Typing Plugin] chatArea:', chatArea, 'inputArea:', inputArea);
        return;
    }

    // Create the typing indicator element
    const indicator = document.createElement('div');
    indicator.id = 'typingIndicator';
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

    // For debugging, temporarily make it visible
    // indicator.style.display = 'block';
    // indicator.textContent = 'Typing indicator loaded!';
}

/**
 * Clean up when room changes
 */
export function onRoomChange() {
    // Clear typing users when switching rooms
    typingUsers.clear();
    updateTypingIndicator();

    // Stop our own typing indicator
    stopTyping();
}
