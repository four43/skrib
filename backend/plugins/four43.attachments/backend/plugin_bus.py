"""Attachments plugin — out-of-process version using the SDK."""
from skrib_plugin_sdk import SkribPlugin, on_lifecycle, on_event
from skrib_plugin_sdk.database import make_db_provider

from . import services as services_module
from .routes import router


class AttachmentsPlugin(SkribPlugin):
    id = "four43.attachments"
    version = "1.0.0"
    permissions = ["bus.send", "bus.receive", "http.routes", "storage.read", "storage.write",
                   "frontend.register"]
    subscriptions = ["core:room_deleted", "core:message_deleted"]
    http_port = 0

    table_schema = '''
        CREATE TABLE IF NOT EXISTS attachments (
            id TEXT PRIMARY KEY,
            room_id TEXT NOT NULL,
            username TEXT NOT NULL,
            chunk_count INTEGER NOT NULL DEFAULT 0,
            total_size INTEGER NOT NULL DEFAULT 0,
            key_epoch INTEGER,
            message_id INTEGER,
            status TEXT NOT NULL DEFAULT 'pending',
            created_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS attachment_chunks (
            attachment_id TEXT NOT NULL,
            chunk_index INTEGER NOT NULL,
            size INTEGER NOT NULL,
            iv TEXT NOT NULL,
            PRIMARY KEY (attachment_id, chunk_index)
        );
    '''

    def __init__(self):
        super().__init__()
        services_module.init_db_provider(make_db_provider(self.id))

    def register_routes(self, app):
        return router

    async def on_connect(self):
        # Inject core_api into routes for room access checks
        from . import routes as routes_module
        routes_module.core_api = self.core_api

        with self.get_plugin_db() as conn:
            conn.execute('''
                CREATE INDEX IF NOT EXISTS idx_attachments_room_id
                ON attachments(room_id)
            ''')
            conn.execute('''
                CREATE INDEX IF NOT EXISTS idx_attachment_chunks_id
                ON attachment_chunks(attachment_id)
            ''')
            conn.execute('''
                CREATE INDEX IF NOT EXISTS idx_attachments_message_id
                ON attachments(message_id)
            ''')
            conn.commit()

        services_module.ensure_files_dir()
        services_module.AttachmentStore().cleanup_stale()

    @on_event("core:room_deleted")
    async def on_room_deleted(self, ctx):
        room_id = ctx.data.get("room_id")
        if room_id:
            services_module.AttachmentStore().delete_room_attachments(room_id)

    @on_event("core:message_deleted")
    async def on_message_deleted(self, ctx):
        message_id = ctx.data.get("message_id")
        if message_id:
            services_module.AttachmentStore().delete_by_message_id(message_id)
