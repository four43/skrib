"""Integration tests for the registration flow.

These target the PROPOSED API shape (3 endpoints, bound tokens/challenges,
TTL enforcement). They will start red and drive the implementation.
"""
from datetime import datetime, timedelta

from skrib.database import get_db

from .conftest import (
    set_mode,
    create_invite_token,
    parse_redirect,
    do_register_step1,
    do_begin,
    do_complete,
    do_full_registration,
)


# -----------------------------------------------------------------------
# Endpoint shape — rename & removal
# -----------------------------------------------------------------------

class TestEndpointShape:
    """POST /register replaces /register/step1; token-info is removed."""

    def test_post_register_endpoint_exists(self, client):
        set_mode("open")
        resp = client.post("/api/auth/register", data={"username": "test_user"})
        assert resp.status_code == 303

    def test_old_step1_endpoint_gone(self, client):
        set_mode("open")
        resp = client.post("/api/auth/register/step1", data={"username": "test_user"})
        # Should be 404 (no route) or 405 (method not allowed)
        assert resp.status_code in (404, 405)

    def test_token_info_endpoint_removed(self, client):
        resp = client.get("/api/auth/register/token-info", params={"token": "x"})
        assert resp.status_code == 404


# -----------------------------------------------------------------------
# Registration modes
# -----------------------------------------------------------------------

class TestRegistrationModes:
    def test_open_mode(self, client):
        set_mode("open")
        resp, (path, params) = do_register_step1(client, "test_user")
        assert resp.status_code == 303
        assert path == "/enroll-passkey.html"
        assert "registration_token" in params

    def test_closed_mode(self, client):
        set_mode("closed")
        resp, (path, params) = do_register_step1(client, "test_user")
        assert resp.status_code == 303
        assert path == "/register.html"
        assert "closed" in params.get("error", "").lower()

    def test_invite_only_no_token(self, client):
        set_mode("invite_only")
        resp, (path, params) = do_register_step1(client, "test_user")
        assert resp.status_code == 303
        assert path == "/register.html"
        assert "invite" in params.get("error", "").lower()

    def test_invite_only_valid_token(self, client):
        set_mode("invite_only")
        token = create_invite_token()
        resp, (path, params) = do_register_step1(client, "test_user", invite=token)
        assert resp.status_code == 303
        assert path == "/enroll-passkey.html"

    def test_invite_only_invalid_token(self, client):
        set_mode("invite_only")
        resp, (path, params) = do_register_step1(client, "test_user", invite="bogus")
        assert resp.status_code == 303
        assert path == "/register.html"

    def test_approval_required(self, client):
        set_mode("approval_required")
        resp, (path, params) = do_register_step1(client, "test_user")
        assert resp.status_code == 303
        assert path == "/enroll-passkey.html"


# -----------------------------------------------------------------------
# Username validation
# -----------------------------------------------------------------------

class TestUsernameValidation:
    def _register_error(self, client, username):
        set_mode("open")
        resp, (path, params) = do_register_step1(client, username)
        assert path == "/register.html", f"Expected error redirect, got {path}"
        return params.get("error", "")

    def test_too_short(self, client):
        err = self._register_error(client, "abc")
        assert "4 char" in err.lower() or "at least" in err.lower()

    def test_too_long(self, client):
        err = self._register_error(client, "a" * 16)
        assert "15" in err

    def test_invalid_chars(self, client):
        err = self._register_error(client, "user@name")
        assert "letters" in err.lower() or "underscore" in err.lower()

    def test_reserved_admin(self, client):
        err = self._register_error(client, "myadmin1")
        assert "admin" in err.lower()

    def test_already_taken(self, client):
        set_mode("open")
        # Create a user directly in the DB
        with get_db() as conn:
            conn.execute(
                """INSERT INTO users (username, credential_id, public_key, status, role, color, created_at)
                   VALUES (?, ?, ?, 'active', 'user', '#aaa', ?)""",
                ("taken_user", "cred1", "pk1", datetime.now().isoformat()),
            )
            conn.commit()
        err = self._register_error(client, "taken_user")
        assert "taken" in err.lower()

    def test_valid_username(self, client):
        set_mode("open")
        resp, (path, params) = do_register_step1(client, "good_user")
        assert path == "/enroll-passkey.html"


# -----------------------------------------------------------------------
# Begin endpoint — returns username, validates token
# -----------------------------------------------------------------------

class TestBeginEndpoint:
    def test_returns_username(self, client):
        """begin should return the username from the registration token."""
        set_mode("open")
        _, (_, params) = do_register_step1(client, "alice1234")
        token = params["registration_token"]

        resp = do_begin(client, token)
        assert resp.status_code == 200
        data = resp.json()
        assert data["username"] == "alice1234"
        assert "challenge" in data

    def test_rejects_invalid_token(self, client):
        resp = do_begin(client, "totally_bogus_token")
        assert resp.status_code in (400, 404)

    def test_rejects_expired_token(self, client):
        """Tokens older than 5 minutes should be rejected."""
        set_mode("open")
        _, (_, params) = do_register_step1(client, "expiring1")
        token = params["registration_token"]

        # Backdate the token by 10 minutes
        old_time = (datetime.now() - timedelta(minutes=10)).isoformat()
        with get_db() as conn:
            conn.execute(
                "UPDATE challenges SET timestamp = ? WHERE challenge = ? AND type = 'registration_step1'",
                (old_time, token),
            )
            conn.commit()

        resp = do_begin(client, token)
        assert resp.status_code in (400, 404)


# -----------------------------------------------------------------------
# Complete endpoint — token binding, challenge binding
# -----------------------------------------------------------------------

class TestCompleteEndpoint:
    def test_uses_token_username(self, client):
        """complete should derive username from the registration_token, not from a body field."""
        set_mode("open")
        _, (_, params) = do_register_step1(client, "from_token")
        token = params["registration_token"]

        resp = do_begin(client, token)
        challenge = resp.json()["challenge"]

        resp = do_complete(client, token, challenge)
        assert resp.status_code == 200

        # Verify user was created with the token's username
        with get_db() as conn:
            row = conn.execute(
                "SELECT username FROM users WHERE username = ?", ("from_token",)
            ).fetchone()
        assert row is not None

    def test_rejects_invalid_token(self, client):
        resp = do_complete(client, "bogus", "fake_challenge")
        assert resp.status_code in (400, 404)

    def test_rejects_wrong_challenge(self, client):
        set_mode("open")
        _, (_, params) = do_register_step1(client, "challenge1")
        token = params["registration_token"]
        do_begin(client, token)  # generates a real challenge, but we ignore it

        resp = do_complete(client, token, "fabricated_challenge")
        assert resp.status_code == 400

    def test_rejects_reused_challenge(self, client):
        set_mode("open")
        _, (_, params) = do_register_step1(client, "reuse_usr")
        token = params["registration_token"]

        resp = do_begin(client, token)
        challenge = resp.json()["challenge"]

        # First complete should succeed
        resp = do_complete(client, token, challenge)
        assert resp.status_code == 200

        # Second complete with same challenge should fail
        # (need a new step1 token since the first was consumed)
        _, (_, params2) = do_register_step1(client, "reuse_ur2")
        token2 = params2["registration_token"]
        resp = do_complete(client, token2, challenge)
        assert resp.status_code == 400

    def test_challenge_tied_to_token(self, client):
        """Challenge from registration A should not work for registration B."""
        set_mode("open")

        # Registration A
        _, (_, params_a) = do_register_step1(client, "user_aaaa")
        token_a = params_a["registration_token"]
        resp_a = do_begin(client, token_a)
        challenge_a = resp_a.json()["challenge"]

        # Registration B
        _, (_, params_b) = do_register_step1(client, "user_bbbb")
        token_b = params_b["registration_token"]
        do_begin(client, token_b)  # generates challenge_b, ignored

        # Try to complete B using A's challenge
        resp = do_complete(client, token_b, challenge_a)
        assert resp.status_code == 400

    def test_expired_challenge_rejected(self, client):
        set_mode("open")
        _, (_, params) = do_register_step1(client, "exp_chall")
        token = params["registration_token"]

        resp = do_begin(client, token)
        challenge = resp.json()["challenge"]

        # Backdate the challenge
        old_time = (datetime.now() - timedelta(minutes=10)).isoformat()
        with get_db() as conn:
            conn.execute(
                "UPDATE challenges SET timestamp = ? WHERE challenge = ? AND type = 'registration'",
                (old_time, challenge),
            )
            conn.commit()

        resp = do_complete(client, token, challenge)
        assert resp.status_code == 400


# -----------------------------------------------------------------------
# First user / roles
# -----------------------------------------------------------------------

class TestUserRoles:
    def test_first_user_becomes_admin(self, client):
        result = do_full_registration(client, "first_usr")
        assert result["status"] == "approved"

        with get_db() as conn:
            row = conn.execute(
                "SELECT role, status FROM users WHERE username = ?", ("first_usr",)
            ).fetchone()
        assert row["role"] == "admin"
        assert row["status"] == "active"

    def test_second_user_is_regular(self, client):
        # Create first user (becomes admin)
        do_full_registration(client, "boss_user")

        # Second user
        result = do_full_registration(client, "reg_user1")
        assert result["status"] == "approved"

        with get_db() as conn:
            row = conn.execute(
                "SELECT role FROM users WHERE username = ?", ("reg_user1",)
            ).fetchone()
        assert row["role"] == "user"


# -----------------------------------------------------------------------
# Complete + registration modes (end-to-end per mode)
# -----------------------------------------------------------------------

class TestCompleteWithModes:
    def test_open_mode_auto_approved(self, client):
        result = do_full_registration(client, "open_user", mode="open")
        assert result["status"] == "approved"

    def test_approval_required_pending(self, client):
        # First user is always auto-approved as admin, so create one first
        do_full_registration(client, "boss_user")

        result = do_full_registration(client, "pend_user", mode="approval_required")
        assert result["status"] == "pending"

        with get_db() as conn:
            row = conn.execute(
                "SELECT status FROM users WHERE username = ?", ("pend_user",)
            ).fetchone()
        assert row["status"] == "pending"

    def test_invite_only_full_flow(self, client):
        # First user (admin)
        do_full_registration(client, "boss_user")

        set_mode("invite_only")
        token = create_invite_token()
        result = do_full_registration(client, "inv_user1", mode="invite_only", invite=token)
        assert result["status"] == "approved"
