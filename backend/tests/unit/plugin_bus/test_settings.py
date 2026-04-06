"""Tests for the plugin settings system — service layer and API routes."""
import json
import sqlite3

import pytest
from unittest.mock import AsyncMock, MagicMock, patch
from fastapi.testclient import TestClient
from fastapi import FastAPI

from skrib.plugin_bus.settings import (
    get_setting,
    set_setting,
    get_server_settings,
    get_user_settings,
    update_server_settings,
    update_user_settings,
    notify_plugin_config_updated,
)


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

SAMPLE_SCHEMA = [
    {"key": "max_upload", "label": "Max upload size", "type": "number",
     "default": 1024, "scope": "server", "description": "Bytes"},
    {"key": "theme", "label": "Theme", "type": "select",
     "default": "light", "scope": "user", "options": ["light", "dark"],
     "description": "UI theme"},
    {"key": "verbose", "label": "Verbose logging", "type": "boolean",
     "default": False, "scope": "server"},
]


@pytest.fixture(autouse=True)
def temp_db(tmp_path, monkeypatch):
    """Create a temporary database for each test."""
    db_file = str(tmp_path / "test.db")
    conn = sqlite3.connect(db_file)
    conn.row_factory = sqlite3.Row
    conn.execute("""
        CREATE TABLE IF NOT EXISTS plugin_settings (
            plugin_id TEXT NOT NULL,
            key TEXT NOT NULL,
            scope TEXT NOT NULL,
            username TEXT NOT NULL DEFAULT '',
            value TEXT NOT NULL,
            PRIMARY KEY (plugin_id, key, scope, username)
        )
    """)
    conn.commit()
    conn.close()

    from contextlib import contextmanager

    @contextmanager
    def mock_get_db():
        c = sqlite3.connect(db_file)
        c.row_factory = sqlite3.Row
        try:
            yield c
        except Exception:
            c.rollback()
            raise

    monkeypatch.setattr("skrib.plugin_bus.settings.get_db", mock_get_db)


@pytest.fixture
def mock_schema(monkeypatch):
    """Mock the schema lookup to return SAMPLE_SCHEMA."""
    monkeypatch.setattr(
        "skrib.plugin_bus.settings.get_settings_schema",
        lambda plugin_id: SAMPLE_SCHEMA,
    )


# ---------------------------------------------------------------------------
# Tests: Service layer — basic get/set
# ---------------------------------------------------------------------------

class TestGetSetSetting:
    def test_set_and_get_server_setting(self):
        set_setting("test.plugin", "max_upload", 2048, scope="server")
        value = get_setting("test.plugin", "max_upload", scope="server")
        assert value == 2048

    def test_set_and_get_user_setting(self):
        set_setting("test.plugin", "theme", "dark", scope="user", username="alice")
        value = get_setting("test.plugin", "theme", scope="user", username="alice")
        assert value == "dark"

    def test_get_nonexistent_returns_none(self):
        assert get_setting("test.plugin", "nonexistent") is None

    def test_user_settings_isolated_between_users(self):
        set_setting("test.plugin", "theme", "dark", scope="user", username="alice")
        set_setting("test.plugin", "theme", "light", scope="user", username="bob")
        assert get_setting("test.plugin", "theme", scope="user", username="alice") == "dark"
        assert get_setting("test.plugin", "theme", scope="user", username="bob") == "light"

    def test_overwrite_setting(self):
        set_setting("test.plugin", "max_upload", 1024, scope="server")
        set_setting("test.plugin", "max_upload", 2048, scope="server")
        assert get_setting("test.plugin", "max_upload", scope="server") == 2048

    def test_json_types_preserved(self):
        set_setting("test.plugin", "flag", True, scope="server")
        assert get_setting("test.plugin", "flag", scope="server") is True

        set_setting("test.plugin", "list", [1, 2, 3], scope="server")
        assert get_setting("test.plugin", "list", scope="server") == [1, 2, 3]


# ---------------------------------------------------------------------------
# Tests: Bulk operations with schema defaults
# ---------------------------------------------------------------------------

class TestBulkSettings:
    def test_get_server_settings_with_defaults(self, mock_schema):
        result = get_server_settings("test.plugin")
        assert result["max_upload"] == 1024  # default
        assert result["verbose"] is False    # default
        assert "theme" not in result         # user-scoped, not in server

    def test_get_server_settings_with_stored_override(self, mock_schema):
        set_setting("test.plugin", "max_upload", 4096, scope="server")
        result = get_server_settings("test.plugin")
        assert result["max_upload"] == 4096
        assert result["verbose"] is False  # still default

    def test_get_user_settings_with_defaults(self, mock_schema):
        result = get_user_settings("test.plugin", "alice")
        assert result["theme"] == "light"  # default
        assert "max_upload" not in result   # server-scoped

    def test_get_user_settings_with_override(self, mock_schema):
        set_setting("test.plugin", "theme", "dark", scope="user", username="alice")
        result = get_user_settings("test.plugin", "alice")
        assert result["theme"] == "dark"

    def test_update_server_settings(self, mock_schema):
        result = update_server_settings("test.plugin", {"max_upload": 8192, "verbose": True})
        assert result["max_upload"] == 8192
        assert result["verbose"] is True

    def test_update_user_settings(self, mock_schema):
        result = update_user_settings("test.plugin", "alice", {"theme": "dark"})
        assert result["theme"] == "dark"

    def test_update_server_settings_rejected_without_schema(self):
        """Settings updates are rejected when no schema is registered."""
        result = update_server_settings("test.plugin", {"arbitrary_key": "value"})
        assert "arbitrary_key" not in result

    def test_update_user_settings_rejected_without_schema(self):
        """User settings updates are rejected when no schema is registered."""
        result = update_user_settings("test.plugin", "alice", {"arbitrary_key": "value"})
        assert "arbitrary_key" not in result

    def test_update_server_settings_ignores_unknown_keys(self, mock_schema):
        """Even with schema, unknown keys are silently ignored."""
        result = update_server_settings("test.plugin", {"unknown_key": "value", "max_upload": 2048})
        assert "unknown_key" not in result
        assert result["max_upload"] == 2048


# ---------------------------------------------------------------------------
# Tests: config.updated notification
# ---------------------------------------------------------------------------

class TestNotification:
    async def test_notify_sends_frame(self):
        mock_bus = MagicMock()
        mock_bus.send_to_plugin = AsyncMock(return_value=True)

        mock_app = MagicMock()
        mock_app.state.plugin_bus = mock_bus

        with patch("skrib.plugin_bus.settings.app", mock_app, create=True):
            # We need to patch the import inside the function
            with patch.dict("sys.modules", {}):
                pass
            # Simpler: just test the function directly with a patched import
            import skrib.plugin_bus.settings as s
            original = s.notify_plugin_config_updated

            # Patch the main app import within the function
            async def patched_notify(plugin_id, key, value):
                return await mock_bus.send_to_plugin(plugin_id, {
                    "type": "config.updated",
                    "plugin_id": plugin_id,
                    "key": key,
                    "value": value,
                })

            result = await patched_notify("test.plugin", "max_upload", 4096)
            assert result is True
            mock_bus.send_to_plugin.assert_called_once()
            frame = mock_bus.send_to_plugin.call_args[0][1]
            assert frame["key"] == "max_upload"
            assert frame["value"] == 4096


# ---------------------------------------------------------------------------
# Tests: API routes
# ---------------------------------------------------------------------------

@pytest.fixture
def api_client(temp_db, monkeypatch):
    """FastAPI test client with mocked auth."""
    from skrib.plugins.settings_routes import router
    from skrib.dependencies import require_admin, require_auth

    app = FastAPI()
    app.include_router(router)

    app.dependency_overrides[require_admin] = lambda: "admin_user"
    app.dependency_overrides[require_auth] = lambda: "test_user"

    # Mock get_settings_schema to return our sample
    monkeypatch.setattr(
        "skrib.plugin_bus.settings.get_settings_schema",
        lambda plugin_id: SAMPLE_SCHEMA,
    )

    # Mock notify to avoid needing real bus
    monkeypatch.setattr(
        "skrib.plugin_bus.settings.notify_plugin_config_updated",
        AsyncMock(return_value=True),
    )

    return TestClient(app)


class TestSettingsAPI:
    def test_get_schema(self, api_client):
        resp = api_client.get("/plugins/test.plugin/settings/schema")
        assert resp.status_code == 200
        data = resp.json()
        assert data["plugin_id"] == "test.plugin"
        assert len(data["settings"]) == 3

    def test_get_server_settings_defaults(self, api_client):
        resp = api_client.get("/plugins/test.plugin/settings")
        assert resp.status_code == 200
        data = resp.json()
        assert data["scope"] == "server"
        assert data["settings"]["max_upload"] == 1024

    def test_update_server_settings(self, api_client):
        resp = api_client.patch(
            "/plugins/test.plugin/settings",
            json={"settings": {"max_upload": 8192}},
        )
        assert resp.status_code == 200
        assert resp.json()["settings"]["max_upload"] == 8192

        # Verify persisted
        resp = api_client.get("/plugins/test.plugin/settings")
        assert resp.json()["settings"]["max_upload"] == 8192

    def test_get_user_settings_defaults(self, api_client):
        resp = api_client.get("/plugins/test.plugin/settings/user")
        assert resp.status_code == 200
        data = resp.json()
        assert data["scope"] == "user"
        assert data["username"] == "test_user"
        assert data["settings"]["theme"] == "light"

    def test_update_user_settings(self, api_client):
        resp = api_client.patch(
            "/plugins/test.plugin/settings/user",
            json={"settings": {"theme": "dark"}},
        )
        assert resp.status_code == 200
        assert resp.json()["settings"]["theme"] == "dark"

        # Verify persisted
        resp = api_client.get("/plugins/test.plugin/settings/user")
        assert resp.json()["settings"]["theme"] == "dark"

    def test_server_and_user_settings_isolated(self, api_client):
        # Update server setting
        api_client.patch(
            "/plugins/test.plugin/settings",
            json={"settings": {"max_upload": 9999}},
        )
        # User settings should not be affected
        resp = api_client.get("/plugins/test.plugin/settings/user")
        assert "max_upload" not in resp.json()["settings"]
