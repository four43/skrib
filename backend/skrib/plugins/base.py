"""Base plugin interface for Mini Chat plugin system."""
import asyncio
import logging
import sqlite3
import threading
from contextlib import contextmanager
from pathlib import Path
from typing import Optional, Any, Callable
from abc import ABC, abstractmethod

from ..config import DB_DIR


class PluginBus:
    """Scoped bus that auto-prepends the plugin namespace to message types.

    Prevents plugins from accidentally sending messages outside their namespace.
    All outgoing messages get type ``{namespace}:{action}`` automatically.

    Enforces declared permissions from the plugin manifest. If a permission
    is not declared, the corresponding bus method raises PermissionError.
    """

    def __init__(self, bus, namespace: str, permissions: list[str] | None = None):
        self._bus = bus
        self._namespace = namespace
        self._permissions = set(permissions or [])

    def _require(self, permission: str):
        """Raise PermissionError if the plugin lacks the given permission."""
        if self._permissions and permission not in self._permissions:
            raise PermissionError(
                f"Plugin '{self._namespace}' lacks '{permission}' permission"
            )

    async def broadcast_to_room(self, room_id: str, action: str, *, exclude_user: str = None, **fields):
        """Broadcast ``{namespace}:{action}`` to all sockets in a room.

        Extra keyword arguments are merged into the message dict.
        """
        self._require("bus.send")
        message = {"type": f"{self._namespace}:{action}", "room_id": room_id, **fields}
        await self._bus.broadcast_to_room(room_id, message, exclude_user=exclude_user)

    async def notify_user(self, username: str, action: str, **fields):
        """Send ``{namespace}:{action}`` to all of a user's sockets."""
        self._require("bus.send")
        message = {"type": f"{self._namespace}:{action}", **fields}
        await self._bus.notify_user(username, message)

    async def notify_all_users(self, action: str, **fields):
        """Send ``{namespace}:{action}`` to every connected user."""
        self._require("bus.send")
        message = {"type": f"{self._namespace}:{action}", **fields}
        await self._bus.notify_all_users(message)

    async def send_error(self, reply_to: str, message: str, *, room_id: str = ""):
        """Send a namespaced error to the originating client via reply token."""
        await self._bus.send_reply(reply_to, {
            "type": f"{self._namespace}:error",
            "room_id": room_id,
            "message": message,
        })

    async def emit_event(self, event_data: dict):
        """Emit an internal lifecycle event to all registered listeners.

        Used for cross-plugin communication (e.g., core:message_deleted).
        Does NOT broadcast to WebSocket clients.
        """
        await self._bus.emit_event(event_data)

# Plugin databases directory
PLUGINS_DB_DIR = DB_DIR / "plugins"
PLUGINS_DB_DIR.mkdir(parents=True, exist_ok=True)

# Thread-local storage for plugin DB connections (keyed by plugin id)
_plugin_local = threading.local()


class _PluginLogFormatter(logging.Formatter):
    """Formats log messages as [plugin_id][LEVEL] Message."""

    def format(self, record: logging.LogRecord) -> str:
        return f"[{record.name}][{record.levelname}] {record.getMessage()}"


class Plugin(ABC):
    """Base class for all Mini Chat plugins.

    Plugins can extend chat functionality in various ways:
    - Room Type Plugins: Provide new room types (whiteboard, video, etc.)
    - Feature Plugins: Add features across all rooms (typing, reactions, etc.)
    - API Extension Plugins: Add new API endpoints
    - Event Listener Plugins: React to bus events
    - State Management Plugins: Store plugin-specific data
    - UI Enhancement Plugins: Frontend-only enhancements
    """

    def __init__(self):
        self.bus = None  # Set by core during startup to PluginBus(ws.bus, plugin.id)
        self.core_api = None  # Set by core during startup to CoreAPI instance
        self._callbacks = None  # Set during startup for callback registration
        self._registered_resources = []  # Auto-cleanup tracking
        self.logger = logging.getLogger(f"plugin.{self.id}")
        if not self.logger.handlers:
            handler = logging.StreamHandler()
            handler.setFormatter(_PluginLogFormatter())
            self.logger.addHandler(handler)
        self.logger.propagate = False

    @property
    def id(self) -> str:
        """Full plugin ID (e.g., 'com.example.plugin-name').

        Defaults to name for backward compatibility.
        Override to provide full reverse-domain plugin ID.
        """
        return self.name

    @property
    @abstractmethod
    def name(self) -> str:
        """Unique plugin identifier (e.g., 'whiteboard', 'typing')."""
        raise NotImplementedError

    @property
    def version(self) -> str:
        """Plugin version (semver)."""
        return "1.0.0"

    @property
    def room_types(self) -> list[str]:
        """Room types this plugin provides (e.g., ['whiteboard']).

        Return empty list if plugin doesn't provide room types.
        Most plugins won't implement this - only Room Type Plugins.
        """
        return []

    @property
    def capabilities(self) -> list[str]:
        """Capabilities this plugin provides.

        Examples: 'file_storage', 'webrtc_signaling', 'video_encoding'
        Other plugins can depend on these capabilities.
        """
        return []

    @property
    def dependencies(self) -> list[str]:
        """Required capabilities from other plugins.

        Plugin will fail to load if dependencies aren't met.
        """
        return []

    @property
    def external_services(self) -> dict[str, str]:
        """External services used by this plugin.

        Example: {'giphy': 'https://api.giphy.com', 'openai': 'https://api.openai.com'}
        """
        return {}

    @property
    def required_env_vars(self) -> list[str]:
        """Environment variables required by this plugin.

        Example: ['GIPHY_API_KEY', 'OPENAI_API_KEY']
        Plugin will fail to load if required env vars are missing.
        """
        return []

    def register_routes(self, app) -> Optional[object]:
        """Return FastAPI router for plugin endpoints.

        Used by: API Extension Plugins, Room Type Plugins, State Management Plugins

        Returns:
            APIRouter instance or None if plugin doesn't add routes
        """
        return None

    def register_middleware(self, app):
        """Register FastAPI middleware for request interception.

        Used by: Rate limiting, authentication extensions, logging plugins

        Args:
            app: FastAPI application instance
        """
        pass

    def get_ws_handler(self) -> Optional[Callable]:
        """Return async handler for this plugin's {plugin.id}:* namespace.

        Core registers it automatically under the plugin's ID namespace.
        Only for feature plugins that need their own WS namespace.

        Returns:
            Async handler function or None if plugin doesn't need a WS namespace
        """
        return None

    def register_event_listeners(self, bus):
        """Register event listeners via bus.on_event().

        For cross-namespace observation (e.g., listening to room:message events).

        Args:
            bus: UnifiedConnectionManager instance
        """
        pass

    def register_callbacks(self, callbacks):
        """Register callback handlers that core can invoke.

        Override to register handlers for plugin callback endpoints:
            /unread-count         {room_id, since_message_id} -> count
            /unread-counts-batch  {room_positions} -> {room_id: count}
            /intercept-message    {message_data} -> message_data or None
            /health               {} -> {"status": "ok"}

        Args:
            callbacks: PluginCallbacks instance — call callbacks.register(endpoint, handler)
        """
        pass

    # Auto-cleanup registration methods

    def register_event(self, event_name: str, handler):
        """Subscribe to a bus event. Auto-unsubscribed on plugin disable/shutdown."""
        self.bus._bus.on_event(event_name, handler)
        self._registered_resources.append(("event", event_name, handler))

    def register_interval(self, seconds: float, callback):
        """Run a periodic async task. Auto-cancelled on plugin disable/shutdown."""
        async def _loop():
            while True:
                await asyncio.sleep(seconds)
                try:
                    await callback()
                except Exception as e:
                    self.logger.error(f"Interval task error: {e}")

        task = asyncio.create_task(_loop())
        self._registered_resources.append(("interval", task))
        return task

    def register_cleanup(self, callback):
        """Run arbitrary cleanup on disable/shutdown."""
        self._registered_resources.append(("cleanup", callback))

    async def _cleanup_all(self):
        """Called by framework on disable/shutdown. Plugins should NOT override."""
        for resource in reversed(self._registered_resources):
            try:
                if resource[0] == "event":
                    self.bus._bus.off_event(resource[1], resource[2])
                elif resource[0] == "interval":
                    resource[1].cancel()
                elif resource[0] == "cleanup":
                    if asyncio.iscoroutinefunction(resource[1]):
                        await resource[1]()
                    else:
                        resource[1]()
            except Exception as e:
                self.logger.error(f"Cleanup error: {e}")
        self._registered_resources.clear()

    # Lifecycle hooks

    async def on_startup(self):
        """Called when the application starts.

        Use for: Opening database connections, starting background tasks, etc.
        """
        pass

    async def on_shutdown(self):
        """Called when the application stops.

        Use for: Cleanup, closing connections, saving state, etc.
        """
        pass

    async def on_enable(self):
        """Called when plugin is enabled at runtime.

        Use for: Dynamic plugin activation without restart
        """
        pass

    async def on_disable(self):
        """Called when plugin is disabled at runtime.

        Use for: Cleanup when plugin is deactivated, save state, etc.
        """
        pass

    # Event hooks

    def on_room_created(self, room_id: str, room_type: str, creator: str):
        """Hook called when a room is created.

        Args:
            room_id: The room identifier
            room_type: The type of room (may or may not be this plugin's type)
            creator: Username who created the room

        Used by: Event Listener Plugins, State Management Plugins
        """
        pass

    def on_room_deleted(self, room_id: str, room_type: str):
        """Hook called when a room is hard-deleted.

        Called for ALL plugins so each can clean up its own data.
        Core tables (room_users, room_keys) are already CASCADE-deleted.

        Args:
            room_id: The room identifier
            room_type: The type of room that was deleted
        """
        pass

    def on_message_sent(self, room_id: str, message_data: dict):
        """Hook called when a message is sent to any room.

        Args:
            room_id: The room where message was sent
            message_data: Full message dict (id, username, content, timestamp, etc.)

        Used by: Event Listener Plugins, Moderation Plugins, Analytics Plugins
        """
        pass

    def on_user_joined_room(self, room_id: str, username: str):
        """Hook called when a user joins a room (sends room:join).

        Args:
            room_id: The room identifier
            username: Username who joined

        Used by: Feature Plugins (e.g., presence indicators), Event Listener Plugins
        """
        pass

    def on_user_left_room(self, room_id: str, username: str):
        """Hook called when a user leaves a room (sends room:leave or disconnects).

        Args:
            room_id: The room identifier
            username: Username who left

        Used by: Feature Plugins (e.g., presence indicators)
        """
        pass

    # Room-type action handling

    async def handle_room_action(self, bus: PluginBus, reply_to: str, username: str, msg: dict, action: str,
                                *, user_role: str = "user", room_role: str | None = None):
        """Handle a room-scoped WebSocket action for rooms of this type.

        Called by the core room handler for any action other than join/leave.
        Only called for rooms whose room_type is in this plugin's room_types.

        Args:
            bus: PluginBus scoped to the plugin's own namespace
            reply_to: Opaque reply token — pass to bus.send_error() to respond
            username: Authenticated username
            msg: Full message dict (includes type, room_id, etc.)
            action: The action part after "room:" (e.g., "message")
            user_role: User's global role (admin/moderator/user), looked up by core
            room_role: User's role in this room (owner/op/member), or None if not a member
        """
        await bus.send_error(reply_to, f"Unsupported action: {action}", room_id=msg.get("room_id", ""))

    # Message interception

    def intercept_message(self, message_data: dict) -> dict | None:
        """Modify or block a message before it's saved.

        Args:
            message_data: Message dict before saving

        Returns:
            Modified message dict, or None to block the message

        Used by: Moderation plugins, content filters, spam detection
        """
        return message_data

    # Data storage

    def get_table_schema(self) -> Optional[str]:
        """Return SQL CREATE TABLE statement for plugin data.

        The table is created in the plugin's own isolated database
        at data/plugins/{plugin_id}.db.

        Returns:
            SQL CREATE TABLE statement, or None if plugin doesn't need storage

        Example:
            return '''
                CREATE TABLE IF NOT EXISTS my_data (
                    username TEXT NOT NULL,
                    setting_key TEXT NOT NULL,
                    setting_value TEXT,
                    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                    PRIMARY KEY (username, setting_key)
                )
            '''
        """
        return None

    @contextmanager
    def get_plugin_db(self):
        """Get a connection to this plugin's private SQLite database.

        Each plugin has its own database file at data/plugins/{plugin_id}.db.
        Connections are cached per-thread for performance.

        Yields:
            sqlite3.Connection to the plugin's private database
        """
        # Use thread-local connection cache keyed by plugin id
        connections = getattr(_plugin_local, 'connections', None)
        if connections is None:
            _plugin_local.connections = {}
            connections = _plugin_local.connections

        conn = connections.get(self.id)
        if conn is None:
            db_path = PLUGINS_DB_DIR / f"{self.id}.db"
            conn = sqlite3.connect(str(db_path), timeout=30.0)
            conn.row_factory = sqlite3.Row
            conn.execute('PRAGMA journal_mode=WAL')
            conn.execute('PRAGMA foreign_keys=ON')
            connections[self.id] = conn

        try:
            yield conn
        except Exception:
            conn.rollback()
            raise

    def execute_query(self, query: str, params: tuple = ()) -> list[dict]:
        """Execute a SELECT query on this plugin's private database.

        Args:
            query: SQL query string
            params: Query parameters (tuple)

        Returns:
            List of row dictionaries
        """
        with self.get_plugin_db() as conn:
            cursor = conn.execute(query, params)
            return [dict(row) for row in cursor.fetchall()]

    def execute_write(self, query: str, params: tuple = ()):
        """Execute an INSERT/UPDATE/DELETE query on this plugin's private database.

        Args:
            query: SQL query string
            params: Query parameters (tuple)
        """
        with self.get_plugin_db() as conn:
            conn.execute(query, params)
            conn.commit()
