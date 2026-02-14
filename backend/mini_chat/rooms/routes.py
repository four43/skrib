"""Rooms API routes."""
from fastapi import APIRouter, HTTPException, Depends, WebSocket, WebSocketDisconnect
from typing import Optional
import json

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
)
from .services import (
    get_user_rooms,
    create_room,
    delete_room,
    ensure_room_exists,
    room_exists,
    get_room_type,
    get_room_members,
    create_or_get_dm,
    validate_channel_name,
    add_room_member,
    remove_room_member,
    store_room_key,
    get_room_keys,
    ChatRoom,
)
from .websocket import manager
from ..subscriptions import ListSubscriptionManager
from ..dependencies import require_auth, require_admin, require_moderator, verify_token

router = APIRouter(prefix="/rooms", tags=["rooms"])

# Room list subscription manager — clients subscribe via WS on /rooms
rooms_subscriptions = ListSubscriptionManager("rooms")


@router.get("", response_model=RoomListResponse)
async def list_rooms(username: str = Depends(require_auth)):
    """Get list of rooms visible to the current user."""
    rooms = get_user_rooms(username)
    return RoomListResponse(rooms=[RoomInfo(**r) for r in rooms])


@router.websocket("")
async def rooms_list_ws(websocket: WebSocket, token: Optional[str] = None):
    """WebSocket subscription for room list updates. Same path as GET /rooms."""
    if not token:
        await websocket.close(code=1008, reason="Authentication required")
        return

    username = verify_token(token)
    if not username:
        await websocket.close(code=1008, reason="Invalid token")
        return

    await rooms_subscriptions.connect(websocket, username)

    try:
        # Keep connection alive — client doesn't send anything meaningful
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        rooms_subscriptions.disconnect(websocket, username)
    except Exception:
        rooms_subscriptions.disconnect(websocket, username)


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

    if not create_room(request.room_id, room_type='channel'):
        raise HTTPException(status_code=400, detail="Room already exists")

    # Add creator as the first member
    add_room_member(request.room_id, username)

    # Notify creator — new channel appears in their room list
    await rooms_subscriptions.notify(username, {"type": "update"})

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
        await rooms_subscriptions.notify(participant, {"type": "update"})

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

    await manager.broadcast_to_room(room_id, {
        "type": "message",
        "data": message
    })

    return SendMessageResponse(status="ok", message=message)


@router.delete("/{room_id}", response_model=DeleteRoomResponse)
async def delete_room_endpoint(
    room_id: str,
    username: str = Depends(require_admin)
):
    """Soft-delete a chat room (admin only)."""
    if not delete_room(room_id, username):
        raise HTTPException(status_code=404, detail="Room not found")

    # Notify all subscribers — room removed from list
    await rooms_subscriptions.notify_all({"type": "update"})

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

    await rooms_subscriptions.notify(request.username, {"type": "update"})

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

    await rooms_subscriptions.notify(username, {"type": "update"})

    return RemoveMemberResponse(status="ok", room_id=room_id, username=username)


@router.delete("/{room_id}/members/{target_username}", response_model=RemoveMemberResponse)
async def kick_member_endpoint(
    room_id: str,
    target_username: str,
    username: str = Depends(require_moderator),
):
    """Kick a member from a channel. Requires moderator or admin."""
    room_type = get_room_type(room_id)
    if room_type == 'dm':
        raise HTTPException(status_code=400, detail="Cannot kick from a DM")
    if not room_type:
        raise HTTPException(status_code=404, detail="Room not found")

    result = remove_room_member(room_id, target_username)

    if result['status'] == 'not_member':
        raise HTTPException(status_code=400, detail="User is not a member of this room")
    if result['status'] == 'room_not_found':
        raise HTTPException(status_code=404, detail="Room not found")

    await rooms_subscriptions.notify(target_username, {"type": "update"})

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


@router.websocket("/{room_id}/ws")
async def websocket_endpoint(websocket: WebSocket, room_id: str, token: Optional[str] = None):
    """WebSocket endpoint for real-time chat in a room."""
    if not token:
        await websocket.close(code=1008, reason="Authentication required")
        return

    username = verify_token(token)
    if not username:
        await websocket.close(code=1008, reason="Invalid token")
        return

    # Check room access
    if not room_exists(room_id):
        ensure_room_exists(room_id)

    room_type = get_room_type(room_id)
    if room_type == 'dm':
        members = get_room_members(room_id)
        if username not in members:
            await websocket.close(code=1008, reason="Not a member of this DM")
            return

    await manager.connect(websocket, room_id)

    try:
        await websocket.send_json({
            "type": "connected",
            "room": room_id,
            "username": username
        })

        while True:
            data = await websocket.receive_text()

            try:
                payload = json.loads(data)

                if payload.get("type") == "message":
                    room = ChatRoom(room_id)
                    message = room.add_message(username, payload.get("message", ""))

                    await manager.broadcast_to_room(room_id, {
                        "type": "message",
                        "data": message
                    })

            except json.JSONDecodeError:
                await websocket.send_json({
                    "type": "error",
                    "message": "Invalid JSON"
                })

    except WebSocketDisconnect:
        manager.disconnect(websocket, room_id)
        print(f"[WS] User {username} disconnected from room {room_id}")
    except Exception as e:
        print(f"[WS] Error in WebSocket connection: {e}")
        manager.disconnect(websocket, room_id)


def _check_room_access(room_id: str, username: str):
    """Verify room exists and user has access."""
    if not room_exists(room_id):
        ensure_room_exists(room_id)

    room_type = get_room_type(room_id)
    if room_type == 'dm':
        members = get_room_members(room_id)
        if username not in members:
            raise HTTPException(status_code=403, detail="Not a member of this DM")
