# Plan 05: Rename API Endpoints to IRC Verbs

## Goal

Rename membership-related endpoints to use IRC-inspired verbs (`join`, `part`, `invite`, `kick`). Consolidate redundant user endpoints. This makes the API more intuitive and aligns with the IRC-style chat model.

**Status:** Room detail endpoint (`GET /rooms/{id}`) already implemented. Room keys table migration (Plan 04) complete. Unread message counts added to WebSocket events.

Don't worry about schema migration. We can delete and recreate the database during development.

## Endpoint Changes

### Room Membership (renamed)

| Before | After | Notes |
|--------|-------|-------|
| `POST /rooms/{id}/members` (body: `{username}`) | `POST /rooms/{id}/invite` (body: `{username}`) | Clearer intent |
| `DELETE /rooms/{id}/members/me` + `DELETE /rooms/{id}/members/{user}` | `DELETE /rooms/{id}/members/{username}` | Consolidated resource-based endpoint |

**Resource-based approach:** Single `DELETE /rooms/{id}/members/{username}` endpoint handles both:

- **Self-removal** (part/leave): Regular users can DELETE their own username
- **Kicking**: Ops/admins can DELETE other usernames

Frontend commands `/part` and `/kick` both use this same endpoint with different usernames.

### Room Info (already implemented ✓)

| Endpoint | Purpose | Status |
|----------|---------|--------|
| `GET /rooms/{id}` | Room detail: topic, members with roles, type, created_by | ✓ Already exists |

### User Endpoints (consolidated)

| Before | After | Notes |
|--------|-------|-------|
| `GET /users` (admin) | `GET /users` (admin) | Unchanged |
| `GET /users/list` (auth) | **Remove** | Use `GET /users` with role-based response |
| `GET /users/preferences/colors` | **Remove** | Fold into `GET /users` response |
| `GET /users/{user}/preferences` | `GET /users/{user}` | Profile includes preferences |
| `PUT /users/{user}/preferences` | `PUT /users/me` | Users only update own profile |

### Encryption Keys (moved under users)

| Before | After | Notes |
|--------|-------|-------|
| `POST /auth/encryption-key` | `POST /users/me/encryption-key` | Belongs with user profile |
| `GET /auth/encryption-key/{user}` | `GET /users/{user}/encryption-key` | Consistent with user namespace |

## Files to Change

### `backend/mini_chat/rooms/routes.py`

**Rename endpoints:**

```python
# Before:
@router.post("/{room_id}/members", ...)
async def add_member_endpoint(...)

# After:
@router.post("/{room_id}/invite", ...)
async def invite_member(...)

# Before (two separate endpoints):
@router.delete("/{room_id}/members/me", ...)
async def leave_room_endpoint(...)

@router.delete("/{room_id}/members/{target_username}", ...)
async def kick_member_endpoint(...)

# After (consolidated resource-based endpoint):
@router.delete("/{room_id}/members/{target_username}", ...)
async def remove_member(...):
    # Permission check: users can remove themselves, ops can remove others
    if target_username != username:
        _require_room_op_or_global_mod(room_id, username)
```

**Room detail endpoint (already exists):**

```python
@router.get("/{room_id}", response_model=RoomDetailResponse)  # ✓ Already implemented
async def get_room_detail(room_id: str, username: str = Depends(require_auth)):
    """Get detailed room info including topic and members with roles."""
    # Implementation complete at routes.py:326
```

**Note:** Route ordering is handled correctly - `GET /rooms/{room_id}` is registered after `GET /rooms` list endpoint.

### `backend/mini_chat/rooms/schemas.py`

```python
# New: replace AddMemberRequest
class InviteRequest(BaseModel):
    username: str

# RoomDetailResponse and MemberInfo already exist ✓
class RoomDetailResponse(BaseModel):  # ✓ Already implemented
    room_id: str
    room_type: str
    topic: str = ''
    created_by: str | None
    members: List[MemberInfo]

class MemberInfo(BaseModel):  # ✓ Already implemented
    username: str
    room_role: str = 'member'
    joined_at: str | None
```

Remove: `AddMemberRequest`, `AddMemberResponse`, `RemoveMemberResponse` (replace with generic `StatusResponse`)

### `backend/mini_chat/users/routes.py`

**Consolidate:**

```python
# Remove /users/list — merge into GET /users with role-based filtering
@router.get("")
async def list_users(username: str = Depends(require_auth)):
    """List users. Admins/mods get full info, regular users get usernames only."""

# Remove /users/preferences/colors — include in GET /users response
# Remove GET /users/{user}/preferences — use GET /users/{user}
# Remove PUT /users/{user}/preferences — use PUT /users/me

@router.get("/me")
async def get_my_profile(username: str = Depends(require_auth)):
    """Get own profile including preferences."""

@router.put("/me")
async def update_my_profile(request: UpdatePreferencesRequest, username: str = Depends(require_auth)):
    """Update own preferences."""

@router.get("/{target_username}")
async def get_user_profile(target_username: str, username: str = Depends(require_auth)):
    """Get public user profile (color, nickname, encryption key)."""
```

**Move encryption key endpoints from auth:**

```python
@router.post("/me/encryption-key")
async def store_encryption_key(...)

@router.get("/{target_username}/encryption-key")
async def get_encryption_key(...)
```

### `backend/mini_chat/auth/routes.py`

- Remove `store_encryption_key` and `get_encryption_key` endpoints (moved to users)

### Frontend: `frontend/src/chat.js`

Update API calls:

```javascript
// /invite command: POST /rooms/{id}/members → POST /rooms/{id}/invite
// (body stays the same: {username})

// /leave and /part commands: DELETE /rooms/{id}/members/{myUsername}
// Backend checks: user can only delete themselves

// /kick command: DELETE /rooms/{id}/members/{targetUsername}
// Backend checks: requires op/mod/admin permission

// loadUserColors: GET /users/preferences/colors → GET /users
// (response shape may change)

// loadDMUserList: GET /users/list → GET /users
// (extract usernames from response)

// loadUserSettings: GET /users/{me}/preferences → GET /users/me

// updateUserColor/Nickname/Theme: PUT /users/{me}/preferences → PUT /users/me

// Encryption key storage: POST /auth/encryption-key → POST /users/me/encryption-key

// Encryption key fetch: GET /auth/encryption-key/{user} → GET /users/{user}/encryption-key
```

### Frontend: `frontend/src/login.js` / `frontend/src/register.js`

- If they reference encryption-key endpoints, update paths

## Deprecation Strategy

Since this is pre-production, no deprecation — just change everything in one coordinated deploy. The frontend and backend are deployed together via Docker.

## Current Implementation Status

### Already Complete ✓

- `GET /rooms/{id}` - Room detail with topic, members, roles (routes.py:326)
- `room_keys` table - E2E encryption keys separated from room_users (Plan 04)
- Unread counts in WebSocket `room.new_message` / `room.update` events
- `RoomDetailResponse` and `MemberInfo` schemas exist

### Still To Do

- [ ] Rename `POST /rooms/{id}/members` → `POST /rooms/{id}/invite`
- [ ] Rename `DELETE /rooms/{id}/members/me` → `POST /rooms/{id}/part`
- [ ] Rename `DELETE /rooms/{id}/members/{target}` → `POST /rooms/{id}/kick/{username}`
- [ ] Consolidate user endpoints (remove `/list`, `/preferences/colors`)
- [ ] Add `GET /users/me` and `PUT /users/me`
- [ ] Move encryption key endpoints from `/auth` to `/users`

## Testing Checklist

- [ ] `POST /rooms/{id}/invite` adds member, returns 200
- [ ] `POST /rooms/{id}/part` removes self from channel, returns 200
- [ ] `POST /rooms/{id}/part` on DM returns 400
- [ ] `POST /rooms/{id}/kick/{user}` removes target (requires op/mod/admin)
- [x] `GET /rooms/{id}` returns room detail with topic and members ✓
- [ ] `GET /users` returns appropriate data based on caller's role
- [ ] `GET /users/me` returns own profile with preferences
- [ ] `PUT /users/me` updates own preferences
- [ ] `GET /users/{user}` returns public profile
- [ ] Encryption key endpoints work at new paths
- [ ] Old endpoints return 404 (not silently succeed)
- [ ] Frontend /invite, /leave, /kick commands work
- [ ] Frontend settings panel works
- [ ] Frontend DM user picker works
