"""Integration tests for rooms API endpoints."""
import base64
import secrets
from datetime import datetime
from unittest.mock import patch, MagicMock

from skrib.database import get_db, set_setting
from skrib.rooms.services import ROOMS, ROOMS_LOCK

from .conftest import do_full_registration, set_mode


def _mock_plugin_bus(room_types=None):
    """Return a mock plugin bus with the given room types registered."""
    if room_types is None:
        room_types = {"chat": "four43.room-type-chat"}
    mock_bus = MagicMock()
    mock_bus.room_type_map = room_types
    return mock_bus


class _FakeInProcessHost:
    """A minimal in-process host double — see skrib.plugin_bus.inprocess_host
    .InProcessHost.plugin_records() for the real shape this mirrors."""

    def __init__(self, records):
        self._records = records

    def plugin_records(self):
        return self._records


def _inprocess_record(plugin_id: str, room_types: list) -> dict:
    return {
        "id": plugin_id,
        "version": "1.0.0",
        "permissions": [],
        "room_types": room_types,
        "room_type_meta": {},
        "frontend_scripts": [],
        "frontend_styles": [],
        "http_base_url": None,
        "runtime": "in_process",
    }


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _make_token(username: str) -> str:
    return base64.urlsafe_b64encode(f"{username}:{secrets.token_hex(32)}".encode()).decode()


def _create_user(username: str, role: str = "user") -> str:
    with get_db() as conn:
        conn.execute(
            """INSERT INTO users (username, credential_id, public_key, status, role, color, created_at)
               VALUES (?, ?, ?, 'active', ?, '#aaa', ?)""",
            (username, f"cred_{username}", f"pk_{username}", role, datetime.now().isoformat()),
        )
        conn.commit()
    return _make_token(username)


def _auth(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


def _create_room_direct(room_id: str, room_type: str = "chat", created_by: str = None,
                         visibility: str = "private"):
    """Insert a room directly in the DB and in-memory registry."""
    now = datetime.now().isoformat()
    with get_db() as conn:
        conn.execute(
            "INSERT INTO rooms (room_id, room_type, visibility, created_at, created_by) VALUES (?, ?, ?, ?, ?)",
            (room_id, room_type, visibility, now, created_by),
        )
        conn.commit()
    with ROOMS_LOCK:
        ROOMS[room_id] = room_type


def _add_member(room_id: str, username: str, room_role: str = "member"):
    now = datetime.now().isoformat()
    with get_db() as conn:
        conn.execute(
            "INSERT INTO room_users (room_id, username, room_role, joined_at) VALUES (?, ?, ?, ?)",
            (room_id, username, room_role, now),
        )
        conn.commit()


def _set_mock_plugin_bus(app, room_types=None, inprocess_host=None):
    """Install a registry wrapping a mock plugin bus for room creation tests.

    ``create_new_room``/``create_dm`` read ``app.state.plugin_registry``, not
    ``app.state.plugin_bus`` directly — the registry is constructed once at
    app startup and holds its own reference, so reassigning
    ``app.state.plugin_bus`` afterwards (the old approach) has no effect on
    it. Install a fresh registry instead.
    """
    from skrib.plugins.registry import PluginRegistry
    mock_bus = _mock_plugin_bus(room_types)
    app.state.plugin_bus = mock_bus
    app.state.plugin_registry = PluginRegistry(mock_bus, inprocess_host)


# ---------------------------------------------------------------------------
# Tests: List rooms
# ---------------------------------------------------------------------------

class TestListRooms:
    def test_list_rooms_empty(self, client):
        token = _create_user("alice")
        resp = client.get("/api/rooms", headers=_auth(token))
        assert resp.status_code == 200
        assert resp.json() == []

    def test_list_rooms_returns_member_rooms(self, client):
        token = _create_user("alice")
        _create_room_direct("general", created_by="alice")
        _add_member("general", "alice", "owner")

        resp = client.get("/api/rooms", headers=_auth(token))
        assert resp.status_code == 200
        rooms = resp.json()
        assert len(rooms) == 1
        assert rooms[0]["room_id"] == "general"
        assert rooms[0]["display_name"] == "#general"

    def test_list_rooms_excludes_non_member(self, client):
        token = _create_user("alice")
        _create_user("bob")
        _create_room_direct("secret", created_by="bob")
        _add_member("secret", "bob", "owner")

        resp = client.get("/api/rooms", headers=_auth(token))
        assert resp.status_code == 200
        assert resp.json() == []

    def test_list_rooms_unauthenticated(self, client):
        resp = client.get("/api/rooms")
        assert resp.status_code == 401


# ---------------------------------------------------------------------------
# Tests: Create room
# ---------------------------------------------------------------------------

class TestCreateRoom:
    def test_create_room_success(self, client):
        from skrib.main import app
        _set_mock_plugin_bus(app)
        token = _create_user("alice")

        resp = client.post("/api/rooms", json={"room_id": "my-room", "room_type": "chat"},
                           headers=_auth(token))
        assert resp.status_code == 200
        assert resp.json()["room_id"] == "my-room"

    def test_create_room_invalid_name(self, client):
        from skrib.main import app
        _set_mock_plugin_bus(app)
        token = _create_user("alice")

        resp = client.post("/api/rooms", json={"room_id": "My Room!", "room_type": "chat"},
                           headers=_auth(token))
        assert resp.status_code == 400

    def test_create_room_duplicate(self, client):
        from skrib.main import app
        _set_mock_plugin_bus(app)
        token = _create_user("alice")
        _create_room_direct("existing")

        resp = client.post("/api/rooms", json={"room_id": "existing", "room_type": "chat"},
                           headers=_auth(token))
        assert resp.status_code == 400

    def test_create_room_with_inprocess_room_type_succeeds(self, client):
        """A room type owned by an in-process plugin (no bus connection at
        all) must be just as usable as a bus-owned one — this is the
        rooms/routes.py:101 call site from Task 4C's follow-up review."""
        from skrib.main import app
        host = _FakeInProcessHost([_inprocess_record("four43.inproc-todo", ["todo"])])
        _set_mock_plugin_bus(app, room_types={}, inprocess_host=host)
        token = _create_user("alice")

        resp = client.post("/api/rooms", json={"room_id": "my-inprocess-room", "room_type": "todo"},
                           headers=_auth(token))
        assert resp.status_code == 200
        assert resp.json()["room_id"] == "my-inprocess-room"

    def test_create_room_invalid_type(self, client):
        from skrib.main import app
        _set_mock_plugin_bus(app, room_types={})
        token = _create_user("alice")

        resp = client.post("/api/rooms", json={"room_id": "my-room", "room_type": "unknown"},
                           headers=_auth(token))
        assert resp.status_code == 400

    def test_create_room_unauthenticated(self, client):
        resp = client.post("/api/rooms", json={"room_id": "test", "room_type": "chat"})
        assert resp.status_code == 401


# ---------------------------------------------------------------------------
# Tests: Create DM
# ---------------------------------------------------------------------------

class TestCreateDM:
    def test_create_dm_with_inprocess_dm_room_type_resolves(self, client):
        """dm_room_type can name an in-process plugin — rooms/routes.py:148
        from Task 4C's follow-up review."""
        from skrib.main import app
        host = _FakeInProcessHost([_inprocess_record("four43.inproc-chat", ["chat"])])
        saved = getattr(app.state, "plugin_registry", None)
        from skrib.plugins.registry import PluginRegistry
        app.state.plugin_registry = PluginRegistry(_mock_plugin_bus({}), host)
        set_setting("dm_room_type", "four43.inproc-chat")
        try:
            token = _create_user("alice")
            _create_user("bob")

            resp = client.post("/api/rooms/dm", json={"usernames": ["bob"]}, headers=_auth(token))
            assert resp.status_code == 200
            assert resp.json()["room"]["room_type"] == "chat"
        finally:
            if saved is not None:
                app.state.plugin_registry = saved
            else:
                del app.state.plugin_registry

    def test_create_dm_missing_dm_plugin_fails(self, client):
        """No registry entry for the configured dm_room_type plugin — 500,
        not a silent wrong room type."""
        from skrib.main import app
        saved = getattr(app.state, "plugin_registry", None)
        from skrib.plugins.registry import PluginRegistry
        app.state.plugin_registry = PluginRegistry(_mock_plugin_bus({}), None)
        set_setting("dm_room_type", "four43.does-not-exist")
        try:
            token = _create_user("alice")
            _create_user("bob")

            resp = client.post("/api/rooms/dm", json={"usernames": ["bob"]}, headers=_auth(token))
            assert resp.status_code == 500
        finally:
            if saved is not None:
                app.state.plugin_registry = saved
            else:
                del app.state.plugin_registry


# ---------------------------------------------------------------------------
# Tests: Delete room
# ---------------------------------------------------------------------------

class TestDeleteRoom:
    def test_delete_room_as_owner(self, client):
        token = _create_user("alice")
        _create_room_direct("to-delete", created_by="alice")
        _add_member("to-delete", "alice", "owner")

        resp = client.delete("/api/rooms/to-delete", headers=_auth(token))
        assert resp.status_code == 200
        assert resp.json()["room_id"] == "to-delete"

    def test_delete_room_as_admin(self, client):
        admin_token = _create_user("admin", role="admin")
        _create_user("alice")
        _create_room_direct("to-delete", created_by="alice")
        _add_member("to-delete", "alice", "owner")
        _add_member("to-delete", "admin", "member")

        resp = client.delete("/api/rooms/to-delete", headers=_auth(admin_token))
        assert resp.status_code == 200

    def test_delete_room_as_member_forbidden(self, client):
        _create_user("alice")
        token = _create_user("bob")
        _create_room_direct("to-delete", created_by="alice")
        _add_member("to-delete", "alice", "owner")
        _add_member("to-delete", "bob", "member")

        resp = client.delete("/api/rooms/to-delete", headers=_auth(token))
        assert resp.status_code == 403

    def test_delete_nonexistent_room(self, client):
        token = _create_user("alice")
        resp = client.delete("/api/rooms/nope", headers=_auth(token))
        # get_room_role returns None for non-member, so 403 before 404
        assert resp.status_code == 403

    def test_delete_dm_forbidden(self, client):
        token = _create_user("alice")
        _create_user("bob")
        _create_room_direct("dm|alice|bob", room_type="chat", created_by="alice")
        _add_member("dm|alice|bob", "alice", "member")

        resp = client.delete("/api/rooms/dm|alice|bob", headers=_auth(token))
        assert resp.status_code == 400


# ---------------------------------------------------------------------------
# Tests: Room detail
# ---------------------------------------------------------------------------

class TestRoomDetail:
    def test_get_room_detail(self, client):
        token = _create_user("alice")
        _create_room_direct("general", created_by="alice")
        _add_member("general", "alice", "owner")

        resp = client.get("/api/rooms/general", headers=_auth(token))
        assert resp.status_code == 200
        data = resp.json()
        assert data["room_id"] == "general"
        assert data["room_type"] == "chat"
        assert len(data["members"]) == 1
        assert data["members"][0]["username"] == "alice"
        assert data["members"][0]["room_role"] == "owner"

    def test_get_room_detail_not_member(self, client):
        _create_user("alice")
        token = _create_user("bob")
        _create_room_direct("private", created_by="alice")
        _add_member("private", "alice", "owner")

        resp = client.get("/api/rooms/private", headers=_auth(token))
        assert resp.status_code == 403

    def test_get_room_detail_nonexistent(self, client):
        token = _create_user("alice")
        resp = client.get("/api/rooms/nope", headers=_auth(token))
        assert resp.status_code == 404


# ---------------------------------------------------------------------------
# Tests: Add/remove members
# ---------------------------------------------------------------------------

class TestMembers:
    def test_add_member(self, client):
        token = _create_user("alice")
        _create_user("bob")
        _create_room_direct("general", created_by="alice")
        _add_member("general", "alice", "owner")

        resp = client.post("/api/rooms/general/members",
                           json={"username": "bob"}, headers=_auth(token))
        assert resp.status_code == 200
        assert resp.json()["username"] == "bob"

    def test_add_member_not_found(self, client):
        token = _create_user("alice")
        _create_room_direct("general", created_by="alice")
        _add_member("general", "alice", "owner")

        resp = client.post("/api/rooms/general/members",
                           json={"username": "ghost"}, headers=_auth(token))
        assert resp.status_code == 404

    def test_add_member_already_member(self, client):
        token = _create_user("alice")
        _create_user("bob")
        _create_room_direct("general", created_by="alice")
        _add_member("general", "alice", "owner")
        _add_member("general", "bob", "member")

        resp = client.post("/api/rooms/general/members",
                           json={"username": "bob"}, headers=_auth(token))
        assert resp.status_code == 400

    def test_add_member_no_permission(self, client):
        _create_user("alice")
        token = _create_user("bob")
        _create_room_direct("general", created_by="alice")
        _add_member("general", "alice", "owner")
        _add_member("general", "bob", "member")

        _create_user("charlie")
        resp = client.post("/api/rooms/general/members",
                           json={"username": "charlie"}, headers=_auth(token))
        assert resp.status_code == 403

    def test_remove_self(self, client):
        _create_user("alice")
        token = _create_user("bob")
        _create_room_direct("general", created_by="alice")
        _add_member("general", "alice", "owner")
        _add_member("general", "bob", "member")

        resp = client.delete("/api/rooms/general/members/bob", headers=_auth(token))
        assert resp.status_code == 200

    def test_remove_other_as_owner(self, client):
        token = _create_user("alice")
        _create_user("bob")
        _create_room_direct("general", created_by="alice")
        _add_member("general", "alice", "owner")
        _add_member("general", "bob", "member")

        resp = client.delete("/api/rooms/general/members/bob", headers=_auth(token))
        assert resp.status_code == 200

    def test_remove_other_as_member_forbidden(self, client):
        _create_user("alice")
        token = _create_user("bob")
        _create_user("charlie")
        _create_room_direct("general", created_by="alice")
        _add_member("general", "alice", "owner")
        _add_member("general", "bob", "member")
        _add_member("general", "charlie", "member")

        resp = client.delete("/api/rooms/general/members/charlie", headers=_auth(token))
        assert resp.status_code == 403

    def test_remove_from_dm_forbidden(self, client):
        token = _create_user("alice")
        _create_user("bob")
        _create_room_direct("dm|alice|bob", created_by="alice")
        _add_member("dm|alice|bob", "alice", "member")
        _add_member("dm|alice|bob", "bob", "member")

        resp = client.delete("/api/rooms/dm|alice|bob/members/bob", headers=_auth(token))
        assert resp.status_code == 400

    def test_remove_nonmember(self, client):
        token = _create_user("alice")
        _create_user("bob")
        _create_room_direct("general", created_by="alice")
        _add_member("general", "alice", "owner")

        resp = client.delete("/api/rooms/general/members/bob", headers=_auth(token))
        assert resp.status_code == 404


# ---------------------------------------------------------------------------
# Tests: Update member (notify_level, room_role)
# ---------------------------------------------------------------------------

class TestUpdateMember:
    def test_update_own_notify_level(self, client):
        token = _create_user("alice")
        _create_room_direct("general", created_by="alice")
        _add_member("general", "alice", "owner")

        resp = client.patch("/api/rooms/general/members/alice",
                            json={"notify_level": "muted"}, headers=_auth(token))
        assert resp.status_code == 200

    def test_cannot_update_other_notify_level(self, client):
        token = _create_user("alice")
        _create_user("bob")
        _create_room_direct("general", created_by="alice")
        _add_member("general", "alice", "owner")
        _add_member("general", "bob", "member")

        resp = client.patch("/api/rooms/general/members/bob",
                            json={"notify_level": "muted"}, headers=_auth(token))
        assert resp.status_code == 403

    def test_set_room_role_as_owner(self, client):
        token = _create_user("alice")
        _create_user("bob")
        _create_room_direct("general", created_by="alice")
        _add_member("general", "alice", "owner")
        _add_member("general", "bob", "member")

        resp = client.patch("/api/rooms/general/members/bob",
                            json={"room_role": "op"}, headers=_auth(token))
        assert resp.status_code == 200

    def test_set_room_role_in_dm_forbidden(self, client):
        token = _create_user("alice")
        _create_user("bob")
        _create_room_direct("dm|alice|bob", created_by="alice")
        _add_member("dm|alice|bob", "alice", "owner")
        _add_member("dm|alice|bob", "bob", "member")

        resp = client.patch("/api/rooms/dm|alice|bob/members/bob",
                            json={"room_role": "op"}, headers=_auth(token))
        assert resp.status_code == 400

    def test_get_member_detail(self, client):
        token = _create_user("alice")
        _create_room_direct("general", created_by="alice")
        _add_member("general", "alice", "owner")

        resp = client.get("/api/rooms/general/members/alice", headers=_auth(token))
        assert resp.status_code == 200
        data = resp.json()
        assert data["username"] == "alice"
        assert data["room_role"] == "owner"

    def test_get_member_detail_not_member(self, client):
        token = _create_user("alice")
        _create_user("bob")
        _create_room_direct("general", created_by="alice")
        _add_member("general", "alice", "owner")

        resp = client.get("/api/rooms/general/members/bob", headers=_auth(token))
        assert resp.status_code == 404


# ---------------------------------------------------------------------------
# Tests: Room keys
# ---------------------------------------------------------------------------

class TestRoomKeys:
    def test_store_and_get_keys(self, client):
        token = _create_user("alice")
        _create_room_direct("general", created_by="alice")
        _add_member("general", "alice", "owner")

        # Store a key
        resp = client.post("/api/rooms/general/keys",
                           json={"username": "alice", "key_epoch": 0, "encrypted_key": "key_blob_0"},
                           headers=_auth(token))
        assert resp.status_code == 200

        # Get keys
        resp = client.get("/api/rooms/general/keys", headers=_auth(token))
        assert resp.status_code == 200
        keys = resp.json()
        assert len(keys) == 1
        assert keys[0]["key_epoch"] == 0
        assert keys[0]["encrypted_key"] == "key_blob_0"

    def test_store_key_for_other_requires_op(self, client):
        _create_user("alice")
        token = _create_user("bob")
        _create_room_direct("general", created_by="alice")
        _add_member("general", "alice", "owner")
        _add_member("general", "bob", "member")

        resp = client.post("/api/rooms/general/keys",
                           json={"username": "alice", "key_epoch": 0, "encrypted_key": "key_blob"},
                           headers=_auth(token))
        assert resp.status_code == 403

    def test_store_key_for_nonmember_forbidden(self, client):
        token = _create_user("alice")
        _create_user("bob")
        _create_room_direct("general", created_by="alice")
        _add_member("general", "alice", "owner")

        resp = client.post("/api/rooms/general/keys",
                           json={"username": "bob", "key_epoch": 0, "encrypted_key": "key_blob"},
                           headers=_auth(token))
        assert resp.status_code == 403


# ---------------------------------------------------------------------------
# Tests: Update room (topic, visibility)
# ---------------------------------------------------------------------------

class TestUpdateRoom:
    def test_set_topic(self, client):
        token = _create_user("alice")
        _create_room_direct("general", created_by="alice")
        _add_member("general", "alice", "owner")

        resp = client.patch("/api/rooms/general",
                            json={"topic": "Welcome!"}, headers=_auth(token))
        assert resp.status_code == 200

        # Verify via detail
        resp = client.get("/api/rooms/general", headers=_auth(token))
        assert resp.json()["topic"] == "Welcome!"

    def test_set_visibility(self, client):
        token = _create_user("alice")
        _create_room_direct("general", created_by="alice")
        _add_member("general", "alice", "owner")

        resp = client.patch("/api/rooms/general",
                            json={"visibility": "public"}, headers=_auth(token))
        assert resp.status_code == 200

        resp = client.get("/api/rooms/general", headers=_auth(token))
        assert resp.json()["visibility"] == "public"

    def test_set_visibility_on_dm_forbidden(self, client):
        token = _create_user("alice")
        _create_user("bob")
        _create_room_direct("dm|alice|bob", created_by="alice")
        _add_member("dm|alice|bob", "alice", "owner")

        resp = client.patch("/api/rooms/dm|alice|bob",
                            json={"visibility": "public"}, headers=_auth(token))
        assert resp.status_code == 400

    def test_update_room_not_member(self, client):
        _create_user("alice")
        token = _create_user("bob")
        _create_room_direct("general", created_by="alice")
        _add_member("general", "alice", "owner")

        resp = client.patch("/api/rooms/general",
                            json={"topic": "hacked"}, headers=_auth(token))
        assert resp.status_code == 403

    def test_update_nonexistent_room(self, client):
        token = _create_user("alice")
        resp = client.patch("/api/rooms/nope",
                            json={"topic": "test"}, headers=_auth(token))
        assert resp.status_code == 404


# ---------------------------------------------------------------------------
# Tests: Search rooms
# ---------------------------------------------------------------------------

class TestSearchRooms:
    def test_search_public_rooms(self, client):
        token = _create_user("alice")
        _create_user("bob")
        _create_room_direct("public-room", visibility="public", created_by="bob")
        _add_member("public-room", "bob", "owner")

        resp = client.get("/api/rooms/search?q=public", headers=_auth(token))
        assert resp.status_code == 200
        results = resp.json()
        assert len(results) == 1
        assert results[0]["room_id"] == "public-room"

    def test_search_excludes_member_rooms(self, client):
        token = _create_user("alice")
        _create_room_direct("public-room", visibility="public", created_by="alice")
        _add_member("public-room", "alice", "owner")

        resp = client.get("/api/rooms/search?q=public", headers=_auth(token))
        assert resp.status_code == 200
        assert resp.json() == []

    def test_search_empty_query(self, client):
        token = _create_user("alice")
        resp = client.get("/api/rooms/search?q=", headers=_auth(token))
        assert resp.status_code == 200
        assert resp.json() == []


# ---------------------------------------------------------------------------
# Tests: Check room name
# ---------------------------------------------------------------------------

class TestCheckRoomName:
    def test_available_name(self, client):
        token = _create_user("alice")
        resp = client.get("/api/rooms/check-name?name=new-room", headers=_auth(token))
        assert resp.status_code == 200
        assert resp.json()["available"] is True

    def test_taken_name(self, client):
        token = _create_user("alice")
        _create_room_direct("existing")
        resp = client.get("/api/rooms/check-name?name=existing", headers=_auth(token))
        assert resp.status_code == 200
        assert resp.json()["available"] is False

    def test_empty_name(self, client):
        token = _create_user("alice")
        resp = client.get("/api/rooms/check-name?name=", headers=_auth(token))
        assert resp.status_code == 200
        assert resp.json()["available"] is False


# ---------------------------------------------------------------------------
# Tests: Join requests
# ---------------------------------------------------------------------------

class TestJoinRequests:
    def test_submit_join_request(self, client):
        _create_user("alice")
        token = _create_user("bob")
        _create_room_direct("public-room", visibility="public", created_by="alice")
        _add_member("public-room", "alice", "owner")

        resp = client.post("/api/rooms/public-room/join-requests", headers=_auth(token))
        assert resp.status_code == 200
        assert resp.json()["status"] == "created"

    def test_join_request_private_room(self, client):
        _create_user("alice")
        token = _create_user("bob")
        _create_room_direct("private-room", visibility="private", created_by="alice")
        _add_member("private-room", "alice", "owner")

        resp = client.post("/api/rooms/private-room/join-requests", headers=_auth(token))
        assert resp.status_code == 400

    def test_join_request_already_member(self, client):
        token = _create_user("alice")
        _create_room_direct("public-room", visibility="public", created_by="alice")
        _add_member("public-room", "alice", "owner")

        resp = client.post("/api/rooms/public-room/join-requests", headers=_auth(token))
        assert resp.status_code == 400

    def test_list_join_requests(self, client):
        token = _create_user("alice")
        _create_user("bob")
        _create_room_direct("public-room", visibility="public", created_by="alice")
        _add_member("public-room", "alice", "owner")

        # Bob submits a request
        bob_token = _make_token("bob")
        client.post("/api/rooms/public-room/join-requests", headers=_auth(bob_token))

        # Alice lists requests
        resp = client.get("/api/rooms/public-room/join-requests", headers=_auth(token))
        assert resp.status_code == 200
        reqs = resp.json()
        assert len(reqs) == 1
        assert reqs[0]["username"] == "bob"

    def test_approve_join_request(self, client):
        token = _create_user("alice")
        _create_user("bob")
        _create_room_direct("public-room", visibility="public", created_by="alice")
        _add_member("public-room", "alice", "owner")

        bob_token = _make_token("bob")
        client.post("/api/rooms/public-room/join-requests", headers=_auth(bob_token))

        resp = client.patch("/api/rooms/public-room/join-requests/bob",
                            json={"action": "approve"}, headers=_auth(token))
        assert resp.status_code == 200
        assert resp.json()["status"] == "approved"

    def test_deny_join_request(self, client):
        token = _create_user("alice")
        _create_user("bob")
        _create_room_direct("public-room", visibility="public", created_by="alice")
        _add_member("public-room", "alice", "owner")

        bob_token = _make_token("bob")
        client.post("/api/rooms/public-room/join-requests", headers=_auth(bob_token))

        resp = client.patch("/api/rooms/public-room/join-requests/bob",
                            json={"action": "deny"}, headers=_auth(token))
        assert resp.status_code == 200
        assert resp.json()["status"] == "denied"

    def test_resolve_nonexistent_request(self, client):
        token = _create_user("alice")
        _create_room_direct("public-room", visibility="public", created_by="alice")
        _add_member("public-room", "alice", "owner")

        resp = client.patch("/api/rooms/public-room/join-requests/ghost",
                            json={"action": "approve"}, headers=_auth(token))
        assert resp.status_code == 404

    def test_duplicate_join_request(self, client):
        _create_user("alice")
        token = _create_user("bob")
        _create_room_direct("public-room", visibility="public", created_by="alice")
        _add_member("public-room", "alice", "owner")

        client.post("/api/rooms/public-room/join-requests", headers=_auth(token))
        resp = client.post("/api/rooms/public-room/join-requests", headers=_auth(token))
        assert resp.status_code == 400
