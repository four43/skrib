# four43.room-type-todo — Todo List Room Type

Collaborative todo lists as a room type. Users can add, edit, toggle, and delete tasks in real-time.

## Plugin Type

Room type plugin. Registers room type `"todo"`. Has its own plugin-scoped SQLite database.

## Structure

```
backend/
  plugin.py             # RoomTypeTodoPlugin — schema, routes, WS handle_room_action
  routes.py             # HTTP endpoints: CRUD for todo items
  services.py           # TodoList class (item CRUD with plugin-scoped DB)
frontend/
  plugin.js             # RoomTypeTodoPlugin IIFE — todo UI, filter bar, inline editing
  plugin.css            # Todo item styles, filter bar, add form, responsive layout
manifest.json           # Permissions: bus.send/receive, http.routes, storage.read/write
```

## Database Schema

Plugin-scoped DB. Table: `todo_items`

```sql
todo_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    room_id TEXT NOT NULL,
    username TEXT NOT NULL,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    done INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
)
-- Index: idx_todo_items_room_id ON todo_items(room_id, done, id)
```

## HTTP Endpoints (under `/api/plugins/four43.room-type-todo`)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/rooms/{room_id}/items` | Get all items (ordered: undone first, then by id) |
| POST | `/rooms/{room_id}/items` | Create item `{title, description}` |
| PATCH | `/rooms/{room_id}/items/{item_id}` | Update item `{title?, description?, done?}` |
| DELETE | `/rooms/{room_id}/items/{item_id}` | Delete item |

## WebSocket Room Actions (via `handle_room_action`)

| Action | Payload | Broadcast |
|--------|---------|-----------|
| `todo_add` | `{title, description}` | `room:todo_added` |
| `todo_update` | `{item_id, title?, description?, done?}` | `room:todo_updated` |
| `todo_delete` | `{item_id}` | `room:todo_deleted` |

## Permissions Model

- **Toggle done**: Any room member
- **Edit title/description**: Creator, room ops, or admins only (uses `can_edit_resource`)
- **Delete**: Creator, room ops, or admins only
- HTTP routes use `require_room_member` and `require_edit_permission` from `skrib.plugins.auth`

## Key Details

- Listens for `core:room_deleted` event to clean up items
- Frontend replaces `#messages` div content with todo UI (filter bar + item list + add form)
- Filter bar: All / Active / Done with counts
- Inline editing with Save/Cancel and keyboard shortcuts (Enter to save, Escape to cancel)
- `room_types: ["todo"]`, `capabilities: ["todo_items"]`
- Frontend exports as `window["Four43.room-type-todoPlugin"]`
