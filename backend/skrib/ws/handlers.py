"""Namespace handlers for the unified WebSocket bus."""
import logging

from fastapi import WebSocket

from ..permissions import get_global_role
from ..rooms.services import (
    room_exists,
    is_dm,
    get_room_type,
    get_room_members,
    get_room_role,
)

logger = logging.getLogger(__name__)


def _get_bridge():
    """Get the plugin bus bridge if available."""
    try:
        from ..main import app
        return getattr(app.state, 'plugin_bus_bridge', None)
    except Exception:
        return None


def check_room_access(room_id: str, username: str) -> str | None:
    """Check if a user can access a room.

    Returns an error message string if access is denied, or None if OK.
    """
    if not room_exists(room_id):
        return "Room not found"

    members = get_room_members(room_id)
    if username not in members:
        return "Not a member of this room"

    return None


async def handle_system(bus, ws: WebSocket, username: str, msg: dict):
    """Handle system:* messages (ping/pong)."""
    action = msg["type"].split(":", 1)[1]

    if action == "ping":
        await ws.send_json({"type": "system:pong"})
    elif action == "pong":
        bus.record_pong(ws)
    else:
        await ws.send_json({"type": "system:error", "message": f"Unknown system action: {action}"})


async def handle_room(bus, ws: WebSocket, username: str, msg: dict):
    """Handle room:* messages.

    Core handles join/leave. All other actions are delegated to the
    room-type plugin (looked up via the plugin registry).
    """
    action = msg["type"].split(":", 1)[1]
    room_id = msg.get("room_id")

    if action == "join":
        if not room_id:
            await ws.send_json({"type": "room:error", "room_id": "", "message": "room_id required"})
            return

        error = check_room_access(room_id, username)
        if error:
            await ws.send_json({"type": "room:error", "room_id": room_id, "message": error})
            return

        bus.join_room(ws, room_id)
        await ws.send_json({"type": "room:joined", "room_id": room_id})

    elif action == "leave":
        if not room_id:
            await ws.send_json({"type": "room:error", "room_id": "", "message": "room_id required"})
            return

        bus.leave_room(ws, room_id)
        await ws.send_json({"type": "room:left", "room_id": room_id})

    else:
        # Delegate to room-type plugin
        if not room_id:
            await ws.send_json({"type": "room:error", "room_id": "", "message": "room_id required"})
            return

        error = check_room_access(room_id, username)
        if error:
            await ws.send_json({"type": "room:error", "room_id": room_id, "message": error})
            return

        room_type = get_room_type(room_id)
        user_role = get_global_role(username)
        room_role = get_room_role(room_id, username)
        reply_to = bus.create_reply_token(ws)

        try:
            bridge = _get_bridge()
            bus_plugin_id = bridge.get_bus_plugin_for_room_type(room_type) if bridge else None

            if bus_plugin_id and await bridge.dispatch_room_action(
                plugin_id=bus_plugin_id,
                room_id=room_id,
                action=action,
                username=username,
                msg=msg,
                reply_to=reply_to,
                user_role=user_role,
                room_role=room_role,
            ):
                return

            logger.error(
                "[WS] No plugin available for room_type=%s (bridge=%s, plugin_id=%s)",
                room_type, bool(bridge), bus_plugin_id,
            )
            await ws.send_json({
                "type": "room:error",
                "room_id": room_id,
                "message": "Plugin unavailable, please try again shortly",
            })
        finally:
            bus.invalidate_reply_token(reply_to)


def register_core_handlers(bus):
    """Register the system and room namespace handlers on the bus."""
    bus.register_namespace("system", handle_system)
    bus.register_namespace("room", handle_room)
