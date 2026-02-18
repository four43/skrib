"""WebSocket handlers for reactions plugin."""
from . import database as db

# Plugin namespace - must match plugin ID
PLUGIN_NAMESPACE = "four43.message-reactions"


async def handle_reaction(bus, ws, username, msg):
    """Handle reaction WebSocket messages.

    Args:
        bus: UnifiedConnectionManager instance
        ws: WebSocket connection
        username: Authenticated username
        msg: WebSocket message dict
    """
    action = msg["type"].split(":", 1)[1]
    message_id = msg.get("message_id")
    emoji = msg.get("emoji")
    room_id = msg.get("room_id")

    if action == "add":
        success = db.add_reaction(message_id, username, emoji)
        if success:
            # Broadcast to all users in the room
            await bus.broadcast_to_room(room_id, {
                "type": f"{PLUGIN_NAMESPACE}:added",
                "room_id": room_id,
                "data": {
                    "message_id": message_id,
                    "emoji": emoji,
                    "username": username
                }
            })
            print(f"[Reactions] {username} added {emoji} to message {message_id}")

    elif action == "remove":
        db.remove_reaction(message_id, username, emoji)
        # Broadcast removal to all users in the room
        await bus.broadcast_to_room(room_id, {
            "type": f"{PLUGIN_NAMESPACE}:removed",
            "room_id": room_id,
            "data": {
                "message_id": message_id,
                "emoji": emoji,
                "username": username
            }
        })
        print(f"[Reactions] {username} removed {emoji} from message {message_id}")


def register_ws_handlers(bus):
    """Register WebSocket namespace for reactions.

    Args:
        bus: UnifiedConnectionManager instance
    """
    bus.register_namespace(PLUGIN_NAMESPACE, handle_reaction)
    print(f"[Reactions Plugin] WebSocket namespace registered: {PLUGIN_NAMESPACE}")
