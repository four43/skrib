"""Todo List Room Type Plugin — provides collaborative todo lists."""
import sys
import importlib.util
from pathlib import Path
from typing import Optional

sys.path.insert(0, str(Path(__file__).parent.parent.parent.parent))

from mini_chat.plugins.base import Plugin
from mini_chat.rooms.services import get_room_members

# Load sibling modules
_backend_dir = Path(__file__).parent


def _load_module(name, filepath):
    spec = importlib.util.spec_from_file_location(name, filepath)
    module = importlib.util.module_from_spec(spec)
    sys.modules[f"room_type_todo_{name}"] = module
    spec.loader.exec_module(module)
    return module


services_module = _load_module("services", _backend_dir / "services.py")
routes_module = _load_module("routes", _backend_dir / "routes.py")

router = routes_module.router


class RoomTypeTodoPlugin(Plugin):
    """Provides collaborative todo lists for todo rooms.

    Handles:
    - Todo item persistence in plugin-scoped database
    - WebSocket room actions for real-time add/update/delete/toggle
    - HTTP endpoints for CRUD operations
    """

    def __init__(self):
        super().__init__()
        services_module.init_db_provider(self.get_plugin_db)
        routes_module.TodoList = services_module.TodoList

    @property
    def id(self) -> str:
        return "four43.room-type-todo"

    @property
    def name(self) -> str:
        return "room-type-todo"

    @property
    def version(self) -> str:
        return "1.0.0"

    @property
    def room_types(self) -> list[str]:
        return ["todo"]

    @property
    def capabilities(self) -> list[str]:
        return ["todo_items"]

    def get_table_schema(self) -> Optional[str]:
        return '''
            CREATE TABLE IF NOT EXISTS todo_items (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                room_id TEXT NOT NULL,
                username TEXT NOT NULL,
                title TEXT NOT NULL,
                description TEXT NOT NULL DEFAULT '',
                done INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            )
        '''

    async def on_startup(self):
        """Create indexes on plugin database."""
        with self.get_plugin_db() as conn:
            conn.execute('''
                CREATE INDEX IF NOT EXISTS idx_todo_items_room_id
                ON todo_items(room_id, done, id)
            ''')
            conn.commit()

    def register_routes(self, app):
        return router

    async def handle_room_action(self, bus, ws, username: str, msg: dict, action: str):
        """Handle room actions for todo rooms via WebSocket."""
        room_id = msg.get("room_id")
        todo = services_module.TodoList(room_id)

        if action == "todo_add":
            title = msg.get("title", "").strip()
            description = msg.get("description", "").strip()

            if not title:
                await ws.send_json({
                    "type": "room:error",
                    "room_id": room_id,
                    "message": "Title is required",
                })
                return

            item = todo.add_item(username, title, description)

            await bus.broadcast_to_room(room_id, {
                "type": "room:todo_added",
                "room_id": room_id,
                "data": item,
            })

        elif action == "todo_update":
            item_id = msg.get("item_id")
            title = msg.get("title")
            description = msg.get("description")
            done = msg.get("done")

            existing = todo.get_item(item_id)
            if not existing:
                await ws.send_json({
                    "type": "room:error",
                    "room_id": room_id,
                    "message": "Item not found",
                })
                return

            # Permission check: anyone can toggle done, but only creator/ops/admins can edit text
            if title is not None or description is not None:
                if not self._can_edit(room_id, username, existing['username']):
                    await ws.send_json({
                        "type": "room:error",
                        "room_id": room_id,
                        "message": "Only the creator, room ops, or admins can edit this item",
                    })
                    return

            updated = todo.update_item(item_id, title=title, description=description, done=done)

            await bus.broadcast_to_room(room_id, {
                "type": "room:todo_updated",
                "room_id": room_id,
                "data": updated,
            })

        elif action == "todo_delete":
            item_id = msg.get("item_id")
            existing = todo.get_item(item_id)

            if not existing:
                await ws.send_json({
                    "type": "room:error",
                    "room_id": room_id,
                    "message": "Item not found",
                })
                return

            if not self._can_edit(room_id, username, existing['username']):
                await ws.send_json({
                    "type": "room:error",
                    "room_id": room_id,
                    "message": "Only the creator, room ops, or admins can delete this item",
                })
                return

            todo.delete_item(item_id)

            await bus.broadcast_to_room(room_id, {
                "type": "room:todo_deleted",
                "room_id": room_id,
                "data": {"id": item_id},
            })

        else:
            await ws.send_json({
                "type": "room:error",
                "room_id": room_id or "",
                "message": f"Unknown todo action: {action}",
            })

    def _can_edit(self, room_id: str, username: str, item_username: str) -> bool:
        """Check if user can edit/delete an item."""
        if username == item_username:
            return True

        from mini_chat.rooms.services import get_room_role
        role = get_room_role(room_id, username)
        if role in ('owner', 'op'):
            return True

        from mini_chat.database import get_db
        with get_db() as conn:
            cursor = conn.execute('SELECT role FROM users WHERE username = ?', (username,))
            row = cursor.fetchone()
            if row and row['role'] in ('admin', 'moderator'):
                return True

        return False
