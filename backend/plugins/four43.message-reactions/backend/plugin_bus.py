"""Message Reactions plugin — out-of-process version using the SDK."""
from skrib_plugin_sdk import SkribPlugin, on_room_action
from skrib_plugin_sdk.database import make_db_provider

from . import database as db
from .routes import router


class MessageReactionsPlugin(SkribPlugin):
    id = "four43.message-reactions"
    version = "1.0.0"
    secret = ""
    permissions = ["bus.send", "bus.receive", "http.routes", "storage.read", "storage.write",
                   "frontend.register"]
    http_port = 0

    table_schema = '''
        CREATE TABLE IF NOT EXISTS message_reactions (
            message_id INTEGER NOT NULL,
            room_id TEXT NOT NULL,
            username TEXT NOT NULL,
            emoji TEXT NOT NULL,
            created_at TEXT NOT NULL,
            PRIMARY KEY (message_id, username, emoji)
        )
    '''

    def __init__(self):
        super().__init__()
        db.init_db_provider(make_db_provider(self.id))

    def register_routes(self, app):
        return router

    async def on_connect(self):
        with self.get_plugin_db() as conn:
            conn.execute('''
                CREATE INDEX IF NOT EXISTS idx_reactions_message_id
                ON message_reactions(message_id)
            ''')
            conn.execute('''
                CREATE INDEX IF NOT EXISTS idx_reactions_room_message
                ON message_reactions(room_id, message_id)
            ''')
            conn.commit()

    # WebSocket actions (was in ws_handlers.py)
    @on_room_action("add")
    async def handle_add(self, ctx):
        message_id = ctx.data.get("message_id")
        emoji = ctx.data.get("emoji")
        room_id = ctx.room_id

        success = db.add_reaction(message_id, ctx.username, emoji, room_id=room_id or "")
        if success:
            await ctx.bus.broadcast_to_room(room_id, "added", data={
                "message_id": message_id,
                "emoji": emoji,
                "username": ctx.username,
            })

    @on_room_action("remove")
    async def handle_remove(self, ctx):
        message_id = ctx.data.get("message_id")
        emoji = ctx.data.get("emoji")
        room_id = ctx.room_id

        db.remove_reaction(message_id, ctx.username, emoji)
        await ctx.bus.broadcast_to_room(room_id, "removed", data={
            "message_id": message_id,
            "emoji": emoji,
            "username": ctx.username,
        })
