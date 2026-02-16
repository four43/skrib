"""Message Reactions Plugin - Main plugin class."""
import sys
import importlib.util
from pathlib import Path

# Add parent directory to path to import mini_chat as a package
sys.path.insert(0, str(Path(__file__).parent.parent.parent.parent))

from mini_chat.plugins.base import Plugin

# Import sibling modules
_backend_dir = Path(__file__).parent

def _load_module(name, filepath):
    """Load a module from a file path."""
    spec = importlib.util.spec_from_file_location(name, filepath)
    module = importlib.util.module_from_spec(spec)
    sys.modules[f"reactions_plugin_{name}"] = module
    spec.loader.exec_module(module)
    return module

# Load plugin modules
db_module = _load_module("database", _backend_dir / "database.py")
routes_module = _load_module("routes", _backend_dir / "routes.py")
ws_handlers_module = _load_module("ws_handlers", _backend_dir / "ws_handlers.py")

# Export module functions
router = routes_module.router
register_ws_handlers = ws_handlers_module.register_ws_handlers


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
        # Inject into routes and ws_handlers copies of the db module
        if hasattr(routes_module, 'db'):
            routes_module.db.init_db_provider(self.get_plugin_db)
        if hasattr(ws_handlers_module, 'db'):
            ws_handlers_module.db.init_db_provider(self.get_plugin_db)

    @property
    def id(self) -> str:
        """Full plugin ID matching manifest."""
        return "four43.message-reactions"

    @property
    def name(self) -> str:
        return "message-reactions"

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

    def register_ws_namespace(self, bus):
        """Register WebSocket namespace for real-time reactions."""
        register_ws_handlers(bus)

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
