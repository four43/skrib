"""Rooms API routes."""
from fastapi import APIRouter, HTTPException, Depends

from .schemas import (
    RoomListResponse,
    RoomInfo,
    CreateRoomRequest,
    CreateRoomResponse,
    CreateDMRequest,
    CreateDMResponse,
    DeleteRoomResponse,
    InviteRequest,
    StoreRoomKeyRequest,
    RoomKeysResponse,
    RoomDetailResponse,
    MemberInfo,
    RoomUpdateRequest,
    MemberUpdateRequest,
)
from .services import (
    get_user_rooms,
    create_room,
    delete_room,
    ensure_room_exists,
    room_exists,
    is_dm,
    get_room_type,
    get_room_members,
    get_room_role,
    create_or_get_dm,
    validate_channel_name,
    add_room_member,
    remove_room_member,
    store_room_key,
    get_room_keys,
    set_notify_level,
    set_topic,
    get_room_info,
    set_room_role,
)
from ..ws import bus
from ..dependencies import require_auth
from ..plugins import registry

router = APIRouter(prefix="/rooms", tags=["rooms"])


@router.get("", response_model=RoomListResponse)
async def list_rooms(username: str = Depends(require_auth)):
    """Get list of rooms visible to the current user."""
    rooms = get_user_rooms(username)
    return RoomListResponse(rooms=[RoomInfo(**r) for r in rooms])



@router.post("", response_model=CreateRoomResponse)
async def create_new_room(
    request: CreateRoomRequest,
    username: str = Depends(require_auth)
):
    """Create a new chat room (channel)."""
    if not validate_channel_name(request.room_id):
        raise HTTPException(
            status_code=400,
            detail="Room name must be lowercase letters, numbers, and hyphens only (e.g. 'my-room')"
        )

    # Validate the room type is provided by an enabled plugin
    if request.room_type not in registry.room_type_map:
        raise HTTPException(
            status_code=400,
            detail=f"Unsupported room type: '{request.room_type}'"
        )

    if not create_room(request.room_id, room_type=request.room_type, created_by=username):
        raise HTTPException(status_code=400, detail="Room already exists")

    # Add creator as owner
    add_room_member(request.room_id, username, room_role='owner')

    # Notify creator — new channel appears in their room list
    await bus.notify_user(username, {"type": "room:update"})

    return CreateRoomResponse(status="ok", room_id=request.room_id)


@router.post("/dm", response_model=CreateDMResponse)
async def create_dm(
    request: CreateDMRequest,
    username: str = Depends(require_auth)
):
    """Create or get a DM room with one or more users."""
    if not request.usernames:
        raise HTTPException(status_code=400, detail="At least one username is required")

    targets = list(set(request.usernames))
    if len(targets) == 1 and targets[0] == username:
        raise HTTPException(status_code=400, detail="Cannot DM yourself")

    # Remove self from target list if included
    targets = [u for u in targets if u != username]
    if not targets:
        raise HTTPException(status_code=400, detail="At least one other user is required")

    # Validate the room type is provided by an enabled plugin
    if request.room_type not in registry.room_type_map:
        raise HTTPException(
            status_code=400,
            detail=f"Unsupported room type: '{request.room_type}'"
        )

    # Verify all target users exist
    from ..database import get_db
    with get_db() as conn:
        for target in targets:
            cursor = conn.execute(
                'SELECT username FROM users WHERE username = ?',
                (target,)
            )
            if not cursor.fetchone():
                raise HTTPException(status_code=404, detail=f"User not found: {target}")

    room = create_or_get_dm(username, targets, room_type=request.room_type)

    # Notify all participants
    for participant in [username] + targets:
        await bus.notify_user(participant, {"type": "room:update"})

    return CreateDMResponse(status="ok", room=RoomInfo(**room))


@router.delete("/{room_id}", response_model=DeleteRoomResponse)
async def delete_room_endpoint(
    room_id: str,
    username: str = Depends(require_auth)
):
    """Soft-delete a chat room. Requires room owner or global admin."""
    room_role = get_room_role(room_id, username)
    global_role = _get_global_role(username)
    if room_role != 'owner' and global_role != 'admin':
        raise HTTPException(status_code=403, detail="Room owner or admin required")
    if not delete_room(room_id, username):
        raise HTTPException(status_code=404, detail="Room not found")

    # Notify all subscribers — room removed from list
    await bus.notify_all_users({"type": "room:update"})

    return DeleteRoomResponse(status="ok", room_id=room_id)


@router.post("/{room_id}/members")
async def add_member(
    room_id: str,
    request: InviteRequest,
    username: str = Depends(require_auth),
):
    """Add a member to a room."""
    _check_room_access(room_id, username)

    result = add_room_member(room_id, request.username)

    if result['status'] == 'user_not_found':
        raise HTTPException(status_code=404, detail="User not found")
    if result['status'] == 'room_not_found':
        raise HTTPException(status_code=404, detail="Room not found")
    if result['status'] == 'already_member':
        raise HTTPException(status_code=400, detail="User is already a member")

    await bus.notify_user(request.username, {"type": "room:update"})

    # Notify room subscribers that membership changed
    await bus.broadcast_to_room(room_id, {
        "type": "room:members_updated",
        "room_id": room_id,
    })

    return {"status": "ok", "room_id": room_id, "username": request.username}


@router.delete("/{room_id}/members/{target_username}")
async def remove_member(
    room_id: str,
    target_username: str,
    username: str = Depends(require_auth),
):
    """Remove a member from a room. Regular users can only remove themselves, ops can remove others."""
    if is_dm(room_id):
        raise HTTPException(status_code=400, detail="Cannot leave or kick from a DM")
    if not room_exists(room_id):
        raise HTTPException(status_code=404, detail="Room not found")

    # Check permission: can always remove yourself, otherwise need op/mod/admin
    if target_username != username:
        _require_room_op_or_global_mod(room_id, username)

    result = remove_room_member(room_id, target_username)

    if result['status'] == 'not_member':
        raise HTTPException(status_code=400, detail="User is not a member of this room")
    if result['status'] == 'room_not_found':
        raise HTTPException(status_code=404, detail="Room not found")

    await bus.notify_user(target_username, {"type": "room:update"})

    # Notify room subscribers that membership changed
    await bus.broadcast_to_room(room_id, {
        "type": "room:members_updated",
        "room_id": room_id,
    })

    return {"status": "ok", "room_id": room_id, "username": target_username}


@router.patch("/{room_id}/members/{target_username}")
async def update_member(
    room_id: str,
    target_username: str,
    updates: MemberUpdateRequest,
    username: str = Depends(require_auth),
):
    """Update member properties. Users can update their own notify_level, ops can update roles."""
    _check_room_access(room_id, username)

    # Check if member exists
    role = get_room_role(room_id, target_username)
    if role is None:
        raise HTTPException(status_code=404, detail="User is not a member of this room")

    # Update notify_level (users can update their own)
    if updates.notify_level is not None:
        if target_username != username:
            raise HTTPException(status_code=403, detail="You can only change your own notification settings")
        set_notify_level(room_id, target_username, updates.notify_level)

    # Update room_role (requires op/mod/admin)
    if updates.room_role is not None:
        _require_room_op_or_global_mod(room_id, username)
        result = set_room_role(room_id, target_username, updates.room_role)
        if result['status'] != 'ok':
            raise HTTPException(status_code=400, detail="Failed to update role")

        # Notify room subscribers that membership changed
        await bus.broadcast_to_room(room_id, {
            "type": "room:members_updated",
            "room_id": room_id,
        })

    return {"status": "ok"}


@router.post("/{room_id}/keys")
async def store_room_key_endpoint(
    room_id: str,
    request: StoreRoomKeyRequest,
    username: str = Depends(require_auth),
):
    """Store an encrypted room key for a user."""
    _check_room_access(room_id, username)
    store_room_key(room_id, request.username, request.key_epoch, request.encrypted_key)
    return {"status": "ok"}


@router.get("/{room_id}/keys", response_model=RoomKeysResponse)
async def get_room_keys_endpoint(
    room_id: str,
    username: str = Depends(require_auth),
):
    """Get your encrypted room keys (all epochs)."""
    _check_room_access(room_id, username)
    keys = get_room_keys(room_id, username)
    return RoomKeysResponse(keys=keys)



@router.get("/{room_id}", response_model=RoomDetailResponse)
async def get_room_detail(
    room_id: str,
    username: str = Depends(require_auth),
):
    """Get detailed room info including topic and members with roles."""
    _check_room_access(room_id, username)
    info = get_room_info(room_id)
    if not info:
        raise HTTPException(status_code=404, detail="Room not found")
    return RoomDetailResponse(
        room_id=info['room_id'],
        room_type=info['room_type'],
        topic=info['topic'],
        created_by=info['created_by'],
        members=[MemberInfo(**m) for m in info['members']],
        is_dm=info.get('is_dm', False),
    )


@router.patch("/{room_id}")
async def update_room(
    room_id: str,
    updates: RoomUpdateRequest,
    username: str = Depends(require_auth),
):
    """Update room properties (e.g., topic). Requires room owner/op or global admin."""
    _check_room_access(room_id, username)
    _require_room_op_or_global_mod(room_id, username)

    if updates.topic is not None:
        if not set_topic(room_id, updates.topic):
            raise HTTPException(status_code=404, detail="Room not found")

        await bus.broadcast_to_room(room_id, {
            "type": "room:topic",
            "room_id": room_id,
            "topic": updates.topic,
            "set_by": username,
        })

    return {"status": "ok"}


def _check_room_access(room_id: str, username: str):
    """Verify room exists and user has access."""
    if not room_exists(room_id):
        ensure_room_exists(room_id)

    if is_dm(room_id):
        members = get_room_members(room_id)
        if username not in members:
            raise HTTPException(status_code=403, detail="Not a member of this DM")


def _get_global_role(username: str) -> str:
    """Get a user's global role."""
    from ..database import get_db
    with get_db() as conn:
        cursor = conn.execute(
            'SELECT role FROM users WHERE username = ?', (username,)
        )
        row = cursor.fetchone()
        return row['role'] if row else 'user'


def _require_room_op_or_global_mod(room_id: str, username: str):
    """Raise 403 unless the user is room owner/op or global admin/moderator."""
    room_role = get_room_role(room_id, username)
    if room_role in ('owner', 'op'):
        return
    global_role = _get_global_role(username)
    if global_role in ('admin', 'moderator'):
        return
    raise HTTPException(status_code=403, detail="Room op or moderator required")
