"""Integration tests for admin plugins API endpoints."""
import base64
import json
import secrets
from datetime import datetime
from unittest.mock import MagicMock

from skrib.database import get_db
from skrib.plugins.registry import PluginRegistry


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _make_token(username: str) -> str:
    return base64.urlsafe_b64encode(f"{username}:{secrets.token_hex(32)}".encode()).decode()


def _create_user(username: str, role: str = "user") -> str:
    with get_db() as conn:
        conn.execute(
            """INSERT INTO users (username, credential_id, public_key, status, role, color, created_at)
               VALUES (?, ?, ?, 'active', ?, '#aaaaaa', ?)""",
            (username, f"cred_{username}", f"pk_{username}", role, datetime.now().isoformat()),
        )
        conn.commit()
    return _make_token(username)


def _auth(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


class _FakeInProcessHost:
    """Mirrors InProcessHost.plugin_records() — see
    skrib.plugin_bus.inprocess_host.InProcessHost."""

    def __init__(self, records):
        self._records = records

    def plugin_records(self):
        return self._records


def _inprocess_record(plugin_id: str) -> dict:
    return {
        "id": plugin_id,
        "version": "1.0.0",
        "permissions": [],
        "room_types": ["chat"],
        "room_type_meta": {},
        "frontend_scripts": [],
        "frontend_styles": [],
        "http_base_url": None,
        "runtime": "in_process",
    }


def _install_inprocess_registry(plugin_id: str):
    """Make ``plugin_id`` resolve as an active in-process plugin.

    Returns the previous registry so the caller can restore it in a
    ``finally`` block, matching the pattern in test_rooms.py.
    """
    from skrib.main import app
    saved = getattr(app.state, "plugin_registry", None)
    host = _FakeInProcessHost([_inprocess_record(plugin_id)])
    app.state.plugin_registry = PluginRegistry(MagicMock(), host)
    return saved


def _restore_registry(saved):
    from skrib.main import app
    if saved is not None:
        app.state.plugin_registry = saved
    else:
        del app.state.plugin_registry


def _create_plugin_approval(plugin_id: str, status: str = "pending",
                             manifest: dict = None):
    """Insert a plugin approval record directly."""
    manifest = manifest or {"id": plugin_id, "name": f"Test {plugin_id}"}
    manifest_json = json.dumps(manifest)
    now = datetime.now().isoformat()
    with get_db() as conn:
        conn.execute(
            """INSERT INTO plugin_approvals
               (plugin_id, status, manifest_hash, manifest_json, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?)""",
            (plugin_id, status, "hash123", manifest_json, now, now),
        )
        conn.commit()


# ---------------------------------------------------------------------------
# Tests: List plugins
# ---------------------------------------------------------------------------

class TestListPlugins:
    def test_list_pending(self, client):
        token = _create_user("admin", role="admin")
        _create_plugin_approval("test.plugin1", status="pending")

        resp = client.get("/api/admin/plugins/pending", headers=_auth(token))
        assert resp.status_code == 200
        plugins = resp.json()
        assert len(plugins) >= 1
        ids = [p["plugin_id"] for p in plugins]
        assert "test.plugin1" in ids

    def test_list_approved(self, client):
        token = _create_user("admin", role="admin")
        _create_plugin_approval("test.plugin2", status="approved")

        resp = client.get("/api/admin/plugins/approved", headers=_auth(token))
        assert resp.status_code == 200
        plugins = resp.json()
        ids = [p["plugin_id"] for p in plugins]
        assert "test.plugin2" in ids

    def test_list_all(self, client):
        token = _create_user("admin", role="admin")
        _create_plugin_approval("test.plugin3", status="pending")
        _create_plugin_approval("test.plugin4", status="approved")

        resp = client.get("/api/admin/plugins", headers=_auth(token))
        assert resp.status_code == 200
        assert len(resp.json()) >= 2

    def test_list_requires_admin(self, client):
        token = _create_user("alice")

        resp = client.get("/api/admin/plugins/pending", headers=_auth(token))
        assert resp.status_code == 403

        resp = client.get("/api/admin/plugins/approved", headers=_auth(token))
        assert resp.status_code == 403

        resp = client.get("/api/admin/plugins", headers=_auth(token))
        assert resp.status_code == 403


# ---------------------------------------------------------------------------
# Tests: Approve/reject/disable
# ---------------------------------------------------------------------------

class TestPluginActions:
    def test_approve_plugin(self, client):
        token = _create_user("admin", role="admin")
        _create_plugin_approval("test.approve-me", status="pending")

        resp = client.post("/api/admin/plugins/test.approve-me/approve",
                           headers=_auth(token))
        assert resp.status_code == 200
        assert resp.json()["status"] == "approved"

    def test_approve_already_approved(self, client):
        token = _create_user("admin", role="admin")
        _create_plugin_approval("test.already", status="approved")

        resp = client.post("/api/admin/plugins/test.already/approve",
                           headers=_auth(token))
        assert resp.status_code == 400

    def test_approve_nonexistent(self, client):
        token = _create_user("admin", role="admin")

        resp = client.post("/api/admin/plugins/test.nope/approve",
                           headers=_auth(token))
        assert resp.status_code == 404

    def test_reject_plugin(self, client):
        token = _create_user("admin", role="admin")
        _create_plugin_approval("test.reject-me", status="pending")

        resp = client.post("/api/admin/plugins/test.reject-me/reject",
                           headers=_auth(token))
        assert resp.status_code == 200
        assert resp.json()["status"] == "rejected"

    def test_reject_nonexistent(self, client):
        token = _create_user("admin", role="admin")

        resp = client.post("/api/admin/plugins/test.nope/reject",
                           headers=_auth(token))
        assert resp.status_code == 404

    def test_disable_approved_plugin(self, client):
        token = _create_user("admin", role="admin")
        _create_plugin_approval("test.disable-me", status="approved")

        resp = client.post("/api/admin/plugins/test.disable-me/disable",
                           headers=_auth(token))
        assert resp.status_code == 200
        assert resp.json()["status"] == "disabled"

    def test_disable_non_approved_plugin(self, client):
        token = _create_user("admin", role="admin")
        _create_plugin_approval("test.pending", status="pending")

        resp = client.post("/api/admin/plugins/test.pending/disable",
                           headers=_auth(token))
        assert resp.status_code == 400

    def test_reject_in_process_plugin_is_rejected(self, client):
        """An in-process plugin (e.g. four43.room-type-chat) may still carry
        a stale approval record from before it moved in-process. Rejecting
        it would call bus.deactivate_plugin as a no-op and return 200 while
        the plugin keeps handling every room — see admin/routes.py."""
        token = _create_user("admin", role="admin")
        _create_plugin_approval("four43.inproc-chat", status="approved")
        saved = _install_inprocess_registry("four43.inproc-chat")
        try:
            resp = client.post("/api/admin/plugins/four43.inproc-chat/reject",
                               headers=_auth(token))
            assert resp.status_code == 400
            assert "in-process" in resp.json()["detail"].lower()
        finally:
            _restore_registry(saved)

    def test_disable_in_process_plugin_is_rejected(self, client):
        token = _create_user("admin", role="admin")
        _create_plugin_approval("four43.inproc-chat", status="approved")
        saved = _install_inprocess_registry("four43.inproc-chat")
        try:
            resp = client.post("/api/admin/plugins/four43.inproc-chat/disable",
                               headers=_auth(token))
            assert resp.status_code == 400
            assert "in-process" in resp.json()["detail"].lower()
        finally:
            _restore_registry(saved)

    def test_actions_require_admin(self, client):
        token = _create_user("alice")
        _create_plugin_approval("test.plugin")

        resp = client.post("/api/admin/plugins/test.plugin/approve",
                           headers=_auth(token))
        assert resp.status_code == 403


# ---------------------------------------------------------------------------
# Tests: Manifest diff
# ---------------------------------------------------------------------------

class TestManifestDiff:
    def test_get_manifest_diff(self, client):
        token = _create_user("admin", role="admin")
        manifest = {"id": "test.manifest", "name": "Test", "version": "1.0"}
        _create_plugin_approval("test.manifest", manifest=manifest)

        resp = client.get("/api/admin/plugins/test.manifest/manifest-diff",
                          headers=_auth(token))
        assert resp.status_code == 200

    def test_manifest_diff_nonexistent(self, client):
        token = _create_user("admin", role="admin")

        resp = client.get("/api/admin/plugins/test.nope/manifest-diff",
                          headers=_auth(token))
        assert resp.status_code == 404
