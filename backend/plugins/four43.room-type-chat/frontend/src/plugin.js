/**
 * Chat Room Type Plugin (four43.room-type-chat)
 *
 * Handles message rendering, history loading, sending, read receipts,
 * notifications, and message edit/delete for chat room types.
 */

import { Marked } from 'marked';
import hljs from 'highlight.js/lib/core';
import javascript from 'highlight.js/lib/languages/javascript';
import python from 'highlight.js/lib/languages/python';
import typescript from 'highlight.js/lib/languages/typescript';
import css from 'highlight.js/lib/languages/css';
import html from 'highlight.js/lib/languages/xml';
import json from 'highlight.js/lib/languages/json';
import bash from 'highlight.js/lib/languages/bash';
import sql from 'highlight.js/lib/languages/sql';
import yaml from 'highlight.js/lib/languages/yaml';
import rust from 'highlight.js/lib/languages/rust';
import go from 'highlight.js/lib/languages/go';
import java from 'highlight.js/lib/languages/java';
import markdown from 'highlight.js/lib/languages/markdown';
import diff from 'highlight.js/lib/languages/diff';
import 'highlight.js/styles/github-dark.min.css';

hljs.registerLanguage('javascript', javascript);
hljs.registerLanguage('js', javascript);
hljs.registerLanguage('python', python);
hljs.registerLanguage('py', python);
hljs.registerLanguage('typescript', typescript);
hljs.registerLanguage('ts', typescript);
hljs.registerLanguage('css', css);
hljs.registerLanguage('html', html);
hljs.registerLanguage('xml', html);
hljs.registerLanguage('json', json);
hljs.registerLanguage('bash', bash);
hljs.registerLanguage('sh', bash);
hljs.registerLanguage('shell', bash);
hljs.registerLanguage('sql', sql);
hljs.registerLanguage('yaml', yaml);
hljs.registerLanguage('yml', yaml);
hljs.registerLanguage('rust', rust);
hljs.registerLanguage('rs', rust);
hljs.registerLanguage('go', go);
hljs.registerLanguage('java', java);
hljs.registerLanguage('markdown', markdown);
hljs.registerLanguage('md', markdown);
hljs.registerLanguage('diff', diff);

const RoomTypeChatPlugin = (function() {
    let ctx = null;
    let renderMarkdown = null; // initialized in init()

    // Plugin-owned state
    let lastMessageId = 0;
    let oldestMessageId = null;   // tracks the oldest loaded message for scroll-back
    let isLoadingMessages = false;
    let hasOlderMessages = true;  // false once the server returns fewer than PAGE_SIZE
    const PAGE_SIZE = 50;
    const PLUGIN_ID = 'four43.room-type-chat';
    let PLUGIN_API = '';

    const USE_NOTIFICATION_TAG = false;
    const LONG_PRESS_DELAY_MS = 400;

    async function init(pluginCtx) {
        ctx = pluginCtx;
        PLUGIN_API = `${ctx.API_URL}/plugins/${PLUGIN_ID}`;

        console.log('[RoomTypeChat] Initializing...');

        // Set up markdown renderer with syntax highlighting
        const marked = new Marked({
            gfm: true,
            breaks: true,
            renderer: {
                link({ href, title, text }) {
                    const titleAttr = title ? ` title="${ctx.escapeHtml(title)}"` : '';
                    return `<a href="${ctx.escapeHtml(href)}"${titleAttr} target="_blank" rel="noopener noreferrer" class="message-link">${text}</a>`;
                },
            },
        });

        renderMarkdown = (text) => {
            const html = marked.parse(text);
            const temp = document.createElement('div');
            temp.innerHTML = html;
            temp.querySelectorAll('pre code').forEach((block) => {
                hljs.highlightElement(block);
            });
            return temp.innerHTML;
        };

        ctx.registerRoomTypeHandler({
            pluginId: PLUGIN_ID,
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
        oldestMessageId = null;
        hasOlderMessages = true;
        allUsersCache = null;
        delete roomMembersCache[roomId];

        const messagesDiv = document.getElementById('messages');
        messagesDiv.className = 'messages';
        messagesDiv.innerHTML = '';

        createInputArea();
        attachScrollListener(messagesDiv);

        // Keys are loaded by core (selectRoom) before room:join to prevent race conditions
        await loadMessages(roomId);
        await markRoomAsRead(roomId, lastMessageId);
        ctx.loadRooms();
    }

    function onRoomLeft(roomId) {
        lastMessageId = 0;
        oldestMessageId = null;
        hasOlderMessages = true;
        removeInputArea();
    }

    // -----------------------------------------------------------------------
    // Input area (owned by this plugin)
    // -----------------------------------------------------------------------

    // -----------------------------------------------------------------------
    // @ mention autocomplete state
    // -----------------------------------------------------------------------

    let mentionDropdown = null;
    let mentionQuery = '';       // text after the '@'
    let mentionStartIndex = -1;  // cursor position of the '@'
    let mentionSelectedIndex = 0;
    let mentionResults = [];
    let allUsersCache = null;    // cached /api/users response
    let roomMembersCache = {};   // room_id -> [username, ...]

    // -----------------------------------------------------------------------
    // / command autocomplete state
    // -----------------------------------------------------------------------

    let commandDropdown = null;
    let commandQuery = '';       // text after the '/'
    let commandSelectedIndex = 0;
    let commandResults = [];     // [{ name, description, args }]

    function createInputArea() {
        // Remove any existing input area first
        removeInputArea();

        const chatArea = document.querySelector('.room-content');
        if (!chatArea) return;

        const inputArea = document.createElement('div');
        inputArea.className = 'input-area';
        inputArea.id = 'chat-input-area';

        const inputWrapper = document.createElement('div');
        inputWrapper.className = 'input-wrapper';

        const input = document.createElement('textarea');
        input.id = 'message-input';
        input.className = 'message-input';
        input.placeholder = 'Type a message...';
        input.rows = 1;
        input.setAttribute('enterkeyhint', 'send');
        input.setAttribute('autocapitalize', 'sentences');
        input.setAttribute('autocorrect', 'on');

        const button = document.createElement('button');
        button.id = 'send-button';
        button.className = 'send-button';
        button.innerHTML = '<span class="send-label">Send</span><svg class="send-icon" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="19" x2="12" y2="5"/><polyline points="5 12 12 5 19 12"/></svg>';

        inputWrapper.appendChild(input);
        inputArea.appendChild(inputWrapper);
        inputArea.appendChild(button);
        chatArea.appendChild(inputArea);

        // Auto-resize textarea as content changes (1 row min, 7 rows max)
        function autoResize() {
            input.style.height = 'auto';
            const lineHeight = parseFloat(getComputedStyle(input).lineHeight) || 20;
            const maxHeight = lineHeight * 7;
            input.style.height = Math.min(input.scrollHeight, maxHeight) + 'px';
            input.style.overflowY = input.scrollHeight > maxHeight ? 'auto' : 'hidden';
        }
        input.addEventListener('input', autoResize);

        // Enter sends, Shift+Enter inserts newline
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey && !mentionDropdown && !commandDropdown) {
                e.preventDefault();
                window.sendMessage();
                // Reset height after send
                input.style.height = 'auto';
            }
        });
        button.addEventListener('click', () => {
            window.sendMessage();
            input.style.height = 'auto';
        });

        // @ mention autocomplete
        input.addEventListener('input', onAutocompleteInput);
        input.addEventListener('keydown', onAutocompleteKeydown);
        input.addEventListener('blur', () => {
            // Delay to allow click on dropdown item
            setTimeout(dismissMentionDropdown, 150);
            setTimeout(dismissCommandDropdown, 150);
        });

        input.focus();
    }

    function removeInputArea() {
        const existing = document.getElementById('chat-input-area');
        if (existing) existing.remove();
        dismissMentionDropdown();
    }

    // -----------------------------------------------------------------------
    // @ mention autocomplete
    // -----------------------------------------------------------------------

    async function fetchAllUsers() {
        if (allUsersCache) return allUsersCache;
        try {
            const response = await fetch(`${ctx.API_URL}/users`, {
                headers: { 'Authorization': `Bearer ${ctx.sessionToken()}` },
            });
            allUsersCache = await response.json();
        } catch (e) {
            console.error('[RoomTypeChat] Error fetching users:', e);
            allUsersCache = [];
        }
        return allUsersCache;
    }

    async function fetchRoomMembers(roomId) {
        if (roomMembersCache[roomId]) return roomMembersCache[roomId];
        try {
            const response = await fetch(`${ctx.API_URL}/rooms/${encodeURIComponent(roomId)}`, {
                headers: { 'Authorization': `Bearer ${ctx.sessionToken()}` },
            });
            const data = await response.json();
            roomMembersCache[roomId] = (data.members || []).map(m => m.username);
        } catch (e) {
            console.error('[RoomTypeChat] Error fetching room members:', e);
            roomMembersCache[roomId] = [];
        }
        return roomMembersCache[roomId];
    }

    function getMentionContext(input) {
        const value = input.value;
        const cursor = input.selectionStart;
        // Walk backwards from cursor to find '@'
        for (let i = cursor - 1; i >= 0; i--) {
            if (value[i] === '@') {
                // '@' must be at start or preceded by whitespace
                if (i === 0 || value[i - 1] === ' ' || value[i - 1] === '\n') {
                    return { start: i, query: value.substring(i + 1, cursor) };
                }
                return null;
            }
            // Stop if we hit whitespace (no '@' in this word)
            if (value[i] === ' ' || value[i] === '\n') return null;
        }
        return null;
    }

    async function onMentionInput() {
        const input = document.getElementById('message-input');
        if (!input) return;

        const mentionCtx = getMentionContext(input);
        if (!mentionCtx) {
            dismissMentionDropdown();
            return;
        }

        mentionStartIndex = mentionCtx.start;
        mentionQuery = mentionCtx.query.toLowerCase();

        // Get room members (prioritized) and all users
        const roomMembers = await fetchRoomMembers(ctx.currentRoom());

        const allUsers = await fetchAllUsers();
        const allUsernames = allUsers.map(u => u.username);

        // Build results: room members first, then others, filtered by query
        const inRoom = [];
        const notInRoom = [];
        for (const username of allUsernames) {
            const displayName = ctx.getDisplayName(username);
            const matchesQuery = !mentionQuery ||
                username.toLowerCase().includes(mentionQuery) ||
                displayName.toLowerCase().includes(mentionQuery);
            if (!matchesQuery) continue;

            if (roomMembers.includes(username)) {
                inRoom.push(username);
            } else {
                notInRoom.push(username);
            }
        }

        mentionResults = [...inRoom, ...notInRoom];
        if (mentionResults.length === 0) {
            dismissMentionDropdown();
            return;
        }

        mentionSelectedIndex = 0;
        renderMentionDropdown(input);
    }

    function onMentionKeydown(e) {
        if (!mentionDropdown) return;

        if (e.key === 'ArrowDown') {
            e.preventDefault();
            mentionSelectedIndex = (mentionSelectedIndex + 1) % mentionResults.length;
            updateMentionSelection();
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            mentionSelectedIndex = (mentionSelectedIndex - 1 + mentionResults.length) % mentionResults.length;
            updateMentionSelection();
        } else if (e.key === 'Enter' || e.key === 'Tab') {
            e.preventDefault();
            acceptMention(mentionResults[mentionSelectedIndex]);
        } else if (e.key === 'Escape') {
            e.preventDefault();
            dismissMentionDropdown();
        }
    }

    function renderMentionDropdown(input) {
        // Remove existing dropdown DOM without resetting state
        if (mentionDropdown) {
            mentionDropdown.remove();
            mentionDropdown = null;
        }

        const wrapper = input.closest('.input-wrapper');
        if (!wrapper) return;

        mentionDropdown = document.createElement('div');
        mentionDropdown.className = 'mention-dropdown';

        const roomMembers = roomMembersCache[ctx.currentRoom()] || [];

        mentionResults.forEach((username, i) => {
            const item = document.createElement('div');
            item.className = 'mention-item' + (i === mentionSelectedIndex ? ' selected' : '');
            item.dataset.index = i;

            const displayName = ctx.getDisplayName(username);
            const color = ctx.userColors()[username] || 'var(--theme-color)';
            const avatarUrl = `${ctx.API_URL}/users/${encodeURIComponent(username)}/avatar`;
            const inRoom = roomMembers.includes(username);

            item.innerHTML = `
                <img class="mention-avatar" src="${avatarUrl}" alt="">
                <span class="mention-name" style="color: ${color};">${ctx.escapeHtml(displayName)}</span>
                ${displayName !== username ? `<span class="mention-username">@${ctx.escapeHtml(username)}</span>` : ''}
                ${inRoom ? '' : '<span class="mention-badge">other</span>'}
            `;

            item.addEventListener('mousedown', (e) => {
                e.preventDefault(); // Prevent blur
                acceptMention(username);
            });

            mentionDropdown.appendChild(item);
        });

        wrapper.appendChild(mentionDropdown);
    }

    function updateMentionSelection() {
        if (!mentionDropdown) return;
        mentionDropdown.querySelectorAll('.mention-item').forEach((el, i) => {
            el.classList.toggle('selected', i === mentionSelectedIndex);
            if (i === mentionSelectedIndex) {
                el.scrollIntoView({ block: 'nearest' });
            }
        });
    }

    function acceptMention(username) {
        const input = document.getElementById('message-input');
        if (!input) return;

        const value = input.value;
        const before = value.substring(0, mentionStartIndex);
        const after = value.substring(input.selectionStart);
        input.value = before + '@' + username + ' ' + after;
        const newCursor = mentionStartIndex + username.length + 2; // @username + space
        input.setSelectionRange(newCursor, newCursor);
        input.focus();

        dismissMentionDropdown();
    }

    function dismissMentionDropdown() {
        if (mentionDropdown) {
            mentionDropdown.remove();
            mentionDropdown = null;
        }
        mentionResults = [];
        mentionStartIndex = -1;
        mentionQuery = '';
    }

    // -----------------------------------------------------------------------
    // / command autocomplete
    // -----------------------------------------------------------------------

    function getCommandContext(input) {
        const value = input.value;
        const cursor = input.selectionStart;
        // Only trigger when '/' is at position 0
        if (value.length === 0 || value[0] !== '/') return null;
        // Extract the command query (text after '/' up to first space or cursor)
        const spaceIndex = value.indexOf(' ');
        // If cursor is past the space, we're in args territory, not command
        if (spaceIndex !== -1 && cursor > spaceIndex) return null;
        const end = spaceIndex !== -1 ? Math.min(spaceIndex, cursor) : cursor;
        return { query: value.substring(1, end) };
    }

    function onCommandInput() {
        const input = document.getElementById('message-input');
        if (!input) return;

        const cmdCtx = getCommandContext(input);
        if (!cmdCtx) {
            dismissCommandDropdown();
            return;
        }

        commandQuery = cmdCtx.query.toLowerCase();

        const commands = ctx.slashCommands();
        commandResults = Object.entries(commands)
            .filter(([name]) => name.startsWith(commandQuery))
            .map(([name, cmd]) => ({ name, description: cmd.description, args: cmd.args || '' }));

        if (commandResults.length === 0) {
            dismissCommandDropdown();
            return;
        }

        commandSelectedIndex = 0;
        renderCommandDropdown(input);
    }

    function onCommandKeydown(e) {
        if (!commandDropdown) return;

        if (e.key === 'ArrowDown') {
            e.preventDefault();
            commandSelectedIndex = (commandSelectedIndex + 1) % commandResults.length;
            updateCommandSelection();
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            commandSelectedIndex = (commandSelectedIndex - 1 + commandResults.length) % commandResults.length;
            updateCommandSelection();
        } else if (e.key === 'Tab') {
            e.preventDefault();
            acceptCommand(commandResults[commandSelectedIndex].name);
        } else if (e.key === 'Enter') {
            e.preventDefault();
            const selected = commandResults[commandSelectedIndex];
            const input = document.getElementById('message-input');
            const currentCmd = input ? input.value.replace(/^\//, '').trim() : '';
            // If input already matches the selected command, submit directly
            if (currentCmd === selected.name) {
                dismissCommandDropdown();
                window.sendMessage();
            } else {
                acceptCommand(selected.name);
            }
        } else if (e.key === 'Escape') {
            e.preventDefault();
            dismissCommandDropdown();
        }
    }

    function renderCommandDropdown(input) {
        if (commandDropdown) {
            commandDropdown.remove();
            commandDropdown = null;
        }

        const wrapper = input.closest('.input-wrapper');
        if (!wrapper) return;

        commandDropdown = document.createElement('div');
        commandDropdown.className = 'command-dropdown';

        commandResults.forEach((cmd, i) => {
            const item = document.createElement('div');
            item.className = 'command-item' + (i === commandSelectedIndex ? ' selected' : '');
            item.dataset.index = i;

            const argsHtml = cmd.args
                ? `<span class="command-args">${ctx.escapeHtml(cmd.args)}</span>`
                : '';

            item.innerHTML = `
                <span class="command-name">${ctx.escapeHtml(cmd.name)}</span>
                ${argsHtml}
                <span class="command-description">${ctx.escapeHtml(cmd.description)}</span>
            `;

            item.addEventListener('mousedown', (e) => {
                e.preventDefault();
                acceptCommand(cmd.name);
            });

            commandDropdown.appendChild(item);
        });

        wrapper.appendChild(commandDropdown);
    }

    function updateCommandSelection() {
        if (!commandDropdown) return;
        commandDropdown.querySelectorAll('.command-item').forEach((el, i) => {
            el.classList.toggle('selected', i === commandSelectedIndex);
            if (i === commandSelectedIndex) {
                el.scrollIntoView({ block: 'nearest' });
            }
        });
    }

    function acceptCommand(name) {
        const input = document.getElementById('message-input');
        if (!input) return;

        input.value = '/' + name + ' ';
        const newCursor = name.length + 2; // '/' + name + ' '
        input.setSelectionRange(newCursor, newCursor);
        input.focus();

        dismissCommandDropdown();
    }

    function dismissCommandDropdown() {
        if (commandDropdown) {
            commandDropdown.remove();
            commandDropdown = null;
        }
        commandResults = [];
        commandQuery = '';
    }

    // -----------------------------------------------------------------------
    // Unified autocomplete dispatcher
    // -----------------------------------------------------------------------

    function onAutocompleteInput() {
        const input = document.getElementById('message-input');
        if (!input) return;

        // Check for command context first (/ at start of input)
        if (getCommandContext(input)) {
            dismissMentionDropdown();
            onCommandInput();
            return;
        }
        // Otherwise check for mention context
        dismissCommandDropdown();
        onMentionInput();
    }

    function onAutocompleteKeydown(e) {
        // Dispatch to whichever dropdown is active
        if (commandDropdown) {
            onCommandKeydown(e);
            return;
        }
        if (mentionDropdown) {
            onMentionKeydown(e);
            return;
        }
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

            case 'update':
                // Room list changed (e.g. sidebar badge refresh)
                ctx.loadRooms();
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

            // Encrypt — room keys must be available
            const roomKeys = ctx.roomKeys();
            let epochs = roomKeys[currentRoom];
            if (!epochs || Object.keys(epochs).length === 0) {
                // Keys may not have loaded yet; try once more
                await ctx.loadRoomKeys(currentRoom);
                epochs = ctx.roomKeys()[currentRoom];
            }
            if (!epochs || Object.keys(epochs).length === 0) {
                alert('Encryption keys not available. Please reload the page.');
                return;
            }
            const epochNums = Object.keys(epochs).map(Number);
            const latestEpoch = Math.max(...epochNums);
            content = await ctx.encryptMessage(epochs[latestEpoch], text, latestEpoch);
            contentType = 'encrypted';
            keyEpoch = latestEpoch;

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
        let epochs = roomKeys[currentRoom];
        if (!epochs || Object.keys(epochs).length === 0) {
            await ctx.loadRoomKeys(currentRoom);
            epochs = ctx.roomKeys()[currentRoom];
        }
        if (!epochs || Object.keys(epochs).length === 0) {
            throw new Error('Encryption keys not available');
        }
        const epochNums = Object.keys(epochs).map(Number);
        const latestEpoch = Math.max(...epochNums);
        const encrypted = await ctx.encryptMessage(epochs[latestEpoch], plaintext, latestEpoch);
        return { content: encrypted, contentType: 'encrypted', keyEpoch: latestEpoch };
    }

    async function decryptContent(msg) {
        let plaintext = msg.content;
        const contentType = msg.content_type || 'text';

        if (contentType === 'encrypted') {
            const epoch = msg.key_epoch !== undefined && msg.key_epoch !== null
                ? msg.key_epoch
                : ctx.getMessageEpoch(msg.content);
            const roomKeys = ctx.roomKeys();
            const currentRoomId = ctx.currentRoom();
            const epochs = roomKeys[currentRoomId];
            const key = epochs && epochs[epoch];
            if (key) {
                try {
                    plaintext = await ctx.decryptMessage(key, msg.content);
                } catch (e) {
                    console.warn('[E2E] Failed to decrypt message:', e);
                    plaintext = '[encrypted message \u2014 cannot decrypt]';
                }
            } else {
                console.warn('[E2E] No key for message decryption:',
                    'room:', currentRoomId,
                    'needed epoch:', epoch,
                    'available epochs:', epochs ? Object.keys(epochs) : 'none',
                    'rooms with keys:', Object.keys(roomKeys));
                plaintext = '[encrypted message \u2014 no key for this room]';
            }
        } else if (contentType === 'text' && ctx.isEncryptedMessage(msg.content)) {
            // Backward compatibility: old messages with ENC: prefix but content_type='text'
            const epoch = ctx.getMessageEpoch(msg.content);
            const roomKeys = ctx.roomKeys();
            const currentRoomId = ctx.currentRoom();
            const epochs = roomKeys[currentRoomId];
            const key = epochs && epochs[epoch];
            if (key) {
                try {
                    plaintext = await ctx.decryptMessage(key, msg.content);
                } catch (e) {
                    console.warn('[E2E] Failed to decrypt legacy message:', e);
                    plaintext = '[encrypted message \u2014 cannot decrypt]';
                }
            } else {
                console.warn('[E2E] No key for legacy message decryption:',
                    'room:', currentRoomId,
                    'needed epoch:', epoch,
                    'available epochs:', epochs ? Object.keys(epochs) : 'none');
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

    // URL regex — matches http(s) URLs in escaped HTML text.
    const URL_RE = /https?:\/\/[^\s<>&"]+/g;
    const IMAGE_EXTS = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp', '.ico'];

    /**
     * Wrap bare URLs in clickable <a> tags. Run AFTER escapeHtml + linkifyRoomRefs.
     */
    function linkifyUrls(html) {
        return html.replace(URL_RE, (url) => {
            // Don't double-wrap if already inside an href (from linkifyRoomRefs)
            return `<a href="${url}" target="_blank" rel="noopener noreferrer" class="message-link">${url}</a>`;
        });
    }

    /**
     * Extract raw URLs from plaintext.
     */
    function extractUrls(text) {
        return (text.match(URL_RE) || []);
    }

    /**
     * True if the URL points to an image based on file extension.
     */
    function isImageUrl(url) {
        try {
            const path = new URL(url).pathname.toLowerCase();
            return IMAGE_EXTS.some(ext => path.endsWith(ext));
        } catch {
            return false;
        }
    }

    // In-memory preview cache to avoid redundant API calls within a session.
    const _previewCache = new Map();

    /**
     * Fetch link preview from the backend (cached).
     */
    async function fetchLinkPreview(url) {
        if (_previewCache.has(url)) return _previewCache.get(url);

        try {
            const resp = await fetch(
                `${PLUGIN_API}/link-preview?url=${encodeURIComponent(url)}`,
                { headers: { 'Authorization': `Bearer ${ctx.sessionToken()}` } },
            );
            if (!resp.ok) return null;
            const data = await resp.json();
            _previewCache.set(url, data);
            return data;
        } catch {
            return null;
        }
    }

    /**
     * Build an image preview element for a direct image URL.
     */
    function buildImagePreview(url) {
        const wrapper = document.createElement('div');
        wrapper.className = 'link-preview-image';
        const img = document.createElement('img');
        img.src = url;
        img.alt = 'Image preview';
        img.loading = 'lazy';
        img.addEventListener('error', () => { wrapper.classList.add('link-preview-error'); });
        wrapper.appendChild(img);
        return wrapper;
    }

    /**
     * Build a preview card element for a web page.
     */
    function buildPreviewCard(preview) {
        if (!preview.title && !preview.description && !preview.image) return null;

        const card = document.createElement('a');
        card.className = 'link-preview-card';
        card.href = preview.url;
        card.target = '_blank';
        card.rel = 'noopener noreferrer';

        let html = '';
        if (preview.image) {
            html += `<img class="link-preview-card-image" src="${ctx.escapeHtml(preview.image)}" alt="" loading="lazy">`;
        }
        html += '<div class="link-preview-card-body">';
        if (preview.site_name) {
            html += `<div class="link-preview-card-site">${ctx.escapeHtml(preview.site_name)}</div>`;
        }
        if (preview.title) {
            html += `<div class="link-preview-card-title">${ctx.escapeHtml(preview.title)}</div>`;
        }
        if (preview.description) {
            html += `<div class="link-preview-card-desc">${ctx.escapeHtml(preview.description)}</div>`;
        }
        html += '</div>';
        card.innerHTML = html;
        return card;
    }

    /**
     * Find URLs in a message's plaintext, then append image previews or
     * OG preview cards below the message text.
     */
    async function renderLinkPreviews(messageDiv, plaintext) {
        const urls = extractUrls(plaintext);
        if (urls.length === 0) return;

        const previewContainer = document.createElement('div');
        previewContainer.className = 'link-previews';

        const messageText = messageDiv.querySelector('.message-text');
        if (!messageText) return;
        messageText.after(previewContainer);

        // Inner wrapper holds the actual preview content
        const previewContent = document.createElement('div');
        previewContent.className = 'link-previews-content';
        previewContainer.appendChild(previewContent);

        for (const url of urls.slice(0, 3)) {  // max 3 previews per message
            if (isImageUrl(url)) {
                previewContent.appendChild(buildImagePreview(url));
            } else {
                const preview = await fetchLinkPreview(url);
                if (preview && preview.content_type === 'image') {
                    previewContent.appendChild(buildImagePreview(preview.image || url));
                } else if (preview && preview.content_type === 'webpage') {
                    const card = buildPreviewCard(preview);
                    if (card) previewContent.appendChild(card);
                }
            }
        }

        // Remove the container if nothing rendered
        if (previewContent.children.length === 0) {
            previewContainer.remove();
            return;
        }

        // Add toggle button
        const toggleBtn = document.createElement('button');
        toggleBtn.className = 'link-preview-toggle';
        toggleBtn.title = 'Hide preview';
        toggleBtn.textContent = '▾ Hide preview';
        toggleBtn.addEventListener('click', () => {
            const hidden = previewContent.classList.toggle('link-previews-hidden');
            toggleBtn.textContent = hidden ? '▸ Show preview' : '▾ Hide preview';
            toggleBtn.title = hidden ? 'Show preview' : 'Hide preview';
        });
        previewContainer.insertBefore(toggleBtn, previewContent);
    }

    /**
     * Build a DOM element for a message (shared by append and prepend paths).
     */
    async function buildMessageElement(msg) {
        const messageDiv = document.createElement('div');
        messageDiv.className = 'message';
        messageDiv.dataset.messageId = msg.id;
        messageDiv.dataset.username = msg.username;

        const date = new Date(msg.timestamp);
        const timeStr = date.toLocaleTimeString();

        const userColors = ctx.userColors();
        const userColor = userColors[msg.username] || '#1976d2';
        const displayName = ctx.getDisplayName(msg.username);
        const avatarUrl = `${ctx.API_URL}/users/${encodeURIComponent(msg.username)}/avatar`;

        if (msg.deleted) {
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
            const messageBody = linkifyRoomRefs(renderMarkdown(plaintext));

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

            createHoverBar(messageDiv, msg);

            // Render link previews asynchronously (don't block message display)
            renderLinkPreviews(messageDiv, plaintext);
        }

        // Make username clickable to open profile
        const usernameEl = messageDiv.querySelector('.username');
        if (usernameEl) {
            usernameEl.style.cursor = 'pointer';
            usernameEl.addEventListener('click', (e) => {
                e.stopPropagation();
                if (window.openUserProfile) window.openUserProfile(msg.username);
            });
        }

        return messageDiv;
    }

    /**
     * Append a message to the bottom (new / real-time messages). Scrolls down.
     */
    async function displayMessage(msg) {
        const messagesDiv = document.getElementById('messages');

        if (messagesDiv.querySelector('.empty-state')) {
            messagesDiv.innerHTML = '';
        }

        const messageDiv = await buildMessageElement(msg);
        messagesDiv.appendChild(messageDiv);

        if (msg.id > lastMessageId) {
            lastMessageId = msg.id;
        }

        messagesDiv.scrollTop = messagesDiv.scrollHeight;
    }

    /**
     * Insert a message before a reference node (for prepending older messages).
     * Does NOT scroll — the caller handles scroll preservation.
     */
    async function displayMessageElement(msg, beforeNode) {
        const messagesDiv = document.getElementById('messages');
        const messageDiv = await buildMessageElement(msg);
        messagesDiv.insertBefore(messageDiv, beforeNode);

        if (msg.id > lastMessageId) {
            lastMessageId = msg.id;
        }
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
            editBtn.innerHTML = '<iconify-icon icon="lucide:pencil"></iconify-icon>';
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
            moreBtn.innerHTML = '<iconify-icon icon="lucide:more-horizontal"></iconify-icon>';
            moreBtn.title = 'More';
            moreBtn.onclick = (e) => {
                e.stopPropagation();
                toggleMoreMenu(moreBtn, messageDiv);
            };
            hoverBar.appendChild(moreBtn);
        }

        messageDiv.appendChild(hoverBar);

        // Mobile: long press to show hover bar (avoids accidental triggers)
        let pressTimer = null;
        let touchMoved = false;
        let isTouchInteraction = false;

        messageDiv.addEventListener('touchstart', (e) => {
            if (e.target.closest('.message-hover-bar') ||
                e.target.closest('.message-more-menu') ||
                e.target.closest('.four43-reaction-btn') ||
                e.target.closest('.message-edit-input')) {
                return;
            }
            touchMoved = false;
            isTouchInteraction = true;
            pressTimer = setTimeout(() => {
                if (!touchMoved) {
                    document.querySelectorAll('.message-hover-bar.active').forEach(bar => {
                        if (bar !== hoverBar) bar.classList.remove('active');
                    });
                    dismissMoreMenu();
                    hoverBar.classList.add('active');
                }
            }, LONG_PRESS_DELAY_MS);
        }, { passive: true });

        messageDiv.addEventListener('touchmove', () => {
            touchMoved = true;
            clearTimeout(pressTimer);
        }, { passive: true });

        messageDiv.addEventListener('touchend', () => {
            clearTimeout(pressTimer);
            // Keep flag set briefly to suppress the synthetic click
            setTimeout(() => { isTouchInteraction = false; }, 300);
        }, { passive: true });

        // Desktop: click to show hover bar (suppressed on touch devices)
        messageDiv.addEventListener('click', (e) => {
            if (isTouchInteraction) return;
            if (e.target.closest('.message-hover-bar') ||
                e.target.closest('.message-more-menu') ||
                e.target.closest('.four43-reaction-btn') ||
                e.target.closest('.message-edit-input')) {
                return;
            }
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

        const input = document.createElement('textarea');
        input.className = 'message-edit-input';
        input.value = originalPlaintext;
        input.rows = 1;

        // Replace message text with input
        textEl.innerHTML = '';
        textEl.appendChild(input);

        // Auto-resize to fit content (1 row min, 7 rows max)
        function autoResizeEdit() {
            input.style.height = 'auto';
            const lineHeight = parseFloat(getComputedStyle(input).lineHeight) || 20;
            const maxHeight = lineHeight * 7;
            input.style.height = Math.min(input.scrollHeight, maxHeight) + 'px';
            input.style.overflowY = input.scrollHeight > maxHeight ? 'auto' : 'hidden';
        }
        input.addEventListener('input', autoResizeEdit);
        autoResizeEdit();

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
            if (e.key === 'Enter' && !e.shiftKey) {
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
            textEl.innerHTML = linkifyRoomRefs(renderMarkdown(newText));

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
            textEl.innerHTML = linkifyRoomRefs(renderMarkdown(originalPlaintext));
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
            textEl.innerHTML = linkifyRoomRefs(renderMarkdown(plaintext));
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
    // Message loading (paginated)
    // -----------------------------------------------------------------------

    /**
     * Load the initial page of messages (most recent PAGE_SIZE).
     */
    async function loadMessages(roomId) {
        if (!roomId || isLoadingMessages) return;

        isLoadingMessages = true;

        try {
            console.log(`[RoomTypeChat] Loading recent messages (limit=${PAGE_SIZE})`);
            const url = `${PLUGIN_API}/rooms/${encodeURIComponent(roomId)}/messages?limit=${PAGE_SIZE}`;
            const response = await fetch(url, {
                headers: { 'Authorization': `Bearer ${ctx.sessionToken()}` },
            });
            const data = await response.json();

            if (data && data.length > 0) {
                console.log(`[RoomTypeChat] Loaded ${data.length} messages from history`);
                for (const msg of data) {
                    await displayMessage(msg);
                }
                oldestMessageId = data[0].id;
                hasOlderMessages = data.length >= PAGE_SIZE;
            } else {
                console.log('[RoomTypeChat] No message history');
                hasOlderMessages = false;
            }
        } catch (error) {
            console.error('[RoomTypeChat] Error loading messages:', error);
        } finally {
            isLoadingMessages = false;
        }
    }

    /**
     * Load an older page of messages (before the oldest currently displayed).
     */
    async function loadOlderMessages(roomId) {
        if (!roomId || isLoadingMessages || !hasOlderMessages || oldestMessageId === null) return;

        isLoadingMessages = true;
        const messagesDiv = document.getElementById('messages');

        try {
            console.log(`[RoomTypeChat] Loading older messages before=${oldestMessageId}`);
            const url = `${PLUGIN_API}/rooms/${encodeURIComponent(roomId)}/messages?before=${oldestMessageId}&limit=${PAGE_SIZE}`;
            const response = await fetch(url, {
                headers: { 'Authorization': `Bearer ${ctx.sessionToken()}` },
            });
            const data = await response.json();

            if (data && data.length > 0) {
                // Preserve scroll position: record distance from bottom before prepending
                const scrollBottomBefore = messagesDiv.scrollHeight - messagesDiv.scrollTop;

                // Build message elements in order (oldest first) and prepend as a batch
                const firstChild = messagesDiv.firstChild;
                for (const msg of data) {
                    await displayMessageElement(msg, firstChild);
                }

                // Restore scroll position so the viewport doesn't jump
                messagesDiv.scrollTop = messagesDiv.scrollHeight - scrollBottomBefore;

                oldestMessageId = data[0].id;
                hasOlderMessages = data.length >= PAGE_SIZE;
                console.log(`[RoomTypeChat] Prepended ${data.length} older messages`);
            } else {
                hasOlderMessages = false;
                console.log('[RoomTypeChat] No older messages');
            }
        } catch (error) {
            console.error('[RoomTypeChat] Error loading older messages:', error);
        } finally {
            isLoadingMessages = false;
        }
    }

    /**
     * Attach a scroll listener that loads older messages when the user
     * scrolls near the top of the message area.
     */
    function attachScrollListener(messagesDiv) {
        // Remove previous listener if any (room switches)
        messagesDiv.removeEventListener('scroll', onMessagesScroll);
        messagesDiv.addEventListener('scroll', onMessagesScroll);
    }

    function onMessagesScroll() {
        const messagesDiv = document.getElementById('messages');
        if (!messagesDiv) return;

        // Trigger when within 100px of the top
        if (messagesDiv.scrollTop < 100 && hasOlderMessages && !isLoadingMessages) {
            loadOlderMessages(ctx.currentRoom());
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

// ID "four43.room-type-chat" -> "Four43.room-type-chatPlugin"
window["Four43.room-type-chatPlugin"] = RoomTypeChatPlugin;

// Export for module loading
if (typeof module !== 'undefined' && module.exports) {
    module.exports = RoomTypeChatPlugin;
}

// Export for plugin loader
// ID "four43.room-type-chat" -> "Four43.room-type-chatPlugin"
window["Four43.room-type-chatPlugin"] = RoomTypeChatPlugin;
