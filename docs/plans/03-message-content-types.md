# Plan 03: Add Content Types to Messages

## Goal

Add `content_type` and `key_epoch` columns to the `messages` table. Rename the `message` column to `content` to avoid the `messages.message` stutter. This enables the client to distinguish plaintext, encrypted, system, and action messages without inspecting the payload.

Don't worry about schema migration. We can delete and recreate the database during development.

## Schema Changes

```sql
-- New schema for messages table
CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    room_id TEXT NOT NULL,
    username TEXT NOT NULL,
    content TEXT NOT NULL,
    content_type TEXT NOT NULL DEFAULT 'text',
    key_epoch INTEGER,
    timestamp TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_room_id ON messages(room_id, id);
```

### Column rename: `message` → `content`

SQLite doesn't support `ALTER TABLE RENAME COLUMN` before 3.25.0. For safety:

1. Check if old `message` column exists (via `PRAGMA table_info(messages)`)
2. If yes: Create new table, copy data, drop old, rename new
3. If no: Create with new schema directly

### New columns

- `content_type TEXT NOT NULL DEFAULT 'text'` — values: `'text'`, `'encrypted'`, `'system'`, `'action'`
- `key_epoch INTEGER` — which E2E key epoch encrypted this message (NULL for plaintext)

## Migration

```sql
-- If 'message' column exists, rename it:
ALTER TABLE messages RENAME TO messages_old;
CREATE TABLE messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    room_id TEXT NOT NULL,
    username TEXT NOT NULL,
    content TEXT NOT NULL,
    content_type TEXT NOT NULL DEFAULT 'text',
    key_epoch INTEGER,
    timestamp TEXT NOT NULL
);
INSERT INTO messages (id, room_id, username, content, content_type, timestamp)
    SELECT id, room_id, username, message, 'text', timestamp FROM messages_old;
DROP TABLE messages_old;
CREATE INDEX IF NOT EXISTS idx_messages_room_id ON messages(room_id, id);
```

Backfill: All existing messages get `content_type='text'` and `key_epoch=NULL`. Existing encrypted messages (which use the `ENC:` prefix convention in the content) will still work — the frontend already checks the prefix. Over time, new encrypted messages will use `content_type='encrypted'` with the epoch in the column.

## Content Type Values

| Type | Description | Example |
|------|-------------|---------|
| `text` | Plain text message | "Hello world" |
| `encrypted` | E2E encrypted payload | Base64 ciphertext |
| `system` | System/server event | "alice joined the channel" |
| `action` | IRC /me action | "dances around" (displayed as "* alice dances around") |

## Files to Change

### `backend/mini_chat/database.py`

- Update `messages` CREATE statement with new schema
- Add migration logic (rename column, add new columns)

### `backend/mini_chat/rooms/services.py`

- `ChatRoom.add_message()`: Accept `content_type` and `key_epoch` params
  - Change column name from `message` to `content` in INSERT
  - Include `content_type` and `key_epoch` in INSERT
- `ChatRoom.get_messages()`: Return `content` (not `message`), plus `content_type` and `key_epoch`
- Return dict keys change: `'message'` → `'content'`, add `'content_type'`, `'key_epoch'`

### `backend/mini_chat/rooms/schemas.py`

- `MessageResponse`: Rename `message: str` → `content: str`, add `content_type: str = 'text'`, `key_epoch: Optional[int] = None`
- `SendMessageRequest`: Rename `message: str` → `content: str`, add `content_type: str = 'text'`, `key_epoch: Optional[int] = None`

### `backend/mini_chat/rooms/routes.py`

- `send_room_message()`: Pass `content_type` and `key_epoch` from request to `add_message()`
- `websocket_endpoint()`: Extract `content_type` and `key_epoch` from WS payload, pass to `add_message()`
- Update broadcast payloads to include new fields

### `backend/mini_chat/messages/services.py`

- `search_messages()`: Update column name from `message` to `content` in queries

### `backend/mini_chat/messages/schemas.py`

- Update any message-related schemas (rename `message` → `content`)

### Frontend: `frontend/src/chat.js`

- `sendMessage()`: Send `content` instead of `message`, include `content_type` and `key_epoch`
  - WS payload: `{cmd: "message", content: "...", content_type: "text"}` (or `"encrypted"` with `key_epoch`)
  - For encrypted: `{cmd: "message", content: "...", content_type: "encrypted", key_epoch: N}`
- `displayMessage()`: Read `msg.content` instead of `msg.message`
  - Check `msg.content_type` instead of `isEncryptedMessage(msg.content)` prefix check
  - Render `system` messages with system styling
  - Render `action` messages as "* username does thing"
- `loadMessages()`: Handle new field names in response
- `handleWebSocketMessage()`: Handle new field names

### Frontend: `frontend/src/crypto.js`

- `isEncryptedMessage()`: Keep for backward compat with old messages, but new code uses `content_type`

## Backward Compatibility

- Old messages in DB have `content_type='text'` after migration. Some may actually be encrypted (using the `ENC:` prefix). The frontend should fall back to prefix-checking when `content_type='text'` to handle these legacy messages.
- The API response shape changes (`message` → `content`). Since the frontend is served from the same deploy, this is a coordinated change — no versioning needed.

## Testing Checklist

- [ ] Fresh database: new schema created correctly
- [ ] Existing database: migration renames column, adds new columns, preserves data
- [ ] Sending a text message: `content_type='text'`, `key_epoch=NULL`
- [ ] Sending an encrypted message: `content_type='encrypted'`, `key_epoch=N`
- [ ] Old encrypted messages (ENC: prefix) still decrypt correctly
- [ ] System messages render with different styling
- [ ] Message search works with renamed column
- [ ] WS broadcast includes new fields
