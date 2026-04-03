"""Plugin settings service — manages typed configuration for plugins.

Plugins declare a settings schema via `register.settings` frames. Admins
configure server-scoped settings, users configure user-scoped settings.
Values are stored as JSON in the `plugin_settings` table.

Settings schema format (each item):
    {
        "key": "max_file_size",
        "label": "Maximum file size",
        "type": "number",          # number, boolean, string, select
        "default": 5242880,
        "scope": "server",         # server or user
        "description": "Max upload size in bytes",
        "options": [...]           # only for type=select
    }
"""
from __future__ import annotations

import json
import logging
from typing import Any, Optional

from ..database import get_db

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Schema queries (from bus-connected plugin state)
# ---------------------------------------------------------------------------

def get_settings_schema(plugin_id: str) -> list[dict]:
    """Get the settings schema for a plugin from the bus server.

    Returns an empty list if the plugin isn't connected or hasn't registered settings.
    """
    try:
        from ..main import app
        plugin_bus = getattr(app.state, "plugin_bus", None)
        if not plugin_bus:
            return []
        conn = plugin_bus.get_plugin(plugin_id)
        if not conn:
            return []
        return conn.settings_schema or []
    except Exception:
        return []


# ---------------------------------------------------------------------------
# Value read/write
# ---------------------------------------------------------------------------

def get_setting(plugin_id: str, key: str, scope: str = "server",
                username: str | None = None) -> Any:
    """Get a single setting value. Returns None if not set."""
    with get_db() as conn:
        uname = username or ""
        row = conn.execute(
            """SELECT value FROM plugin_settings
               WHERE plugin_id = ? AND key = ? AND scope = ? AND username = ?""",
            (plugin_id, key, scope, uname),
        ).fetchone()
        if row:
            return json.loads(row["value"])
    return None


def get_server_settings(plugin_id: str) -> dict[str, Any]:
    """Get all server-scoped settings for a plugin.

    Returns {key: value} with defaults filled in from schema.
    """
    schema = get_settings_schema(plugin_id)
    defaults = {
        s["key"]: s.get("default")
        for s in schema if s.get("scope", "server") == "server"
    }

    with get_db() as conn:
        rows = conn.execute(
            """SELECT key, value FROM plugin_settings
               WHERE plugin_id = ? AND scope = 'server' AND username = ''""",
            (plugin_id,),
        ).fetchall()
        stored = {row["key"]: json.loads(row["value"]) for row in rows}

    # Merge: stored values override defaults
    return {**defaults, **stored}


def get_user_settings(plugin_id: str, username: str) -> dict[str, Any]:
    """Get all user-scoped settings for a plugin and user.

    Returns {key: value} with defaults filled in from schema.
    """
    schema = get_settings_schema(plugin_id)
    defaults = {
        s["key"]: s.get("default")
        for s in schema if s.get("scope") == "user"
    }

    with get_db() as conn:
        rows = conn.execute(
            """SELECT key, value FROM plugin_settings
               WHERE plugin_id = ? AND scope = 'user' AND username = ?""",
            (plugin_id, username),
        ).fetchall()
        stored = {row["key"]: json.loads(row["value"]) for row in rows}

    return {**defaults, **stored}


def set_setting(plugin_id: str, key: str, value: Any, scope: str = "server",
                username: str | None = None) -> None:
    """Set a single setting value."""
    json_value = json.dumps(value)

    uname = username or ""
    with get_db() as conn:
        conn.execute(
            """INSERT INTO plugin_settings (plugin_id, key, scope, username, value)
               VALUES (?, ?, ?, ?, ?)
               ON CONFLICT(plugin_id, key, scope, username)
               DO UPDATE SET value = excluded.value""",
            (plugin_id, key, scope, uname, json_value),
        )
        conn.commit()


def update_server_settings(plugin_id: str, updates: dict[str, Any]) -> dict[str, Any]:
    """Update multiple server-scoped settings. Returns the full settings dict."""
    schema = get_settings_schema(plugin_id)
    valid_keys = {s["key"] for s in schema if s.get("scope", "server") == "server"}

    for key, value in updates.items():
        if key in valid_keys or not schema:
            # If no schema registered yet, allow any key
            set_setting(plugin_id, key, value, scope="server")

    return get_server_settings(plugin_id)


def update_user_settings(plugin_id: str, username: str, updates: dict[str, Any]) -> dict[str, Any]:
    """Update multiple user-scoped settings. Returns the full user settings dict."""
    schema = get_settings_schema(plugin_id)
    valid_keys = {s["key"] for s in schema if s.get("scope") == "user"}

    for key, value in updates.items():
        if key in valid_keys or not schema:
            set_setting(plugin_id, key, value, scope="user", username=username)

    return get_user_settings(plugin_id, username)


# ---------------------------------------------------------------------------
# Notify plugin of config changes
# ---------------------------------------------------------------------------

async def notify_plugin_config_updated(plugin_id: str, key: str, value: Any) -> bool:
    """Send a config.updated frame to a bus-connected plugin."""
    try:
        from ..main import app
        plugin_bus = getattr(app.state, "plugin_bus", None)
        if not plugin_bus:
            return False
        from .protocol import FrameType
        return await plugin_bus.send_to_plugin(plugin_id, {
            "type": FrameType.CONFIG_UPDATED.value,
            "plugin_id": plugin_id,
            "key": key,
            "value": value,
        })
    except Exception:
        logger.exception("[Settings] Failed to notify plugin '%s'", plugin_id)
        return False
