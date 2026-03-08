"""HTTP routes for chat message operations."""
from fastapi import APIRouter, Depends, Query, Request
from pydantic import BaseModel
from typing import Optional

from skrib.plugins.auth import plugin_user, check_room_access

# Injected by plugin.py after module load
ChatRoom = None
plugin_bus = None  # PluginBus scoped to this plugin's namespace
core_api = None  # CoreAPI for querying core data
link_preview_service = None  # LinkPreviewService, injected by plugin.py

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
    request: Request,
    since: int = 0,
    before: Optional[int] = Query(None, description="Return messages with id < before"),
    limit: Optional[int] = Query(None, ge=1, le=500, description="Max messages to return"),
    username: str = Depends(plugin_user),
):
    """Get messages from a specific room.

    Pagination modes:
    - ``?limit=50`` — most recent 50 messages
    - ``?before=123&limit=50`` — 50 messages older than id 123
    - ``?since=100`` — all messages newer than id 100 (real-time catch-up)
    """
    check_room_access(request, room_id)

    room = ChatRoom(room_id)
    return room.get_messages(since=since, before=before, limit=limit)


@router.post("/rooms/{room_id}/messages", response_model=SendMessageResponse)
async def send_room_message(
    room_id: str,
    body: SendMessageRequest,
    request: Request,
    username: str = Depends(plugin_user),
):
    """Send a message to a specific room."""
    check_room_access(request, room_id)

    room = ChatRoom(room_id)
    message = room.add_message(
        username,
        body.content,
        body.content_type,
        body.key_epoch
    )

    await plugin_bus.broadcast_to_room(room_id, "message", data=message)

    # Notify other room members so their sidebar unread counts refresh
    members = core_api.get_room_members(room_id)
    for member in members:
        if member != username:
            level = core_api.get_notify_level(room_id, member)
            notify_action = "new_message" if level == "all" else "update"
            unread_count = core_api.get_unread_count(room_id, member)
            await plugin_bus.notify_user(
                member, notify_action,
                room_id=room_id, sender=username, unread_count=unread_count,
            )

    return SendMessageResponse(message=message)


@router.post("/rooms/{room_id}/read")
async def mark_read_endpoint(
    room_id: str,
    body: MarkReadRequest,
    request: Request,
    username: str = Depends(plugin_user),
):
    """Mark messages in a room as read up to a given message ID."""
    check_room_access(request, room_id)
    core_api.mark_room_read(room_id, username, body.last_read_message_id)
    return {}


# --- Link preview ---

class LinkPreviewResponse(BaseModel):
    url: str
    content_type: str = 'webpage'
    title: str = ''
    description: str = ''
    image: str = ''
    site_name: str = ''


@router.get("/link-preview", response_model=LinkPreviewResponse)
async def get_link_preview(
    url: str = Query(..., description="URL to fetch a preview for"),
    username: str = Depends(plugin_user),
):
    """Fetch (or return cached) Open Graph preview data for a URL."""
    return link_preview_service.fetch_preview(url)
