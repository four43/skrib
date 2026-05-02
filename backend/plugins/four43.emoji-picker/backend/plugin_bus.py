"""Emoji Picker plugin — out-of-process version using the SDK."""
from skrib_plugin_sdk import SkribPlugin
from skrib_plugin_sdk.database import make_db_provider

from . import services
from .routes import router


class EmojiPickerPlugin(SkribPlugin):
    id = "four43.emoji-picker"
    version = "1.0.0"
    permissions = ["bus.send", "bus.receive", "http.routes", "storage.read", "storage.write",
                   "frontend.register"]
    http_port = 0  # auto-assign

    table_schema = '''
        CREATE TABLE IF NOT EXISTS custom_emoji (
            shortcode TEXT PRIMARY KEY,
            display_name TEXT NOT NULL,
            filename TEXT NOT NULL,
            content_type TEXT NOT NULL,
            file_size INTEGER NOT NULL,
            category TEXT NOT NULL DEFAULT 'custom',
            uploaded_by TEXT NOT NULL,
            created_at TEXT NOT NULL
        )
    '''

    def __init__(self):
        super().__init__()
        services.init_db_provider(make_db_provider(self.id))

    def register_routes(self, app):
        return router

    async def on_connect(self):
        services.ensure_files_dir()
