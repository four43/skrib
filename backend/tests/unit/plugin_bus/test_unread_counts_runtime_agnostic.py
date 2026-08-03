"""rooms/services.py's unread-count helpers must resolve the owning plugin
through the bridge (runtime-agnostic), not by reading the bus server's
``room_type_map`` directly — see Task 4C's follow-up review, call sites
rooms/services.py:466 and :699.
"""
from unittest.mock import AsyncMock, MagicMock

import pytest

from skrib.database import get_db
from skrib.rooms.services import get_unread_count_for_room, get_unread_counts


@pytest.fixture(autouse=True)
def temp_db(tmp_path, monkeypatch):
    """Point skrib.database at a fresh, fully-initialized temp DB per test."""
    from skrib import database

    monkeypatch.setattr(database, "DB_FILE", str(tmp_path / "test.db"))
    database.close_all_connections()
    database.init_db()

    yield

    database.close_all_connections()


def _mark_read(room_id: str, username: str, message_id: int) -> None:
    with get_db() as conn:
        conn.execute(
            "UPDATE room_users SET last_read_message_id = ? WHERE room_id = ? AND username = ?",
            (message_id, room_id, username),
        )
        conn.commit()


@pytest.fixture
def wired_app_state(seeded_room):
    """Install a fake bridge whose ``get_bus_plugin_for_room_type`` resolves
    an in-process room type, and a plugin_bus whose ``room_type_map`` is
    deliberately empty/wrong — proving the two functions under test consult
    only the bridge, exactly the fix this test is guarding.
    """
    from skrib.main import app

    room_id, members = seeded_room

    fake_bridge = MagicMock()
    fake_bridge.get_bus_plugin_for_room_type = MagicMock(return_value="four43.inproc-chat")
    fake_bridge.send_callback = AsyncMock(return_value=None)

    fake_bus = MagicMock()
    fake_bus.room_type_map = {}  # empty on purpose — must not be consulted

    saved_bridge = getattr(app.state, "plugin_bus_bridge", None)
    saved_bus = getattr(app.state, "plugin_bus", None)
    app.state.plugin_bus_bridge = fake_bridge
    app.state.plugin_bus = fake_bus
    try:
        yield room_id, members, fake_bridge
    finally:
        if saved_bridge is not None:
            app.state.plugin_bus_bridge = saved_bridge
        else:
            del app.state.plugin_bus_bridge
        if saved_bus is not None:
            app.state.plugin_bus = saved_bus
        else:
            del app.state.plugin_bus


class TestGetUnreadCountForRoom:
    async def test_resolves_owner_through_bridge_not_bus_map(self, wired_app_state):
        room_id, members, fake_bridge = wired_app_state
        username = members[0]
        fake_bridge.send_callback.return_value = {"count": 4}

        count = await get_unread_count_for_room(room_id, username)

        fake_bridge.get_bus_plugin_for_room_type.assert_called_once_with("chat")
        fake_bridge.send_callback.assert_called_once()
        assert fake_bridge.send_callback.call_args[0][0] == "four43.inproc-chat"
        assert count == 4

    async def test_returns_zero_when_bridge_has_no_owner(self, wired_app_state):
        room_id, members, fake_bridge = wired_app_state
        fake_bridge.get_bus_plugin_for_room_type.return_value = None

        count = await get_unread_count_for_room(room_id, members[0])

        assert count == 0
        fake_bridge.send_callback.assert_not_called()


class TestGetUnreadCounts:
    async def test_resolves_owner_through_bridge_not_bus_map(self, wired_app_state):
        room_id, members, fake_bridge = wired_app_state
        username = members[0]
        _mark_read(room_id, username, 0)
        fake_bridge.send_callback.return_value = {room_id: 9}

        counts = await get_unread_counts(username)

        fake_bridge.get_bus_plugin_for_room_type.assert_called_once_with("chat")
        assert counts == {room_id: 9}
