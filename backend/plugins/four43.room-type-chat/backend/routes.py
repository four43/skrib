"""HTTP routes for chat message operations."""
from fastapi import APIRouter, HTTPException, Depends
from pydantic import BaseModel
from typing import List, Optional

from skrib.dependencies import require_auth
from skrib.permissions import check_room_access as _check_room_access
from skrib.rooms.services import (
    get_room_members,
    get_notify_level,
    get_unread_count_for_room,
    mark_room_read,
)
# Injected by plugin.py after module load
ChatRoom = None
plugin_bus = None  # PluginBus scoped to this plugin's namespace

router = APIRouter(tags=["Plugin: four43/room-type-chat"])

# --- Schemas ---

class MessageResponse(BaseModel):
    id: int
    username: str
    content: str
    content_type: str = 'text'
    key_epoch: Optional[int] = None
    timestamp: str
    edited_at: Optional[str] = None
    deleted: bool = False


class SendMessageRequest(BaseModel):
    content: str
    content_type: str = 'text'
    key_epoch: Optional[int] = None


class SendMessageResponse(BaseModel):
    message: MessageResponse


class MarkReadRequest(BaseModel):
    last_read_message_id: int


# --- Endpoints ---

@router.get("/rooms/{room_id}/messages", response_model=list[MessageResponse])
async def get_room_messages(
    room_id: str,
    since: int = 0,
    username: str = Depends(require_auth),
):
    """Get messages from a specific room."""
    _check_room_access(room_id, username)

    room = ChatRoom(room_id)
    return room.get_messages(since)


@router.post("/rooms/{room_id}/messages", response_model=SendMessageResponse)
async def send_room_message(
    room_id: str,
    request: SendMessageRequest,
    username: str = Depends(require_auth),
):
    """Send a message to a specific room."""
    _check_room_access(room_id, username)

    room = ChatRoom(room_id)
    message = room.add_message(
        username,
        request.content,
        request.content_type,
        request.key_epoch
    )

    await plugin_bus.broadcast_to_room(room_id, "message", data=message)

    # Notify other room members so their sidebar unread counts refresh
    members = get_room_members(room_id)
    for member in members:
        if member != username:
            level = get_notify_level(room_id, member)
            notify_action = "new_message" if level == "all" else "update"
            unread_count = get_unread_count_for_room(room_id, member)
            await plugin_bus.notify_user(
                member, notify_action,
                room_id=room_id, sender=username, unread_count=unread_count,
            )

    return SendMessageResponse(message=message)


@router.post("/rooms/{room_id}/read")
async def mark_read_endpoint(
    room_id: str,
    request: MarkReadRequest,
    username: str = Depends(require_auth),
):
    """Mark messages in a room as read up to a given message ID."""
    _check_room_access(room_id, username)
    mark_room_read(room_id, username, request.last_read_message_id)
    return {}
