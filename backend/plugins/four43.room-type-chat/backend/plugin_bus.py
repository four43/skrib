"""Chat Room Type plugin — out-of-process version using the SDK."""
from skrib_plugin_sdk import SkribPlugin, on_room_action, on_lifecycle, callback
from skrib_plugin_sdk.database import make_db_provider

from . import services as services_module
from .routes import router


class RoomTypeChatPlugin(SkribPlugin):
    id = "four43.room-type-chat"
    version = "1.0.0"
    permissions = ["bus.send", "bus.receive", "room_type.register", "http.routes",
                   "storage.read", "storage.write", "core_api", "frontend.register",
                   "callbacks.register"]
    room_types = ["chat"]
    published_events = ["message"]
    callbacks_list = ["/unread-count", "/unread-counts-batch"]
    http_port = 0  # auto-assign — serves message CRUD routes

    table_schema = '''
        CREATE TABLE IF NOT EXISTS messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            room_id TEXT NOT NULL,
            username TEXT NOT NULL,
            content TEXT NOT NULL DEFAULT '',
            content_type TEXT NOT NULL DEFAULT 'text',
            key_epoch INTEGER,
            timestamp TEXT NOT NULL,
            edited_at TEXT,
            deleted INTEGER NOT NULL DEFAULT 0
        );

        CREATE TABLE IF NOT EXISTS link_previews (
            url TEXT PRIMARY KEY,
            title TEXT,
            description TEXT,
            image TEXT,
            site_name TEXT,
            content_type TEXT NOT NULL DEFAULT 'webpage',
            fetched_at TEXT NOT NULL
        );
    '''

    def __init__(self):
        super().__init__()
        _db_provider = make_db_provider(self.id)
        services_module.init_db_provider(_db_provider)
        # Inject ChatRoom and LinkPreviewService into routes module
        from . import routes as routes_module
        routes_module.ChatRoom = services_module.ChatRoom
        routes_module.link_preview_service = services_module.LinkPreviewService(_db_provider)

    def register_routes(self, app):
        return router

    async def on_connect(self):
        # Inject bus/core_api into routes module for HTTP endpoints
        from . import routes as routes_module
        routes_module.plugin_bus = self.bus
        routes_module.core_api = self.core_api

        with self.get_plugin_db() as conn:
            conn.execute('''
                CREATE INDEX IF NOT EXISTS idx_messages_room_id
                ON messages(room_id, id)
            ''')
            conn.commit()

    @on_lifecycle("room_deleted")
    async def handle_room_deleted(self, ctx):
        room_id = ctx.room_id
        if room_id:
            with self.get_plugin_db() as conn:
                conn.execute('DELETE FROM messages WHERE room_id = ?', (room_id,))
                conn.commit()

    # --- Callbacks ---

    @callback("/unread-count")
    async def get_unread_count(self, ctx):
        data = ctx.data.get("data", {})
        room_id = data.get("room_id", "")
        since_message_id = data.get("since_message_id", 0)
        count = self._count_unread(room_id, since_message_id)
        return {"result": count}

    @callback("/unread-counts-batch")
    async def get_unread_counts_batch(self, ctx):
        data = ctx.data.get("data", {})
        room_positions = data.get("room_positions", {})
        result = self._count_unread_batch(room_positions)
        return {"result": result}

    def _count_unread(self, room_id: str, since_message_id: int) -> int:
        with self.get_plugin_db() as conn:
            cursor = conn.execute(
                'SELECT COUNT(*) as cnt FROM messages WHERE room_id = ? AND id > ?',
                (room_id, since_message_id)
            )
            row = cursor.fetchone()
            return row['cnt'] if row else 0

    def _count_unread_batch(self, room_positions: dict) -> dict:
        if not room_positions:
            return {}
        result = {}
        with self.get_plugin_db() as conn:
            for room_id, since_id in room_positions.items():
                cursor = conn.execute(
                    'SELECT COUNT(*) as cnt FROM messages WHERE room_id = ? AND id > ?',
                    (room_id, since_id)
                )
                row = cursor.fetchone()
                result[room_id] = row['cnt'] if row else 0
        return result

    # --- Room actions ---

    @on_room_action("message")
    async def handle_message(self, ctx):
        room_id = ctx.room_id
        content = ctx.data.get("content", "")
        content_type = ctx.data.get("content_type", "text")
        key_epoch = ctx.data.get("key_epoch")

        room = services_module.ChatRoom(room_id)
        message_data = room.add_message(ctx.username, content, content_type, key_epoch)

        await ctx.bus.broadcast_to_room(room_id, "message", data=message_data)

        # Notify other members for sidebar badges (best-effort).
        # One batched core_api call, not one per member — N sequential
        # round-trips inside a message handler is what made a second
        # message queue behind the first.
        try:
            levels = await self.core_api.get_notify_levels(room_id) or {}
            for member, level in levels.items():
                if member == ctx.username:
                    continue
                notify_action = "new_message" if level == "all" else "update"
                await ctx.bus.notify_user(
                    member, notify_action,
                    room_id=room_id, sender=ctx.username,
                )
        except Exception:
            pass  # Notifications are best-effort

    @on_room_action("edit_message")
    async def handle_edit_message(self, ctx):
        room_id = ctx.room_id
        message_id = ctx.data.get("message_id")
        content = ctx.data.get("content", "")
        content_type = ctx.data.get("content_type", "text")
        key_epoch = ctx.data.get("key_epoch")

        room = services_module.ChatRoom(room_id)
        try:
            result = room.edit_message(message_id, ctx.username, content, content_type, key_epoch)
            await ctx.bus.broadcast_to_room(room_id, "message_edited", data=result)
        except (ValueError, PermissionError) as e:
            await ctx.bus.send_error(ctx.reply_to, str(e), room_id=room_id)

    @on_room_action("delete_message")
    async def handle_delete_message(self, ctx):
        room_id = ctx.room_id
        message_id = ctx.data.get("message_id")
        is_admin = ctx.user_role == 'admin'

        room = services_module.ChatRoom(room_id)
        try:
            result = room.delete_message(message_id, ctx.username, is_admin=is_admin)
            await ctx.bus.broadcast_to_room(room_id, "message_deleted", data=result)
            await ctx.bus.emit_event({
                "type": "core:message_deleted",
                "room_id": room_id,
                "message_id": message_id,
            })
        except (ValueError, PermissionError) as e:
            await ctx.bus.send_error(ctx.reply_to, str(e), room_id=room_id)
