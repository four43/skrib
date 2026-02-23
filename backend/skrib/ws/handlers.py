"""Namespace handlers for the unified WebSocket bus."""
from fastapi import WebSocket

from ..plugins import registry
from ..plugins.base import PluginBus
from ..rooms.services import (
    room_exists,
    is_dm,
    get_room_type,
    get_room_members,
)


def check_room_access(room_id: str, username: str) -> str | None:
    """Check if a user can access a room.

    Returns an error message string if access is denied, or None if OK.
    """
    if not room_exists(room_id):
        return "Room not found"

    if is_dm(room_id):
        members = get_room_members(room_id)
        if username not in members:
            return "Not a member of this DM"

    return None


async def handle_system(bus, ws: WebSocket, username: str, msg: dict):
    """Handle system:* messages (ping/pong)."""
    action = msg["type"].split(":", 1)[1]

    if action == "ping":
        await ws.send_json({"type": "system:pong"})
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
        plugin = registry.get_plugin_for_room_type(room_type)
        if plugin:
            room_bus = PluginBus(bus, plugin.id)
            await plugin.handle_room_action(room_bus, ws, username, msg, action)
        else:
            await ws.send_json({
                "type": "room:error",
                "room_id": room_id,
                "message": f"No plugin handles room type '{room_type}'",
            })


def register_core_handlers(bus):
    """Register the system and room namespace handlers on the bus."""
    bus.register_namespace("system", handle_system)
    bus.register_namespace("room", handle_room)
