"""Namespace handlers for the unified WebSocket bus."""
from fastapi import WebSocket

from ..rooms.services import (
    room_exists,
    get_room_type,
    get_room_members,
    get_room_role,
    get_notify_level,
    get_unread_count_for_room,
    ChatRoom,
)


def check_room_access(room_id: str, username: str) -> str | None:
    """Check if a user can access a room.

    Returns an error message string if access is denied, or None if OK.
    """
    if not room_exists(room_id):
        return "Room not found"

    room_type = get_room_type(room_id)
    if room_type == "dm":
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
    """Handle room:* messages (join, leave, message)."""
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

    elif action == "message":
        if not room_id:
            await ws.send_json({"type": "room:error", "room_id": "", "message": "room_id required"})
            return

        error = check_room_access(room_id, username)
        if error:
            await ws.send_json({"type": "room:error", "room_id": room_id, "message": error})
            return

        content = msg.get("content", "")
        content_type = msg.get("content_type", "text")
        key_epoch = msg.get("key_epoch")

        room = ChatRoom(room_id)
        message_data = room.add_message(username, content, content_type, key_epoch)

        # Broadcast to all sockets subscribed to this room
        await bus.broadcast_to_room(room_id, {
            "type": "room:message",
            "room_id": room_id,
            "data": message_data,
        })

        # Notify other members (user-scoped) for sidebar badges / notifications
        room_type = get_room_type(room_id)
        members = get_room_members(room_id)
        for member in members:
            if member != username:
                level = get_notify_level(room_id, member)
                event_type = "room:new_message" if level == "all" else "room:update"
                unread_count = get_unread_count_for_room(room_id, member)
                await bus.notify_user(member, {
                    "type": event_type,
                    "room_id": room_id,
                    "room_type": room_type,
                    "sender": username,
                    "unread_count": unread_count,
                })

    else:
        await ws.send_json({"type": "room:error", "room_id": room_id or "", "message": f"Unknown room action: {action}"})


def register_core_handlers(bus):
    """Register the system and room namespace handlers on the bus."""
    bus.register_namespace("system", handle_system)
    bus.register_namespace("room", handle_room)
