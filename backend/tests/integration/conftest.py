"""Test fixtures for integration tests.

IMPORTANT: The env vars MUST be set before any skrib import because
config.py reads SKRIB_DATA_DIR at import time to set DB_FILE.
"""
import os
import tempfile

_test_data_dir = tempfile.mkdtemp(prefix="skrib_test_")
os.environ["SKRIB_DATA_DIR"] = _test_data_dir
os.environ["SKRIB_RP_ID"] = "localhost"

import secrets
from datetime import datetime
from urllib.parse import urlparse, parse_qs

import pytest
from starlette.testclient import TestClient

from skrib.main import app
from skrib.config import DB_FILE
from skrib.database import get_db, init_db, set_setting, thread_local


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

@pytest.fixture(autouse=True)
def fresh_db():
    """Give every test a clean database."""
    # Close any cached thread-local connection
    if hasattr(thread_local, "connection") and thread_local.connection:
        thread_local.connection.close()
        thread_local.connection = None

    # Delete the DB file so init_db creates a fresh one
    if os.path.exists(DB_FILE):
        os.remove(DB_FILE)

    # Also remove WAL/SHM files
    for suffix in ("-wal", "-shm"):
        path = DB_FILE + suffix
        if os.path.exists(path):
            os.remove(path)

    init_db()
    yield

    # Teardown: close connection for next test
    if hasattr(thread_local, "connection") and thread_local.connection:
        thread_local.connection.close()
        thread_local.connection = None


@pytest.fixture
def client():
    """FastAPI test client with redirects disabled (we assert on 303 Location)."""
    with TestClient(app, follow_redirects=False) as c:
        yield c


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def set_mode(mode: str):
    """Set the registration mode for the current test."""
    set_setting("registration_mode", mode)


def create_invite_token(created_by: str = None) -> str:
    """Insert a valid invite token and return it.

    If no created_by user exists, one is created directly in the DB.
    """
    token = secrets.token_urlsafe(16)
    with get_db() as conn:
        if not created_by:
            # Ensure a user exists to satisfy the FK on created_by
            row = conn.execute("SELECT username FROM users LIMIT 1").fetchone()
            if row:
                created_by = row["username"]
            else:
                created_by = "seed_user"
                conn.execute(
                    """INSERT INTO users (username, credential_id, public_key, status, role, color, created_at)
                       VALUES (?, ?, ?, 'active', 'admin', '#aaa', ?)""",
                    (created_by, "cred", "pk", datetime.now().isoformat()),
                )
        conn.execute(
            "INSERT INTO invite_tokens (token, created_by, created_at) VALUES (?, ?, ?)",
            (token, created_by, datetime.now().isoformat()),
        )
        conn.commit()
    return token


def parse_redirect(response):
    """Parse a 303 redirect into (path, query_params_dict).

    Query param values are returned as strings (first value only).
    """
    location = response.headers["location"]
    parsed = urlparse(location)
    params = {k: v[0] for k, v in parse_qs(parsed.query).items()}
    return parsed.path, params


def do_register_step1(client, username, invite=None):
    """POST /api/auth/register and return (path, params) from the redirect."""
    data = {"username": username}
    if invite:
        data["invite"] = invite
    resp = client.post("/api/auth/register", data=data)
    return resp, parse_redirect(resp)


def do_begin(client, registration_token):
    """GET /api/auth/register/begin with a registration_token."""
    return client.get(
        "/api/auth/register/begin",
        params={"registration_token": registration_token},
    )


def do_complete(client, registration_token, challenge, invite_token=None,
                credential_id=None, public_key=None):
    """POST /api/auth/register/complete with the proposed schema."""
    body = {
        "registration_token": registration_token,
        "challenge": challenge,
        "credentialId": credential_id or secrets.token_urlsafe(16),
        "publicKey": public_key or secrets.token_urlsafe(32),
    }
    if invite_token:
        body["invite_token"] = invite_token
    return client.post("/api/auth/register/complete", json=body)


def do_full_registration(client, username, mode="open", invite=None):
    """Run the full 3-step registration flow. Returns the complete response JSON."""
    set_mode(mode)

    # Step 1
    resp, (path, params) = do_register_step1(client, username, invite=invite)
    assert resp.status_code == 303, f"Step 1 failed: {path} {params}"
    token = params["registration_token"]

    # Step 2 — begin
    resp = do_begin(client, token)
    assert resp.status_code == 200, f"Begin failed: {resp.text}"
    begin_data = resp.json()
    challenge = begin_data["challenge"]

    # Step 3 — complete
    resp = do_complete(client, token, challenge, invite_token=invite)
    assert resp.status_code == 200, f"Complete failed: {resp.text}"
    return resp.json()
