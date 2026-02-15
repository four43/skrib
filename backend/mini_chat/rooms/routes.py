"""Rooms API routes."""
from fastapi import APIRouter, HTTPException, Depends

from .schemas import (
    RoomListResponse,
    RoomInfo,
    CreateRoomRequest,
    CreateRoomResponse,
    CreateDMRequest,
    CreateDMResponse,
    SendMessageRequest,
    SendMessageResponse,
    MessagesResponse,
    DeleteRoomResponse,
    AddMemberRequest,
    AddMemberResponse,
    RemoveMemberResponse,
    StoreRoomKeyRequest,
    RoomKeysResponse,
    MarkReadRequest,
    UpdateNotifyLevelRequest,
    RoomDetailResponse,
    MemberInfo,
    SetTopicRequest,
    SetRoomRoleRequest,
)
from .services import (
    get_user_rooms,
    create_room,
    delete_room,
    ensure_room_exists,
    room_exists,
    get_room_type,
    get_room_members,
    get_room_role,
    create_or_get_dm,
    validate_channel_name,
    add_room_member,
    remove_room_member,
    store_room_key,
    get_room_keys,
    mark_room_read,
    set_notify_level,
    get_notify_level,
    set_topic,
    get_room_info,
    set_room_role,
    ChatRoom,
)
from ..ws import bus
from ..dependencies import require_auth

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

    if not create_room(request.room_id, room_type='channel', created_by=username):
        raise HTTPException(status_code=400, detail="Room already exists")

    # Add creator as owner
    add_room_member(request.room_id, username, room_role='owner')

    # Notify creator — new channel appears in their room list
    await bus.notify_user(username, {"type": "room.update"})

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

    room = create_or_get_dm(username, targets)

    # Notify all participants
    for participant in [username] + targets:
        await bus.notify_user(participant, {"type": "room.update"})

    return CreateDMResponse(status="ok", room=RoomInfo(**room))


@router.get("/{room_id}/messages", response_model=MessagesResponse)
async def get_room_messages(
    room_id: str,
    since: int = 0,
    username: str = Depends(require_auth),
):
    """Get messages from a specific room."""
    _check_room_access(room_id, username)

    room = ChatRoom(room_id)
    messages = room.get_messages(since)

    return MessagesResponse(status="ok", messages=messages)


@router.post("/{room_id}/messages", response_model=SendMessageResponse)
async def send_room_message(
    room_id: str,
    request: SendMessageRequest,
    username: str = Depends(require_auth)
):
    """Send a message to a specific room."""
    _check_room_access(room_id, username)

    room = ChatRoom(room_id)
    message = room.add_message(username, request.message)

    await bus.broadcast_to_room(room_id, {
        "type": "room.message",
        "room_id": room_id,
        "data": message,
    })

    # Notify other room members so their sidebar unread counts refresh
    room_type = get_room_type(room_id)
    members = get_room_members(room_id)
    for member in members:
        if member != username:
            level = get_notify_level(room_id, member)
            event_type = "room.new_message" if level == "all" else "room.update"
            await bus.notify_user(member, {
                "type": event_type,
                "room_id": room_id,
                "room_type": room_type,
                "sender": username,
            })

    return SendMessageResponse(status="ok", message=message)


@router.post("/{room_id}/read")
async def mark_read_endpoint(
    room_id: str,
    request: MarkReadRequest,
    username: str = Depends(require_auth),
):
    """Mark messages in a room as read up to a given message ID."""
    _check_room_access(room_id, username)
    mark_room_read(room_id, username, request.last_read_message_id)
    return {"status": "ok"}


@router.put("/{room_id}/notify")
async def update_notify_level_endpoint(
    room_id: str,
    request: UpdateNotifyLevelRequest,
    username: str = Depends(require_auth),
):
    """Set the notification level for the current user in a room."""
    _check_room_access(room_id, username)
    set_notify_level(room_id, username, request.notify_level)
    return {"status": "ok", "notify_level": request.notify_level}


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
    await bus.notify_all_users({"type": "room.update"})

    return DeleteRoomResponse(status="ok", room_id=room_id)


@router.post("/{room_id}/members", response_model=AddMemberResponse)
async def add_member_endpoint(
    room_id: str,
    request: AddMemberRequest,
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

    await bus.notify_user(request.username, {"type": "room.update"})

    return AddMemberResponse(status="ok", room_id=room_id, username=request.username)


@router.delete("/{room_id}/members/me", response_model=RemoveMemberResponse)
async def leave_room_endpoint(
    room_id: str,
    username: str = Depends(require_auth),
):
    """Leave a channel. Cannot leave DMs."""
    room_type = get_room_type(room_id)
    if room_type == 'dm':
        raise HTTPException(status_code=400, detail="Cannot leave a DM")
    if not room_type:
        raise HTTPException(status_code=404, detail="Room not found")

    result = remove_room_member(room_id, username)

    if result['status'] == 'not_member':
        raise HTTPException(status_code=400, detail="You are not a member of this room")
    if result['status'] == 'room_not_found':
        raise HTTPException(status_code=404, detail="Room not found")

    await bus.notify_user(username, {"type": "room.update"})

    return RemoveMemberResponse(status="ok", room_id=room_id, username=username)


@router.delete("/{room_id}/members/{target_username}", response_model=RemoveMemberResponse)
async def kick_member_endpoint(
    room_id: str,
    target_username: str,
    username: str = Depends(require_auth),
):
    """Kick a member from a channel. Requires room owner/op or global admin/moderator."""
    room_type = get_room_type(room_id)
    if room_type == 'dm':
        raise HTTPException(status_code=400, detail="Cannot kick from a DM")
    if not room_type:
        raise HTTPException(status_code=404, detail="Room not found")

    # Check permission: room owner/op OR global admin/moderator
    _require_room_op_or_global_mod(room_id, username)

    result = remove_room_member(room_id, target_username)

    if result['status'] == 'not_member':
        raise HTTPException(status_code=400, detail="User is not a member of this room")
    if result['status'] == 'room_not_found':
        raise HTTPException(status_code=404, detail="Room not found")

    await bus.notify_user(target_username, {"type": "room.update"})

    return RemoveMemberResponse(status="ok", room_id=room_id, username=target_username)


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
    )


@router.put("/{room_id}/topic")
async def set_topic_endpoint(
    room_id: str,
    request: SetTopicRequest,
    username: str = Depends(require_auth),
):
    """Set a room's topic. Requires room owner/op or global admin."""
    _check_room_access(room_id, username)
    _require_room_op_or_global_mod(room_id, username)

    if not set_topic(room_id, request.topic):
        raise HTTPException(status_code=404, detail="Room not found")

    await bus.broadcast_to_room(room_id, {
        "type": "room.topic",
        "room_id": room_id,
        "topic": request.topic,
        "set_by": username,
    })

    return {"status": "ok", "topic": request.topic}


@router.put("/{room_id}/role")
async def set_room_role_endpoint(
    room_id: str,
    request: SetRoomRoleRequest,
    username: str = Depends(require_auth),
):
    """Set a member's role in a room. Requires room owner."""
    _check_room_access(room_id, username)

    room_role = get_room_role(room_id, username)
    global_role = _get_global_role(username)
    if room_role != 'owner' and global_role != 'admin':
        raise HTTPException(status_code=403, detail="Room owner or admin required")

    result = set_room_role(room_id, request.username, request.role)
    if result['status'] == 'not_member':
        raise HTTPException(status_code=400, detail="User is not a member of this room")
    if result['status'] == 'room_not_found':
        raise HTTPException(status_code=404, detail="Room not found")

    return {"status": "ok", "username": request.username, "role": request.role}


def _check_room_access(room_id: str, username: str):
    """Verify room exists and user has access."""
    if not room_exists(room_id):
        ensure_room_exists(room_id)

    room_type = get_room_type(room_id)
    if room_type == 'dm':
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
