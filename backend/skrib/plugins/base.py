"""Plugin database utilities.

Thread-local SQLite connection management for plugin databases.
Used by the integration test fixtures for cleanup.
"""
import sqlite3
import threading

from ..config import DB_DIR

# Plugin databases directory
PLUGINS_DB_DIR = DB_DIR / "plugins"
PLUGINS_DB_DIR.mkdir(parents=True, exist_ok=True)

# Thread-local storage for plugin DB connections (keyed by plugin id)
_plugin_local = threading.local()

# Registry of all plugin DB connections (for test cleanup)
_all_plugin_connections: list[sqlite3.Connection] = []
_all_plugin_connections_lock = threading.Lock()


def close_all_plugin_connections():
    """Close all tracked plugin database connections. Used by test fixtures."""
    with _all_plugin_connections_lock:
        for conn in _all_plugin_connections:
            try:
                conn.close()
            except Exception:
                pass
        _all_plugin_connections.clear()
    _plugin_local.connections = {}
