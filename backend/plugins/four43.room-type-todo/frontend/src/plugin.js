/**
 * Todo List Room Type Plugin (four43.room-type-todo)
 *
 * Provides a collaborative todo list UI for todo-type rooms.
 * Users can add, edit, toggle, and delete items in real-time.
 */

const RoomTypeTodoPlugin = (function() {
    let ctx = null;

    const PLUGIN_ID = 'four43.room-type-todo';
    let PLUGIN_API = '';

    // State
    let items = [];         // Current room's todo items
    let filter = 'all';  // 'all' | 'active' | 'done'
    let editingItemId = null;

    async function init(pluginCtx) {
        ctx = pluginCtx;
        PLUGIN_API = `${ctx.API_URL}/plugins/${PLUGIN_ID}`;

        console.log('[RoomTypeTodo] Initializing...');

        // Load CSS
        loadStylesheet();

        ctx.registerRoomTypeHandler({
            pluginId: PLUGIN_ID,
            roomTypes: ['todo'],
            onRoomSelected,
            onRoomLeft,
            onRoomAction,
        });

        console.log('[RoomTypeTodo] Initialized successfully');
    }

    function loadStylesheet() {
        const link = document.createElement('link');
        link.rel = 'stylesheet';
        link.href = `${ctx.API_URL}/plugins/${PLUGIN_ID}/file/frontend/plugin.css`;
        document.head.appendChild(link);
    }

    // -----------------------------------------------------------------------
    // Room type handler interface
    // -----------------------------------------------------------------------

    async function onRoomSelected(roomId) {
        items = [];
        editingItemId = null;
        filter = 'all';
        renderTodoUI();
        await loadItems(roomId);
    }

    function onRoomLeft(roomId) {
        items = [];
        editingItemId = null;
        // Restore the messages div className so other room types render correctly
        const messagesDiv = document.getElementById('messages');
        if (messagesDiv) {
            messagesDiv.className = 'messages';
        }
    }

    function onRoomAction(action, data) {
        switch (action) {
            case 'todo_added':
                if (data.room_id === ctx.currentRoom()) {
                    items.push(data.data);
                    renderItems();
                }
                break;

            case 'todo_updated':
                if (data.room_id === ctx.currentRoom()) {
                    const idx = items.findIndex(i => i.id === data.data.id);
                    if (idx !== -1) {
                        items[idx] = data.data;
                    }
                    renderItems();
                }
                break;

            case 'todo_deleted':
                if (data.room_id === ctx.currentRoom()) {
                    items = items.filter(i => i.id !== data.data.id);
                    if (editingItemId === data.data.id) {
                        editingItemId = null;
                    }
                    renderItems();
                }
                break;

            default:
                console.warn('[RoomTypeTodo] Unknown room action:', action);
        }
    }

    // -----------------------------------------------------------------------
    // Data loading
    // -----------------------------------------------------------------------

    async function loadItems(roomId) {
        try {
            const response = await fetch(
                `${PLUGIN_API}/rooms/${encodeURIComponent(roomId)}/items`,
                { headers: { 'Authorization': `Bearer ${ctx.sessionToken()}` } }
            );
            const data = await response.json();

            if (data) {
                items = data;
                renderItems();
            }
        } catch (error) {
            console.error('[RoomTypeTodo] Error loading items:', error);
        }
    }

    // -----------------------------------------------------------------------
    // Rendering
    // -----------------------------------------------------------------------

    function renderTodoUI() {
        const messagesDiv = document.getElementById('messages');
        messagesDiv.innerHTML = '';
        messagesDiv.className = 'todo-container';

        // Filter bar
        const filterBar = document.createElement('div');
        filterBar.className = 'todo-filter-bar';
        filterBar.innerHTML = `
            <button class="todo-filter-btn ${filter === 'all' ? 'active' : ''}" data-filter="all">All</button>
            <button class="todo-filter-btn ${filter === 'active' ? 'active' : ''}" data-filter="active">Active</button>
            <button class="todo-filter-btn ${filter === 'done' ? 'active' : ''}" data-filter="done">Done</button>
            <span class="todo-count"></span>
        `;
        filterBar.addEventListener('click', (e) => {
            const btn = e.target.closest('.todo-filter-btn');
            if (btn) {
                filter = btn.dataset.filter;
                renderItems();
                // Update active state on buttons
                filterBar.querySelectorAll('.todo-filter-btn').forEach(b => {
                    b.classList.toggle('active', b.dataset.filter === filter);
                });
            }
        });
        messagesDiv.appendChild(filterBar);

        // Items list
        const listEl = document.createElement('div');
        listEl.className = 'todo-list';
        listEl.id = 'todo-items-list';
        messagesDiv.appendChild(listEl);

        // Add item form (at the bottom, mirroring chat input)
        const addForm = document.createElement('div');
        addForm.className = 'todo-add-form';
        addForm.innerHTML = `
            <input type="text" class="todo-add-title" placeholder="New task title..." />
            <input type="text" class="todo-add-desc" placeholder="Description (optional)" />
            <button class="todo-add-btn">Add</button>
        `;

        const titleInput = addForm.querySelector('.todo-add-title');
        const descInput = addForm.querySelector('.todo-add-desc');
        const addBtn = addForm.querySelector('.todo-add-btn');

        function addItem() {
            const title = titleInput.value.trim();
            if (!title) return;

            ctx.sendWs({
                type: 'room:todo_add',
                room_id: ctx.currentRoom(),
                title: title,
                description: descInput.value.trim(),
            });

            titleInput.value = '';
            descInput.value = '';
            titleInput.focus();
        }

        addBtn.addEventListener('click', addItem);
        titleInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') addItem();
        });
        descInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') addItem();
        });

        messagesDiv.appendChild(addForm);
    }

    function renderItems() {
        const listEl = document.getElementById('todo-items-list');
        if (!listEl) return;

        // Apply filter
        let filtered;
        if (filter === 'active') {
            filtered = items.filter(i => !i.done);
        } else if (filter === 'done') {
            filtered = items.filter(i => i.done);
        } else {
            filtered = [...items];
        }

        // Update count
        const countEl = document.querySelector('.todo-count');
        if (countEl) {
            const active = items.filter(i => !i.done).length;
            const done = items.filter(i => i.done).length;
            countEl.textContent = `${active} active, ${done} done`;
        }

        listEl.innerHTML = '';

        if (filtered.length === 0) {
            const empty = document.createElement('div');
            empty.className = 'todo-empty';
            if (filter === 'done') {
                empty.textContent = 'No completed tasks yet.';
            } else if (filter === 'active') {
                empty.textContent = 'All caught up! No active tasks.';
            } else {
                empty.textContent = 'No tasks yet. Add one below!';
            }
            listEl.appendChild(empty);
            return;
        }

        filtered.forEach(item => {
            if (editingItemId === item.id) {
                listEl.appendChild(renderEditForm(item));
            } else {
                listEl.appendChild(renderItem(item));
            }
        });
    }

    function renderItem(item) {
        const el = document.createElement('div');
        el.className = `todo-item ${item.done ? 'done' : ''}`;
        el.dataset.itemId = item.id;

        const userColors = ctx.userColors();
        const userColor = userColors[item.username] || '#1976d2';
        const displayName = ctx.getDisplayName(item.username);

        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.className = 'todo-checkbox';
        checkbox.checked = item.done;
        checkbox.addEventListener('change', () => {
            ctx.sendWs({
                type: 'room:todo_update',
                room_id: ctx.currentRoom(),
                item_id: item.id,
                done: checkbox.checked,
            });
        });

        const content = document.createElement('div');
        content.className = 'todo-item-content';

        const titleRow = document.createElement('div');
        titleRow.className = 'todo-item-title-row';

        const title = document.createElement('span');
        title.className = 'todo-item-title';
        title.textContent = item.title;

        titleRow.appendChild(title);
        content.appendChild(titleRow);

        if (item.description) {
            const desc = document.createElement('div');
            desc.className = 'todo-item-desc';
            desc.textContent = item.description;
            content.appendChild(desc);
        }

        const meta = document.createElement('div');
        meta.className = 'todo-item-meta';

        const creator = document.createElement('span');
        creator.className = 'todo-item-creator';
        creator.style.color = userColor;
        creator.textContent = displayName;
        creator.title = item.username;

        const date = document.createElement('span');
        date.className = 'todo-item-date';
        date.textContent = formatDate(item.created_at);

        meta.appendChild(creator);
        meta.appendChild(date);
        content.appendChild(meta);

        el.appendChild(checkbox);
        el.appendChild(content);

        // Only show edit/delete buttons for the item creator
        if (item.username === ctx.currentUsername()) {
            const actions = document.createElement('div');
            actions.className = 'todo-item-actions';

            const editBtn = document.createElement('button');
            editBtn.className = 'todo-action-btn todo-edit-btn';
            editBtn.textContent = 'Edit';
            editBtn.title = 'Edit item';
            editBtn.addEventListener('click', () => {
                editingItemId = item.id;
                renderItems();
            });

            const deleteBtn = document.createElement('button');
            deleteBtn.className = 'todo-action-btn todo-delete-btn';
            deleteBtn.textContent = 'Delete';
            deleteBtn.title = 'Delete item';
            deleteBtn.addEventListener('click', () => {
                if (confirm('Delete this task?')) {
                    ctx.sendWs({
                        type: 'room:todo_delete',
                        room_id: ctx.currentRoom(),
                        item_id: item.id,
                    });
                }
            });

            actions.appendChild(editBtn);
            actions.appendChild(deleteBtn);
            el.appendChild(actions);
        }

        return el;
    }

    function renderEditForm(item) {
        const el = document.createElement('div');
        el.className = 'todo-item todo-item-editing';
        el.dataset.itemId = item.id;

        el.innerHTML = `
            <div class="todo-edit-form">
                <span class="todo-edit-label">Editing: ${escapeAttr(item.title)}</span>
                <input type="text" class="todo-edit-title" value="${escapeAttr(item.title)}" placeholder="Title" />
                <input type="text" class="todo-edit-desc" value="${escapeAttr(item.description)}" placeholder="Description (optional)" />
                <div class="todo-edit-actions">
                    <button class="todo-action-btn todo-save-btn">Save</button>
                    <button class="todo-action-btn todo-cancel-btn">Cancel</button>
                </div>
            </div>
        `;

        const titleInput = el.querySelector('.todo-edit-title');
        const descInput = el.querySelector('.todo-edit-desc');

        function save() {
            const newTitle = titleInput.value.trim();
            if (!newTitle) return;

            ctx.sendWs({
                type: 'room:todo_update',
                room_id: ctx.currentRoom(),
                item_id: item.id,
                title: newTitle,
                description: descInput.value.trim(),
            });

            editingItemId = null;
            renderItems();
        }

        function cancel() {
            editingItemId = null;
            renderItems();
        }

        el.querySelector('.todo-save-btn').addEventListener('click', save);
        el.querySelector('.todo-cancel-btn').addEventListener('click', cancel);
        titleInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') save();
        });
        descInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') save();
        });
        titleInput.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') cancel();
        });
        descInput.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') cancel();
        });

        // Focus the title input after render
        setTimeout(() => titleInput.focus(), 0);

        return el;
    }

    // -----------------------------------------------------------------------
    // Helpers
    // -----------------------------------------------------------------------

    function formatDate(isoStr) {
        const date = new Date(isoStr);
        const now = new Date();
        const diff = now - date;

        // Today: show time
        if (diff < 86400000 && date.getDate() === now.getDate()) {
            return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        }
        // Within 7 days: show day name
        if (diff < 604800000) {
            return date.toLocaleDateString([], { weekday: 'short' });
        }
        // Older: show date
        return date.toLocaleDateString([], { month: 'short', day: 'numeric' });
    }

    function escapeAttr(str) {
        return str.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }

    // Public API
    return {
        init,
    };
})();

// Export for module loading
if (typeof module !== 'undefined' && module.exports) {
    module.exports = RoomTypeTodoPlugin;
}

// Export for plugin loader
// ID "four43.room-type-todo" -> "Four43.room-type-todoPlugin"
window["Four43.room-type-todoPlugin"] = RoomTypeTodoPlugin;
