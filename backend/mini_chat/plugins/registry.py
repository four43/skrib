"""Plugin registry for managing Mini Chat plugins."""
import json
import os
import sys
import importlib.util
import inspect
from pathlib import Path
from typing import Dict, Optional
from .base import Plugin

# All plugins live in backend/plugins/
PLUGINS_DIR = Path(__file__).parent.parent.parent / "plugins"


class PluginRegistry:
    """Central registry for all plugins."""

    def __init__(self):
        self.plugins: Dict[str, Plugin] = {}
        self.disabled_plugins: Dict[str, dict] = {}  # plugin_id -> manifest data
        self.room_type_map: Dict[str, Plugin] = {}  # room_type -> plugin
        self.capability_map: Dict[str, list[Plugin]] = {}  # capability -> [plugins]

    def register(self, plugin: Plugin):
        """Register a plugin.

        Args:
            plugin: Plugin instance to register

        Raises:
            ValueError: If plugin name conflicts or dependencies aren't met
        """
        # Check for name conflicts
        if plugin.name in self.plugins:
            raise ValueError(f"Plugin '{plugin.name}' is already registered")

        # Check dependencies
        missing_deps = []
        for dep in plugin.dependencies:
            if dep not in self.capability_map:
                missing_deps.append(dep)

        if missing_deps:
            raise ValueError(
                f"Plugin '{plugin.name}' has unmet dependencies: {missing_deps}"
            )

        # Check required environment variables
        missing_env_vars = []
        for env_var in plugin.required_env_vars:
            if not os.getenv(env_var):
                missing_env_vars.append(env_var)

        if missing_env_vars:
            raise ValueError(
                f"Plugin '{plugin.name}' requires missing environment variables: {missing_env_vars}"
            )

        # Register the plugin
        self.plugins[plugin.name] = plugin
        print(f"[Plugins] Registered plugin: {plugin.name} v{plugin.version}")

        # Create plugin's database table if schema provided
        schema = plugin.get_table_schema()
        if schema:
            from ..database import get_db
            try:
                with get_db() as conn:
                    conn.execute(schema)
                    conn.commit()
                print(f"[Plugins]   - Created table: plugin_{plugin.name}")
            except Exception as e:
                print(f"[Plugins]   - Warning: Failed to create table for {plugin.name}: {e}")

        # Register room types
        for room_type in plugin.room_types:
            if room_type in self.room_type_map:
                existing_plugin = self.room_type_map[room_type].name
                raise ValueError(
                    f"Room type '{room_type}' already registered by plugin '{existing_plugin}'"
                )
            self.room_type_map[room_type] = plugin
            print(f"[Plugins]   - Provides room type: {room_type}")

        # Register capabilities
        for capability in plugin.capabilities:
            if capability not in self.capability_map:
                self.capability_map[capability] = []
            self.capability_map[capability].append(plugin)
            print(f"[Plugins]   - Provides capability: {capability}")

    def get_plugin(self, name: str) -> Optional[Plugin]:
        """Get a plugin by name."""
        return self.plugins.get(name)

    def get_plugin_for_room_type(self, room_type: str) -> Optional[Plugin]:
        """Get the plugin that handles a specific room type."""
        return self.room_type_map.get(room_type)

    def get_plugins_with_capability(self, capability: str) -> list[Plugin]:
        """Get all plugins that provide a specific capability."""
        return self.capability_map.get(capability, [])

    def get_all_plugins(self) -> list[Plugin]:
        """Get all registered (enabled) plugins."""
        return list(self.plugins.values())

    def is_plugin_enabled(self, plugin_id: str) -> bool:
        """Check if a plugin is enabled. Defaults to True if no setting exists."""
        from ..database import get_setting
        return get_setting(f"plugin:{plugin_id}:enabled", "true") == "true"

    def set_plugin_enabled(self, plugin_id: str, enabled: bool):
        """Persist enabled/disabled state for a plugin."""
        from ..database import set_setting
        set_setting(f"plugin:{plugin_id}:enabled", "true" if enabled else "false")

    def get_all_plugin_info(self) -> list[dict]:
        """Return info for all discovered plugins (enabled and disabled) with state."""
        result = []

        # Enabled plugins (registered in self.plugins)
        for plugin in self.plugins.values():
            result.append({
                "id": plugin.id,
                "name": plugin.name,
                "version": plugin.version,
                "enabled": True,
            })

        # Disabled plugins (discovered but not loaded)
        for plugin_id, manifest in self.disabled_plugins.items():
            result.append({
                "id": plugin_id,
                "name": manifest.get("name", plugin_id),
                "version": manifest.get("version", "unknown"),
                "enabled": False,
            })

        return result

    def discover_plugins(self):
        """Discover and load enabled plugins from backend/plugins/."""
        if not PLUGINS_DIR.exists():
            return

        print(f"[Plugins] Discovering plugins in: {PLUGINS_DIR}")

        for plugin_dir in PLUGINS_DIR.iterdir():
            if not plugin_dir.is_dir():
                continue

            plugin_id = plugin_dir.name

            # Load manifest.json for metadata
            manifest_data = None
            manifest_path = plugin_dir / "manifest.json"
            if manifest_path.exists():
                try:
                    with open(manifest_path) as f:
                        manifest_data = json.load(f)
                except Exception as e:
                    print(f"[Plugins] Failed to read manifest for {plugin_id}: {e}")

            # Check enabled state before loading any code
            if not self.is_plugin_enabled(plugin_id):
                print(f"[Plugins] Skipping disabled plugin: {plugin_id}")
                if manifest_data:
                    self.disabled_plugins[plugin_id] = manifest_data
                continue

            # Load backend/plugin.py if it exists
            backend_file = plugin_dir / "backend" / "plugin.py"
            if not backend_file.exists():
                continue

            print(f"[Plugins] Loading plugin: {plugin_id}")

            try:
                spec = importlib.util.spec_from_file_location(
                    f"plugin_{plugin_id}",
                    backend_file
                )
                if spec and spec.loader:
                    module = importlib.util.module_from_spec(spec)
                    sys.modules[spec.name] = module
                    spec.loader.exec_module(module)

                    # Look for Plugin subclasses
                    for name, obj in inspect.getmembers(module):
                        if (inspect.isclass(obj) and
                            issubclass(obj, Plugin) and
                            obj != Plugin):
                            try:
                                plugin_instance = obj()
                                self.register(plugin_instance)
                            except Exception as e:
                                print(f"[Plugins] Failed to instantiate {name} from {plugin_id}: {e}")

            except Exception as e:
                print(f"[Plugins] Failed to load plugin {plugin_id}: {e}")


# Global registry instance
registry = PluginRegistry()
