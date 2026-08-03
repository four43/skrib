"""In-process plugins must be reachable through the same bridge paths.

The ``bridge`` fixture here is local to this file rather than added to
``conftest.py``: ``test_bridge.py`` already builds its bridge inline with
lightweight fakes rather than through a shared fixture, so this follows the
same pattern instead of reshaping the shared conftest (which also hosts the
unrelated ``seeded_room`` fixture).
"""
from unittest.mock import MagicMock

import pytest

from skrib.plugin_bus.bridge import PluginBusBridge
from skrib.plugin_bus.server import PluginBusServer


class _FakeWSManager:
    """Minimal stand-in for UnifiedConnectionManager's event registration."""

    def on_event(self, event_type, callback):
        pass

    def off_event(self, event_type, callback):
        pass


@pytest.fixture
def bridge():
    return PluginBusBridge(PluginBusServer(), _FakeWSManager(), MagicMock())


@pytest.mark.asyncio
async def test_send_to_plugin_prefers_inprocess(bridge):
    """A registered in-process plugin receives frames without the bus server."""
    delivered = []

    async def deliver(frame):
        delivered.append(frame)

    bridge.register_inprocess("four43.room-type-chat", deliver, ["chat"])

    sent = await bridge._send_to_plugin(
        "four43.room-type-chat", {"type": "room.action", "action": "message"}
    )

    assert sent is True
    assert delivered == [{"type": "room.action", "action": "message"}]


def test_room_type_lookup_resolves_inprocess_plugins(bridge):
    """get_bus_plugin_for_room_type must find in-process room types too,
    so ws/handlers.py needs no runtime-specific branching."""
    async def deliver(frame):
        pass

    bridge.register_inprocess("four43.room-type-chat", deliver, ["chat"])

    assert bridge.get_bus_plugin_for_room_type("chat") == "four43.room-type-chat"


def test_unregister_removes_room_types(bridge):
    """Unregistering drops the plugin's room types from the lookup."""
    async def deliver(frame):
        pass

    bridge.register_inprocess("four43.room-type-chat", deliver, ["chat"])
    bridge.unregister_inprocess("four43.room-type-chat")

    assert bridge.get_bus_plugin_for_room_type("chat") is None


@pytest.mark.asyncio
async def test_send_to_plugin_returns_false_when_inprocess_deliver_raises(bridge):
    """An in-process handler exception must not propagate.

    A raise here is exactly what would otherwise tear down the caller's
    entire WebSocket connection (ws/routes.py's outer except Exception),
    reproducing the msg-2 teardown symptom this plan exists to fix. The
    in-process branch must fail the same way the bus branch already does:
    catch, log, return False.
    """
    async def deliver(frame):
        raise ValueError("boom")

    bridge.register_inprocess("four43.room-type-chat", deliver, ["chat"])

    sent = await bridge._send_to_plugin(
        "four43.room-type-chat", {"type": "room.action", "action": "message"}
    )

    assert sent is False


def test_reregister_inprocess_drops_stale_room_types(bridge):
    """Re-registering a plugin with a shrunk room_types list must not leave
    a stale mapping to a room type it no longer owns."""
    async def deliver(frame):
        pass

    bridge.register_inprocess("four43.room-type-chat", deliver, ["chat", "chat-legacy"])
    bridge.register_inprocess("four43.room-type-chat", deliver, ["chat"])

    assert bridge.get_bus_plugin_for_room_type("chat") == "four43.room-type-chat"
    assert bridge.get_bus_plugin_for_room_type("chat-legacy") is None
