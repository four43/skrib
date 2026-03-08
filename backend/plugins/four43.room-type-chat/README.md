# four43.room-type-chat — Chat Room Type

Core room type plugin providing text-based chat messaging. Handles message storage, delivery, history, editing, deletion, read receipts, link previews, and unread counts.

## Plugin Type

Room type plugin. Registers room type `"chat"`. Has its own plugin-scoped SQLite database.

## Structure

```
backend/
  plugin.py             # RoomTypeChatPlugin — schema, routes, callbacks, WS handle_room_action
  routes.py             # HTTP endpoints: messages CRUD, mark read, link preview
  services.py           # ChatRoom class (message CRUD), LinkPreviewService (OG tag fetcher/cache)
frontend/
  plugin.js             # Bundled JS (marked + highlight.js for markdown rendering)
  plugin.css            # Chat message styles
  plugin-hljs.css       # Highlight.js theme
  package.json          # Frontend build deps (marked, highlight.js, vite)
manifest.json           # Permissions: bus.send/receive, http.routes, storage.read/write, core_api
```

## Database Schema

Plugin-scoped DB. Two tables:

```sql
messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    room_id TEXT NOT NULL,
    username TEXT NOT NULL,
    content TEXT NOT NULL DEFAULT '',
    content_type TEXT NOT NULL DEFAULT 'text',
    key_epoch INTEGER,
    timestamp TEXT NOT NULL,
    edited_at TEXT,
    deleted INTEGER NOT NULL DEFAULT 0
)
-- Index: idx_messages_room_id ON messages(room_id, id)

link_previews (
    url TEXT PRIMARY KEY,
    title TEXT, description TEXT, image TEXT, site_name TEXT,
    content_type TEXT NOT NULL DEFAULT 'webpage',
    fetched_at TEXT NOT NULL
)
```

## HTTP Endpoints (under `/api/plugins/four43.room-type-chat`)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/rooms/{room_id}/messages` | Get messages. Params: `since`, `before`, `limit` |
| POST | `/rooms/{room_id}/messages` | Send message `{content, content_type, key_epoch}` |
| POST | `/rooms/{room_id}/read` | Mark read `{last_read_message_id}` |
| GET | `/link-preview?url=` | Fetch/cache OG preview for URL |

## WebSocket Room Actions (via `handle_room_action`)

| Action | Payload | Broadcast |
|--------|---------|-----------|
| `message` | `{content, content_type, key_epoch}` | `room:message` to room, `room:new_message`/`room:update` to other members |
| `edit_message` | `{message_id, content, content_type, key_epoch}` | `room:message_edited` |
| `delete_message` | `{message_id}` | `room:message_deleted` (soft delete, admin or author) |

## Registered Callbacks

- `/unread-count` — returns count of messages with `id > since_message_id` for a room
- `/unread-counts-batch` — batch version for multiple rooms

## Key Details

- Listens for `core:room_deleted` event to clean up messages
- Messages support `content_type` (text/encrypted) and `key_epoch` for E2E encryption
- Soft delete: sets `deleted=1`, content returned as empty string
- Only author can edit; author or admin can delete
- LinkPreviewService: fetches HTML, parses OG meta tags, caches in `link_previews` table. Detects direct image URLs by extension.
- Frontend is a Vite bundle (marked for markdown, highlight.js for code blocks)
- `room_types: ["chat"]`, `capabilities: ["chat_messages"]`
