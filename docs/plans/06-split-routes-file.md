# Plan 06: Split Rooms Routes File

## Goal

Split the monolithic `rooms/routes.py` (~400 lines) into focused route files by responsibility. Keep them all in the same `rooms/` module under the same `/rooms` API prefix.

Don't worry about schema migration. We can delete and recreate the database during development.

## New File Structure

```
rooms/
  __init__.py
  routes.py              → Room CRUD, list, topic (core room operations)
  membership_routes.py   → join, part, invite, kick
  message_routes.py      → get/send messages, mark read, WebSocket chat
  key_routes.py          → E2E key storage and retrieval
  services.py            → (unchanged)
  schemas.py             → (unchanged)
  websocket.py           → (unchanged)
```

## Route Distribution

### `routes.py` — Room CRUD (~80 lines)
- `GET /rooms` — list rooms
- `WS /rooms` — room list subscription
- `POST /rooms` — create channel
- `POST /rooms/dm` — create/get DM
- `GET /rooms/{room_id}` — room detail (from Plan 02/05)
- `PUT /rooms/{room_id}/topic` — set topic (from Plan 02)
- `DELETE /rooms/{room_id}` — delete room

Keeps: `rooms_subscriptions` ListSubscriptionManager instance (imported by other route files for notifications)

### `membership_routes.py` — Membership (~60 lines)
- `POST /rooms/{room_id}/invite` — invite member
- `POST /rooms/{room_id}/part` — leave room
- `POST /rooms/{room_id}/kick/{username}` — kick member

### `message_routes.py` — Messages + WebSocket (~120 lines)
- `GET /rooms/{room_id}/messages` — get messages
- `POST /rooms/{room_id}/messages` — send message (HTTP)
- `POST /rooms/{room_id}/read` — mark read
- `PUT /rooms/{room_id}/notify` — notification settings
- `WS /rooms/{room_id}/ws` — WebSocket chat

### `key_routes.py` — E2E Keys (~30 lines)
- `POST /rooms/{room_id}/keys` — store encrypted key
- `GET /rooms/{room_id}/keys` — get encrypted keys

## Implementation

### `backend/mini_chat/rooms/__init__.py`
Currently empty (or doesn't exist). No changes needed — each route file defines its own `APIRouter`.

### `backend/mini_chat/main.py`
Register all route files under the same prefix:

```python
from .rooms.routes import router as rooms_router
from .rooms.membership_routes import router as rooms_membership_router
from .rooms.message_routes import router as rooms_message_router
from .rooms.key_routes import router as rooms_key_router

app.include_router(rooms_router, prefix="/api")
app.include_router(rooms_membership_router, prefix="/api")
app.include_router(rooms_message_router, prefix="/api")
app.include_router(rooms_key_router, prefix="/api")
```

All routers use `prefix="/rooms"` internally, so the full paths remain `/api/rooms/...`.

### Shared State

The `rooms_subscriptions` ListSubscriptionManager is currently defined in `routes.py` and used to notify users when rooms change. After the split:

- **Option A:** Keep it in `routes.py`, import from there in other route files
- **Option B:** Move it to a `rooms/state.py` file

Option A is simpler. The other route files import:
```python
from .routes import rooms_subscriptions
```

### `_check_room_access` helper

Currently a private function in `routes.py`. Used by message routes and key routes. Move to `services.py` as a public function so all route files can use it:

```python
# services.py
def check_room_access(room_id: str, username: str):
    """Verify room exists and user has access. Raises HTTPException on failure."""
    ...
```

Wait — services shouldn't raise HTTPException (that's a route concern). Two options:
1. Move to a `rooms/helpers.py` shared by route files
2. Return a result and let each route file handle it

Cleanest: Keep `_check_room_access` as a helper in a small `rooms/helpers.py`:

```python
# rooms/helpers.py
from fastapi import HTTPException
from .services import room_exists, ensure_room_exists, get_room_type, get_room_members

def check_room_access(room_id: str, username: str):
    """Verify room exists and user has access. Raises HTTPException."""
    if not room_exists(room_id):
        ensure_room_exists(room_id)
    room_type = get_room_type(room_id)
    if room_type == 'dm':
        members = get_room_members(room_id)
        if username not in members:
            raise HTTPException(status_code=403, detail="Not a member of this DM")
```

## Files to Create

- `backend/mini_chat/rooms/membership_routes.py`
- `backend/mini_chat/rooms/message_routes.py`
- `backend/mini_chat/rooms/key_routes.py`
- `backend/mini_chat/rooms/helpers.py`

## Files to Modify

- `backend/mini_chat/rooms/routes.py` — Remove moved endpoints, keep room CRUD + subscriptions
- `backend/mini_chat/main.py` — Register new routers

## No Frontend Changes

This is purely backend file organization. The API paths don't change.

## Testing Checklist

- [ ] All existing endpoints still respond at the same paths
- [ ] Room CRUD works (create, list, delete)
- [ ] Room list WebSocket subscription works
- [ ] Membership endpoints work (invite, part, kick)
- [ ] Message endpoints work (get, send, read, notify)
- [ ] WebSocket chat works
- [ ] E2E key endpoints work
- [ ] Notifications fire correctly across route files (rooms_subscriptions shared)
