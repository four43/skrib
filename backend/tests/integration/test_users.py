"""Integration tests for users API endpoints."""
import base64
import secrets
from datetime import datetime

from skrib.database import get_db

from .conftest import do_full_registration, set_mode


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _make_token(username: str) -> str:
    return base64.urlsafe_b64encode(f"{username}:{secrets.token_hex(32)}".encode()).decode()


def _create_user(username: str, role: str = "user", status: str = "active",
                 approval_code: str = None) -> str:
    with get_db() as conn:
        conn.execute(
            """INSERT INTO users (username, credential_id, public_key, status, role, color, created_at, approval_code)
               VALUES (?, ?, ?, ?, ?, '#aaaaaa', ?, ?)""",
            (username, f"cred_{username}", f"pk_{username}", status, role,
             datetime.now().isoformat(), approval_code),
        )
        conn.commit()
    return _make_token(username)


def _auth(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


# ---------------------------------------------------------------------------
# Tests: List users
# ---------------------------------------------------------------------------

class TestListUsers:
    def test_list_users_display(self, client):
        token = _create_user("alice")
        _create_user("bob")

        resp = client.get("/api/users", headers=_auth(token))
        assert resp.status_code == 200
        users = resp.json()
        assert len(users) == 2
        usernames = {u["username"] for u in users}
        assert "alice" in usernames
        assert "bob" in usernames

    def test_list_users_admin_detail(self, client):
        token = _create_user("admin", role="admin")
        _create_user("bob")

        resp = client.get("/api/users?detail=admin", headers=_auth(token))
        assert resp.status_code == 200
        users = resp.json()
        assert len(users) == 2
        # Admin detail includes role and account_status
        assert "role" in users[0]
        assert "account_status" in users[0]

    def test_list_users_admin_detail_forbidden(self, client):
        token = _create_user("alice")

        resp = client.get("/api/users?detail=admin", headers=_auth(token))
        assert resp.status_code == 403

    def test_list_users_filter_pending(self, client):
        token = _create_user("admin", role="admin")
        _create_user("pending-user", status="pending", approval_code="abc123")

        resp = client.get("/api/users?detail=admin&account_status=pending", headers=_auth(token))
        assert resp.status_code == 200
        users = resp.json()
        assert len(users) == 1
        assert users[0]["username"] == "pending-user"


# ---------------------------------------------------------------------------
# Tests: Approve/reject pending users
# ---------------------------------------------------------------------------

class TestPendingUsers:
    def test_approve_pending_user(self, client):
        token = _create_user("admin", role="admin")
        _create_user("pending-user", status="pending", approval_code="code123")

        resp = client.patch("/api/users/pending/code123",
                            json={"status": "approved"}, headers=_auth(token))
        assert resp.status_code == 200
        assert resp.json()["action"] == "approved"

    def test_reject_pending_user(self, client):
        token = _create_user("admin", role="admin")
        _create_user("pending-user", status="pending", approval_code="code456")

        resp = client.patch("/api/users/pending/code456",
                            json={"status": "rejected"}, headers=_auth(token))
        assert resp.status_code == 200
        assert resp.json()["action"] == "rejected"

    def test_approve_nonexistent_code(self, client):
        token = _create_user("admin", role="admin")

        resp = client.patch("/api/users/pending/nope",
                            json={"status": "approved"}, headers=_auth(token))
        assert resp.status_code == 404

    def test_approve_requires_moderator(self, client):
        token = _create_user("alice")

        resp = client.patch("/api/users/pending/code",
                            json={"status": "approved"}, headers=_auth(token))
        assert resp.status_code == 403


# ---------------------------------------------------------------------------
# Tests: Delete user
# ---------------------------------------------------------------------------

class TestDeleteUser:
    def test_delete_user_as_admin(self, client):
        token = _create_user("admin", role="admin")
        _create_user("bob")

        resp = client.delete("/api/users/bob", headers=_auth(token))
        assert resp.status_code == 200

    def test_delete_user_not_admin(self, client):
        token = _create_user("alice")
        _create_user("bob")

        resp = client.delete("/api/users/bob", headers=_auth(token))
        assert resp.status_code == 403

    def test_delete_last_admin(self, client):
        token = _create_user("admin", role="admin")

        resp = client.delete("/api/users/admin", headers=_auth(token))
        assert resp.status_code == 400

    def test_delete_nonexistent_user(self, client):
        token = _create_user("admin", role="admin")

        resp = client.delete("/api/users/ghost", headers=_auth(token))
        assert resp.status_code == 400


# ---------------------------------------------------------------------------
# Tests: User profile
# ---------------------------------------------------------------------------

class TestUserProfile:
    def test_get_own_profile(self, client):
        token = _create_user("alice")

        resp = client.get("/api/users/alice", headers=_auth(token))
        assert resp.status_code == 200
        data = resp.json()
        assert data["username"] == "alice"
        assert data["color"] == "#aaaaaa"
        # Own profile includes theme fields
        assert "theme_name" in data

    def test_get_other_profile(self, client):
        token = _create_user("alice")
        _create_user("bob")

        resp = client.get("/api/users/bob", headers=_auth(token))
        assert resp.status_code == 200
        data = resp.json()
        assert data["username"] == "bob"
        # Other profile does NOT include theme fields
        assert "theme_name" not in data

    def test_get_nonexistent_profile(self, client):
        token = _create_user("alice")

        resp = client.get("/api/users/ghost", headers=_auth(token))
        assert resp.status_code == 404


# ---------------------------------------------------------------------------
# Tests: Update user
# ---------------------------------------------------------------------------

class TestUpdateUser:
    def test_update_own_color(self, client):
        token = _create_user("alice")

        resp = client.patch("/api/users/alice",
                            json={"color": "#ff0000"}, headers=_auth(token))
        assert resp.status_code == 200

        # Verify
        resp = client.get("/api/users/alice", headers=_auth(token))
        assert resp.json()["color"] == "#ff0000"

    def test_update_own_nickname(self, client):
        token = _create_user("alice")

        resp = client.patch("/api/users/alice",
                            json={"nickname": "Ali"}, headers=_auth(token))
        assert resp.status_code == 200

    def test_update_other_forbidden(self, client):
        token = _create_user("alice")
        _create_user("bob")

        resp = client.patch("/api/users/bob",
                            json={"color": "#ff0000"}, headers=_auth(token))
        assert resp.status_code == 403

    def test_admin_can_set_role(self, client):
        token = _create_user("admin", role="admin")
        _create_user("bob")

        resp = client.patch("/api/users/bob",
                            json={"role": "moderator"}, headers=_auth(token))
        assert resp.status_code == 200

    def test_non_admin_cannot_set_role(self, client):
        token = _create_user("alice")
        _create_user("bob")

        resp = client.patch("/api/users/bob",
                            json={"role": "admin"}, headers=_auth(token))
        assert resp.status_code == 403

    def test_invalid_role(self, client):
        token = _create_user("admin", role="admin")
        _create_user("bob")

        resp = client.patch("/api/users/bob",
                            json={"role": "superuser"}, headers=_auth(token))
        assert resp.status_code == 400

    def test_update_status(self, client):
        token = _create_user("alice")

        resp = client.patch("/api/users/alice",
                            json={"status_emoji": "🎉", "status_text": "Celebrating!"},
                            headers=_auth(token))
        assert resp.status_code == 200


# ---------------------------------------------------------------------------
# Tests: Avatar
# ---------------------------------------------------------------------------

class TestAvatar:
    def test_get_avatar(self, client):
        _create_user("alice")
        resp = client.get("/api/users/alice/avatar")
        assert resp.status_code == 200
        assert resp.headers["content-type"] == "image/png"

    def test_get_avatar_nonexistent(self, client):
        resp = client.get("/api/users/ghost/avatar")
        assert resp.status_code == 404
