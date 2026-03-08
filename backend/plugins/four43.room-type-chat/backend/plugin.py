"""Chat Room Type Plugin — provides text messaging for chat rooms."""
from typing import Optional

from skrib.plugins.base import Plugin

from . import services as services_module
from .routes import router


class RoomTypeChatPlugin(Plugin):
    """Provides text-based chat messaging for chat rooms.

    Handles:
    - Message persistence in plugin-scoped database
    - WebSocket room:message action
    - HTTP endpoints for message history, sending, and read receipts
    - Unread count queries (called by core via registry)
    """

    def __init__(self):
        super().__init__()
        # Wire up the DB provider for services module
        services_module.init_db_provider(self.get_plugin_db)
        # Inject ChatRoom and LinkPreviewService into routes module
        from . import routes as routes_module
        routes_module.ChatRoom = services_module.ChatRoom
        routes_module.link_preview_service = services_module.LinkPreviewService(self.get_plugin_db)

    @property
    def id(self) -> str:
        return "four43.room-type-chat"

    @property
    def name(self) -> str:
        return "Room: Chat"

    @property
    def version(self) -> str:
        return "1.0.0"

    @property
    def room_types(self) -> list[str]:
        return ["chat"]

    @property
    def capabilities(self) -> list[str]:
        return ["chat_messages"]

    def get_table_schema(self) -> Optional[str]:
        return '''
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

    async def on_startup(self):
        """Create indexes on plugin database and inject bus/core_api into routes."""
        from . import routes as routes_module
        routes_module.plugin_bus = self.bus
        routes_module.core_api = self.core_api

        self.register_event("core:room_deleted", self._on_room_deleted)

        with self.get_plugin_db() as conn:
            conn.execute('''
                CREATE INDEX IF NOT EXISTS idx_messages_room_id
                ON messages(room_id, id)
            ''')
            conn.commit()

    def register_routes(self, app):
        return router

    async def _on_room_deleted(self, event_data: dict):
        """Clean up messages when a room is deleted."""
        room_id = event_data.get("room_id")
        if room_id:
            with self.get_plugin_db() as conn:
                conn.execute('DELETE FROM messages WHERE room_id = ?', (room_id,))
                conn.commit()

    def register_callbacks(self, callbacks):
        callbacks.register('/unread-count',
                           lambda data: self._get_unread_count(data['room_id'], data['since_message_id']))
        callbacks.register('/unread-counts-batch',
                           lambda data: self._get_unread_counts_batch(data['room_positions']))

    # --- Unread count implementation ---

    def _get_unread_count(self, room_id: str, since_message_id: int) -> int:
        """Count messages in a room with id > since_message_id."""
        with self.get_plugin_db() as conn:
            cursor = conn.execute(
                'SELECT COUNT(*) as cnt FROM messages WHERE room_id = ? AND id > ?',
                (room_id, since_message_id)
            )
            row = cursor.fetchone()
            return row['cnt'] if row else 0

    def _get_unread_counts_batch(self, room_positions: dict[str, int]) -> dict[str, int]:
        """Get unread counts for multiple rooms.

        Args:
            room_positions: {room_id: last_read_message_id}

        Returns:
            {room_id: unread_count}
        """
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

    # --- WebSocket handler ---

    async def handle_room_action(self, bus, reply_to, username: str, msg: dict, action: str,
                                *, user_role: str = "user", room_role: str | None = None):
        """Handle room:message (and future chat actions) for chat rooms."""
        room_id = msg.get("room_id")

        if action == "message":
            content = msg.get("content", "")
            content_type = msg.get("content_type", "text")
            key_epoch = msg.get("key_epoch")

            room = services_module.ChatRoom(room_id)
            message_data = room.add_message(username, content, content_type, key_epoch)

            # Broadcast to all sockets subscribed to this room
            await bus.broadcast_to_room(room_id, "message", data=message_data)

            # Notify other members (user-scoped) for sidebar badges / notifications
            members = self.core_api.get_room_members(room_id)
            for member in members:
                if member != username:
                    level = self.core_api.get_notify_level(room_id, member)
                    notify_action = "new_message" if level == "all" else "update"
                    unread_count = self.core_api.get_unread_count(room_id, member)
                    await bus.notify_user(
                        member, notify_action,
                        room_id=room_id, sender=username, unread_count=unread_count,
                    )

        elif action == "edit_message":
            message_id = msg.get("message_id")
            content = msg.get("content", "")
            content_type = msg.get("content_type", "text")
            key_epoch = msg.get("key_epoch")

            room = services_module.ChatRoom(room_id)
            try:
                result = room.edit_message(message_id, username, content, content_type, key_epoch)
                await bus.broadcast_to_room(room_id, "message_edited", data=result)
            except (ValueError, PermissionError) as e:
                await bus.send_error(reply_to, str(e), room_id=room_id)

        elif action == "delete_message":
            message_id = msg.get("message_id")
            is_admin = user_role == 'admin'

            room = services_module.ChatRoom(room_id)
            try:
                result = room.delete_message(message_id, username, is_admin=is_admin)
                await bus.broadcast_to_room(room_id, "message_deleted", data=result)
            except (ValueError, PermissionError) as e:
                await bus.send_error(reply_to, str(e), room_id=room_id)

        else:
            await bus.send_error(reply_to, f"Unknown chat action: {action}", room_id=room_id or "")
