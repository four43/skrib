"""Database helper for out-of-process plugins.

Provides the same get_plugin_db() context manager pattern used by
in-process plugins, connecting to the plugin's private SQLite database
at data/plugins/{plugin_id}.db.
"""
from __future__ import annotations

import os
import sqlite3
import threading
from contextlib import contextmanager
from pathlib import Path

# Default data directory — can be overridden by SKRIB_DATA_DIR env var
_DEFAULT_DATA_DIR = Path(__file__).parent.parent.parent / "data"

_local = threading.local()
_all_connections: list[sqlite3.Connection] = []
_lock = threading.Lock()


def _get_data_dir() -> Path:
    return Path(os.getenv("SKRIB_DATA_DIR", str(_DEFAULT_DATA_DIR)))


def get_db_path(plugin_id: str) -> Path:
    """Return the path to a plugin's private database file."""
    db_dir = _get_data_dir() / "plugins"
    db_dir.mkdir(parents=True, exist_ok=True)
    return db_dir / f"{plugin_id}.db"


@contextmanager
def get_plugin_db(plugin_id: str):
    """Context manager yielding a SQLite connection to the plugin's DB.

    Connections are cached per-thread for performance.
    """
    connections = getattr(_local, "connections", None)
    if connections is None:
        _local.connections = {}
        connections = _local.connections

    conn = connections.get(plugin_id)
    if conn is None:
        db_path = get_db_path(plugin_id)
        conn = sqlite3.connect(str(db_path), timeout=30.0)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA foreign_keys=ON")
        connections[plugin_id] = conn
        with _lock:
            _all_connections.append(conn)

    try:
        yield conn
    except Exception:
        conn.rollback()
        raise


def init_schema(plugin_id: str, schema_sql: str) -> None:
    """Create tables from a schema string if they don't exist."""
    with get_plugin_db(plugin_id) as conn:
        conn.executescript(schema_sql)
        conn.commit()


def close_all_connections() -> None:
    """Close all cached plugin database connections."""
    with _lock:
        for conn in _all_connections:
            try:
                conn.close()
            except Exception:
                pass
        _all_connections.clear()


def make_db_provider(plugin_id: str):
    """Return a get_db callable suitable for init_db_provider() calls.

    This allows existing service modules (which use the init_db_provider
    pattern) to work with out-of-process plugins unchanged::

        from skrib_plugin_sdk.database import make_db_provider
        services.init_db_provider(make_db_provider("four43.emoji-picker"))
    """
    @contextmanager
    def _provider():
        with get_plugin_db(plugin_id) as conn:
            yield conn
    return _provider
