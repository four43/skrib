# four43.message-reactions — Message Reactions

Emoji reactions on chat messages with real-time sync and persistence.

## Plugin Type

Feature plugin (no room type). Has its own plugin-scoped SQLite database.

## Structure

```
backend/
  plugin.py             # MessageReactionsPlugin — schema, routes, WS handler registration
  database.py           # CRUD: add/remove/get reactions, batch get by room+ID range
  routes.py             # REST API under /reactions (add, remove, get by message, get by room range)
  ws_handlers.py        # handle_reaction() — WS handler for add/remove with broadcast
frontend/
  plugin.js             # ReactionsPlugin IIFE — hover bar emoji buttons, reaction pills, batch loading
  plugin.css            # Styles for hover-bar emoji buttons and reaction pill badges
manifest.json           # Permissions: bus.send, bus.receive, http.routes, storage.read/write, dom.messages
```

## Database Schema

Plugin-scoped DB (not core DB). Table: `message_reactions`

```sql
message_reactions (
    message_id INTEGER NOT NULL,
    room_id TEXT NOT NULL,
    username TEXT NOT NULL,
    emoji TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (message_id, username, emoji)
)
-- Indexes: idx_reactions_message_id, idx_reactions_room_message
```

## HTTP Endpoints (under `/api/plugins/four43.message-reactions/reactions`)

| Method | Path | Description |
|--------|------|-------------|
| POST | `/add` | Add reaction `{message_id, room_id, emoji}` |
| POST | `/remove` | Remove reaction `{message_id, emoji}` |
| GET | `/message/{message_id}` | Get reactions grouped by emoji |
| GET | `/room/{room_id}?min_id=&max_id=` | Batch get reactions for message ID range |

## WebSocket Events

| Direction | Type | Payload |
|-----------|------|---------|
| Client -> Server | `four43.message-reactions:add` | `{room_id, message_id, emoji}` |
| Client -> Server | `four43.message-reactions:remove` | `{room_id, message_id, emoji}` |
| Server -> Client | `four43.message-reactions:added` | `{data: {message_id, emoji, username}}` |
| Server -> Client | `four43.message-reactions:removed` | `{data: {message_id, emoji, username}}` |

## Key Details

- Frontend injects emoji buttons into the `.message-hover-bar` created by room-type-chat
- Batch loading: MutationObserver tracks new `.message` elements, debounces 50ms, then fetches reactions for the min/max ID range via the room endpoint
- Reaction pills below messages show emoji + count, highlighted if current user reacted
- Click toggles own reaction (add if not reacted, remove if reacted)
- `onRoomChange` hook registered but is a no-op
- Frontend exports as `window["Four43.message-reactionsPlugin"]`
