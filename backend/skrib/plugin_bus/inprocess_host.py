"""Host for plugins declaring ``runtime: "in_process"``.

Discovers, imports and instantiates in-process plugins, wires each to an
``InProcessClient`` pointed at the bridge, and registers its room types so
``ws/handlers.py`` can dispatch to it without knowing where it runs.

An in-process plugin shares this interpreter with core: it is trusted, its
permissions are not enforced, and a crash in it can take down the server.
Only first-party code ships this way. See
docs/spec/2026-08-02-extension-model.md §3.1.
"""
from __future__ import annotations

import json
import logging
from pathlib import Path
from typing import Any

from skrib_plugin_sdk.database import init_schema
from skrib_plugin_sdk.inprocess import InProcessClient

from .settings import register_inprocess_settings_schema, unregister_inprocess_settings_schema

logger = logging.getLogger(__name__)


def discover_inprocess_plugins(plugins_dir: Path) -> list[tuple[str, Path]]:
    """Return (plugin_id, plugin_dir) for manifests with runtime == in_process.

    ``runtime`` defaults to ``"process"`` when absent, so an unmodified
    manifest keeps its current behaviour.
    """
    found: list[tuple[str, Path]] = []
    if not plugins_dir.is_dir():
        return found
    for entry in sorted(plugins_dir.iterdir()):
        manifest_path = entry / "manifest.json"
        if not manifest_path.is_file():
            continue
        try:
            manifest = json.loads(manifest_path.read_text())
        except (json.JSONDecodeError, OSError):
            logger.warning("[InProcess] Unreadable manifest at %s", manifest_path)
            continue
        if manifest.get("runtime", "process") != "in_process":
            continue
        plugin_id = manifest.get("id") or entry.name
        found.append((plugin_id, entry))
    return found


def _load_plugin_class(plugin_dir: Path) -> Any:
    """Return the SkribPlugin subclass defined in a plugin's backend/plugin_bus.py.

    Delegates to the SDK loader, which sets the plugin's backend/ up as a real
    package so its relative imports (`from . import services`) resolve. A bare
    spec_from_file_location cannot do that.
    """
    from skrib_plugin_sdk.loader import load_plugin_class
    from skrib_plugin_sdk.plugin import SkribPlugin

    module = load_plugin_class(
        str(plugin_dir),
        allowed_base=str(Path(plugin_dir).parent),
    )

    for attr in vars(module).values():
        if (
            isinstance(attr, type)
            and issubclass(attr, SkribPlugin)
            and attr is not SkribPlugin
        ):
            return attr
    raise ImportError(f"No SkribPlugin subclass found in {plugin_dir}/backend/plugin_bus.py")


class InProcessHost:
    """Owns the lifecycle of every in-process plugin."""

    def __init__(self, bridge, plugins_dir: Path):
        self._bridge = bridge
        self._plugins_dir = Path(plugins_dir)
        self._instances: dict[str, Any] = {}
        self._failures: dict[str, str] = {}
        self._http_urls: dict[str, str | None] = {}

    @property
    def failures(self) -> dict[str, str]:
        """Plugin id -> repr(exc) for every plugin that failed to start."""
        return dict(self._failures)

    async def start(self) -> list[str]:
        """Load and register every in-process plugin. Returns started ids.

        A plugin that fails to load is logged and skipped; it must never be
        fatal to core startup. But it must never be silent either — a failure
        is recorded in ``self.failures``, logged with a traceback, and printed.
        """
        started: list[str] = []
        for plugin_id, plugin_dir in discover_inprocess_plugins(self._plugins_dir):
            try:
                await self._start_one(plugin_id, plugin_dir)
                started.append(plugin_id)
                logger.info("[InProcess] %s started", plugin_id)
            except Exception as exc:
                self._failures[plugin_id] = repr(exc)
                logger.error(
                    "[InProcess] FAILED to start %s — it will not handle any traffic: %r",
                    plugin_id, exc, exc_info=True,
                )
                print(f"[Plugins] IN-PROCESS PLUGIN FAILED: {plugin_id}: {exc!r}")
        return started

    async def _start_one(self, plugin_id: str, plugin_dir: Path) -> None:
        from skrib_plugin_sdk.bus import PluginBus
        from skrib_plugin_sdk.core_api import CoreAPI

        cls = _load_plugin_class(plugin_dir)
        plugin = cls()

        if plugin.table_schema:
            init_schema(plugin.id, plugin.table_schema)

        client = InProcessClient(plugin.id, self._bridge._handle_plugin_frame)
        plugin._client = client
        plugin._bus = PluginBus(client, plugin.id)
        plugin._core_api = CoreAPI(client)

        # Same frame registrations run() performs for the bus transport.
        client.on_frame("room.action", plugin._handle_room_action)
        client.on_frame("callback.request", plugin._handle_callback)
        client.on_frame("event", plugin._handle_event)
        for lt in (
            "lifecycle.room_created",
            "lifecycle.room_deleted",
            "lifecycle.user_joined",
            "lifecycle.user_left",
        ):
            client.on_frame(lt, plugin._handle_lifecycle)

        # Bus plugins get their HTTP server started by SkribPlugin.run(); in-process
        # plugins need the host to do it, because their CRUD routes are still served
        # through the middleware proxy at /api/plugins/{id}/...
        http_base_url = None
        if plugin.http_port is not None:
            http_base_url = await plugin._start_http_server()
        self._http_urls[plugin.id] = http_base_url

        try:
            await client.connect()
            self._bridge.register_inprocess(plugin.id, client.deliver, plugin.room_types)
            await plugin.on_connect()

            # The bus server registers settings schemas when it handles a
            # register.settings frame. In-process plugins never send one, so do it here.
            if plugin.settings:
                register_inprocess_settings_schema(plugin.id, plugin.settings)

            self._instances[plugin.id] = plugin
        except Exception:
            # A failure past this point happens after the HTTP server (if any) is
            # already listening. start()'s per-plugin try/except records the
            # failure and moves on to the next plugin — this plugin never reaches
            # self._instances, and only stop() ever calls _stop_http_server(), only
            # for instances it holds. Without this cleanup the socket would stay
            # bound with no code path left to close it for the rest of the
            # process's life.
            del self._http_urls[plugin.id]
            await plugin._stop_http_server()
            raise

    def plugin_records(self) -> list[dict]:
        """Uniform records for every running in-process plugin.

        Key set matches what the bus server exposes per connection, so the plugin
        registry can merge both sources without special-casing either runtime.
        """
        records = []
        for plugin_id, plugin in self._instances.items():
            records.append({
                "id": plugin_id,
                "version": plugin.version,
                "permissions": list(plugin.permissions),
                "room_types": list(plugin.room_types),
                "room_type_meta": dict(plugin.room_type_meta),
                "frontend_scripts": list(plugin.frontend_scripts),
                "frontend_styles": list(plugin.frontend_styles),
                "http_base_url": self._http_urls.get(plugin_id),
                "runtime": "in_process",
            })
        return records

    async def stop(self) -> None:
        """Unregister and shut down every in-process plugin."""
        for plugin_id, plugin in list(self._instances.items()):
            self._bridge.unregister_inprocess(plugin_id)
            unregister_inprocess_settings_schema(plugin_id)
            try:
                await plugin.on_disconnect()
            except Exception:
                logger.exception("[InProcess] Error stopping %s", plugin_id)
            try:
                await plugin._stop_http_server()
            except Exception:
                logger.exception("[InProcess] Error stopping HTTP server for %s", plugin_id)
            if plugin._client is not None:
                await plugin._client.close()
        self._instances.clear()
        self._http_urls.clear()
