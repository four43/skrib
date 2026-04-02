/**
 * Emoji Picker Plugin
 *
 * Provides a reusable emoji picker with search, categories, and custom emoji support.
 * Exposes window.SkribEmojiPicker for other plugins and core UI.
 */

const EmojiPickerPlugin = (function() {
    let context = null;
    const PLUGIN_ID = 'four43.emoji-picker';
    const API_BASE = `/api/plugins/${PLUGIN_ID}`;
    const RECENTS_KEY = 'skrib-emoji-recents';
    const MAX_RECENTS = 32;

    // Category metadata: id, icon, label
    const CATEGORIES = [
        { id: 'recents',    icon: '🕐', label: 'Recents' },
        { id: 'smileys',    icon: '😀', label: 'Smileys' },
        { id: 'people',     icon: '👋', label: 'People' },
        { id: 'animals',    icon: '🐻', label: 'Animals' },
        { id: 'food',       icon: '🍔', label: 'Food' },
        { id: 'travel',     icon: '✈️', label: 'Travel' },
        { id: 'activities', icon: '⚽', label: 'Activities' },
        { id: 'objects',    icon: '💡', label: 'Objects' },
        { id: 'symbols',    icon: '❤️', label: 'Symbols' },
        { id: 'flags',      icon: '🏳️', label: 'Flags' },
        { id: 'custom',     icon: '⭐', label: 'Custom' },
    ];

    // State
    let emojiData = null;       // Unicode emoji from JSON
    let customEmoji = null;     // Custom emoji from API
    let pickerEl = null;        // Current picker DOM element
    let currentResolve = null;  // Promise resolve for open()
    let currentOnSelect = null; // Streaming callback
    let isAdmin = false;

    // ── Data Loading ──────────────────────────────────────────────────

    async function loadEmojiData() {
        if (emojiData) return;
        try {
            const resp = await fetch(`${API_BASE}/file/frontend/data/emoji.json`);
            emojiData = await resp.json();
        } catch (e) {
            console.error('[EmojiPicker] Failed to load emoji data:', e);
            emojiData = [];
        }
    }

    async function loadCustomEmoji() {
        try {
            const token = context ? context.sessionToken() : localStorage.getItem('session_token');
            const resp = await fetch(`${API_BASE}/custom-emoji`, {
                headers: token ? { 'Authorization': `Bearer ${token}` } : {},
            });
            if (resp.ok) {
                customEmoji = await resp.json();
            } else {
                customEmoji = [];
            }
        } catch {
            customEmoji = [];
        }
    }

    function getRecents() {
        try {
            return JSON.parse(localStorage.getItem(RECENTS_KEY) || '[]');
        } catch { return []; }
    }

    function addRecent(emoji) {
        const recents = getRecents().filter(r =>
            r.emoji !== emoji.emoji || r.shortcode !== emoji.shortcode
        );
        recents.unshift(emoji);
        if (recents.length > MAX_RECENTS) recents.length = MAX_RECENTS;
        localStorage.setItem(RECENTS_KEY, JSON.stringify(recents));
    }

    // ── Search ────────────────────────────────────────────────────────

    function searchEmoji(query) {
        if (!query) return null; // null means "show categories"
        const q = query.toLowerCase().replace(/[^a-z0-9-]/g, '');
        if (!q) return null;

        const results = [];

        // Search Unicode emoji
        if (emojiData) {
            for (const e of emojiData) {
                if (e.name.includes(q) || e.keywords.some(k => k.includes(q))) {
                    results.push({ emoji: e.emoji, name: e.name, shortcode: e.name, isCustom: false });
                }
            }
        }

        // Search custom emoji
        if (customEmoji) {
            for (const e of customEmoji) {
                if (e.shortcode.includes(q) || e.display_name.toLowerCase().includes(q)) {
                    results.push({
                        emoji: null, name: e.display_name, shortcode: e.shortcode,
                        isCustom: true, url: e.url,
                    });
                }
            }
        }

        return results;
    }

    // ── Picker DOM ────────────────────────────────────────────────────

    function createPicker() {
        const el = document.createElement('div');
        el.className = 'emoji-picker';
        el.setAttribute('data-emoji-picker', '');

        el.innerHTML = `
            <div class="emoji-picker-search">
                <input type="text" placeholder="Search emoji..." autocomplete="off" />
            </div>
            <div class="emoji-picker-categories"></div>
            <div class="emoji-picker-grid"></div>
        `;

        // Build category tabs
        const catBar = el.querySelector('.emoji-picker-categories');
        for (const cat of CATEGORIES) {
            // Hide custom tab if no custom emoji
            if (cat.id === 'custom' && (!customEmoji || customEmoji.length === 0)) continue;
            // Hide recents tab if no recents
            if (cat.id === 'recents' && getRecents().length === 0) continue;

            const btn = document.createElement('button');
            btn.className = 'emoji-picker-cat-btn';
            btn.setAttribute('data-category', cat.id);
            btn.title = cat.label;
            btn.textContent = cat.icon;
            btn.addEventListener('click', () => selectCategory(el, cat.id));
            catBar.appendChild(btn);
        }

        // Search handler
        let searchTimer = null;
        const searchInput = el.querySelector('input');
        searchInput.addEventListener('input', () => {
            clearTimeout(searchTimer);
            searchTimer = setTimeout(() => {
                const q = searchInput.value.trim();
                if (q) {
                    renderSearchResults(el, q);
                } else {
                    // Restore category view
                    const active = el.querySelector('.emoji-picker-cat-btn.active');
                    const catId = active ? active.dataset.category : 'smileys';
                    selectCategory(el, catId);
                }
            }, 100);
        });

        // Click handler for emoji buttons (delegated)
        el.querySelector('.emoji-picker-grid').addEventListener('click', (e) => {
            const btn = e.target.closest('.emoji-picker-emoji-btn');
            if (!btn) return;

            const selected = {
                emoji: btn.dataset.emoji || null,
                shortcode: btn.dataset.shortcode || null,
                isCustom: btn.dataset.custom === 'true',
                url: btn.dataset.url || null,
            };

            // Add to recents
            addRecent(selected);

            if (currentOnSelect) {
                currentOnSelect(selected);
            } else {
                closePicker(selected);
            }
        });

        return el;
    }

    function selectCategory(el, categoryId) {
        // Update active tab
        el.querySelectorAll('.emoji-picker-cat-btn').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.category === categoryId);
        });

        const grid = el.querySelector('.emoji-picker-grid');
        grid.innerHTML = '';

        if (categoryId === 'recents') {
            renderRecents(grid);
        } else if (categoryId === 'custom') {
            renderCustom(grid);
        } else {
            renderCategory(grid, categoryId);
        }

        grid.scrollTop = 0;
    }

    function renderCategory(grid, categoryId) {
        if (!emojiData) return;

        const items = emojiData.filter(e => e.category === categoryId);
        if (items.length === 0) {
            grid.innerHTML = '<div class="emoji-picker-empty">No emoji in this category</div>';
            return;
        }

        const row = document.createElement('div');
        row.className = 'emoji-picker-emoji-row';
        for (const e of items) {
            row.appendChild(createEmojiButton(e.emoji, e.name, false));
        }
        grid.appendChild(row);
    }

    function renderRecents(grid) {
        const recents = getRecents();
        if (recents.length === 0) {
            grid.innerHTML = '<div class="emoji-picker-empty">No recent emoji</div>';
            return;
        }

        const row = document.createElement('div');
        row.className = 'emoji-picker-emoji-row';
        for (const r of recents) {
            if (r.isCustom) {
                row.appendChild(createCustomEmojiButton(r.shortcode, r.url));
            } else {
                row.appendChild(createEmojiButton(r.emoji, r.shortcode || '', false));
            }
        }
        grid.appendChild(row);
    }

    function renderCustom(grid) {
        if (!customEmoji || customEmoji.length === 0) {
            grid.innerHTML = '<div class="emoji-picker-empty">No custom emoji</div>';
            return;
        }

        const row = document.createElement('div');
        row.className = 'emoji-picker-emoji-row';
        for (const e of customEmoji) {
            row.appendChild(createCustomEmojiButton(e.shortcode, e.url));
        }
        grid.appendChild(row);
    }

    function renderSearchResults(el, query) {
        // Clear active category
        el.querySelectorAll('.emoji-picker-cat-btn').forEach(btn => btn.classList.remove('active'));

        const grid = el.querySelector('.emoji-picker-grid');
        const results = searchEmoji(query);

        if (!results || results.length === 0) {
            grid.innerHTML = '<div class="emoji-picker-empty">No emoji found</div>';
            return;
        }

        grid.innerHTML = '';
        const row = document.createElement('div');
        row.className = 'emoji-picker-emoji-row';
        for (const r of results.slice(0, 100)) {
            if (r.isCustom) {
                row.appendChild(createCustomEmojiButton(r.shortcode, r.url));
            } else {
                row.appendChild(createEmojiButton(r.emoji, r.name, false));
            }
        }
        grid.appendChild(row);
    }

    function createEmojiButton(emoji, name, isCustom) {
        const btn = document.createElement('button');
        btn.className = 'emoji-picker-emoji-btn';
        btn.textContent = emoji;
        btn.title = name;
        btn.dataset.emoji = emoji;
        btn.dataset.shortcode = name;
        btn.dataset.custom = 'false';
        return btn;
    }

    function createCustomEmojiButton(shortcode, url) {
        const btn = document.createElement('button');
        btn.className = 'emoji-picker-emoji-btn';
        btn.title = `:${shortcode}:`;
        btn.dataset.shortcode = shortcode;
        btn.dataset.custom = 'true';
        btn.dataset.url = url;

        const img = document.createElement('img');
        img.src = url;
        img.alt = shortcode;
        img.loading = 'lazy';
        btn.appendChild(img);

        return btn;
    }

    // ── Positioning ───────────────────────────────────────────────────

    function positionPicker(el, anchor) {
        const rect = anchor.getBoundingClientRect();
        const pickerHeight = 420;
        const pickerWidth = 352;
        const gap = 8;

        let top, left;

        // Vertical: prefer above, flip below if no space
        if (rect.top > pickerHeight + gap) {
            top = rect.top - pickerHeight - gap;
        } else {
            top = rect.bottom + gap;
        }

        // Horizontal: align left with anchor, clamp to viewport
        left = rect.left;
        if (left + pickerWidth > window.innerWidth - 8) {
            left = window.innerWidth - pickerWidth - 8;
        }
        if (left < 8) left = 8;

        el.style.top = `${top}px`;
        el.style.left = `${left}px`;
    }

    // ── Open/Close ────────────────────────────────────────────────────

    function closePicker(result) {
        if (pickerEl) {
            pickerEl.remove();
            pickerEl = null;
        }
        document.removeEventListener('mousedown', onOutsideClick);
        document.removeEventListener('keydown', onEscapeKey);

        if (currentResolve) {
            currentResolve(result || null);
            currentResolve = null;
        }
        currentOnSelect = null;
    }

    function onOutsideClick(e) {
        if (pickerEl && !pickerEl.contains(e.target)) {
            closePicker(null);
        }
    }

    function onEscapeKey(e) {
        if (e.key === 'Escape') {
            e.stopPropagation();
            closePicker(null);
        }
    }

    // ── Admin Manage UI ───────────────────────────────────────────────

    function addAdminBar(el) {
        if (!isAdmin) return;

        const bar = document.createElement('div');
        bar.className = 'emoji-picker-admin-bar';

        const btn = document.createElement('button');
        btn.className = 'emoji-picker-manage-btn';
        btn.textContent = 'Manage Custom Emoji';
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            openManagePanel();
        });

        bar.appendChild(btn);
        el.appendChild(bar);
    }

    function openManagePanel() {
        // Close picker
        closePicker(null);

        const overlay = document.createElement('div');
        overlay.className = 'emoji-manage-overlay';

        overlay.innerHTML = `
            <div class="emoji-manage-panel">
                <div class="emoji-manage-header">
                    <h3>Manage Custom Emoji</h3>
                    <button class="emoji-manage-close">&times;</button>
                </div>
                <div class="emoji-manage-body">
                    <form class="emoji-upload-form">
                        <label>Shortcode</label>
                        <input type="text" name="shortcode" placeholder="my-emoji" required pattern="[a-z0-9-]+" />
                        <label>Display Name</label>
                        <input type="text" name="display_name" placeholder="My Emoji" required />
                        <label>Image (PNG or GIF, max 256KB)</label>
                        <input type="file" name="file" accept="image/png,image/gif" required />
                        <div class="emoji-upload-error" style="display:none"></div>
                        <button type="submit" class="emoji-upload-submit">Upload</button>
                    </form>
                    <div class="emoji-manage-list"></div>
                </div>
            </div>
        `;

        // Close handlers
        overlay.querySelector('.emoji-manage-close').addEventListener('click', () => overlay.remove());
        overlay.addEventListener('mousedown', (e) => {
            if (e.target === overlay) overlay.remove();
        });

        // Upload handler
        const form = overlay.querySelector('.emoji-upload-form');
        const errEl = overlay.querySelector('.emoji-upload-error');
        form.addEventListener('submit', async (e) => {
            e.preventDefault();
            errEl.style.display = 'none';

            const token = context ? context.sessionToken() : localStorage.getItem('session_token');
            const formData = new FormData(form);

            const submitBtn = form.querySelector('.emoji-upload-submit');
            submitBtn.disabled = true;
            submitBtn.textContent = 'Uploading...';

            try {
                const resp = await fetch(`${API_BASE}/custom-emoji`, {
                    method: 'POST',
                    headers: { 'Authorization': `Bearer ${token}` },
                    body: formData,
                });

                if (resp.ok) {
                    form.reset();
                    await loadCustomEmoji();
                    invalidateCustomMap();
                    renderManageList(overlay.querySelector('.emoji-manage-list'));
                } else {
                    const data = await resp.json().catch(() => ({}));
                    errEl.textContent = data.detail || 'Upload failed';
                    errEl.style.display = 'block';
                }
            } catch (err) {
                errEl.textContent = 'Upload failed';
                errEl.style.display = 'block';
            }

            submitBtn.disabled = false;
            submitBtn.textContent = 'Upload';
        });

        // Render existing emoji
        renderManageList(overlay.querySelector('.emoji-manage-list'));

        document.body.appendChild(overlay);
    }

    function renderManageList(listEl) {
        listEl.innerHTML = '';

        if (!customEmoji || customEmoji.length === 0) {
            listEl.innerHTML = '<div class="emoji-manage-empty">No custom emoji yet</div>';
            return;
        }

        for (const e of customEmoji) {
            const item = document.createElement('div');
            item.className = 'emoji-manage-item';
            item.innerHTML = `
                <img src="${e.url}" alt="${e.shortcode}" />
                <div class="emoji-manage-item-info">
                    <div class="emoji-manage-item-name">${e.display_name}</div>
                    <div class="emoji-manage-item-code">:${e.shortcode}:</div>
                </div>
            `;

            const delBtn = document.createElement('button');
            delBtn.className = 'emoji-manage-delete';
            delBtn.innerHTML = '&times;';
            delBtn.title = 'Delete';
            delBtn.addEventListener('click', async () => {
                if (!confirm(`Delete :${e.shortcode}:?`)) return;
                const token = context ? context.sessionToken() : localStorage.getItem('session_token');
                await fetch(`${API_BASE}/custom-emoji/${e.shortcode}`, {
                    method: 'DELETE',
                    headers: { 'Authorization': `Bearer ${token}` },
                });
                await loadCustomEmoji();
                invalidateCustomMap();
                renderManageList(listEl);
            });

            item.appendChild(delBtn);
            listEl.appendChild(item);
        }
    }

    // ── Inline Autocomplete ──────────────────────────────────────────

    let emojiDropdown = null;
    let emojiQuery = '';
    let emojiStartIndex = -1;   // cursor position of the ':'
    let emojiSelectedIndex = 0;
    let emojiResults = [];
    let emojiInputEl = null;
    let observerActive = false;

    const MAX_INLINE_RESULTS = 5;
    const MIN_QUERY_LENGTH = 2;

    /**
     * Detect an emoji `:query` context at the cursor position.
     * Returns { query, start } or null.
     */
    function getEmojiContext(input) {
        const value = input.value;
        const cursor = input.selectionStart;

        // Walk backwards from cursor to find an unmatched ':'
        let i = cursor - 1;
        while (i >= 0) {
            const ch = value[i];
            if (ch === ':') {
                // ':' must be at position 0 or preceded by whitespace
                if (i === 0 || /\s/.test(value[i - 1])) {
                    const query = value.substring(i + 1, cursor);
                    // Query must be only valid shortcode chars (no spaces)
                    if (/^[a-z0-9-]*$/i.test(query)) {
                        return { query: query.toLowerCase(), start: i };
                    }
                }
                return null;
            }
            // Stop if we hit whitespace (no ':' found in this word)
            if (/\s/.test(ch)) return null;
            i--;
        }
        return null;
    }

    function onEmojiInput() {
        if (!emojiInputEl) return;

        const emojiCtx = getEmojiContext(emojiInputEl);
        if (!emojiCtx || emojiCtx.query.length < MIN_QUERY_LENGTH) {
            dismissEmojiDropdown();
            return;
        }

        emojiQuery = emojiCtx.query;
        emojiStartIndex = emojiCtx.start;

        const results = searchEmoji(emojiQuery);
        if (!results || results.length === 0) {
            dismissEmojiDropdown();
            return;
        }

        emojiResults = results.slice(0, MAX_INLINE_RESULTS);
        emojiSelectedIndex = 0;
        renderEmojiDropdown();
    }

    function onEmojiKeydown(e) {
        if (!emojiDropdown) return;

        if (e.key === 'ArrowDown') {
            e.preventDefault();
            e.stopPropagation();
            emojiSelectedIndex = (emojiSelectedIndex - 1 + emojiResults.length) % emojiResults.length;
            updateEmojiSelection();
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            e.stopPropagation();
            emojiSelectedIndex = (emojiSelectedIndex + 1) % emojiResults.length;
            updateEmojiSelection();
        } else if (e.key === 'Enter' || e.key === 'Tab') {
            e.preventDefault();
            e.stopPropagation();
            acceptEmoji(emojiResults[emojiSelectedIndex]);
        } else if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            dismissEmojiDropdown();
        }
    }

    function renderEmojiDropdown() {
        if (emojiDropdown) {
            emojiDropdown.remove();
            emojiDropdown = null;
        }

        const wrapper = emojiInputEl.closest('.input-wrapper');
        if (!wrapper) return;

        emojiDropdown = document.createElement('div');
        emojiDropdown.className = 'emoji-inline-dropdown';

        // Render in reverse order: best match (index 0) at the bottom,
        // closest to the input field where the user is typing.
        for (let i = emojiResults.length - 1; i >= 0; i--) {
            const result = emojiResults[i];
            const item = document.createElement('div');
            item.className = 'emoji-inline-item' + (i === emojiSelectedIndex ? ' selected' : '');
            item.dataset.index = i;

            const preview = document.createElement('span');
            preview.className = 'emoji-inline-preview';
            if (result.isCustom && result.url) {
                const img = document.createElement('img');
                img.src = result.url;
                img.alt = result.shortcode;
                preview.appendChild(img);
            } else {
                preview.textContent = result.emoji;
            }

            const shortcode = document.createElement('span');
            shortcode.className = 'emoji-inline-shortcode';
            shortcode.textContent = `:${result.shortcode || result.name}:`;

            item.appendChild(preview);
            item.appendChild(shortcode);

            item.addEventListener('mousedown', (e) => {
                e.preventDefault();
                acceptEmoji(result);
            });

            emojiDropdown.appendChild(item);
        }

        wrapper.appendChild(emojiDropdown);
    }

    function updateEmojiSelection() {
        if (!emojiDropdown) return;
        emojiDropdown.querySelectorAll('.emoji-inline-item').forEach((el) => {
            const idx = parseInt(el.dataset.index, 10);
            el.classList.toggle('selected', idx === emojiSelectedIndex);
        });
    }

    function acceptEmoji(result) {
        if (!emojiInputEl) return;

        const shortcode = result.shortcode || result.name;
        const replacement = `:${shortcode}: `;
        const before = emojiInputEl.value.substring(0, emojiStartIndex);
        const after = emojiInputEl.value.substring(emojiInputEl.selectionStart);

        emojiInputEl.value = before + replacement + after;
        const newCursor = before.length + replacement.length;
        emojiInputEl.setSelectionRange(newCursor, newCursor);
        emojiInputEl.focus();

        // Add to recents
        addRecent({
            emoji: result.emoji || null,
            shortcode: shortcode,
            isCustom: result.isCustom || false,
            url: result.url || null,
        });

        dismissEmojiDropdown();

        // Trigger input event so textarea auto-resizes
        emojiInputEl.dispatchEvent(new Event('input', { bubbles: true }));
    }

    function dismissEmojiDropdown() {
        if (emojiDropdown) {
            emojiDropdown.remove();
            emojiDropdown = null;
        }
        emojiResults = [];
        emojiQuery = '';
        emojiStartIndex = -1;
    }

    /**
     * Attach inline autocomplete listeners to #message-input.
     * Uses capture phase for keydown so we intercept before the chat plugin.
     */
    function attachInlineAutocomplete(input) {
        if (emojiInputEl === input) return; // already attached
        detachInlineAutocomplete();

        emojiInputEl = input;
        input.addEventListener('input', onEmojiInput);
        // Capture phase: fires before the chat plugin's bubble-phase keydown
        input.addEventListener('keydown', onEmojiKeydown, true);
        input.addEventListener('blur', () => {
            setTimeout(dismissEmojiDropdown, 150);
        });
    }

    function detachInlineAutocomplete() {
        if (emojiInputEl) {
            emojiInputEl.removeEventListener('input', onEmojiInput);
            emojiInputEl.removeEventListener('keydown', onEmojiKeydown, true);
            emojiInputEl = null;
        }
        dismissEmojiDropdown();
    }

    /**
     * Watch for #message-input appearing/disappearing in the DOM.
     */
    function observeMessageInput() {
        if (observerActive) return;
        observerActive = true;

        // Check if already present
        const existing = document.getElementById('message-input');
        if (existing) attachInlineAutocomplete(existing);

        const observer = new MutationObserver(() => {
            const input = document.getElementById('message-input');
            if (input && input !== emojiInputEl) {
                attachInlineAutocomplete(input);
            } else if (!input && emojiInputEl) {
                detachInlineAutocomplete();
            }
        });

        observer.observe(document.body, { childList: true, subtree: true });
    }

    // ── Public API ────────────────────────────────────────────────────

    /**
     * Open the emoji picker near an anchor element.
     *
     * @param {Object} options
     * @param {HTMLElement} options.anchor - Element to position near
     * @param {Function} [options.onSelect] - Called on each selection (picker stays open)
     * @returns {Promise<{emoji, shortcode, isCustom, url}|null>}
     */
    async function open({ anchor, onSelect } = {}) {
        // Close any existing picker
        if (pickerEl) closePicker(null);

        // Load data on first use
        await Promise.all([loadEmojiData(), loadCustomEmoji()]);

        return new Promise((resolve) => {
            currentResolve = resolve;
            currentOnSelect = onSelect || null;

            pickerEl = createPicker();

            // Add admin bar if admin
            addAdminBar(pickerEl);

            document.body.appendChild(pickerEl);

            // Position near anchor
            if (anchor) {
                positionPicker(pickerEl, anchor);
            }

            // Select first available category
            const recents = getRecents();
            const defaultCat = recents.length > 0 ? 'recents' : 'smileys';
            selectCategory(pickerEl, defaultCat);

            // Focus search
            const input = pickerEl.querySelector('input');
            if (input) {
                setTimeout(() => input.focus(), 50);
            }

            // Dismiss handlers (delay to avoid immediate close)
            setTimeout(() => {
                document.addEventListener('mousedown', onOutsideClick);
                document.addEventListener('keydown', onEscapeKey);
            }, 10);
        });
    }

    /**
     * Search emoji programmatically (for inline autocomplete).
     *
     * @param {string} query - Search term
     * @returns {Array<{emoji, name, shortcode, isCustom}>}
     */
    function search(query) {
        return searchEmoji(query) || [];
    }

    // ── Shortcode Resolution ──────────────────────────────────────────

    // Lazily-built lookup maps: shortcode → emoji char / custom url
    let unicodeMap = null;
    let customMap = null;

    function buildUnicodeMap() {
        if (unicodeMap) return;
        unicodeMap = new Map();
        if (emojiData) {
            for (const e of emojiData) {
                unicodeMap.set(e.name, e.emoji);
            }
        }
    }

    function buildCustomMap() {
        customMap = new Map();
        if (customEmoji) {
            for (const e of customEmoji) {
                customMap.set(e.shortcode, e.url);
            }
        }
    }

    /**
     * Replace :shortcode: tokens in an HTML string with emoji.
     *
     * Unicode emoji → the character wrapped in a <span>.
     * Custom emoji → an <img> tag.
     * Unknown shortcodes are left as-is.
     *
     * Only replaces shortcodes in text nodes (not inside HTML tags/attributes).
     */
    function resolveShortcodes(html) {
        if (!emojiData && !customEmoji) return html;
        buildUnicodeMap();
        buildCustomMap();

        // Match :shortcode: but not inside HTML tags.
        // We split on HTML tags to only process text segments.
        const SHORTCODE_RE = /:([a-z0-9][a-z0-9-]*):/g;

        // Split HTML into tags and text segments
        const parts = html.split(/(<[^>]*>)/);
        for (let i = 0; i < parts.length; i++) {
            // Skip HTML tag segments (odd indices after split)
            if (parts[i].startsWith('<')) continue;

            parts[i] = parts[i].replace(SHORTCODE_RE, (match, code) => {
                const unicode = unicodeMap.get(code);
                if (unicode) {
                    return `<span class="emoji-shortcode" title=":${code}:">${unicode}</span>`;
                }
                const url = customMap.get(code);
                if (url) {
                    return `<img class="emoji-shortcode emoji-custom-inline" src="${url}" alt=":${code}:" title=":${code}:">`;
                }
                return match; // Unknown shortcode — leave as-is
            });
        }

        return parts.join('');
    }

    /**
     * Invalidate the custom emoji lookup map (call after uploading/deleting).
     */
    function invalidateCustomMap() {
        customMap = null;
    }

    // ── Plugin init ───────────────────────────────────────────────────

    async function detectAdmin() {
        try {
            const token = context ? context.sessionToken() : localStorage.getItem('session_token');
            if (!token) return;
            const resp = await fetch(`/api/users/me`, {
                headers: { 'Authorization': `Bearer ${token}` },
            });
            if (resp.ok) {
                const me = await resp.json();
                isAdmin = me.role === 'admin';
            }
        } catch {}
    }

    async function init(ctx) {
        context = ctx;
        await detectAdmin();
        // Pre-load emoji data so inline autocomplete works immediately
        await Promise.all([loadEmojiData(), loadCustomEmoji()]);
        // Start watching for chat input element
        observeMessageInput();
    }

    // Expose global API immediately so it works on any page
    // (not just app.html where plugins are loaded via init)
    window.SkribEmojiPicker = { open, search, resolveShortcodes };

    return { init };
})();

window["Four43.emoji-pickerPlugin"] = EmojiPickerPlugin;
