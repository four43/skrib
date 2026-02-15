"""Typing indicators plugin - shows who's typing in real-time."""
import time
from .base import Plugin


class TypingPlugin(Plugin):
    """Typing indicators - a feature that works across all room types.

    This plugin demonstrates a Feature Plugin that:
    - Doesn't create new room types
    - Works across all rooms (channels, DMs, future room types)
    - Uses ephemeral state (no database)
    - Registers a WebSocket namespace
    - Listens to events from other namespaces
    """

    def __init__(self):
        # Track who's typing in which room (ephemeral, no DB)
        # room_id -> {username: last_typing_time}
        self.typing_state = {}

    @property
    def name(self) -> str:
        return "typing"

    @property
    def version(self) -> str:
        return "1.0.0"

    # No room_types - this plugin doesn't create rooms, it enhances them

    def register_ws_namespace(self, bus):
        """Register the typing namespace handler."""

        async def handle_typing(bus, ws, username, msg):
            """Handle typing.* messages from clients."""
            action = msg["type"].split(".", 1)[1]
            room_id = msg.get("room_id")

            if not room_id:
                await ws.send_json({
                    "type": "typing.error",
                    "message": "room_id required"
                })
                return

            if action == "start":
                # User started typing
                if room_id not in self.typing_state:
                    self.typing_state[room_id] = {}
                self.typing_state[room_id][username] = time.time()

                # Broadcast to everyone else in the room
                await bus.broadcast_to_room(room_id, {
                    "type": "typing.user_typing",
                    "room_id": room_id,
                    "username": username,
                    "is_typing": True
                })
                print(f"[Typing] {username} started typing in {room_id}")

            elif action == "stop":
                # User stopped typing
                if room_id in self.typing_state:
                    self.typing_state[room_id].pop(username, None)
                    if not self.typing_state[room_id]:
                        del self.typing_state[room_id]

                await bus.broadcast_to_room(room_id, {
                    "type": "typing.user_typing",
                    "room_id": room_id,
                    "username": username,
                    "is_typing": False
                })
                print(f"[Typing] {username} stopped typing in {room_id}")

        # Register the typing namespace
        bus.register_namespace("typing", handle_typing)

        # Listen to room.message events to auto-clear typing state
        # When someone sends a message, they're no longer typing
        async def on_room_message(event):
            """Auto-clear typing state when user sends a message."""
            room_id = event.get("room_id")
            if not room_id:
                return

            username = event.get("data", {}).get("username")
            if not username:
                return

            # Clear typing state for this user in this room
            if room_id in self.typing_state:
                if username in self.typing_state[room_id]:
                    self.typing_state[room_id].pop(username)
                    print(f"[Typing] Auto-cleared {username} in {room_id} (sent message)")

                    # Broadcast that they stopped typing
                    await bus.broadcast_to_room(room_id, {
                        "type": "typing.user_typing",
                        "room_id": room_id,
                        "username": username,
                        "is_typing": False
                    })

                # Clean up empty room state
                if not self.typing_state[room_id]:
                    del self.typing_state[room_id]

        # Register as listener for room.message events
        bus.on_event("room.message", on_room_message)
        print("[Typing] Registered listener for room.message events")

    def on_user_left_room(self, room_id: str, username: str):
        """Clean up typing state when user leaves a room."""
        if room_id in self.typing_state:
            self.typing_state[room_id].pop(username, None)
            if not self.typing_state[room_id]:
                del self.typing_state[room_id]
            print(f"[Typing] Cleaned up {username} from {room_id} (left room)")

    def get_frontend_assets(self) -> dict:
        """Return frontend assets for typing indicators."""
        return {
            "scripts": ["typing.js"],  # Frontend plugin module
            "styles": [],
            "config": {
                "timeout_ms": 3000,  # Clear typing after 3s of inactivity
                "debounce_ms": 500   # Send typing events max every 500ms
            }
        }
