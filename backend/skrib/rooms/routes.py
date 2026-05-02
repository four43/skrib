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
    get_notify_level,
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
from ..room_folders import services as folder_services
from ..room_folders.schemas import (
    CreateFolderRequest,
    CreateFolderResponse,
    FolderTreeResponse,
    FolderInfo,
    ReorderRequest,
    RoomPosition,
    UpdateFolderRequest,
)

router = APIRouter(prefix="/rooms", tags=["rooms"])



def _require_admin_or_mod(username: str):
    """Raise 403 unless user is admin or moderator."""
    role = _get_global_role(username)
    if role not in ('admin', 'moderator'):
        raise HTTPException(status_code=403, detail="Admin or moderator required")


async def _broadcast_folder_update():
    """Broadcast folder update to all connected users."""
    await bus.notify_all_users({"type": "room:folders_updated"})


@router.get("", response_model=list[RoomInfo])
async def list_rooms(username: str = Depends(require_auth)):
    """Get list of rooms visible to the current user."""
    rooms = await get_user_rooms(username)
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

    # Validate the room type is provided by a connected plugin
    from ..main import app as _app
    _plugin_bus = getattr(_app.state, 'plugin_bus', None)
    if not _plugin_bus or request.room_type not in _plugin_bus.room_type_map:
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
    from ..main import app as _app
    _plugin_bus = getattr(_app.state, 'plugin_bus', None)
    dm_plugin_id = get_setting('dm_room_type', 'four43.room-type-chat')
    dm_conn = _plugin_bus.get_plugin(dm_plugin_id) if _plugin_bus else None
    if not dm_conn or not dm_conn.room_types:
        raise HTTPException(
            status_code=500,
            detail=f"DM room type plugin '{dm_plugin_id}' is not available"
        )
    room_type = dm_conn.room_types[0]

    # Verify all target users exist
    from ..database import get_db
    with get_db() as conn:
        for target in targets:
            cursor = conn.execute(
                'SELECT username FROM users WHERE username = ?',
                (target,)
            )
            if not cursor.fetchone():
                raise HTTPException(status_code=404, detail="One or more users not found")

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
    results = search_rooms(q.strip().lower()[:100], username)
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


# ── Room Folders (under /rooms/folders) ──────────────────────────────────
# These MUST be defined before any {room_id} path parameters to avoid
# /rooms/folders being matched as room_id="folders".


@router.get("/folders", response_model=FolderTreeResponse)
async def get_folder_tree(username: str = Depends(require_auth)):
    """Get the full folder tree and room positions."""
    folders = folder_services.get_all_folders()
    room_positions = folder_services.get_room_positions()
    return FolderTreeResponse(
        folders=[FolderInfo(**f) for f in folders],
        room_positions=[RoomPosition(**r) for r in room_positions],
    )


@router.post("/folders", response_model=CreateFolderResponse)
async def create_folder(
    request: CreateFolderRequest,
    username: str = Depends(require_auth),
):
    _require_admin_or_mod(username)
    try:
        folder_id = folder_services.create_folder(
            name=request.name,
            parent_folder_id=request.parent_folder_id,
            created_by=username,
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))

    await _broadcast_folder_update()
    return CreateFolderResponse(folder_id=folder_id)


@router.patch("/folders/{folder_id}")
async def update_folder(
    folder_id: str,
    request: UpdateFolderRequest,
    username: str = Depends(require_auth),
):
    _require_admin_or_mod(username)

    kwargs = {}
    if request.name is not None:
        kwargs['name'] = request.name
    if request.position is not None:
        kwargs['position'] = request.position
    raw = request.model_dump(exclude_unset=True)
    if 'parent_folder_id' in raw:
        kwargs['parent_folder_id'] = request.parent_folder_id
    else:
        kwargs['parent_folder_id'] = folder_services._SENTINEL

    try:
        found = folder_services.update_folder(folder_id, **kwargs)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))

    if not found:
        raise HTTPException(status_code=404, detail="Folder not found")

    await _broadcast_folder_update()
    return {"ok": True}


@router.delete("/folders/{folder_id}")
async def delete_folder(
    folder_id: str,
    username: str = Depends(require_auth),
):
    _require_admin_or_mod(username)
    if not folder_services.delete_folder(folder_id):
        raise HTTPException(status_code=404, detail="Folder not found")

    await _broadcast_folder_update()
    return {"ok": True}


@router.post("/folders/reorder")
async def reorder(
    request: ReorderRequest,
    username: str = Depends(require_auth),
):
    _require_admin_or_mod(username)
    folder_dicts = [f.model_dump() for f in request.folders]
    room_dicts = [r.model_dump() for r in request.rooms]
    try:
        folder_services.batch_reorder(folder_dicts, room_dicts)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))

    await _broadcast_folder_update()
    return {"ok": True}


@router.delete("/{room_id}", response_model=DeleteRoomResponse)
async def delete_room_endpoint(
    room_id: str,
    username: str = Depends(require_auth)
):
    """Delete a chat room and all associated data. Requires room owner or global admin."""
    if is_dm(room_id):
        raise HTTPException(status_code=400, detail="Cannot delete a DM")
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
    if not is_dm(room_id):
        _require_room_op_or_global_mod(room_id, username)

    result = add_room_member(room_id, request.username)

    if result['status'] == 'user_not_found':
        raise HTTPException(status_code=404, detail="User not found or does not exist")
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
        raise HTTPException(status_code=404, detail="User is not a member of this room")
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

    # Update room_role (requires op/mod/admin, not allowed in DMs)
    if updates.room_role is not None:
        if is_dm(room_id):
            raise HTTPException(status_code=400, detail="Cannot change roles in a DM")
        _require_room_op_or_global_mod(room_id, username)
        result = set_room_role(room_id, target_username, updates.room_role)
        if result['status'] == 'not_member':
            raise HTTPException(status_code=404, detail="User is not a member of this room")
        if result['status'] == 'room_not_found':
            raise HTTPException(status_code=404, detail="Room not found")

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

    # Storing keys for another user requires op/owner/admin (e.g. during /invite)
    if request.username != username:
        _require_room_op_or_global_mod(room_id, username)
        # Target must be a room member
        if get_room_role(room_id, request.username) is None:
            raise HTTPException(status_code=403, detail="Target user is not a member of this room")

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
    """Update room properties (e.g., topic, visibility, folder).

    Topic/visibility require room membership + op/owner/admin.
    Folder placement requires global admin/moderator (no membership needed).
    """
    if not room_exists(room_id):
        raise HTTPException(status_code=404, detail="Room not found")

    raw = updates.model_dump(exclude_unset=True)
    has_room_fields = updates.topic is not None or updates.visibility is not None
    has_folder_fields = 'folder_id' in raw or 'sort_position' in raw

    # Topic/visibility changes need membership + op
    if has_room_fields:
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

    # Folder placement requires admin/mod (no membership needed)
    if has_folder_fields:
        _require_admin_or_mod(username)
        folder_id = raw.get('folder_id')  # may be None (unfile)
        sort_position = raw.get('sort_position', 0) or 0
        try:
            folder_services.move_room(room_id, folder_id, sort_position)
        except ValueError as e:
            raise HTTPException(status_code=400, detail=str(e))
        await _broadcast_folder_update()

    return {}
