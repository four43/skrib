"""Integration tests for server API endpoints."""
import base64
import secrets
from datetime import datetime

from skrib.database import get_db


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


# ---------------------------------------------------------------------------
# Tests: Server info
# ---------------------------------------------------------------------------

class TestServerInfo:
    def test_get_server_info(self, client):
        resp = client.get("/api/server")
        assert resp.status_code == 200
        data = resp.json()
        assert "registration_mode" in data
        assert "name" in data

    def test_update_server_requires_admin(self, client):
        token = _create_user("alice")
        resp = client.patch("/api/server", json={"name": "Test"}, headers=_auth(token))
        assert resp.status_code == 403

    def test_update_server_name(self, client):
        token = _create_user("admin", role="admin")
        resp = client.patch("/api/server", json={"name": "My Chat"}, headers=_auth(token))
        assert resp.status_code == 200
        assert resp.json()["name"] == "My Chat"

    def test_update_registration_mode(self, client):
        token = _create_user("admin", role="admin")
        resp = client.patch("/api/server",
                            json={"registration_mode": "open"}, headers=_auth(token))
        assert resp.status_code == 200
        assert resp.json()["registration_mode"] == "open"

    def test_update_dm_room_type_accepts_inprocess_plugin(self, client):
        """dm_room_type can name an in-process plugin — server/routes.py:57
        from Task 4C's follow-up review."""
        from skrib.main import app
        from skrib.plugins.registry import PluginRegistry
        from unittest.mock import MagicMock

        class _FakeInProcessHost:
            def plugin_records(self):
                return [{
                    "id": "four43.inproc-chat", "version": "1.0.0", "permissions": [],
                    "room_types": ["chat"], "room_type_meta": {}, "frontend_scripts": [],
                    "frontend_styles": [], "http_base_url": None, "runtime": "in_process",
                }]

        saved = getattr(app.state, "plugin_registry", None)
        mock_bus = MagicMock()
        mock_bus.room_type_map = {}
        app.state.plugin_registry = PluginRegistry(mock_bus, _FakeInProcessHost())
        try:
            token = _create_user("admin", role="admin")
            resp = client.patch("/api/server",
                                json={"dm_room_type": "four43.inproc-chat"}, headers=_auth(token))
            assert resp.status_code == 200
        finally:
            if saved is not None:
                app.state.plugin_registry = saved
            else:
                del app.state.plugin_registry

    def test_update_dm_room_type_rejects_unknown_plugin(self, client):
        from skrib.main import app
        from skrib.plugins.registry import PluginRegistry
        from unittest.mock import MagicMock

        saved = getattr(app.state, "plugin_registry", None)
        mock_bus = MagicMock()
        mock_bus.room_type_map = {}
        app.state.plugin_registry = PluginRegistry(mock_bus, None)
        try:
            token = _create_user("admin", role="admin")
            resp = client.patch("/api/server",
                                json={"dm_room_type": "four43.does-not-exist"}, headers=_auth(token))
            assert resp.status_code == 400
        finally:
            if saved is not None:
                app.state.plugin_registry = saved
            else:
                del app.state.plugin_registry


# ---------------------------------------------------------------------------
# Tests: Server icon
# ---------------------------------------------------------------------------

class TestServerIcon:
    def test_get_default_icon(self, client):
        resp = client.get("/api/server/icon")
        assert resp.status_code == 200
        assert resp.headers["content-type"] == "image/png"

    def test_delete_icon_requires_admin(self, client):
        token = _create_user("alice")
        resp = client.delete("/api/server/icon", headers=_auth(token))
        assert resp.status_code == 403

    def test_delete_icon_as_admin(self, client):
        token = _create_user("admin", role="admin")
        resp = client.delete("/api/server/icon", headers=_auth(token))
        assert resp.status_code == 200
        assert resp.json()["custom"] is False


# ---------------------------------------------------------------------------
# Tests: Invite tokens
# ---------------------------------------------------------------------------

class TestInviteTokens:
    def test_create_invite(self, client):
        token = _create_user("admin", role="admin")
        resp = client.post("/api/server/invites", headers=_auth(token))
        assert resp.status_code == 200
        data = resp.json()
        assert "token" in data
        assert "invite_url" in data

    def test_list_invites(self, client):
        token = _create_user("admin", role="admin")
        # Create one first
        client.post("/api/server/invites", headers=_auth(token))

        resp = client.get("/api/server/invites", headers=_auth(token))
        assert resp.status_code == 200
        assert len(resp.json()) == 1

    def test_delete_invite(self, client):
        token = _create_user("admin", role="admin")
        create_resp = client.post("/api/server/invites", headers=_auth(token))
        invite_token = create_resp.json()["token"]

        resp = client.delete(f"/api/server/invites/{invite_token}", headers=_auth(token))
        assert resp.status_code == 200

    def test_delete_nonexistent_invite(self, client):
        token = _create_user("admin", role="admin")
        resp = client.delete("/api/server/invites/nonexistent", headers=_auth(token))
        assert resp.status_code == 404

    def test_invites_require_admin(self, client):
        token = _create_user("alice")
        resp = client.post("/api/server/invites", headers=_auth(token))
        assert resp.status_code == 403

        resp = client.get("/api/server/invites", headers=_auth(token))
        assert resp.status_code == 403
