"""Chat Typing plugin — out-of-process version using the SDK."""
import time

from skrib_plugin_sdk import SkribPlugin, on_room_action


class ChatTypingPlugin(SkribPlugin):
    id = "four43.chat-typing"
    version = "1.0.0"
    secret = ""
    permissions = ["bus.send", "bus.receive"]
    published_events = ["user_typing"]

    def __init__(self):
        super().__init__()
        # Ephemeral typing state: room_id -> {username: last_typing_time}
        self.typing_state = {}

    @on_room_action("start")
    async def handle_start(self, ctx):
        room_id = ctx.room_id
        username = ctx.username

        if room_id not in self.typing_state:
            self.typing_state[room_id] = {}
        self.typing_state[room_id][username] = time.time()

        await ctx.bus.broadcast_to_room(
            room_id, "user_typing",
            username=username, is_typing=True,
            exclude_user=username,
        )

    @on_room_action("stop")
    async def handle_stop(self, ctx):
        room_id = ctx.room_id
        username = ctx.username

        if room_id in self.typing_state:
            self.typing_state[room_id].pop(username, None)
            if not self.typing_state[room_id]:
                del self.typing_state[room_id]

        await ctx.bus.broadcast_to_room(
            room_id, "user_typing",
            username=username, is_typing=False,
            exclude_user=username,
        )
