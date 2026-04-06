"""Tests for CoreAPI HTTP endpoints exposed for out-of-process plugins."""
import pytest
from unittest.mock import patch, MagicMock

from fastapi.testclient import TestClient
from fastapi import FastAPI

from skrib.plugins.core_api_routes import router, require_plugin_auth


# ---------------------------------------------------------------------------
# Test app setup
# ---------------------------------------------------------------------------

@pytest.fixture
def mock_core_api():
    """Mock CoreAPI instance with preset return values."""
    api = MagicMock()
    api.get_room_members.return_value = ["alice", "bob"]
    api.get_room_info.return_value = {
        "id": "room1",
        "name": "Test Room",
        "type": "chat",
        "members": [
            {"username": "alice", "role": "owner"},
            {"username": "bob", "role": "member"},
        ],
    }
    api.get_notify_level.return_value = "all"
    api.get_unread_count.return_value = 5
    api.mark_room_read.return_value = None
    api.is_user_connected.return_value = True
    return api


@pytest.fixture
def client(mock_core_api):
    """FastAPI test client with mocked CoreAPI and plugin auth bypassed."""
    app = FastAPI()
    app.include_router(router)

    # Override plugin auth to always return a test plugin ID
    app.dependency_overrides[require_plugin_auth] = lambda: "test.plugin"

    with patch("skrib.plugins.core_api_routes._get_core_api", return_value=mock_core_api):
        yield TestClient(app)


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------

class TestGetRoomMembers:
    def test_returns_members(self, client, mock_core_api):
        resp = client.get("/core/rooms/room1/members")
        assert resp.status_code == 200
        assert resp.json() == {"members": ["alice", "bob"]}
        mock_core_api.get_room_members.assert_called_once_with("room1")


class TestGetRoomInfo:
    def test_returns_room_info(self, client, mock_core_api):
        resp = client.get("/core/rooms/room1")
        assert resp.status_code == 200
        data = resp.json()
        assert data["id"] == "room1"
        assert len(data["members"]) == 2

    def test_returns_404_when_not_found(self, client, mock_core_api):
        mock_core_api.get_room_info.return_value = None
        resp = client.get("/core/rooms/nonexistent")
        assert resp.status_code == 404


class TestGetMemberDetails:
    def test_returns_notify_level(self, client, mock_core_api):
        resp = client.get("/core/rooms/room1/members/alice")
        assert resp.status_code == 200
        data = resp.json()
        assert data["username"] == "alice"
        assert data["room_id"] == "room1"
        assert data["notify_level"] == "all"


class TestMarkRoomRead:
    def test_marks_read(self, client, mock_core_api):
        resp = client.post(
            "/core/rooms/room1/read",
            json={"message_id": 42},
            headers={"x-skrib-username": "alice"},
        )
        assert resp.status_code == 200
        assert resp.json() == {"ok": True}
        mock_core_api.mark_room_read.assert_called_once_with("room1", "alice", 42)

    def test_requires_auth(self, client):
        resp = client.post("/core/rooms/room1/read", json={"message_id": 42})
        assert resp.status_code == 401


class TestGetUserPresence:
    def test_returns_connected_status(self, client, mock_core_api):
        resp = client.get("/core/users/alice/presence")
        assert resp.status_code == 200
        data = resp.json()
        assert data["username"] == "alice"
        assert data["connected"] is True

    def test_returns_disconnected(self, client, mock_core_api):
        mock_core_api.is_user_connected.return_value = False
        resp = client.get("/core/users/bob/presence")
        assert resp.status_code == 200
        assert resp.json()["connected"] is False
