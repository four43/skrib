"""Chat Room Type Plugin — provides text messaging for chat rooms."""
import sys
import importlib.util
from pathlib import Path
from typing import Optional

sys.path.insert(0, str(Path(__file__).parent.parent.parent.parent))

from mini_chat.plugins.base import Plugin
from mini_chat.rooms.services import (
    get_room_members,
    get_notify_level,
    get_unread_count_for_room,
)

# Load sibling modules
_backend_dir = Path(__file__).parent


def _load_module(name, filepath):
    spec = importlib.util.spec_from_file_location(name, filepath)
    module = importlib.util.module_from_spec(spec)
    sys.modules[f"room_type_chat_{name}"] = module
    spec.loader.exec_module(module)
    return module


services_module = _load_module("services", _backend_dir / "services.py")
routes_module = _load_module("routes", _backend_dir / "routes.py")

router = routes_module.router


class RoomTypeChatPlugin(Plugin):
    """Provides text-based chat messaging for chat rooms.

    Handles:
    - Message persistence in plugin-scoped database
    - WebSocket room:message action
    - HTTP endpoints for message history, sending, and read receipts
    - Unread count queries (called by core via registry)
    """

    def __init__(self):
        # Wire up the DB provider for services module
        services_module.init_db_provider(self.get_plugin_db)
        # Inject ChatRoom into routes module (so it uses the same services instance)
        routes_module.ChatRoom = services_module.ChatRoom

    @property
    def id(self) -> str:
        return "com.four43.room-type-chat"

    @property
    def name(self) -> str:
        return "room-type-chat"

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
                timestamp TEXT NOT NULL
            )
        '''

    async def on_startup(self):
        """Create indexes on plugin database."""
        with self.get_plugin_db() as conn:
            conn.execute('''
                CREATE INDEX IF NOT EXISTS idx_messages_room_id
                ON messages(room_id, id)
            ''')
            conn.commit()

    def register_routes(self, app):
        return router

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
            await bus.broadcast_to_room(room_id, {
                "type": "room:message",
                "room_id": room_id,
                "data": message_data,
            })

            # Notify other members (user-scoped) for sidebar badges / notifications
            members = get_room_members(room_id)
            for member in members:
                if member != username:
                    level = get_notify_level(room_id, member)
                    event_type = "room:new_message" if level == "all" else "room:update"
                    unread_count = get_unread_count_for_room(room_id, member)
                    await bus.notify_user(member, {
                        "type": event_type,
                        "room_id": room_id,
                        "sender": username,
                        "unread_count": unread_count,
                    })
        else:
            await ws.send_json({
                "type": "room:error",
                "room_id": room_id or "",
                "message": f"Unknown chat action: {action}",
            })
