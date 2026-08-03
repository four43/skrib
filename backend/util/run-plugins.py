"""Launch all out-of-process plugins in a single asyncio event loop.

Used by the VSCode "Plugins: Start All" launch config. All plugins
run as concurrent tasks in one process, which is convenient for
development and debugging (breakpoints, logs in one terminal).

Plugins declaring ``runtime: in_process`` in their manifest are skipped —
the backend's ``InProcessHost`` already loads those in-interpreter, and this
launcher would otherwise start a second, bus-connected copy of the same
plugin (see util/start-plugins, which applies the same skip).

For production, use util/start-plugins which runs each as a separate process.
"""
import asyncio
import json
import os
import sys
import signal

# Ensure backend/ is on the path
backend_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if backend_dir not in sys.path:
    sys.path.insert(0, backend_dir)

from skrib_plugin_sdk.loader import load_plugin_class

PLUGINS_DIR = os.path.join(backend_dir, "plugins")
BUS_URL = os.getenv("SKRIB_BUS_URL", "ws://127.0.0.1:9000")


def _runtime_of(plugin_dir):
    """Return a plugin's declared runtime, defaulting to "process".

    Mirrors util/start-plugins: a missing or unreadable manifest, or one
    with no "runtime" key, is treated as "process" so an unmodified
    manifest keeps its current behaviour.
    """
    manifest_path = os.path.join(plugin_dir, "manifest.json")
    try:
        with open(manifest_path) as f:
            manifest = json.load(f)
    except (OSError, json.JSONDecodeError):
        return "process"
    return manifest.get("runtime", "process")


def discover_plugins():
    """Find all plugin directories that have a __main__.py.

    Skips ``runtime: in_process`` plugins — the backend's ``InProcessHost``
    already loads those in-interpreter, so spawning a second, bus-connected
    copy here would mean two processes fighting over the same plugin
    database.
    """
    plugins = []
    for name in sorted(os.listdir(PLUGINS_DIR)):
        plugin_dir = os.path.join(PLUGINS_DIR, name)
        if not os.path.isfile(os.path.join(plugin_dir, "__main__.py")):
            continue
        if _runtime_of(plugin_dir) == "in_process":
            print(f"[Plugins] Skipping {name} (runtime: in_process — loaded by the backend)")
            continue
        plugins.append((name, plugin_dir))
    return plugins


async def run_plugin(name, plugin_dir):
    """Load and run a single plugin, restarting on failure."""
    try:
        mod = load_plugin_class(plugin_dir)
        # Find the SkribPlugin subclass
        plugin_cls = None
        for attr_name in dir(mod):
            obj = getattr(mod, attr_name)
            if isinstance(obj, type) and hasattr(obj, "id") and getattr(obj, "id", ""):
                plugin_cls = obj
                break

        if not plugin_cls:
            print(f"[Plugins] No plugin class found in {name}")
            return

        plugin = plugin_cls()
        print(f"[Plugins] Starting {plugin.id}")
        await plugin.run_forever(BUS_URL)
    except asyncio.CancelledError:
        print(f"[Plugins] {name} stopped")
    except Exception as e:
        print(f"[Plugins] {name} crashed: {e}")


async def main():
    plugins = discover_plugins()
    if not plugins:
        print(f"[Plugins] No plugins found in {PLUGINS_DIR}")
        return

    print(f"[Plugins] Discovered {len(plugins)} plugins, bus URL: {BUS_URL}")
    print()

    tasks = []
    for name, plugin_dir in plugins:
        task = asyncio.create_task(run_plugin(name, plugin_dir))
        tasks.append(task)

    # Wait for Ctrl+C
    stop = asyncio.Event()
    loop = asyncio.get_event_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        loop.add_signal_handler(sig, stop.set)

    await stop.wait()

    print("\n[Plugins] Shutting down...")
    for task in tasks:
        task.cancel()
    await asyncio.gather(*tasks, return_exceptions=True)
    print("[Plugins] All plugins stopped")


if __name__ == "__main__":
    asyncio.run(main())
