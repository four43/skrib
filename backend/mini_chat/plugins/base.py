"""Base plugin interface for Mini Chat plugin system."""
from typing import Optional, Any
from abc import ABC, abstractmethod


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

    def register_ws_namespace(self, bus):
        """Register WebSocket namespace handlers (e.g., 'whiteboard.*', 'typing.*').

        Plugins can:
        - Register their own namespace for bidirectional communication
        - Subscribe to events from other namespaces (listen-only)

        Used by: Feature Plugins, Room Type Plugins, Event Listener Plugins

        Args:
            bus: UnifiedConnectionManager instance
        """
        pass

    def get_frontend_assets(self) -> dict:
        """Return frontend assets to inject into the client.

        Used by: All plugins with UI components

        Returns:
            dict with keys:
                - scripts: List of JS file paths
                - styles: List of CSS file paths
                - config: JSON-serializable config for frontend
        """
        return {
            "scripts": [],
            "styles": [],
            "config": {}
        }

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
        """Hook called when a room is soft-deleted.

        Args:
            room_id: The room identifier
            room_type: The type of room

        Used by: Event Listener Plugins, State Management Plugins (for cleanup)
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
        """Hook called when a user joins a room (sends room.join).

        Args:
            room_id: The room identifier
            username: Username who joined

        Used by: Feature Plugins (e.g., presence indicators), Event Listener Plugins
        """
        pass

    def on_user_left_room(self, room_id: str, username: str):
        """Hook called when a user leaves a room (sends room.leave or disconnects).

        Args:
            room_id: The room identifier
            username: Username who left

        Used by: Feature Plugins (e.g., presence indicators)
        """
        pass

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

        Table will be named: plugin_{self.name}

        Returns:
            SQL CREATE TABLE statement, or None if plugin doesn't need storage

        Example:
            return '''
                CREATE TABLE IF NOT EXISTS plugin_myplug (
                    username TEXT NOT NULL,
                    setting_key TEXT NOT NULL,
                    setting_value TEXT,
                    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                    PRIMARY KEY (username, setting_key),
                    FOREIGN KEY (username) REFERENCES users(username) ON DELETE CASCADE
                )
            '''
        """
        return None

    def _get_table_name(self) -> str:
        """Get this plugin's table name.

        Returns:
            Table name in format: plugin_{plugin_name} (hyphens converted to underscores)
        """
        # Replace hyphens with underscores for SQL compatibility
        safe_name = self.name.replace('-', '_')
        return f"plugin_{safe_name}"

    def execute_query(self, query: str, params: tuple = ()) -> list[dict]:
        """Execute a SELECT query on this plugin's table.

        Args:
            query: SQL query string
            params: Query parameters (tuple)

        Returns:
            List of row dictionaries

        Example:
            rows = self.execute_query(
                f"SELECT * FROM {self._get_table_name()} WHERE username = ?",
                (username,)
            )
        """
        from ..database import get_db
        with get_db() as conn:
            cursor = conn.execute(query, params)
            return [dict(row) for row in cursor.fetchall()]

    def execute_write(self, query: str, params: tuple = ()):
        """Execute an INSERT/UPDATE/DELETE query on this plugin's table.

        Args:
            query: SQL query string
            params: Query parameters (tuple)

        Example:
            self.execute_write(
                f"INSERT INTO {self._get_table_name()} (username, key) VALUES (?, ?)",
                (username, key)
            )
        """
        from ..database import get_db
        with get_db() as conn:
            conn.execute(query, params)
            conn.commit()
