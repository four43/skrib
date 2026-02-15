# Plan 04: Proper E2E Key Table

## Goal

Replace the `encrypted_keys TEXT DEFAULT '{}'` JSON blob in `room_members` with a dedicated `room_keys` table. This makes key storage queryable, indexable, and separates E2E concerns from membership.

Don't worry about schema migration. We can delete and recreate the database during development.

## New Schema

```sql
CREATE TABLE IF NOT EXISTS room_keys (
    room_id TEXT NOT NULL,
    key_epoch INTEGER NOT NULL,
    username TEXT NOT NULL,
    encrypted_key TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (room_id, key_epoch, username),
    FOREIGN KEY (room_id) REFERENCES rooms(room_id),
    FOREIGN KEY (username) REFERENCES users(username)
);
```

### Drop from `room_members`

Remove the `encrypted_keys` column. SQLite doesn't support `DROP COLUMN` before 3.35.0, so we'll recreate the table if the column exists.

## Migration

1. Check if `room_members.encrypted_keys` column exists
2. If yes:
   a. Read all non-empty encrypted_keys from `room_members`
   b. Parse the JSON and INSERT rows into `room_keys`
   c. Recreate `room_members` without the `encrypted_keys` column
3. If no: just create `room_keys` if it doesn't exist

```sql
-- Migration pseudocode:
-- For each room_member row with encrypted_keys != '{}':
--   Parse JSON: {epoch_str: encrypted_key_str, ...}
--   INSERT INTO room_keys (room_id, key_epoch, username, encrypted_key, created_at)
--   VALUES (room_id, int(epoch), username, encrypted_key, now())

-- Then recreate room_members without encrypted_keys:
ALTER TABLE room_members RENAME TO room_members_old;
CREATE TABLE room_members (
    room_id TEXT NOT NULL,
    username TEXT NOT NULL,
    last_read_message_id INTEGER NOT NULL DEFAULT 0,
    notify_level TEXT NOT NULL DEFAULT 'all',
    room_role TEXT NOT NULL DEFAULT 'member',
    joined_at TEXT,
    PRIMARY KEY (room_id, username),
    FOREIGN KEY (room_id) REFERENCES rooms(room_id),
    FOREIGN KEY (username) REFERENCES users(username)
);
INSERT INTO room_members (room_id, username, last_read_message_id, notify_level)
    SELECT room_id, username, last_read_message_id, notify_level FROM room_members_old;
DROP TABLE room_members_old;
```

**Note:** This plan assumes Plan 02 (room_role, joined_at) is implemented first. If implementing independently, omit `room_role` and `joined_at` from the recreated table.

## Files to Change

### `backend/mini_chat/database.py`

- Add `room_keys` CREATE TABLE statement
- Add migration logic to move data from JSON blob to new table
- Remove `encrypted_keys` from `room_members` CREATE statement

### `backend/mini_chat/rooms/services.py`

- `store_room_key()`: Rewrite — INSERT into `room_keys` (simple INSERT OR REPLACE, no JSON parse/update)
- `get_room_keys()`: Rewrite — SELECT from `room_keys WHERE room_id = ? AND username = ?`
- Remove `json` import if no longer needed by other functions

**Before (current):**

```python
def store_room_key(room_id, username, key_epoch, encrypted_key):
    with get_db() as conn:
        cursor = conn.execute(
            'SELECT encrypted_keys FROM room_members WHERE room_id = ? AND username = ?',
            (room_id, username))
        row = cursor.fetchone()
        if not row: return
        keys = json.loads(row['encrypted_keys'])
        keys[str(key_epoch)] = encrypted_key
        conn.execute(
            'UPDATE room_members SET encrypted_keys = ? WHERE room_id = ? AND username = ?',
            (json.dumps(keys), room_id, username))
        conn.commit()
```

**After:**

```python
def store_room_key(room_id, username, key_epoch, encrypted_key):
    now = datetime.now().isoformat()
    with get_db() as conn:
        conn.execute('''
            INSERT OR REPLACE INTO room_keys (room_id, key_epoch, username, encrypted_key, created_at)
            VALUES (?, ?, ?, ?, ?)
        ''', (room_id, key_epoch, username, encrypted_key, now))
        conn.commit()
```

**Before (current):**

```python
def get_room_keys(room_id, username):
    with get_db() as conn:
        cursor = conn.execute(
            'SELECT encrypted_keys FROM room_members WHERE room_id = ? AND username = ?',
            (room_id, username))
        row = cursor.fetchone()
        if not row: return []
        keys = json.loads(row['encrypted_keys'])
        return [{'key_epoch': int(e), 'encrypted_key': k} for e, k in sorted(keys.items(), key=lambda x: int(x[0]))]
```

**After:**

```python
def get_room_keys(room_id, username):
    with get_db() as conn:
        cursor = conn.execute('''
            SELECT key_epoch, encrypted_key FROM room_keys
            WHERE room_id = ? AND username = ?
            ORDER BY key_epoch
        ''', (room_id, username))
        return [{'key_epoch': row['key_epoch'], 'encrypted_key': row['encrypted_key']} for row in cursor]
```

### `backend/mini_chat/rooms/routes.py`

- No changes needed — routes call `store_room_key()` and `get_room_keys()` which have the same signatures

### `backend/mini_chat/rooms/schemas.py`

- No changes needed — `StoreRoomKeyRequest` and `RoomKeysResponse` schemas unchanged

### Frontend

- No changes needed — API request/response shape is identical

## Benefits

- Queries like "get all users with epoch N keys" are now a simple SELECT (useful for key rotation)
- No JSON parsing in hot paths
- Proper foreign keys and indexing
- Clean separation: membership is in `room_members`, encryption is in `room_keys`

## Testing Checklist

- [ ] Fresh database: `room_keys` table created, `room_members` has no `encrypted_keys` column
- [ ] Existing database: JSON data migrated to `room_keys` rows correctly
- [ ] Store room key: new row in `room_keys`
- [ ] Get room keys: returns correct epochs in order
- [ ] Multiple epochs per user per room work correctly
- [ ] E2E encryption flow still works end-to-end (create room, invite, send encrypted messages)
- [ ] `/invite` slash command still distributes keys correctly
