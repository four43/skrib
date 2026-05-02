"""Integration tests for the login flow.

Tests for username-assisted login (residentKey: "preferred" support).
When a username is provided to /login/begin, the server returns
allowCredentials populated with that user's credential so the
authenticator can use a non-discoverable credential.
"""
import secrets
from datetime import datetime

from skrib.database import get_db

from .conftest import set_mode, do_full_registration


def _create_active_user(username, credential_id=None):
    """Insert an active user directly in the DB and return their credential_id."""
    cred_id = credential_id or secrets.token_urlsafe(16)
    with get_db() as conn:
        conn.execute(
            """INSERT INTO users (username, credential_id, public_key, status, role, color, created_at)
               VALUES (?, ?, ?, 'active', 'user', '#aaa', ?)""",
            (username, cred_id, "pk_" + username, datetime.now().isoformat()),
        )
        conn.commit()
    return cred_id


class TestLoginBeginWithoutUsername:
    """Existing usernameless flow should still work."""

    def test_returns_empty_allow_credentials(self, client):
        resp = client.get("/api/auth/login/begin")
        assert resp.status_code == 200
        data = resp.json()
        assert data["allowCredentials"] == []
        assert "challenge" in data
        assert "rpId" in data

    def test_challenge_is_unique_each_call(self, client):
        r1 = client.get("/api/auth/login/begin").json()
        r2 = client.get("/api/auth/login/begin").json()
        assert r1["challenge"] != r2["challenge"]


class TestLoginBeginWithUsername:
    """When username is provided, allowCredentials should contain the user's credential."""

    def test_known_user_returns_credential(self, client):
        cred_id = _create_active_user("login_usr")
        resp = client.get("/api/auth/login/begin", params={"username": "login_usr"})
        assert resp.status_code == 200
        data = resp.json()
        assert len(data["allowCredentials"]) == 1
        assert data["allowCredentials"][0]["type"] == "public-key"
        assert data["allowCredentials"][0]["id"] == cred_id

    def test_unknown_user_returns_empty(self, client):
        """Don't reveal whether a user exists — return empty allowCredentials."""
        resp = client.get("/api/auth/login/begin", params={"username": "no_such_user"})
        assert resp.status_code == 200
        data = resp.json()
        assert data["allowCredentials"] == []

    def test_pending_user_returns_empty(self, client):
        """Pending (not yet approved) users should not get credentials."""
        with get_db() as conn:
            conn.execute(
                """INSERT INTO users (username, credential_id, public_key, status, role, color, created_at)
                   VALUES (?, ?, ?, 'pending', 'user', '#aaa', ?)""",
                ("pending_u", "cred_pending", "pk", datetime.now().isoformat()),
            )
            conn.commit()
        resp = client.get("/api/auth/login/begin", params={"username": "pending_u"})
        assert resp.status_code == 200
        data = resp.json()
        assert data["allowCredentials"] == []

    def test_still_returns_challenge_and_rpid(self, client):
        _create_active_user("has_creds")
        resp = client.get("/api/auth/login/begin", params={"username": "has_creds"})
        data = resp.json()
        assert "challenge" in data
        assert "rpId" in data


class TestLoginComplete:
    """Login complete should work regardless of whether username was used at begin."""

    def test_login_complete_with_username_assisted_flow(self, client):
        """Full flow: register user, then login with username-assisted begin."""
        set_mode("open")
        do_full_registration(client, "flow_user")

        # Get the credential_id from the DB
        with get_db() as conn:
            row = conn.execute(
                "SELECT credential_id FROM users WHERE username = ?", ("flow_user",)
            ).fetchone()
        cred_id = row["credential_id"]

        # Begin with username
        begin_resp = client.get("/api/auth/login/begin", params={"username": "flow_user"})
        assert begin_resp.status_code == 200
        begin_data = begin_resp.json()
        assert len(begin_data["allowCredentials"]) == 1

        # Complete
        complete_resp = client.post("/api/auth/login/complete", json={
            "credentialId": cred_id,
            "challenge": begin_data["challenge"],
        })
        assert complete_resp.status_code == 200
        data = complete_resp.json()
        assert data["username"] == "flow_user"
        assert "session_token" in data
