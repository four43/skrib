# Room Joining & Discoverability

## Overview

Rooms gain a visibility setting that controls who can find and join them. Users can search for discoverable rooms and request to join. Room ops receive real-time notifications and can approve or deny requests.



## Requirements

1. Rooms have a **visibility** level: `private` (unsearchable, invite-only) or `public` (searchable, users can request to join)
2. Users can search for public rooms and request to join
   - The search lives in the "Create Channel" modal, renamed to **"Add Channel"**
   - Channel name input moves above room type selection
   - When a room with that name already exists and is public, show it in results instead of the create option
3. A notification appears for room ops when a user requests to join, allowing them to approve or deny

## Database Changes

### `rooms` table — add `visibility` column

```sql
ALTER TABLE rooms ADD COLUMN visibility TEXT NOT NULL DEFAULT 'private';
```

Values: `'private'` (default, not searchable) or `'public'` (searchable, joinable by request).

Since we're in early dev: just modify the `CREATE TABLE` in `database.py` and wipe `data/`. Ensure `./backend/scripts/seed.py` creates rooms with the new `visibility` field.

### New `join_requests` table

```sql
CREATE TABLE IF NOT EXISTS join_requests (
    room_id TEXT NOT NULL,
    username TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',  -- 'pending', 'approved', 'denied'
    created_at TEXT NOT NULL,
    resolved_by TEXT,
    resolved_at TEXT,
    PRIMARY KEY (room_id, username),
    FOREIGN KEY (room_id) REFERENCES rooms(room_id) ON DELETE CASCADE,
    FOREIGN KEY (username) REFERENCES users(username)
);
```

- Composite PK prevents duplicate requests for the same room+user.
- `ON DELETE CASCADE` cleans up when a room is deleted.
- Only one active request per user per room (upsert on re-request if previously denied).

## Backend Changes

### 1. Schema updates (`rooms/schemas.py`)

```python
class CreateRoomRequest(BaseModel):
    room_id: str
    room_type: str = 'chat'
    visibility: Literal['private', 'public'] = 'private'

class RoomUpdateRequest(BaseModel):
    topic: Optional[str] = None
    visibility: Optional[Literal['private', 'public']] = None

class RoomInfo(BaseModel):
    # ... existing fields ...
    visibility: str = 'private'

class RoomDetailResponse(BaseModel):
    # ... existing fields ...
    visibility: str = 'private'

class RoomSearchResult(BaseModel):
    room_id: str
    room_type: str
    topic: str
    visibility: str
    member_count: int

class JoinRequestInfo(BaseModel):
    room_id: str
    username: str
    status: str  # 'pending', 'approved', 'denied'
    created_at: str
    nickname: Optional[str] = None
    color: Optional[str] = None

class JoinRequestAction(BaseModel):
    action: Literal['approve', 'deny']
```

### 2. Service layer (`rooms/services.py`)

New functions:

- **`search_rooms(query: str, username: str) -> list[dict]`** — Search public rooms by name (prefix/substring match). Exclude rooms the user is already a member of. Returns room_id, room_type, topic, visibility, member_count.
- **`create_join_request(room_id: str, username: str) -> dict`** — Insert a pending join request. Returns `{'status': 'created'}`, `{'status': 'already_member'}`, `{'status': 'already_pending'}`, or `{'status': 'room_not_found'}`. If previously denied, reset to pending.
- **`get_join_requests(room_id: str) -> list[dict]`** — Get all pending join requests for a room. Joins with `users` table for nickname/color.
- **`resolve_join_request(room_id: str, username: str, action: str, resolved_by: str) -> dict`** — Approve or deny. On approve: add user as member, update request status. On deny: update request status. Returns `{'status': 'approved'|'denied'}` or `{'status': 'not_found'}`.
- **`get_pending_request_count(room_id: str) -> int`** — Count pending requests for a room (for badge counts).

Modify existing:

- **`create_room()`** — Accept and store `visibility` parameter.
- **`get_user_rooms()`** — Include `visibility` in returned data.
- **`get_room_info()`** — Include `visibility` in returned data.
- **`set_topic()`** pattern → generalize to `update_room()` or add `set_visibility()`.

### 3. Routes (`rooms/routes.py`)

New endpoints:

- **`GET /rooms/search?q={query}`** — Search public rooms. Returns `list[RoomSearchResult]`. No room membership required. Authenticated only.
- **`POST /rooms/{room_id}/join-requests`** — Submit a join request. Validates room is public and user isn't already a member. Notifies room ops via WebSocket.
- **`GET /rooms/{room_id}/join-requests`** — List pending requests. Requires room op/owner or global admin/mod.
- **`PATCH /rooms/{room_id}/join-requests/{username}`** — Approve or deny a request. Body: `JoinRequestAction`. Requires room op/owner or global admin/mod. On approve: adds member, notifies the requester. On deny: notifies the requester.

Modified endpoints:

- **`POST /rooms`** — Accept `visibility` field from `CreateRoomRequest`.
- **`PATCH /rooms/{room_id}`** — Accept `visibility` field from `RoomUpdateRequest`. Requires op/owner. Broadcasts `room:visibility_changed` to room subscribers.
- **`GET /rooms/{room_id}`** — Include `visibility` in response.
- **`GET /rooms`** — Include `visibility` in room list items.

Route ordering note: `/rooms/search` must be registered **before** `/rooms/{room_id}` to avoid the path parameter capturing "search".

### 4. WebSocket events

New event types:

| Event | Direction | Scope | Payload | Purpose |
|-------|-----------|-------|---------|---------|
| `room:join_request` | server → client | user-scoped (to ops) | `{room_id, username, nickname?, color?}` | Notify ops of new request |
| `room:join_resolved` | server → client | user-scoped (to requester) | `{room_id, action: 'approved'\|'denied'}` | Notify requester of decision |
| `room:visibility_changed` | server → client | room-scoped | `{room_id, visibility}` | Notify room members of visibility change |

Notification flow for join requests:

1. User submits `POST /rooms/{room_id}/join-requests`
2. Backend creates request row, then finds all ops/owners of the room
3. `bus.notify_user(op_username, {"type": "room:join_request", ...})` for each op/owner
4. When op approves/denies: `bus.notify_user(requester, {"type": "room:join_resolved", ...})`
5. On approve: also `bus.notify_user(requester, {"type": "room:update"})` so their room list refreshes, and `bus.broadcast_to_room(room_id, {"type": "room:members_updated", ...})`

## Frontend Changes

### 1. "Add Channel" modal redesign (`app.html` + `app.js`)

Rename modal from "Create Channel" to **"Add Channel"**. Restructure the form:

```
┌─────────────────────────────────┐
│  Add Channel                  ✕ │
├─────────────────────────────────┤
│                                 │
│  Channel name                   │
│  ┌─────────────────────────┐    │
│  │ e.g. general            │    │
│  └─────────────────────────┘    │
│                                 │
│  ┌─ Search results ───────────┐ │
│  │  #cooking  ·  12 members   │ │  ← shown when name matches
│  │  [Request to Join]         │ │    an existing public room
│  └────────────────────────────┘ │
│                                 │
│  ── or create new ──────────── │  ← shown when no exact match
│                                 │
│  Room type                      │
│  ○ Chat  ○ Canvas  ...         │
│                                 │
│  Visibility                     │
│  ○ Private  ○ Public           │
│                                 │
│  [Create]                       │
│                                 │
└─────────────────────────────────┘
```

Behavior:

- As the user types a channel name, debounce a search to `GET /rooms/search?q={name}` (300ms delay)
- If the exact name matches an existing public room: show the room in a results section with a "Request to Join" button. Hide the create form below.
- If no match or only partial matches: show any partial matches above, and show the full create form (room type + visibility + create button) below
  - Show a green check and outline the text input if the name is valid and available for creation (no existing rooms with that name). Show a red X and red outline if the name is taken (like github repo names validation)
- If the user is already a member of a matched room, show "Already joined" instead of the button
- If a private room exists with that name, ignore it in search results (since it's not joinable)
  - If a user tries to create a room with the same name as an existing private room, they should be shown a "room name unavailable" error as they finish typing (like github repo names validation)

### 2. Visibility selector in room settings

In the existing room settings/detail panel, add a visibility toggle for ops/owners:

- Dropdown: Private / Public
- `PATCH /rooms/{room_id}` with `{visibility: 'public'|'private'}`

### 3. Join request notifications

When a `room:join_request` event arrives via WebSocket:

- Show a badge on the room (sum requests with unread messages) in `app.html` - `#room-list`
- Show a badge next to the `app.html` - `#members-toggle-btn`
- Show Approve/Deny buttons in the members list, `app.html` - `#members-panel`, with pending users at the top
- Show Approve/Deny buttons in the members list, `room-settings.html` - `#members-list`, with pending users at the top

As a user navigates, that info can also be fetched from - `GET /rooms/{room_id}/join-requests`
When a `room:join_resolved` event arrives:

- If approved, just show the room in the user's room list (should already happen on room change?)

### 5. Visual indicators

- Public rooms in the sidebar already have a #, private rooms should have a lock icon
- Rooms with pending join requests show a badge count on the room name in the sidebar (for ops only)  in `app.html` - `#room-list`

## Implementation Order

1. **Database**: Add `visibility` to `rooms` table, create `join_requests` table in `database.py`
2. **Schemas**: Add new Pydantic models and update existing ones
3. **Services**: Add search, join request CRUD, and modify existing room functions
4. **Routes**: Add new endpoints, modify existing ones. Mind route ordering.
5. **Frontend modal**: Rename and restructure "Add Channel" modal with search + create flow
6. **Frontend notifications**: Handle `room:join_request` and `room:join_resolved` WebSocket events
7. **Frontend room settings**: Add visibility toggle and pending requests panel
8. **Testing**: E2E tests for search → request → approve/deny flow

## Edge Cases

- **Room deleted while request pending**: `ON DELETE CASCADE` cleans up. If requester gets `room:join_resolved` for a deleted room, handle gracefully.
- **User re-requests after denial**: Upsert resets status to `pending` and updates `created_at`. Ops see a fresh request.
- **Visibility changed to private while requests pending**: Existing pending requests remain and can still be resolved. No new requests can be submitted.
- **Op demoted while request pending**: Other ops can still resolve. If no ops remain, only the owner or global admin/mod can resolve.
- **Race condition — approved twice**: The `add_room_member()` call returns `already_member` on second attempt. Resolve endpoint handles this gracefully.
- **DMs**: DMs should never be searchable/public. The DM creation flow is separate and unchanged. Guard against setting visibility on DM rooms.

## Validation

1. Add frontend tests for all of the visual elements and functionality
