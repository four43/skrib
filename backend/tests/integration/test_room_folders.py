"""Integration tests for room folders API endpoints."""
import base64
import secrets
from datetime import datetime

from skrib.database import get_db
from skrib.rooms.services import ROOMS, ROOMS_LOCK


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


def _create_room_direct(room_id: str, room_type: str = "chat"):
    now = datetime.now().isoformat()
    with get_db() as conn:
        conn.execute(
            "INSERT INTO rooms (room_id, room_type, visibility, created_at) VALUES (?, ?, 'private', ?)",
            (room_id, room_type, now),
        )
        conn.commit()
    with ROOMS_LOCK:
        ROOMS[room_id] = room_type


# ---------------------------------------------------------------------------
# Tests: Folder CRUD
# ---------------------------------------------------------------------------

class TestFolderCRUD:
    def test_get_empty_folder_tree(self, client):
        token = _create_user("alice")

        resp = client.get("/api/rooms/folders", headers=_auth(token))
        assert resp.status_code == 200
        data = resp.json()
        assert data["folders"] == []

    def test_create_folder(self, client):
        token = _create_user("admin", role="admin")

        resp = client.post("/api/rooms/folders",
                           json={"name": "my-folder"}, headers=_auth(token))
        assert resp.status_code == 200
        assert "folder_id" in resp.json()

    def test_create_folder_requires_admin(self, client):
        token = _create_user("alice")

        resp = client.post("/api/rooms/folders",
                           json={"name": "my-folder"}, headers=_auth(token))
        assert resp.status_code == 403

    def test_create_folder_invalid_name(self, client):
        token = _create_user("admin", role="admin")

        resp = client.post("/api/rooms/folders",
                           json={"name": "My Folder!"}, headers=_auth(token))
        assert resp.status_code == 400

    def test_create_nested_folder(self, client):
        token = _create_user("admin", role="admin")

        # Create parent
        resp = client.post("/api/rooms/folders",
                           json={"name": "parent"}, headers=_auth(token))
        parent_id = resp.json()["folder_id"]

        # Create child
        resp = client.post("/api/rooms/folders",
                           json={"name": "child", "parent_folder_id": parent_id},
                           headers=_auth(token))
        assert resp.status_code == 200

    def test_update_folder_name(self, client):
        token = _create_user("admin", role="admin")

        resp = client.post("/api/rooms/folders",
                           json={"name": "old-name"}, headers=_auth(token))
        folder_id = resp.json()["folder_id"]

        resp = client.patch(f"/api/rooms/folders/{folder_id}",
                            json={"name": "new-name"}, headers=_auth(token))
        assert resp.status_code == 200

    def test_update_folder_not_found(self, client):
        token = _create_user("admin", role="admin")

        resp = client.patch("/api/rooms/folders/nonexistent",
                            json={"name": "test"}, headers=_auth(token))
        assert resp.status_code == 404

    def test_delete_folder(self, client):
        token = _create_user("admin", role="admin")

        resp = client.post("/api/rooms/folders",
                           json={"name": "to-delete"}, headers=_auth(token))
        folder_id = resp.json()["folder_id"]

        resp = client.delete(f"/api/rooms/folders/{folder_id}", headers=_auth(token))
        assert resp.status_code == 200

    def test_delete_folder_not_found(self, client):
        token = _create_user("admin", role="admin")

        resp = client.delete("/api/rooms/folders/nonexistent", headers=_auth(token))
        assert resp.status_code == 404

    def test_delete_folder_requires_admin(self, client):
        token = _create_user("alice")

        resp = client.delete("/api/rooms/folders/some-id", headers=_auth(token))
        assert resp.status_code == 403

    def test_moderator_can_create_folder(self, client):
        token = _create_user("mod", role="moderator")

        resp = client.post("/api/rooms/folders",
                           json={"name": "mod-folder"}, headers=_auth(token))
        assert resp.status_code == 200


# ---------------------------------------------------------------------------
# Tests: Reorder
# ---------------------------------------------------------------------------

class TestReorder:
    def test_reorder_folders(self, client):
        token = _create_user("admin", role="admin")

        # Create two folders
        resp1 = client.post("/api/rooms/folders",
                            json={"name": "folder-a"}, headers=_auth(token))
        id1 = resp1.json()["folder_id"]
        resp2 = client.post("/api/rooms/folders",
                            json={"name": "folder-b"}, headers=_auth(token))
        id2 = resp2.json()["folder_id"]

        # Reorder: swap positions
        resp = client.post("/api/rooms/folders/reorder", json={
            "folders": [
                {"folder_id": id1, "position": 2},
                {"folder_id": id2, "position": 1},
            ],
            "rooms": [],
        }, headers=_auth(token))
        assert resp.status_code == 200

    def test_reorder_requires_admin(self, client):
        token = _create_user("alice")

        resp = client.post("/api/rooms/folders/reorder", json={
            "folders": [], "rooms": [],
        }, headers=_auth(token))
        assert resp.status_code == 403


# ---------------------------------------------------------------------------
# Tests: Folder tree with rooms
# ---------------------------------------------------------------------------

class TestFolderTree:
    def test_folder_tree_includes_room_positions(self, client):
        token = _create_user("admin", role="admin")
        _create_room_direct("general")

        resp = client.get("/api/rooms/folders", headers=_auth(token))
        assert resp.status_code == 200
        data = resp.json()
        # Room positions should include our room
        room_ids = [r["room_id"] for r in data["room_positions"]]
        assert "general" in room_ids
