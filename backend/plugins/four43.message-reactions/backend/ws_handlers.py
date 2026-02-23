"""WebSocket handlers for reactions plugin."""
from . import database as db


async def handle_reaction(bus, ws, username, msg):
    """Handle reaction WebSocket messages.

    Args:
        bus: PluginBus scoped to ``four43.message-reactions``
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
            await bus.broadcast_to_room(room_id, "added", data={
                "message_id": message_id,
                "emoji": emoji,
                "username": username,
            })
            print(f"[Reactions] {username} added {emoji} to message {message_id}")

    elif action == "remove":
        db.remove_reaction(message_id, username, emoji)
        await bus.broadcast_to_room(room_id, "removed", data={
            "message_id": message_id,
            "emoji": emoji,
            "username": username,
        })
        print(f"[Reactions] {username} removed {emoji} from message {message_id}")
