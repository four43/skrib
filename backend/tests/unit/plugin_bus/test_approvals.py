"""Tests for the plugin approval system — approval service, bus server integration,
and admin API routes."""
import json
import os
import sqlite3
import tempfile
from unittest.mock import AsyncMock, patch, MagicMock

import pytest
from fastapi.testclient import TestClient
from fastapi import FastAPI

from skrib.plugin_bus.approvals import (
    check_plugin_approval,
    approve_plugin,
    reject_plugin,
    disable_plugin,
    delete_approval,
    get_approval,
    get_plugin_secret,
    list_by_status,
    get_manifest_diff,
    _manifest_hash,
)
from skrib.plugin_bus.server import PluginBusServer
from skrib.plugin_bus.protocol import ApprovalStatus


# ---------------------------------------------------------------------------
# Fixtures — use a temp database for isolation
# ---------------------------------------------------------------------------

@pytest.fixture(autouse=True)
def temp_db(tmp_path, monkeypatch):
    """Create a temporary database for each test."""
    db_file = str(tmp_path / "test.db")
    conn = sqlite3.connect(db_file)
    conn.row_factory = sqlite3.Row
    conn.execute("""
        CREATE TABLE IF NOT EXISTS plugin_approvals (
            plugin_id TEXT PRIMARY KEY,
            status TEXT NOT NULL DEFAULT 'pending',
            manifest_hash TEXT NOT NULL,
            manifest_json TEXT NOT NULL,
            secret TEXT,
            approved_by TEXT,
            approved_at TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        )
    """)
    conn.commit()
    conn.close()

    # Patch get_db to use our temp database
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

    monkeypatch.setattr("skrib.plugin_bus.approvals.get_db", mock_get_db)


SAMPLE_MANIFEST = {
    "id": "test.plugin",
    "version": "1.0.0",
    "permissions": ["bus.send", "bus.receive"],
}


# ---------------------------------------------------------------------------
# Tests: Manifest hash
# ---------------------------------------------------------------------------

class TestManifestHash:
    def test_stable_hash(self):
        """Same manifest produces same hash regardless of key order."""
        m1 = {"permissions": ["a", "b"], "id": "test", "description": "x"}
        m2 = {"id": "test", "permissions": ["a", "b"], "description": "y"}
        assert _manifest_hash(m1) == _manifest_hash(m2)

    def test_different_permissions_different_hash(self):
        m1 = {"id": "test", "permissions": ["bus.send"]}
        m2 = {"id": "test", "permissions": ["bus.send", "core_api"]}
        assert _manifest_hash(m1) != _manifest_hash(m2)

    def test_cosmetic_changes_same_hash(self):
        """Non-security fields (name, description, entry) don't affect the hash."""
        m1 = {"id": "test", "permissions": ["bus.send"], "name": "Old Name", "entry": "old.js"}
        m2 = {"id": "test", "permissions": ["bus.send"], "name": "New Name", "entry": "new.js"}
        assert _manifest_hash(m1) == _manifest_hash(m2)


# ---------------------------------------------------------------------------
# Tests: check_plugin_approval
# ---------------------------------------------------------------------------

class TestCheckPluginApproval:
    def test_new_plugin_returns_pending(self):
        status = check_plugin_approval("test.plugin", SAMPLE_MANIFEST)
        assert status == "pending"

    def test_new_plugin_creates_record(self):
        check_plugin_approval("test.plugin", SAMPLE_MANIFEST)
        record = get_approval("test.plugin")
        assert record is not None
        assert record["status"] == "pending"
        assert record["manifest_hash"] == _manifest_hash(SAMPLE_MANIFEST)

    def test_approved_plugin_with_same_manifest(self):
        check_plugin_approval("test.plugin", SAMPLE_MANIFEST)
        approve_plugin("test.plugin", "admin1")

        status = check_plugin_approval("test.plugin", SAMPLE_MANIFEST)
        assert status == "approved"

    def test_approved_plugin_with_changed_manifest_re_enters_pending(self):
        check_plugin_approval("test.plugin", SAMPLE_MANIFEST)
        approve_plugin("test.plugin", "admin1")

        changed = {**SAMPLE_MANIFEST, "permissions": ["bus.send", "bus.receive", "core_api"]}
        status = check_plugin_approval("test.plugin", changed)
        assert status == "pending"

        record = get_approval("test.plugin")
        assert record["status"] == "pending"
        assert record["manifest_hash"] == _manifest_hash(changed)

    def test_rejected_plugin_stays_rejected(self):
        check_plugin_approval("test.plugin", SAMPLE_MANIFEST)
        reject_plugin("test.plugin")

        status = check_plugin_approval("test.plugin", SAMPLE_MANIFEST)
        assert status == "rejected"

    def test_disabled_plugin_stays_disabled(self):
        check_plugin_approval("test.plugin", SAMPLE_MANIFEST)
        approve_plugin("test.plugin", "admin1")
        disable_plugin("test.plugin")

        status = check_plugin_approval("test.plugin", SAMPLE_MANIFEST)
        assert status == "disabled"


# ---------------------------------------------------------------------------
# Tests: Admin actions
# ---------------------------------------------------------------------------

class TestAdminActions:
    def test_approve_pending_plugin(self):
        check_plugin_approval("test.plugin", SAMPLE_MANIFEST)
        result = approve_plugin("test.plugin", "admin1")
        assert result is True
        record = get_approval("test.plugin")
        assert record["status"] == "approved"
        assert record["approved_by"] == "admin1"

    def test_approve_nonexistent_returns_false(self):
        assert approve_plugin("nonexistent", "admin1") is False

    def test_reject_plugin(self):
        check_plugin_approval("test.plugin", SAMPLE_MANIFEST)
        result = reject_plugin("test.plugin")
        assert result is True
        assert get_approval("test.plugin")["status"] == "rejected"

    def test_disable_approved_plugin(self):
        check_plugin_approval("test.plugin", SAMPLE_MANIFEST)
        approve_plugin("test.plugin", "admin1")
        result = disable_plugin("test.plugin")
        assert result is True
        assert get_approval("test.plugin")["status"] == "disabled"

    def test_list_by_status(self):
        check_plugin_approval("plugin.a", SAMPLE_MANIFEST)
        check_plugin_approval("plugin.b", {**SAMPLE_MANIFEST, "id": "plugin.b"})
        approve_plugin("plugin.a", "admin1")

        pending = list_by_status("pending")
        approved = list_by_status("approved")
        assert len(pending) == 1
        assert pending[0]["plugin_id"] == "plugin.b"
        assert len(approved) == 1
        assert approved[0]["plugin_id"] == "plugin.a"

    def test_manifest_diff(self):
        check_plugin_approval("test.plugin", SAMPLE_MANIFEST)
        diff = get_manifest_diff("test.plugin")
        assert diff is not None
        assert diff["plugin_id"] == "test.plugin"
        assert diff["manifest"]["permissions"] == ["bus.send", "bus.receive"]

    def test_delete_approval_removes_record(self):
        check_plugin_approval("stale.plugin", SAMPLE_MANIFEST)
        assert get_approval("stale.plugin") is not None
        assert delete_approval("stale.plugin") is True
        assert get_approval("stale.plugin") is None

    def test_delete_approval_missing_returns_false(self):
        assert delete_approval("nonexistent.plugin") is False


# ---------------------------------------------------------------------------
# Tests: Bus server activate/deactivate
# ---------------------------------------------------------------------------

class TestBusServerActivation:
    async def test_activate_pending_plugin(self):
        server = PluginBusServer()
        mock_ws = AsyncMock()

        from skrib.plugin_bus.server import PluginConnection
        conn = PluginConnection(
            plugin_id="test.plugin",
            version="1.0.0",
            ws=mock_ws,
            permissions={"bus.send"},
            status=ApprovalStatus.PENDING,
        )
        server._plugins["test.plugin"] = conn

        result = await server.activate_plugin("test.plugin")
        assert result is True
        assert conn.status == ApprovalStatus.APPROVED
        mock_ws.send.assert_called_once()
        sent = json.loads(mock_ws.send.call_args[0][0])
        assert sent["status"] == "approved"

    async def test_activate_nonexistent_returns_false(self):
        server = PluginBusServer()
        result = await server.activate_plugin("nonexistent")
        assert result is False

    async def test_activate_already_approved_returns_false(self):
        server = PluginBusServer()
        from skrib.plugin_bus.server import PluginConnection
        conn = PluginConnection(
            plugin_id="test.plugin",
            version="1.0.0",
            ws=AsyncMock(),
            status=ApprovalStatus.APPROVED,
        )
        server._plugins["test.plugin"] = conn
        result = await server.activate_plugin("test.plugin")
        assert result is False

    async def test_deactivate_connected_plugin(self):
        server = PluginBusServer()
        mock_ws = AsyncMock()

        from skrib.plugin_bus.server import PluginConnection
        conn = PluginConnection(
            plugin_id="test.plugin",
            version="1.0.0",
            ws=mock_ws,
            status=ApprovalStatus.APPROVED,
        )
        server._plugins["test.plugin"] = conn

        result = await server.deactivate_plugin("test.plugin", reason="rejected")
        assert result is True
        assert "test.plugin" not in server._plugins
        mock_ws.close.assert_called_once()


# ---------------------------------------------------------------------------
# Tests: Admin API routes
# ---------------------------------------------------------------------------

@pytest.fixture
def admin_client(temp_db, monkeypatch):
    """FastAPI test client with mocked admin auth."""
    from skrib.admin.routes import router
    from skrib.dependencies import require_admin

    app = FastAPI()
    app.include_router(router)

    # Override require_admin dependency to always return "admin_user"
    app.dependency_overrides[require_admin] = lambda: "admin_user"

    # Mock _get_bus_server
    mock_bus = MagicMock()
    mock_bus.get_plugin.return_value = None
    mock_bus.activate_plugin = AsyncMock(return_value=True)
    mock_bus.deactivate_plugin = AsyncMock(return_value=True)
    monkeypatch.setattr("skrib.admin.routes._get_bus_server", lambda: mock_bus)

    # Mock add_system_log
    monkeypatch.setattr("skrib.admin.routes.add_system_log", lambda *a, **kw: None)

    return TestClient(app), mock_bus


class TestAdminAPI:
    def test_list_pending(self, admin_client):
        client, _ = admin_client
        check_plugin_approval("test.plugin", SAMPLE_MANIFEST)

        resp = client.get("/admin/plugins/pending")
        assert resp.status_code == 200
        data = resp.json()
        assert len(data) == 1
        assert data[0]["plugin_id"] == "test.plugin"
        assert data[0]["status"] == "pending"

    def test_list_approved(self, admin_client):
        client, _ = admin_client
        check_plugin_approval("test.plugin", SAMPLE_MANIFEST)
        approve_plugin("test.plugin", "admin1")

        resp = client.get("/admin/plugins/approved")
        assert resp.status_code == 200
        assert len(resp.json()) == 1
        assert resp.json()[0]["status"] == "approved"

    def test_approve_plugin(self, admin_client):
        client, mock_bus = admin_client
        check_plugin_approval("test.plugin", SAMPLE_MANIFEST)

        resp = client.post("/admin/plugins/test.plugin/approve")
        assert resp.status_code == 200
        data = resp.json()
        assert data["status"] == "approved"
        assert data["activated"] is True

        record = get_approval("test.plugin")
        assert record["status"] == "approved"

    def test_approve_already_approved(self, admin_client):
        client, _ = admin_client
        check_plugin_approval("test.plugin", SAMPLE_MANIFEST)
        approve_plugin("test.plugin", "admin1")

        resp = client.post("/admin/plugins/test.plugin/approve")
        assert resp.status_code == 400

    def test_reject_plugin(self, admin_client):
        client, mock_bus = admin_client
        check_plugin_approval("test.plugin", SAMPLE_MANIFEST)

        resp = client.post("/admin/plugins/test.plugin/reject")
        assert resp.status_code == 200
        assert resp.json()["status"] == "rejected"
        mock_bus.deactivate_plugin.assert_called_once()

    def test_disable_plugin(self, admin_client):
        client, mock_bus = admin_client
        check_plugin_approval("test.plugin", SAMPLE_MANIFEST)
        approve_plugin("test.plugin", "admin1")

        resp = client.post("/admin/plugins/test.plugin/disable")
        assert resp.status_code == 200
        assert resp.json()["status"] == "disabled"
        mock_bus.deactivate_plugin.assert_called_once()

    def test_disable_non_approved_fails(self, admin_client):
        client, _ = admin_client
        check_plugin_approval("test.plugin", SAMPLE_MANIFEST)

        resp = client.post("/admin/plugins/test.plugin/disable")
        assert resp.status_code == 400

    def test_manifest_diff(self, admin_client):
        client, _ = admin_client
        check_plugin_approval("test.plugin", SAMPLE_MANIFEST)

        resp = client.get("/admin/plugins/test.plugin/manifest-diff")
        assert resp.status_code == 200
        data = resp.json()
        assert data["plugin_id"] == "test.plugin"
        assert data["manifest"]["permissions"] == ["bus.send", "bus.receive"]

    def test_not_found(self, admin_client):
        client, _ = admin_client
        resp = client.post("/admin/plugins/nonexistent/approve")
        assert resp.status_code == 404

    def test_list_all(self, admin_client):
        client, _ = admin_client
        check_plugin_approval("plugin.a", SAMPLE_MANIFEST)
        check_plugin_approval("plugin.b", {**SAMPLE_MANIFEST, "id": "plugin.b"})
        approve_plugin("plugin.a", "admin1")

        resp = client.get("/admin/plugins")
        assert resp.status_code == 200
        assert len(resp.json()) == 2

    def test_approve_returns_secret(self, admin_client):
        client, _ = admin_client
        check_plugin_approval("test.plugin", SAMPLE_MANIFEST)

        resp = client.post("/admin/plugins/test.plugin/approve")
        assert resp.status_code == 200
        data = resp.json()
        assert "secret" in data
        assert data["secret"] is not None
        assert len(data["secret"]) == 64  # token_hex(32) = 64 chars


# ---------------------------------------------------------------------------
# Tests: Plugin secret generation and retrieval
# ---------------------------------------------------------------------------

class TestPluginSecrets:
    def test_pending_plugin_has_no_secret(self):
        check_plugin_approval("test.plugin", SAMPLE_MANIFEST)
        assert get_plugin_secret("test.plugin") is None

    def test_approved_plugin_gets_secret(self):
        check_plugin_approval("test.plugin", SAMPLE_MANIFEST)
        approve_plugin("test.plugin", "admin1")
        secret = get_plugin_secret("test.plugin")
        assert secret is not None
        assert len(secret) == 64  # token_hex(32) = 64 hex chars

    def test_secret_preserved_on_re_approval(self):
        check_plugin_approval("test.plugin", SAMPLE_MANIFEST)
        approve_plugin("test.plugin", "admin1")
        secret1 = get_plugin_secret("test.plugin")

        # Change manifest -> re-enters pending
        changed = {**SAMPLE_MANIFEST, "permissions": ["bus.send", "bus.receive", "core_api"]}
        check_plugin_approval("test.plugin", changed)
        assert get_approval("test.plugin")["status"] == "pending"

        # Re-approve -> same secret
        approve_plugin("test.plugin", "admin1")
        secret2 = get_plugin_secret("test.plugin")
        assert secret1 == secret2

    def test_nonexistent_plugin_returns_none(self):
        assert get_plugin_secret("nonexistent") is None
