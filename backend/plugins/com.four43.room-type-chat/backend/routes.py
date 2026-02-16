"""HTTP routes for chat message operations."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent.parent.parent))

from fastapi import APIRouter, HTTPException, Depends
from pydantic import BaseModel
from typing import List, Optional

from mini_chat.dependencies import require_auth
from mini_chat.rooms.services import (
    room_exists,
    is_dm,
    get_room_members,
    get_notify_level,
    get_unread_count_for_room,
    mark_room_read,
    ensure_room_exists,
)
from mini_chat.ws import bus

# Injected by plugin.py after module load
ChatRoom = None

router = APIRouter()


# --- Schemas ---

class MessageResponse(BaseModel):
    id: int
    username: str
    content: str
    content_type: str = 'text'
    key_epoch: Optional[int] = None
    timestamp: str


class SendMessageRequest(BaseModel):
    content: str
    content_type: str = 'text'
    key_epoch: Optional[int] = None


class SendMessageResponse(BaseModel):
    status: str
    message: MessageResponse


class MessagesResponse(BaseModel):
    status: str
    messages: List[MessageResponse]


class MarkReadRequest(BaseModel):
    last_read_message_id: int


# --- Helpers ---

def _check_room_access(room_id: str, username: str):
    """Verify room exists and user has access."""
    if not room_exists(room_id):
        ensure_room_exists(room_id)

    if is_dm(room_id):
        members = get_room_members(room_id)
        if username not in members:
            raise HTTPException(status_code=403, detail="Not a member of this DM")


# --- Endpoints ---

@router.get("/rooms/{room_id}/messages", response_model=MessagesResponse)
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

    await bus.broadcast_to_room(room_id, {
        "type": "room:message",
        "room_id": room_id,
        "data": message,
    })

    # Notify other room members so their sidebar unread counts refresh
    members = get_room_members(room_id)
    for member in members:
        if member != username:
            level = get_notify_level(room_id, member)
            event_type = "room:new_message" if level == "all" else "room:update"
            unread_count = get_unread_count_for_room(room_id, member)
            await bus.notify_user(member, {
                "type": event_type,
                "room_id": room_id,
                "sender": username,
                "unread_count": unread_count,
            })

    return SendMessageResponse(status="ok", message=message)


@router.post("/rooms/{room_id}/read")
async def mark_read_endpoint(
    room_id: str,
    request: MarkReadRequest,
    username: str = Depends(require_auth),
):
    """Mark messages in a room as read up to a given message ID."""
    _check_room_access(room_id, username)
    mark_room_read(room_id, username, request.last_read_message_id)
    return {"status": "ok"}
