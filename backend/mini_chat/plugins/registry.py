"""Plugin registry for managing Mini Chat plugins."""
import os
import sys
import importlib
import importlib.util
import inspect
from typing import Dict, Optional
from .base import Plugin


class PluginRegistry:
    """Central registry for all plugins."""

    def __init__(self):
        self.plugins: Dict[str, Plugin] = {}
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
        """Get a plugin by name.

        Args:
            name: Plugin name

        Returns:
            Plugin instance or None if not found
        """
        return self.plugins.get(name)

    def get_plugin_for_room_type(self, room_type: str) -> Optional[Plugin]:
        """Get the plugin that handles a specific room type.

        Args:
            room_type: Room type identifier

        Returns:
            Plugin instance or None if room type not registered
        """
        return self.room_type_map.get(room_type)

    def get_plugins_with_capability(self, capability: str) -> list[Plugin]:
        """Get all plugins that provide a specific capability.

        Args:
            capability: Capability identifier

        Returns:
            List of plugins providing this capability
        """
        return self.capability_map.get(capability, [])

    def get_all_plugins(self) -> list[Plugin]:
        """Get all registered plugins.

        Returns:
            List of all plugin instances
        """
        return list(self.plugins.values())

    def discover_plugins(self, plugins_dir: str = None):
        """Auto-discover plugins in the plugins/ directory.

        Scans for:
        1. Python modules in mini_chat/plugins/*.py
        2. Distributed plugins in backend/plugins/*/backend/plugin.py

        Args:
            plugins_dir: Directory to scan (defaults to this module's directory)
        """
        if plugins_dir is None:
            plugins_dir = os.path.dirname(os.path.abspath(__file__))

        print(f"[Plugins] Discovering built-in plugins in: {plugins_dir}")

        # Scan for Python files in mini_chat/plugins/
        for filename in os.listdir(plugins_dir):
            if not filename.endswith('.py') or filename.startswith('_'):
                continue
            if filename in ['base.py', 'registry.py']:
                continue

            module_name = filename[:-3]
            try:
                # Import the module
                module = importlib.import_module(f".{module_name}", package=__package__)

                # Look for Plugin subclasses
                for name, obj in inspect.getmembers(module):
                    if (inspect.isclass(obj) and
                        issubclass(obj, Plugin) and
                        obj != Plugin):
                        # Found a plugin class, try to instantiate it
                        try:
                            plugin_instance = obj()
                            self.register(plugin_instance)
                        except Exception as e:
                            print(f"[Plugins] Failed to instantiate {name}: {e}")

            except Exception as e:
                print(f"[Plugins] Failed to load module {module_name}: {e}")

        # Also scan for distributed plugins with backend components
        self._discover_distributed_plugins()

    def _discover_distributed_plugins(self):
        """Discover distributed plugins with backend/plugin.py files."""
        from pathlib import Path

        # Distributed plugins are in backend/plugins/
        distributed_dir = Path(__file__).parent.parent.parent / "plugins"

        if not distributed_dir.exists():
            return

        print(f"[Plugins] Discovering distributed plugins in: {distributed_dir}")

        for plugin_dir in distributed_dir.iterdir():
            if not plugin_dir.is_dir():
                continue

            # Check if plugin has a backend component
            backend_file = plugin_dir / "backend" / "plugin.py"
            if not backend_file.exists():
                continue

            plugin_id = plugin_dir.name
            print(f"[Plugins] Found distributed plugin with backend: {plugin_id}")

            try:
                # Load the backend plugin module
                spec = importlib.util.spec_from_file_location(
                    f"distributed_plugin_{plugin_id}",
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
                print(f"[Plugins] Failed to load distributed plugin {plugin_id}: {e}")

    def get_manifest(self) -> dict:
        """Get plugin manifest for frontend consumption.

        Returns:
            dict with plugin metadata and frontend assets
        """
        manifest = {
            "plugins": []
        }

        for plugin in self.plugins.values():
            assets = plugin.get_frontend_assets()
            manifest["plugins"].append({
                "name": plugin.name,
                "version": plugin.version,
                "room_types": plugin.room_types,
                "scripts": assets.get("scripts", []),
                "styles": assets.get("styles", []),
                "config": assets.get("config", {})
            })

        return manifest


# Global registry instance
registry = PluginRegistry()
