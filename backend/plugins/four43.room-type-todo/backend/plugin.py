"""Todo List Room Type Plugin — provides collaborative todo lists."""
from typing import Optional

from skrib.plugins.base import Plugin
from skrib.plugins.auth import can_edit_resource

from . import services as services_module
from .routes import router


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
        from . import routes as routes_module
        routes_module.TodoList = services_module.TodoList

    @property
    def id(self) -> str:
        return "four43.room-type-todo"

    @property
    def name(self) -> str:
        return "Room: Todo List"

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
        self.register_event("core:room_deleted", self._on_room_deleted)

        with self.get_plugin_db() as conn:
            conn.execute('''
                CREATE INDEX IF NOT EXISTS idx_todo_items_room_id
                ON todo_items(room_id, done, id)
            ''')
            conn.commit()

    def register_routes(self, app):
        return router

    async def _on_room_deleted(self, event_data: dict):
        """Clean up todo items when a room is deleted."""
        room_id = event_data.get("room_id")
        if room_id:
            with self.get_plugin_db() as conn:
                conn.execute('DELETE FROM todo_items WHERE room_id = ?', (room_id,))
                conn.commit()

    async def handle_room_action(self, bus, reply_to, username: str, msg: dict, action: str,
                                *, user_role: str = "user", room_role: str | None = None):
        """Handle room actions for todo rooms via WebSocket."""
        room_id = msg.get("room_id")
        todo = services_module.TodoList(room_id)

        if action == "todo_add":
            title = msg.get("title", "").strip()
            description = msg.get("description", "").strip()

            if not title:
                await bus.send_error(reply_to, "Title is required", room_id=room_id)
                return

            item = todo.add_item(username, title, description)
            await bus.broadcast_to_room(room_id, "todo_added", data=item)

        elif action == "todo_update":
            item_id = msg.get("item_id")
            title = msg.get("title")
            description = msg.get("description")
            done = msg.get("done")

            existing = todo.get_item(item_id)
            if not existing:
                await bus.send_error(reply_to, "Item not found", room_id=room_id)
                return

            # Permission check: anyone can toggle done, but only creator/ops/admins can edit text
            if title is not None or description is not None:
                if not can_edit_resource(username, existing['username'],
                                        room_role=room_role, global_role=user_role):
                    await bus.send_error(reply_to, "Only the creator, room ops, or admins can edit this item", room_id=room_id)
                    return

            updated = todo.update_item(item_id, title=title, description=description, done=done)
            await bus.broadcast_to_room(room_id, "todo_updated", data=updated)

        elif action == "todo_delete":
            item_id = msg.get("item_id")
            existing = todo.get_item(item_id)

            if not existing:
                await bus.send_error(reply_to, "Item not found", room_id=room_id)
                return

            if not can_edit_resource(username, existing['username'],
                                    room_role=room_role, global_role=user_role):
                await bus.send_error(reply_to, "Only the creator, room ops, or admins can delete this item", room_id=room_id)
                return

            todo.delete_item(item_id)
            await bus.broadcast_to_room(room_id, "todo_deleted", data={"id": item_id})

        else:
            await bus.send_error(reply_to, f"Unknown todo action: {action}", room_id=room_id or "")
