"""Message Reactions Plugin - Main plugin class."""
from skrib.plugins.base import Plugin

from . import database as db_module
from .routes import router
from .ws_handlers import handle_reaction


class MessageReactionsPlugin(Plugin):
    """Plugin that adds emoji reactions to messages.

    Features:
    - React to messages with emojis
    - Real-time updates via WebSocket
    - Server-side persistence in plugin-scoped database
    - See who reacted
    """

    def __init__(self):
        super().__init__()
        # Wire up the DB provider for the database module
        db_module.init_db_provider(self.get_plugin_db)

    @property
    def id(self) -> str:
        """Full plugin ID matching manifest."""
        return "four43.message-reactions"

    @property
    def name(self) -> str:
        return "Message Reactions"

    @property
    def version(self) -> str:
        return "1.0.0"

    def get_table_schema(self) -> str:
        """Return SQL schema for reactions table (no cross-DB foreign keys)."""
        return '''
            CREATE TABLE IF NOT EXISTS message_reactions (
                message_id INTEGER NOT NULL,
                username TEXT NOT NULL,
                emoji TEXT NOT NULL,
                created_at TEXT NOT NULL,
                PRIMARY KEY (message_id, username, emoji)
            )
        '''

    async def on_startup(self):
        """Create indexes on plugin database."""
        with self.get_plugin_db() as conn:
            conn.execute('''
                CREATE INDEX IF NOT EXISTS idx_reactions_message_id
                ON message_reactions(message_id)
            ''')
            conn.commit()
        print("[Reactions Plugin] Database initialized")

    def register_routes(self, app):
        """Register REST API endpoints."""
        return router

    def get_ws_handler(self):
        """Return handler for four43.message-reactions:* namespace."""
        return handle_reaction

    def get_frontend_assets(self) -> dict:
        """Return frontend JavaScript and CSS files."""
        return {
            "scripts": [
                "/api/plugins/four43.message-reactions/file/frontend/plugin.js"
            ],
            "styles": [
                "/api/plugins/four43.message-reactions/file/frontend/plugin.css"
            ],
            "config": {
                "common_emojis": ['👍', '❤️', '😂', '😮', '😢', '🎉', '🚀', '👀']
            }
        }
