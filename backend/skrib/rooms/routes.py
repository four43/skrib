"""Rooms API routes."""
from fastapi import APIRouter, HTTPException, Depends

from .schemas import (
    RoomInfo,
    CreateRoomRequest,
    CreateRoomResponse,
    CreateDMRequest,
    CreateDMResponse,
    DeleteRoomResponse,
    InviteRequest,
    StoreRoomKeyRequest,
    RoomKeyEntry,
    RoomDetailResponse,
    MemberInfo,
    RoomUpdateRequest,
    MemberUpdateRequest,
    RoomSearchResult,
    JoinRequestInfo,
    JoinRequestAction,
)
from .services import (
    get_user_rooms,
    create_room,
    delete_room,
    room_exists,
    is_dm,
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
    search_rooms,
    check_room_name_available,
    set_visibility,
    create_join_request,
    get_join_requests,
    resolve_join_request,
    get_room_ops,
)
from ..ws import bus
from ..dependencies import require_auth
from ..permissions import check_room_access as _check_room_access, get_global_role as _get_global_role, require_room_op_or_global_mod as _require_room_op_or_global_mod
from ..database import get_setting
from ..plugins import registry

router = APIRouter(prefix="/rooms", tags=["rooms"])


@router.get("", response_model=list[RoomInfo])
async def list_rooms(username: str = Depends(require_auth)):
    """Get list of rooms visible to the current user."""
    rooms = get_user_rooms(username)
    return [RoomInfo(**r) for r in rooms]



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

    if not create_room(request.room_id, room_type=request.room_type, created_by=username, visibility=request.visibility):
        raise HTTPException(status_code=400, detail="Room already exists")

    # Add creator as owner
    add_room_member(request.room_id, username, room_role='owner')

    # Emit lifecycle event
    await bus.emit_event({
        "type": "core:room_created",
        "room_id": request.room_id,
        "room_type": request.room_type,
        "creator": username,
    })

    # Notify creator — new channel appears in their room list
    await bus.notify_user(username, {"type": "room:update"})

    return CreateRoomResponse(room_id=request.room_id)


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

    # Resolve DM room type from server setting (plugin ID -> room type)
    dm_plugin_id = get_setting('dm_room_type', 'four43.room-type-chat')
    dm_plugin = registry.get_plugin(dm_plugin_id)
    if not dm_plugin or not dm_plugin.room_types:
        raise HTTPException(
            status_code=500,
            detail=f"DM room type plugin '{dm_plugin_id}' is not available"
        )
    room_type = dm_plugin.room_types[0]

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

    room = create_or_get_dm(username, targets, room_type=room_type)

    # Notify all participants
    for participant in [username] + targets:
        await bus.notify_user(participant, {"type": "room:update"})

    return CreateDMResponse(room=RoomInfo(**room))


@router.get("/search", response_model=list[RoomSearchResult])
async def search_rooms_endpoint(
    q: str = '',
    username: str = Depends(require_auth),
):
    """Search for public rooms by name. Returns rooms the user is not already a member of."""
    if not q.strip():
        return []
    results = search_rooms(q.strip().lower(), username)
    return [RoomSearchResult(**r) for r in results]


@router.get("/check-name")
async def check_room_name(
    name: str = '',
    username: str = Depends(require_auth),
):
    """Check if a room name is available for creation."""
    if not name.strip():
        return {'available': False, 'reason': 'Name is required'}
    return check_room_name_available(name.strip().lower())


@router.delete("/{room_id}", response_model=DeleteRoomResponse)
async def delete_room_endpoint(
    room_id: str,
    username: str = Depends(require_auth)
):
    """Delete a chat room and all associated data. Requires room owner or global admin."""
    room_role = get_room_role(room_id, username)
    global_role = _get_global_role(username)
    if room_role != 'owner' and global_role != 'admin':
        raise HTTPException(status_code=403, detail="Room owner or admin required")

    room_type = delete_room(room_id, username)
    if not room_type:
        raise HTTPException(status_code=404, detail="Room not found")

    # Emit lifecycle event so plugins can clean up their own data
    await bus.emit_event({
        "type": "core:room_deleted",
        "room_id": room_id,
        "room_type": room_type,
    })

    # Notify all subscribers — room removed from list
    await bus.notify_all_users({"type": "room:update"})

    return DeleteRoomResponse(room_id=room_id)


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

    return {"room_id": room_id, "username": request.username}


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

    return {"room_id": room_id, "username": target_username}


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

    return {}


@router.post("/{room_id}/keys")
async def store_room_key_endpoint(
    room_id: str,
    request: StoreRoomKeyRequest,
    username: str = Depends(require_auth),
):
    """Store an encrypted room key for a user."""
    _check_room_access(room_id, username)
    store_room_key(room_id, request.username, request.key_epoch, request.encrypted_key)
    return {}


@router.get("/{room_id}/keys", response_model=list[RoomKeyEntry])
async def get_room_keys_endpoint(
    room_id: str,
    username: str = Depends(require_auth),
):
    """Get your encrypted room keys (all epochs)."""
    _check_room_access(room_id, username)
    return get_room_keys(room_id, username)



@router.post("/{room_id}/join-requests")
async def submit_join_request(
    room_id: str,
    username: str = Depends(require_auth),
):
    """Submit a request to join a public room."""
    result = create_join_request(room_id, username)

    if result['status'] == 'room_not_found':
        raise HTTPException(status_code=404, detail="Room not found")
    if result['status'] == 'not_public':
        raise HTTPException(status_code=400, detail="Room is not public")
    if result['status'] == 'already_member':
        raise HTTPException(status_code=400, detail="You are already a member of this room")
    if result['status'] == 'already_pending':
        raise HTTPException(status_code=400, detail="You already have a pending request for this room")

    # Notify room ops
    ops = get_room_ops(room_id)
    for op_username in ops:
        await bus.notify_user(op_username, {
            "type": "room:join_request",
            "room_id": room_id,
            "username": username,
        })

    return {"status": "created"}


@router.get("/{room_id}/join-requests", response_model=list[JoinRequestInfo])
async def list_join_requests(
    room_id: str,
    username: str = Depends(require_auth),
):
    """List pending join requests for a room. Requires op/owner or global admin/mod."""
    _check_room_access(room_id, username)
    _require_room_op_or_global_mod(room_id, username)

    requests = get_join_requests(room_id)
    return [JoinRequestInfo(**r) for r in requests]


@router.patch("/{room_id}/join-requests/{target_username}")
async def resolve_join_request_endpoint(
    room_id: str,
    target_username: str,
    action: JoinRequestAction,
    username: str = Depends(require_auth),
):
    """Approve or deny a join request. Requires op/owner or global admin/mod."""
    _check_room_access(room_id, username)
    _require_room_op_or_global_mod(room_id, username)

    result = resolve_join_request(room_id, target_username, action.action, username)

    if result['status'] == 'not_found':
        raise HTTPException(status_code=404, detail="No pending join request found")

    # Notify the requester of the decision
    await bus.notify_user(target_username, {
        "type": "room:join_resolved",
        "room_id": room_id,
        "action": result['status'],
    })

    if result['status'] == 'approved':
        # Requester's room list changed
        await bus.notify_user(target_username, {"type": "room:update"})
        # Room members changed
        await bus.broadcast_to_room(room_id, {
            "type": "room:members_updated",
            "room_id": room_id,
        })

    return {"status": result['status']}


@router.get("/{room_id}/members/{target_username}")
async def get_member_detail(
    room_id: str,
    target_username: str,
    username: str = Depends(require_auth),
):
    """Get a single member's details (role, notify_level) in a room."""
    _check_room_access(room_id, username)
    from .services import get_room_role, get_notify_level
    role = get_room_role(room_id, target_username)
    if role is None:
        raise HTTPException(status_code=404, detail="User is not a member of this room")
    notify_level = get_notify_level(room_id, target_username)
    return {"username": target_username, "room_role": role, "notify_level": notify_level}


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
        visibility=info.get('visibility', 'private'),
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
    """Update room properties (e.g., topic, visibility). Requires room owner/op or global admin."""
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

    if updates.visibility is not None:
        if is_dm(room_id):
            raise HTTPException(status_code=400, detail="Cannot change visibility of a DM")
        if not set_visibility(room_id, updates.visibility):
            raise HTTPException(status_code=404, detail="Room not found")

        await bus.broadcast_to_room(room_id, {
            "type": "room:visibility_changed",
            "room_id": room_id,
            "visibility": updates.visibility,
        })

    return {}


