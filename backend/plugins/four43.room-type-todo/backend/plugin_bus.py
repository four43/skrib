"""Todo Room Type plugin — out-of-process version using the SDK."""
from skrib_plugin_sdk import SkribPlugin, on_room_action, on_lifecycle
from skrib_plugin_sdk.database import make_db_provider

from skrib.plugins.auth import can_edit_resource

from . import services as services_module
from .routes import router


class RoomTypeTodoPlugin(SkribPlugin):
    id = "four43.room-type-todo"
    version = "1.0.0"
    secret = ""
    permissions = ["bus.send", "bus.receive", "room_type.register", "http.routes",
                   "storage.read", "storage.write", "frontend.register"]
    room_types = ["todo"]

    table_schema = '''
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

    def __init__(self):
        super().__init__()
        services_module.init_db_provider(make_db_provider(self.id))
        from . import routes as routes_module
        routes_module.TodoList = services_module.TodoList

    def register_routes(self, app):
        return router

    async def on_connect(self):
        with self.get_plugin_db() as conn:
            conn.execute('''
                CREATE INDEX IF NOT EXISTS idx_todo_items_room_id
                ON todo_items(room_id, done, id)
            ''')
            conn.commit()

    @on_lifecycle("room_deleted")
    async def handle_room_deleted(self, ctx):
        room_id = ctx.room_id
        if room_id:
            with self.get_plugin_db() as conn:
                conn.execute('DELETE FROM todo_items WHERE room_id = ?', (room_id,))
                conn.commit()

    @on_room_action("todo_add")
    async def handle_todo_add(self, ctx):
        room_id = ctx.room_id
        title = ctx.data.get("title", "").strip()
        description = ctx.data.get("description", "").strip()

        if not title:
            await ctx.bus.send_error(ctx.reply_to, "Title is required", room_id=room_id)
            return

        todo = services_module.TodoList(room_id)
        item = todo.add_item(ctx.username, title, description)
        await ctx.bus.broadcast_to_room(room_id, "todo_added", data=item)

    @on_room_action("todo_update")
    async def handle_todo_update(self, ctx):
        room_id = ctx.room_id
        item_id = ctx.data.get("item_id")
        title = ctx.data.get("title")
        description = ctx.data.get("description")
        done = ctx.data.get("done")

        todo = services_module.TodoList(room_id)
        existing = todo.get_item(item_id)
        if not existing:
            await ctx.bus.send_error(ctx.reply_to, "Item not found", room_id=room_id)
            return

        if title is not None or description is not None:
            if not can_edit_resource(ctx.username, existing['username'],
                                    room_role=ctx.room_role, global_role=ctx.user_role):
                await ctx.bus.send_error(ctx.reply_to,
                                        "Only the creator, room ops, or admins can edit this item",
                                        room_id=room_id)
                return

        updated = todo.update_item(item_id, title=title, description=description, done=done)
        await ctx.bus.broadcast_to_room(room_id, "todo_updated", data=updated)

    @on_room_action("todo_delete")
    async def handle_todo_delete(self, ctx):
        room_id = ctx.room_id
        item_id = ctx.data.get("item_id")

        todo = services_module.TodoList(room_id)
        existing = todo.get_item(item_id)
        if not existing:
            await ctx.bus.send_error(ctx.reply_to, "Item not found", room_id=room_id)
            return

        if not can_edit_resource(ctx.username, existing['username'],
                                room_role=ctx.room_role, global_role=ctx.user_role):
            await ctx.bus.send_error(ctx.reply_to,
                                    "Only the creator, room ops, or admins can delete this item",
                                    room_id=room_id)
            return

        todo.delete_item(item_id)
        await ctx.bus.broadcast_to_room(room_id, "todo_deleted", data={"id": item_id})
