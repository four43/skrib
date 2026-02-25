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
        return "Typing Indicators"

    @property
    def version(self) -> str:
        return "1.0.0"

    def get_ws_handler(self):
        """Return handler for four43.chat-typing:* namespace."""
        typing_state = self.typing_state

        async def handle_typing(bus, ws, username, msg):
            """Handle four43.chat-typing:* messages from clients."""
            action = msg["type"].split(":", 1)[1]  # Get action after namespace
            room_id = msg.get("room_id")

            if not room_id:
                await bus.send_error(ws, "room_id required")
                return

            if action == "start":
                # User started typing
                if room_id not in typing_state:
                    typing_state[room_id] = {}

                typing_state[room_id][username] = time.time()

                # Broadcast to other users in the room (excluding sender)
                await bus.broadcast_to_room(
                    room_id, "user_typing",
                    username=username, is_typing=True,
                    exclude_user=username,
                )

            elif action == "stop":
                # User stopped typing
                if room_id in typing_state:
                    typing_state[room_id].pop(username, None)
                    if not typing_state[room_id]:
                        del typing_state[room_id]

                # Broadcast to other users in the room
                await bus.broadcast_to_room(
                    room_id, "user_typing",
                    username=username, is_typing=False,
                    exclude_user=username,
                )

        return handle_typing

