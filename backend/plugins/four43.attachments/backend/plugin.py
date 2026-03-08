"""File Attachments Plugin — encrypted file sharing in chat rooms."""
from typing import Optional

from skrib.plugins.base import Plugin

from . import services as services_module
from .routes import router


class AttachmentsPlugin(Plugin):
    """Adds encrypted file attachment support to chat rooms.

    Features:
    - Chunked upload with per-chunk AES-GCM encryption
    - Server stores only encrypted blobs
    - Download and decrypt via room key
    """

    def __init__(self):
        super().__init__()
        services_module.init_db_provider(self.get_plugin_db)

    @property
    def id(self) -> str:
        return "four43.attachments"

    @property
    def name(self) -> str:
        return "File Attachments"

    @property
    def version(self) -> str:
        return "1.0.0"

    def get_table_schema(self) -> Optional[str]:
        return '''
            CREATE TABLE IF NOT EXISTS attachments (
                id TEXT PRIMARY KEY,
                room_id TEXT NOT NULL,
                username TEXT NOT NULL,
                chunk_count INTEGER NOT NULL DEFAULT 0,
                total_size INTEGER NOT NULL DEFAULT 0,
                key_epoch INTEGER,
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

    async def on_startup(self):
        """Create indexes, ensure files dir, register cleanup events."""
        from . import routes as routes_module
        routes_module.core_api = self.core_api

        self.register_event("core:room_deleted", self._on_room_deleted)

        with self.get_plugin_db() as conn:
            conn.execute('''
                CREATE INDEX IF NOT EXISTS idx_attachments_room_id
                ON attachments(room_id)
            ''')
            conn.execute('''
                CREATE INDEX IF NOT EXISTS idx_attachment_chunks_id
                ON attachment_chunks(attachment_id)
            ''')
            conn.commit()

        services_module.ensure_files_dir()

        # Clean up stale pending uploads from previous runs
        services_module.AttachmentStore().cleanup_stale()

        print("[Attachments Plugin] Database initialized")

    def register_routes(self, app):
        return router

    async def _on_room_deleted(self, event_data: dict):
        """Clean up all attachments when a room is deleted."""
        room_id = event_data.get("room_id")
        if room_id:
            services_module.AttachmentStore().delete_room_attachments(room_id)
