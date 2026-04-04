"""SkribPlugin — base class for out-of-process Skrib plugins.

Subclass this and use decorators to register handlers. The SDK
auto-discovers decorated methods and wires them to the bus client.
"""
from __future__ import annotations

import asyncio
import inspect
import logging
from contextlib import contextmanager
from typing import Any

from .client import BusClient
from .bus import PluginBus
from .core_api import CoreAPI
from .database import get_plugin_db as _get_plugin_db, init_schema, make_db_provider

logger = logging.getLogger(__name__)


class ActionContext:
    """Context passed to room action and lifecycle handlers."""

    def __init__(self, bus: PluginBus, data: dict):
        self.bus = bus
        self._data = data

    @property
    def room_id(self) -> str:
        return self._data.get("room_id", "")

    @property
    def username(self) -> str:
        return self._data.get("username", "")

    @property
    def action(self) -> str:
        return self._data.get("action", "")

    @property
    def reply_to(self) -> str:
        return self._data.get("reply_to", "")

    @property
    def user_role(self) -> str:
        return self._data.get("user_role", "")

    @property
    def room_role(self) -> str:
        return self._data.get("room_role", "")

    @property
    def data(self) -> dict:
        """Full frame data."""
        return self._data

    def get(self, key: str, default: Any = None) -> Any:
        return self._data.get(key, default)


class SkribPlugin:
    """Base class for Skrib plugins using the out-of-process SDK.

    Subclasses define class attributes and decorate methods::

        class MyPlugin(SkribPlugin):
            id = "myorg.my-plugin"
            version = "1.0.0"
            permissions = ["bus.send", "bus.receive"]
            published_events = ["something_happened"]
            subscriptions = []
            room_types = []
            frontend_scripts = []
            frontend_styles = []
            settings = []
            callbacks_list = []

            @on_room_action("do_thing")
            async def handle_do_thing(self, ctx: ActionContext):
                await ctx.bus.broadcast_to_room(ctx.room_id, "thing_done")
    """

    # Subclasses must set these
    id: str = ""
    version: str = "1.0.0"
    secret: str = ""

    # Manifest fields
    permissions: list[str] = []
    published_events: list[str] = []
    subscriptions: list[str] = []
    room_types: list[str] = []
    frontend_scripts: list[str] = []
    frontend_styles: list[str] = []
    settings: list[dict] = []
    callbacks_list: list[str] = []

    # Database schema (SQL CREATE TABLE statements)
    table_schema: str | None = None

    # HTTP server port (0 = auto-assign, None = no HTTP server)
    http_port: int | None = None

    def __init__(self):
        self._client: BusClient | None = None
        self._bus: PluginBus | None = None
        self._core_api: CoreAPI | None = None
        self._http_server = None

        # Discovered handlers (populated by _discover_handlers)
        self._room_action_handlers: dict[str, Any] = {}
        self._lifecycle_handlers: dict[str, Any] = {}
        self._event_handlers: dict[str, Any] = {}
        self._callback_handlers: dict[str, Any] = {}

        self._discover_handlers()

    @property
    def bus(self) -> PluginBus:
        if self._bus is None:
            raise RuntimeError("Plugin not connected — call run() first")
        return self._bus

    @property
    def core_api(self) -> CoreAPI:
        if self._core_api is None:
            raise RuntimeError("Plugin not connected — call run() first")
        return self._core_api

    @contextmanager
    def get_plugin_db(self):
        """Context manager for the plugin's private SQLite database."""
        with _get_plugin_db(self.id) as conn:
            yield conn

    def get_db_provider(self):
        """Return a db provider callable for service modules using init_db_provider()."""
        return make_db_provider(self.id)

    def _discover_handlers(self) -> None:
        """Scan methods for @on_room_action, @on_lifecycle, @on_event, @callback decorators."""
        for name in dir(self):
            if name.startswith("_"):
                continue
            # Skip properties to avoid triggering getters before connection
            if isinstance(getattr(type(self), name, None), property):
                continue
            method = getattr(self, name, None)
            if not callable(method):
                continue
            markers = getattr(method, "_skrib_handlers", None)
            if not markers:
                continue
            for handler_type, key in markers:
                if handler_type == "room_action":
                    self._room_action_handlers[key] = method
                elif handler_type == "lifecycle":
                    self._lifecycle_handlers[key] = method
                elif handler_type == "event":
                    self._event_handlers[key] = method
                elif handler_type == "callback":
                    self._callback_handlers[key] = method

    def _build_manifest(self) -> dict:
        """Build the manifest dict sent in the hello frame."""
        return {
            "id": self.id,
            "version": self.version,
            "permissions": self.permissions,
            "published_events": self.published_events,
            "subscriptions": self.subscriptions,
            "room_types": self.room_types,
        }

    async def _handle_room_action(self, data: dict) -> None:
        action = data.get("action", "")
        handler = self._room_action_handlers.get(action)
        if handler:
            ctx = ActionContext(self.bus, data)
            await handler(ctx)
        else:
            logger.warning("[Plugin:%s] No handler for room action '%s'", self.id, action)

    async def _handle_lifecycle(self, data: dict) -> None:
        # Extract event name from type: "lifecycle.room_deleted" → "room_deleted"
        event = data.get("type", "").removeprefix("lifecycle.")
        handler = self._lifecycle_handlers.get(event)
        if handler:
            ctx = ActionContext(self.bus, data)
            await handler(ctx)

    async def _handle_event(self, data: dict) -> None:
        event_type = data.get("event_type", "")
        handler = self._event_handlers.get(event_type)
        if handler:
            ctx = ActionContext(self.bus, data)
            await handler(ctx)

    async def _handle_callback(self, data: dict) -> None:
        endpoint = data.get("endpoint", "")
        handler = self._callback_handlers.get(endpoint)
        if handler:
            ctx = ActionContext(self.bus, data)
            result = await handler(ctx)
            # Send callback response
            await self._client.send({
                "type": "callback.response",
                "request_id": data.get("request_id", ""),
                **(result if isinstance(result, dict) else {}),
            })
        else:
            await self._client.send({
                "type": "callback.response",
                "request_id": data.get("request_id", ""),
                "error": f"No handler for callback '{endpoint}'",
            })

    async def on_connect(self) -> None:
        """Called after successful connection. Override for setup logic."""
        pass

    async def on_disconnect(self) -> None:
        """Called on disconnect. Override for cleanup logic."""
        pass

    def register_routes(self, app):
        """Override to add HTTP routes to the plugin's FastAPI app.

        Return a FastAPI APIRouter or None.
        """
        return None

    async def run(self, bus_url: str = "ws://localhost:9000/bus") -> None:
        """Connect to the bus and run the plugin.

        This is the main entry point. Handles reconnection automatically.
        """
        # Initialize database schema if defined
        if self.table_schema:
            init_schema(self.id, self.table_schema)

        # Start HTTP server if plugin has routes
        http_base_url = None
        if self.http_port is not None:
            http_base_url = await self._start_http_server()

        self._client = BusClient(
            bus_url=bus_url,
            plugin_id=self.id,
            version=self.version,
            secret=self.secret,
            manifest=self._build_manifest(),
            http_base_url=http_base_url,
        )
        self._bus = PluginBus(self._client, self.id)
        self._core_api = CoreAPI(self._client)

        # Register frame handlers
        self._client.on_frame("room.action", self._handle_room_action)
        self._client.on_frame("callback.request", self._handle_callback)
        self._client.on_frame("event", self._handle_event)

        # Register lifecycle frame handlers
        for lt in ("lifecycle.room_created", "lifecycle.room_deleted",
                    "lifecycle.user_joined", "lifecycle.user_left"):
            self._client.on_frame(lt, self._handle_lifecycle)

        # Connect and send registrations
        ack = await self._client.connect()
        if ack.get("status") != "approved":
            logger.warning("[Plugin:%s] Not approved (status=%s)", self.id, ack.get("status"))
            return

        await self._send_registrations()
        await self.on_connect()

        try:
            await self._client.run()
        finally:
            await self.on_disconnect()
            await self._stop_http_server()

    async def run_forever(self, bus_url: str = "ws://localhost:9000/bus") -> None:
        """Connect with automatic reconnection. Blocks indefinitely."""
        # Initialize database schema if defined
        if self.table_schema:
            init_schema(self.id, self.table_schema)

        # Start HTTP server if plugin has routes
        http_base_url = None
        if self.http_port is not None:
            http_base_url = await self._start_http_server()

        self._client = BusClient(
            bus_url=bus_url,
            plugin_id=self.id,
            version=self.version,
            secret=self.secret,
            manifest=self._build_manifest(),
            http_base_url=http_base_url,
            on_connect_callback=self._on_bus_connect,
        )
        self._bus = PluginBus(self._client, self.id)
        self._core_api = CoreAPI(self._client)

        # Register frame handlers
        self._client.on_frame("room.action", self._handle_room_action)
        self._client.on_frame("callback.request", self._handle_callback)
        self._client.on_frame("event", self._handle_event)
        for lt in ("lifecycle.room_created", "lifecycle.room_deleted",
                    "lifecycle.user_joined", "lifecycle.user_left"):
            self._client.on_frame(lt, self._handle_lifecycle)

        try:
            await self._client.run_with_reconnect()
        finally:
            await self.on_disconnect()
            await self._stop_http_server()

    async def _on_bus_connect(self) -> None:
        """Called by BusClient after each successful connect during run_forever."""
        await self._send_registrations()
        await self.on_connect()
        print(f"[Plugins] {self.id} connected and running")

    async def _start_http_server(self) -> str | None:
        """Start the plugin's HTTP server if routes are registered."""
        from .http import create_plugin_app, run_http_server
        app = create_plugin_app(self.id)
        router = self.register_routes(app)
        if router:
            app.include_router(router)
        self._http_server, actual_port = await run_http_server(app, port=self.http_port or 0)
        url = f"http://127.0.0.1:{actual_port}"
        logger.info("[Plugin:%s] HTTP server on %s", self.id, url)
        return url

    async def _stop_http_server(self):
        """Stop the plugin's HTTP server."""
        if self._http_server:
            self._http_server.should_exit = True
            try:
                await self._http_server.shutdown()
            except Exception:
                pass
            self._http_server = None

    async def _send_registrations(self) -> None:
        """Send registration frames after hello_ack."""
        if self.room_types:
            for rt in self.room_types:
                await self._client.send({
                    "type": "register.room_type",
                    "room_type": rt,
                    "display_name": rt.title(),
                })

        if self.frontend_scripts or self.frontend_styles:
            await self._client.send({
                "type": "register.frontend",
                "scripts": self.frontend_scripts,
                "styles": self.frontend_styles,
            })

        if self.settings:
            await self._client.send({
                "type": "register.settings",
                "settings": self.settings,
            })

        for endpoint in self.callbacks_list:
            await self._client.send({
                "type": "register.callback",
                "endpoint": endpoint,
            })
