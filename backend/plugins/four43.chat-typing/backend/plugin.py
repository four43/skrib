"""Typing indicators plugin - backend handler."""
import time

from skrib.plugins.base import Plugin


class ChatTypingPlugin(Plugin):
    """Typing indicators - shows who's typing in real-time.

    This plugin:
    - Tracks ephemeral typing state (no database)
    - Registers a WebSocket namespace for typing events
    - Loads frontend assets from the plugin directory
    """

    def __init__(self):
        super().__init__()
        # Track who's typing in which room (ephemeral, no DB)
        # room_id -> {username: last_typing_time}
        self.typing_state = {}

    @property
    def name(self) -> str:
        return "four43.chat-typing"

    @property
    def version(self) -> str:
        return "1.0.0"

    def register_ws_namespace(self, bus):
        """Register the typing namespace handler."""

        async def handle_typing(bus, ws, username, msg):
            """Handle four43.chat-typing:* messages from clients."""
            action = msg["type"].split(":", 1)[1]  # Get action after namespace
            room_id = msg.get("room_id")

            if not room_id:
                await ws.send_json({
                    "type": "four43.chat-typing:error",
                    "message": "room_id required"
                })
                return

            if action == "start":
                # User started typing
                if room_id not in self.typing_state:
                    self.typing_state[room_id] = {}

                self.typing_state[room_id][username] = time.time()

                # Broadcast to other users in the room (excluding sender)
                await bus.broadcast_to_room(
                    room_id,
                    {
                        "type": "four43.chat-typing:user_typing",
                        "room_id": room_id,
                        "username": username,
                        "is_typing": True
                    },
                    exclude_user=username
                )

            elif action == "stop":
                # User stopped typing
                if room_id in self.typing_state:
                    self.typing_state[room_id].pop(username, None)
                    if not self.typing_state[room_id]:
                        del self.typing_state[room_id]

                # Broadcast to other users in the room
                await bus.broadcast_to_room(
                    room_id,
                    {
                        "type": "four43.chat-typing:user_typing",
                        "room_id": room_id,
                        "username": username,
                        "is_typing": False
                    },
                    exclude_user=username
                )

        # Register the namespace
        bus.register_namespace("four43.chat-typing", handle_typing)

    def get_frontend_assets(self) -> dict:
        """Return frontend assets."""
        return {
            "scripts": ["/api/plugins/four43.chat-typing/file/frontend/plugin.js"],
            "styles": [],
            "config": {
                "plugin_id": "four43.chat-typing",
                "namespace": "four43.chat-typing"
            }
        }
