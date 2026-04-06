"""Integration tests for backups and system log API endpoints."""
import base64
import secrets
from datetime import datetime

from skrib.database import get_db, add_system_log


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
# Tests: Backup list
# ---------------------------------------------------------------------------

class TestBackupList:
    def test_list_backups_empty(self, client):
        token = _create_user("admin", role="admin")
        resp = client.get("/api/admin/backups", headers=_auth(token))
        assert resp.status_code == 200
        assert resp.json()["backups"] == []

    def test_list_backups_requires_admin(self, client):
        token = _create_user("alice")
        resp = client.get("/api/admin/backups", headers=_auth(token))
        assert resp.status_code == 403


# ---------------------------------------------------------------------------
# Tests: Create backup
# ---------------------------------------------------------------------------

class TestCreateBackup:
    def test_create_backup(self, client):
        token = _create_user("admin", role="admin")
        resp = client.post("/api/admin/backups", headers=_auth(token))
        assert resp.status_code == 200
        data = resp.json()
        assert data["status"] == "completed"
        assert "filename" in data
        assert data["size"] > 0

    def test_create_backup_requires_admin(self, client):
        token = _create_user("alice")
        resp = client.post("/api/admin/backups", headers=_auth(token))
        assert resp.status_code == 403


# ---------------------------------------------------------------------------
# Tests: Backup config
# ---------------------------------------------------------------------------

class TestBackupConfig:
    def test_get_config(self, client):
        token = _create_user("admin", role="admin")
        resp = client.get("/api/admin/backups/config", headers=_auth(token))
        assert resp.status_code == 200
        data = resp.json()
        assert "enabled" in data
        assert "directory" in data
        assert "schedule" in data

    def test_update_config(self, client):
        token = _create_user("admin", role="admin")
        resp = client.patch("/api/admin/backups/config",
                            json={"schedule": "04:00"}, headers=_auth(token))
        assert resp.status_code == 200
        assert resp.json()["schedule"] == "04:00"

    def test_disable_backups(self, client):
        token = _create_user("admin", role="admin")
        resp = client.patch("/api/admin/backups/config",
                            json={"enabled": False}, headers=_auth(token))
        assert resp.status_code == 200
        assert resp.json()["enabled"] is False

    def test_config_requires_admin(self, client):
        token = _create_user("alice")
        resp = client.get("/api/admin/backups/config", headers=_auth(token))
        assert resp.status_code == 403


# ---------------------------------------------------------------------------
# Tests: Download / delete backup
# ---------------------------------------------------------------------------

class TestBackupFileOps:
    def test_download_nonexistent(self, client):
        token = _create_user("admin", role="admin")
        resp = client.get("/api/admin/backups/nonexistent.zip", headers=_auth(token))
        assert resp.status_code == 404

    def test_delete_nonexistent(self, client):
        token = _create_user("admin", role="admin")
        resp = client.delete("/api/admin/backups/nonexistent.zip", headers=_auth(token))
        assert resp.status_code == 404

    def test_path_traversal_blocked(self, client):
        token = _create_user("admin", role="admin")
        resp = client.get("/api/admin/backups/../../../etc/passwd", headers=_auth(token))
        assert resp.status_code in (400, 404, 422)

    def test_create_and_delete_backup(self, client):
        token = _create_user("admin", role="admin")

        # Create
        create_resp = client.post("/api/admin/backups", headers=_auth(token))
        assert create_resp.status_code == 200
        filename = create_resp.json()["filename"]

        # Delete
        resp = client.delete(f"/api/admin/backups/{filename}", headers=_auth(token))
        assert resp.status_code == 200


# ---------------------------------------------------------------------------
# Tests: System log
# ---------------------------------------------------------------------------

class TestSystemLog:
    def test_get_logs_empty(self, client):
        token = _create_user("admin", role="admin")
        resp = client.get("/api/admin/logs", headers=_auth(token))
        assert resp.status_code == 200
        data = resp.json()
        assert "entries" in data
        assert "total" in data

    def test_get_logs_with_entries(self, client):
        token = _create_user("admin", role="admin")
        add_system_log("test", "Test log message", level="info")
        add_system_log("test", "Another message", level="warn")

        resp = client.get("/api/admin/logs", headers=_auth(token))
        assert resp.status_code == 200
        data = resp.json()
        assert data["total"] >= 2

    def test_filter_by_category(self, client):
        token = _create_user("admin", role="admin")
        add_system_log("backups", "Backup done")
        add_system_log("plugins", "Plugin loaded")

        resp = client.get("/api/admin/logs?category=backups", headers=_auth(token))
        assert resp.status_code == 200
        entries = resp.json()["entries"]
        for e in entries:
            assert e["category"] == "backups"

    def test_logs_require_admin(self, client):
        token = _create_user("alice")
        resp = client.get("/api/admin/logs", headers=_auth(token))
        assert resp.status_code == 403

    def test_pagination(self, client):
        token = _create_user("admin", role="admin")
        for i in range(10):
            add_system_log("test", f"Log entry {i}")

        resp = client.get("/api/admin/logs?page=1&page_size=3", headers=_auth(token))
        assert resp.status_code == 200
        data = resp.json()
        assert len(data["entries"]) == 3
        assert data["page"] == 1
        assert data["page_size"] == 3
        assert data["total"] >= 10
