"""HTTP endpoints exposing CoreAPI for out-of-process plugins.

These endpoints mirror the methods on CoreAPI (core_api.py) but are accessible
over HTTP. Bus-connected plugins call these directly, while in-process plugins
continue using the CoreAPI object.

All endpoints require plugin-level authentication via the X-Skrib-Plugin-Id
and X-Skrib-Plugin-Secret headers, or a valid user Bearer token (middleware
injects x-skrib-username).
"""
from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel
from typing import Optional


router = APIRouter(prefix="/core", tags=["core-api"])


def _get_core_api():
    """Lazy import to avoid circular imports at module level."""
    from ..plugins.core_api import CoreAPI
    from .. import ws
    return CoreAPI(bus=ws.bus)


# ------------------------------------------------------------------
# Schemas
# ------------------------------------------------------------------

class MarkReadRequest(BaseModel):
    message_id: int


# ------------------------------------------------------------------
# Endpoints
# ------------------------------------------------------------------

@router.get("/rooms/{room_id}/members")
async def get_room_members(room_id: str):
    """List usernames that are members of a room."""
    core_api = _get_core_api()
    members = core_api.get_room_members(room_id)
    return {"members": members}


@router.get("/rooms/{room_id}")
async def get_room_info(room_id: str):
    """Get full room details including members with roles."""
    core_api = _get_core_api()
    info = core_api.get_room_info(room_id)
    if info is None:
        raise HTTPException(status_code=404, detail="Room not found")
    return info


@router.get("/rooms/{room_id}/members/{username}")
async def get_member_details(room_id: str, username: str):
    """Get member details including notification level."""
    core_api = _get_core_api()
    notify_level = core_api.get_notify_level(room_id, username)
    return {"username": username, "room_id": room_id, "notify_level": notify_level}


@router.post("/rooms/{room_id}/read")
async def mark_room_read(room_id: str, body: MarkReadRequest, request: Request):
    """Mark a room as read up to a given message ID."""
    username = request.headers.get("x-skrib-username")
    if not username:
        raise HTTPException(status_code=401, detail="Unauthorized")
    core_api = _get_core_api()
    core_api.mark_room_read(room_id, username, body.message_id)
    return {"ok": True}


@router.get("/users/{username}/presence")
async def get_user_presence(username: str):
    """Check if a user has any active WebSocket connections."""
    core_api = _get_core_api()
    connected = core_api.is_user_connected(username)
    return {"username": username, "connected": connected}
