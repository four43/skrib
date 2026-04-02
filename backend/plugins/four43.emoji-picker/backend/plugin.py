"""Emoji Picker Plugin - Main plugin class."""
from skrib.plugins.base import Plugin

from . import services
from .routes import router


class EmojiPickerPlugin(Plugin):
    """Plugin that provides a reusable emoji picker with custom emoji support.

    Features:
    - Searchable emoji picker with categories
    - Custom emoji upload (PNG/GIF) by admins
    - Global window.SkribEmojiPicker API for other plugins
    """

    def __init__(self):
        super().__init__()
        services.init_db_provider(self.get_plugin_db)

    @property
    def id(self) -> str:
        return "four43.emoji-picker"

    @property
    def name(self) -> str:
        return "Emoji Picker"

    @property
    def version(self) -> str:
        return "1.0.0"

    def get_table_schema(self) -> str:
        return '''
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

    async def on_startup(self):
        services.ensure_files_dir()
        print("[Emoji Picker Plugin] Database initialized")

    def register_routes(self, app):
        return router
