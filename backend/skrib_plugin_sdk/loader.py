"""Plugin loader — sets up proper package context for out-of-process plugins.

Handles the tricky business of making a plugin's backend/ directory work
as a proper Python package so relative imports (from . import services, etc.)
work correctly when the plugin is run standalone.
"""
from __future__ import annotations

import importlib
import importlib.util
import os
import sys
from pathlib import Path


def load_plugin_class(plugin_dir: str, module_name: str = "plugin_bus"):
    """Load a plugin class from a plugin directory.

    Sets up the plugin's backend/ as a proper Python package so that
    relative imports within the plugin code work correctly.

    Args:
        plugin_dir: Path to the plugin directory (e.g., plugins/four43.emoji-picker/)
        module_name: Name of the module containing the plugin class (default: plugin_bus)

    Returns:
        The loaded module (access the plugin class as module.ClassName)
    """
    plugin_dir = os.path.abspath(plugin_dir)
    backend_dir = os.path.join(plugin_dir, "backend")

    if not os.path.isdir(backend_dir):
        raise FileNotFoundError(f"No backend/ directory in {plugin_dir}")

    # Ensure __init__.py exists
    init_file = os.path.join(backend_dir, "__init__.py")
    if not os.path.exists(init_file):
        Path(init_file).touch()

    # Create a unique package name from the plugin dir name
    # e.g., "four43.emoji-picker" -> "four43_emoji_picker"
    dir_name = os.path.basename(plugin_dir)
    pkg_name = dir_name.replace(".", "_").replace("-", "_")

    # Load the backend/ dir as a package
    if pkg_name not in sys.modules:
        pkg_spec = importlib.util.spec_from_file_location(
            pkg_name,
            init_file,
            submodule_search_locations=[backend_dir],
        )
        pkg_mod = importlib.util.module_from_spec(pkg_spec)
        sys.modules[pkg_name] = pkg_mod
        pkg_spec.loader.exec_module(pkg_mod)

    # Load the target module within the package
    full_name = f"{pkg_name}.{module_name}"
    if full_name not in sys.modules:
        mod_path = os.path.join(backend_dir, f"{module_name}.py")
        if not os.path.exists(mod_path):
            raise FileNotFoundError(f"Module {mod_path} not found")

        mod_spec = importlib.util.spec_from_file_location(
            full_name,
            mod_path,
            submodule_search_locations=[],
        )
        mod = importlib.util.module_from_spec(mod_spec)
        sys.modules[full_name] = mod
        mod_spec.loader.exec_module(mod)

    return sys.modules[full_name]
