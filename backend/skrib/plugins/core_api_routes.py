"""HTTP endpoints exposing CoreAPI for out-of-process plugins.

These endpoints mirror the methods on CoreAPI (core_api.py) but are accessible
over HTTP. Bus-connected plugins call these via the middleware proxy, while
in-process plugins continue using the CoreAPI object.

All endpoints require a valid plugin connection (X-Skrib-Plugin-Id header
must match a connected, approved plugin on the bus).
"""
from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel
from typing import Optional


router = APIRouter(prefix="/core", tags=["core-api"])


def _get_core_api():
    """Lazy import to avoid circular imports at module level."""
    from ..plugins.core_api import CoreAPI
    from .. import ws
    return CoreAPI(bus=ws.bus)


def _get_bus_server():
    """Lazy import to get the bus server instance."""
    from ..main import app
    return getattr(app.state, "plugin_bus", None)


def require_plugin_auth(request: Request) -> str:
    """Dependency that validates the request comes from an approved plugin.

    Checks X-Skrib-Plugin-Id header against connected bus plugins.
    Returns the plugin_id.
    """
    plugin_id = request.headers.get("x-skrib-plugin-id")
    if not plugin_id:
        raise HTTPException(status_code=403, detail="Missing X-Skrib-Plugin-Id header")

    bus = _get_bus_server()
    if not bus:
        raise HTTPException(status_code=503, detail="Plugin bus not available")

    from ..plugin_bus.protocol import ApprovalStatus
    conn = bus.get_plugin(plugin_id)
    if not conn or conn.status != ApprovalStatus.APPROVED:
        raise HTTPException(status_code=403, detail=f"Plugin '{plugin_id}' not connected or not approved")

    return plugin_id


# ------------------------------------------------------------------
# Schemas
# ------------------------------------------------------------------

class MarkReadRequest(BaseModel):
    message_id: int


# ------------------------------------------------------------------
# Endpoints
# ------------------------------------------------------------------

@router.get("/rooms/{room_id}/members")
async def get_room_members(room_id: str, plugin_id: str = Depends(require_plugin_auth)):
    """List usernames that are members of a room."""
    core_api = _get_core_api()
    members = core_api.get_room_members(room_id)
    return {"members": members}


@router.get("/rooms/{room_id}")
async def get_room_info(room_id: str, plugin_id: str = Depends(require_plugin_auth)):
    """Get full room details including members with roles."""
    core_api = _get_core_api()
    info = core_api.get_room_info(room_id)
    if info is None:
        raise HTTPException(status_code=404, detail="Room not found")
    return info


@router.get("/rooms/{room_id}/members/{username}")
async def get_member_details(room_id: str, username: str, plugin_id: str = Depends(require_plugin_auth)):
    """Get member details including notification level."""
    core_api = _get_core_api()
    notify_level = core_api.get_notify_level(room_id, username)
    return {"username": username, "room_id": room_id, "notify_level": notify_level}


@router.post("/rooms/{room_id}/read")
async def mark_room_read(room_id: str, body: MarkReadRequest, request: Request, plugin_id: str = Depends(require_plugin_auth)):
    """Mark a room as read up to a given message ID."""
    username = request.headers.get("x-skrib-username")
    if not username:
        raise HTTPException(status_code=401, detail="Unauthorized")
    core_api = _get_core_api()
    core_api.mark_room_read(room_id, username, body.message_id)
    return {"ok": True}


@router.get("/users/{username}/presence")
async def get_user_presence(username: str, plugin_id: str = Depends(require_plugin_auth)):
    """Check if a user has any active WebSocket connections."""
    core_api = _get_core_api()
    connected = core_api.is_user_connected(username)
    return {"username": username, "connected": connected}
