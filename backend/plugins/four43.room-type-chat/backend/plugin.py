"""Chat Room Type Plugin — provides text messaging for chat rooms."""
from typing import Optional

from skrib.plugins.base import Plugin
from skrib.permissions import get_global_role
from skrib.rooms.services import (
    get_room_members,
    get_notify_level,
    get_unread_count_for_room,
)

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
        # Inject ChatRoom into routes module (so it uses the same services instance)
        from . import routes as routes_module
        routes_module.ChatRoom = services_module.ChatRoom

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
            )
        '''

    async def on_startup(self):
        """Create indexes on plugin database and inject bus into routes."""
        # Inject plugin_bus so HTTP routes can broadcast under this plugin's namespace
        from . import routes as routes_module
        routes_module.plugin_bus = self.bus

        with self.get_plugin_db() as conn:
            conn.execute('''
                CREATE INDEX IF NOT EXISTS idx_messages_room_id
                ON messages(room_id, id)
            ''')
            conn.commit()

    def get_frontend_assets(self) -> dict:
        return {
            "scripts": ["/api/plugins/four43.room-type-chat/file/frontend/plugin.js"],
            "styles": ["/api/plugins/four43.room-type-chat/file/frontend/plugin.css"],
            "config": {}
        }

    def register_routes(self, app):
        return router

    def on_room_deleted(self, room_id: str, room_type: str):
        """Delete all messages for the room."""
        with self.get_plugin_db() as conn:
            conn.execute('DELETE FROM messages WHERE room_id = ?', (room_id,))
            conn.commit()

    # --- Unread count API (called by core via registry) ---

    def get_unread_count(self, room_id: str, since_message_id: int) -> int:
        """Count messages in a room with id > since_message_id."""
        with self.get_plugin_db() as conn:
            cursor = conn.execute(
                'SELECT COUNT(*) as cnt FROM messages WHERE room_id = ? AND id > ?',
                (room_id, since_message_id)
            )
            row = cursor.fetchone()
            return row['cnt'] if row else 0

    def get_unread_counts_batch(self, room_positions: dict[str, int]) -> dict[str, int]:
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

    async def handle_room_action(self, bus, ws, username: str, msg: dict, action: str):
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
            members = get_room_members(room_id)
            for member in members:
                if member != username:
                    level = get_notify_level(room_id, member)
                    notify_action = "new_message" if level == "all" else "update"
                    unread_count = get_unread_count_for_room(room_id, member)
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
                await bus.send_error(ws, str(e), room_id=room_id)

        elif action == "delete_message":
            message_id = msg.get("message_id")
            is_admin = get_global_role(username) == 'admin'

            room = services_module.ChatRoom(room_id)
            try:
                result = room.delete_message(message_id, username, is_admin=is_admin)
                await bus.broadcast_to_room(room_id, "message_deleted", data=result)
            except (ValueError, PermissionError) as e:
                await bus.send_error(ws, str(e), room_id=room_id)

        else:
            await bus.send_error(ws, f"Unknown chat action: {action}", room_id=room_id or "")
