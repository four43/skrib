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

import importlib.util
import json
import logging
from pathlib import Path
from typing import Any

from skrib_plugin_sdk.database import init_schema
from skrib_plugin_sdk.inprocess import InProcessClient

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
    """Import ``backend/plugin_bus.py`` from a plugin dir and return its
    SkribPlugin subclass."""
    from skrib_plugin_sdk.plugin import SkribPlugin

    module_path = plugin_dir / "backend" / "plugin_bus.py"
    if not module_path.is_file():
        raise FileNotFoundError(f"No backend/plugin_bus.py in {plugin_dir}")

    # Namespaced module name so two plugins cannot collide in sys.modules.
    module_name = f"_skrib_inprocess_{plugin_dir.name.replace('.', '_')}"
    spec = importlib.util.spec_from_file_location(module_name, module_path)
    if spec is None or spec.loader is None:
        raise ImportError(f"Cannot load {module_path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)

    for attr in vars(module).values():
        if (
            isinstance(attr, type)
            and issubclass(attr, SkribPlugin)
            and attr is not SkribPlugin
        ):
            return attr
    raise ImportError(f"No SkribPlugin subclass found in {module_path}")


class InProcessHost:
    """Owns the lifecycle of every in-process plugin."""

    def __init__(self, bridge, plugins_dir: Path):
        self._bridge = bridge
        self._plugins_dir = Path(plugins_dir)
        self._instances: dict[str, Any] = {}

    async def start(self) -> list[str]:
        """Load and register every in-process plugin. Returns started ids.

        A plugin that fails to load is logged and skipped; it must never be
        fatal to core startup.
        """
        started: list[str] = []
        for plugin_id, plugin_dir in discover_inprocess_plugins(self._plugins_dir):
            try:
                await self._start_one(plugin_id, plugin_dir)
                started.append(plugin_id)
                logger.info("[InProcess] %s started", plugin_id)
            except Exception:
                logger.exception("[InProcess] Failed to start %s", plugin_id)
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

        await client.connect()
        self._bridge.register_inprocess(plugin.id, client.deliver, plugin.room_types)
        await plugin.on_connect()
        self._instances[plugin.id] = plugin

    async def stop(self) -> None:
        """Unregister and shut down every in-process plugin."""
        for plugin_id, plugin in list(self._instances.items()):
            self._bridge.unregister_inprocess(plugin_id)
            try:
                await plugin.on_disconnect()
            except Exception:
                logger.exception("[InProcess] Error stopping %s", plugin_id)
            if plugin._client is not None:
                await plugin._client.close()
        self._instances.clear()
