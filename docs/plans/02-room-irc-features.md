# Plan 02: Add IRC Features to Rooms

## Goal

Add `topic`, `created_by` to the `rooms` table and `room_role`, `joined_at` to `room_users`. This enables IRC-style channel management: topics, per-room operators, and channel ownership.

Don't worry about schema migration. We can delete and recreate the database during development.

## Schema Changes

### `rooms` table — add columns

```sql
ALTER TABLE rooms ADD COLUMN topic TEXT NOT NULL DEFAULT '';
ALTER TABLE rooms ADD COLUMN created_by TEXT;
```

### `room_users` table — add columns

```sql
ALTER TABLE room_users ADD COLUMN room_role TEXT NOT NULL DEFAULT 'member';
ALTER TABLE room_users ADD COLUMN joined_at TEXT;
```

`room_role` values: `'owner'`, `'op'`, `'voice'`, `'member'`

## Migration

In `init_db()`, use `ALTER TABLE ... ADD COLUMN` with `IF NOT EXISTS`-style error handling (SQLite doesn't support `IF NOT EXISTS` for ALTER, so catch the "duplicate column" error or check `PRAGMA table_info`).

Backfill:

- `rooms.created_by`: Leave NULL for existing rooms (unknown creator)
- `rooms.topic`: Default `''` (empty)
- `room_users.room_role`: Default `'member'` for all existing rows
- `room_users.joined_at`: Backfill with `rooms.created_at` for existing members

## Files to Change

### `backend/mini_chat/database.py`

- Add new columns to `rooms` and `room_users` CREATE statements
- Add migration ALTER TABLE for existing databases

### `backend/mini_chat/rooms/services.py`

- `create_room()`: Accept `created_by` param, INSERT it
- `add_room_member()`: Accept optional `room_role` param (default `'member'`), INSERT `joined_at`
- When creating a channel: creator gets `room_role='owner'`
- `create_or_get_dm()`: All DM members get `room_role='member'`
- New function: `set_topic(room_id, topic, username)` — update topic, check user has `op` or `owner` role
- New function: `get_room_info(room_id)` — return room details including topic, members with roles
- New function: `set_room_role(room_id, target_username, role, acting_username)` — owner can set roles
- `get_user_rooms()`: Include `topic` in returned room info

### `backend/mini_chat/rooms/schemas.py`

- `RoomInfo`: Add `topic: str = ''` field
- New schema: `RoomDetailResponse` — includes topic, members with roles
- New schema: `SetTopicRequest(topic: str)`
- New schema: `SetRoomRoleRequest(username: str, role: Literal['op', 'voice', 'member'])`

### `backend/mini_chat/rooms/routes.py`

- `create_new_room()`: Pass `username` as `created_by` to `create_room()`, add creator with `room_role='owner'`
- New endpoint: `GET /rooms/{room_id}` — return room detail (topic, members, roles)
- New endpoint: `PUT /rooms/{room_id}/topic` — set topic (requires `op` or `owner` room_role, or global admin)
- Update kick endpoint: Allow room `op`/`owner` to kick (not just global moderator)

### `backend/mini_chat/dependencies.py`

- New dependency: `require_room_op(room_id, username)` — check user is `op` or `owner` in the room

### Frontend: `frontend/src/chat.js`

- Display topic in chat header (after room name)
- New slash command: `/topic <text>` — calls `PUT /rooms/{room_id}/topic`
- Update `/kick` to work based on room role (remove global moderator check on frontend)

### Frontend: `frontend/chat.html`

- Add topic display area in chat header

## Permission Model

| Action | Required role |
|--------|--------------|
| Set topic | Room `owner` or `op`, or global `admin` |
| Kick member | Room `owner` or `op`, or global `admin`/`moderator` |
| Set room roles | Room `owner` only |
| Delete room | Room `owner`, or global `admin` |

## Testing Checklist

- [ ] Creating a channel sets `created_by` and gives creator `owner` role
- [ ] Topic can be set by room owner/op
- [ ] Topic displayed in room list and chat header
- [ ] Non-op members cannot set topic (403)
- [ ] Room owner can promote members to `op`
- [ ] Room op can kick members
- [ ] DM members all get `member` role (no hierarchy)
- [ ] Existing rooms migrate cleanly (empty topic, member role)
- [ ] `GET /rooms/{room_id}` returns full detail with member roles
