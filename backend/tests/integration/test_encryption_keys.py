"""Integration tests for encryption key endpoints.

Tests S1 (restrict wrapped private keys to key owner) and
S4 (validate public key consistency on re-upload).
"""
import base64
import json
import secrets
from datetime import datetime

from skrib.database import get_db

from .conftest import do_full_registration, set_mode


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _make_token(username: str) -> str:
    """Create a forgeable session token (matches current token scheme)."""
    return base64.urlsafe_b64encode(f"{username}:{secrets.token_hex(32)}".encode()).decode()


def _create_user(username: str, role: str = "user") -> str:
    """Insert a user directly and return a session token."""
    with get_db() as conn:
        conn.execute(
            """INSERT INTO users (username, credential_id, public_key, status, role, color, created_at)
               VALUES (?, ?, ?, 'active', ?, '#aaa', ?)""",
            (username, f"cred_{username}", f"pk_{username}", role, datetime.now().isoformat()),
        )
        conn.commit()
    return _make_token(username)


def _store_keys(username: str, public_key: str, encrypted_private_key: str = None,
                passphrase_encrypted_private_key: str = None):
    """Set encryption keys directly in the DB."""
    with get_db() as conn:
        conn.execute(
            """UPDATE users SET encryption_public_key = ?,
               encrypted_private_key = ?,
               passphrase_encrypted_private_key = ?
               WHERE username = ?""",
            (public_key, encrypted_private_key, passphrase_encrypted_private_key, username),
        )
        conn.commit()


# A valid-looking JWK public key (RSA-OAEP)
SAMPLE_PUBLIC_KEY = json.dumps({
    "kty": "RSA", "e": "AQAB", "n": "test_modulus_abc123",
    "alg": "RSA-OAEP-256", "ext": True, "key_ops": ["encrypt"],
})

DIFFERENT_PUBLIC_KEY = json.dumps({
    "kty": "RSA", "e": "AQAB", "n": "different_modulus_xyz789",
    "alg": "RSA-OAEP-256", "ext": True, "key_ops": ["encrypt"],
})


# -----------------------------------------------------------------------
# S1: Restrict wrapped private keys to key owner
# -----------------------------------------------------------------------

class TestEncryptionKeyAccess:
    """GET /encryption-key/{username} should only return wrapped private keys to the owner."""

    def test_owner_sees_all_fields(self, client):
        """User fetching their own keys gets public + both wrapped private keys."""
        token = _create_user("alice1234")
        _store_keys("alice1234",
                     public_key=SAMPLE_PUBLIC_KEY,
                     encrypted_private_key="prf_wrapped_blob",
                     passphrase_encrypted_private_key="passphrase_wrapped_blob")

        resp = client.get(
            "/api/auth/encryption-key/alice1234",
            headers={"Authorization": f"Bearer {token}"},
        )
        assert resp.status_code == 200
        data = resp.json()
        assert data["public_key"] == SAMPLE_PUBLIC_KEY
        assert data["encrypted_private_key"] == "prf_wrapped_blob"
        assert data["passphrase_encrypted_private_key"] == "passphrase_wrapped_blob"

    def test_other_user_sees_only_public_key(self, client):
        """Another user fetching someone's keys only gets the public key."""
        _create_user("alice1234")
        bob_token = _create_user("bob_user1")
        _store_keys("alice1234",
                     public_key=SAMPLE_PUBLIC_KEY,
                     encrypted_private_key="prf_wrapped_blob",
                     passphrase_encrypted_private_key="passphrase_wrapped_blob")

        resp = client.get(
            "/api/auth/encryption-key/alice1234",
            headers={"Authorization": f"Bearer {bob_token}"},
        )
        assert resp.status_code == 200
        data = resp.json()
        assert data["public_key"] == SAMPLE_PUBLIC_KEY
        assert data["encrypted_private_key"] is None
        assert data["passphrase_encrypted_private_key"] is None

    def test_other_user_cannot_infer_wrapped_key_existence(self, client):
        """Response shape is the same whether wrapped keys exist or not."""
        _create_user("alice1234")
        bob_token = _create_user("bob_user1")
        _store_keys("alice1234",
                     public_key=SAMPLE_PUBLIC_KEY,
                     encrypted_private_key="secret_blob")

        resp = client.get(
            "/api/auth/encryption-key/alice1234",
            headers={"Authorization": f"Bearer {bob_token}"},
        )
        data = resp.json()
        # Should be None regardless of whether the blob exists on the server
        assert data["encrypted_private_key"] is None
        assert data["passphrase_encrypted_private_key"] is None


# -----------------------------------------------------------------------
# S4: Validate public key consistency on re-upload
# -----------------------------------------------------------------------

class TestPublicKeyConsistency:
    """POST /encryption-key should reject public key changes when one already exists."""

    def test_first_upload_accepted(self, client):
        """First public key upload should always succeed."""
        token = _create_user("alice1234")

        resp = client.post(
            "/api/auth/encryption-key",
            headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
            json={"public_key": SAMPLE_PUBLIC_KEY},
        )
        assert resp.status_code == 200

    def test_same_key_reupload_accepted(self, client):
        """Re-uploading the same public key should succeed."""
        token = _create_user("alice1234")
        _store_keys("alice1234", public_key=SAMPLE_PUBLIC_KEY)

        resp = client.post(
            "/api/auth/encryption-key",
            headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
            json={"public_key": SAMPLE_PUBLIC_KEY},
        )
        assert resp.status_code == 200

    def test_different_key_rejected(self, client):
        """Uploading a different public key when one already exists should fail."""
        token = _create_user("alice1234")
        _store_keys("alice1234", public_key=SAMPLE_PUBLIC_KEY)

        resp = client.post(
            "/api/auth/encryption-key",
            headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
            json={"public_key": DIFFERENT_PUBLIC_KEY},
        )
        assert resp.status_code == 409

    def test_different_key_rejected_with_message(self, client):
        """Error response should explain why the upload was rejected."""
        token = _create_user("alice1234")
        _store_keys("alice1234", public_key=SAMPLE_PUBLIC_KEY)

        resp = client.post(
            "/api/auth/encryption-key",
            headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
            json={"public_key": DIFFERENT_PUBLIC_KEY},
        )
        assert resp.status_code == 409
        assert "mismatch" in resp.json()["detail"].lower() or "changed" in resp.json()["detail"].lower()
