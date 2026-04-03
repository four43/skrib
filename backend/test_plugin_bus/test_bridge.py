"""Tests for the plugin bus bridge — core-side bus client that translates between
the plugin bus and UnifiedConnectionManager/CoreAPI."""
import asyncio
import json
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from skrib.plugin_bus.bridge import PluginBusBridge
from skrib.plugin_bus.protocol import FrameType
from skrib.plugin_bus.server import PluginBusServer


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

class FakeWSManager:
    """Minimal mock of UnifiedConnectionManager for bridge tests."""

    def __init__(self):
        self.broadcast_to_room = AsyncMock()
        self.notify_user = AsyncMock()
        self.notify_all_users = AsyncMock()
        self.send_reply = AsyncMock()
        self.emit_event = AsyncMock()
        self._event_listeners = {}

    def on_event(self, event_type, callback):
        self._event_listeners.setdefault(event_type, []).append(callback)

    def off_event(self, event_type, callback):
        listeners = self._event_listeners.get(event_type, [])
        if callback in listeners:
            listeners.remove(callback)


class FakeCoreAPI:
    """Minimal mock of CoreAPI for bridge tests."""

    def get_room_members(self, room_id):
        return ["alice", "bob"]

    def get_room_info(self, room_id):
        return {"id": room_id, "name": "Test Room", "members": ["alice", "bob"]}

    def get_notify_level(self, room_id, username):
        return "all"

    def get_unread_count(self, room_id, username):
        return 5

    def mark_room_read(self, room_id, username, message_id):
        pass

    def is_user_connected(self, username):
        return username == "alice"


@pytest.fixture
def bus_server():
    return PluginBusServer()


@pytest.fixture
def ws_manager():
    return FakeWSManager()


@pytest.fixture
def core_api():
    return FakeCoreAPI()


@pytest.fixture
def bridge(bus_server, ws_manager, core_api):
    return PluginBusBridge(bus_server, ws_manager, core_api)


# ---------------------------------------------------------------------------
# Tests: Bus operations (plugin → client WebSockets)
# ---------------------------------------------------------------------------

class TestBroadcastRoom:
    async def test_broadcast_to_room(self, bridge, ws_manager):
        """Plugin sends bus.broadcast_room → bridge calls ws_manager.broadcast_to_room."""
        frame = {
            "type": FrameType.BUS_BROADCAST_ROOM.value,
            "room_id": "room1",
            "action": "new_message",
            "content": "hello",
            "_plugin_id": "test.plugin",
        }
        await bridge._handle_plugin_frame("test.plugin", frame)

        ws_manager.broadcast_to_room.assert_called_once()
        call_args = ws_manager.broadcast_to_room.call_args
        assert call_args[0][0] == "room1"
        msg = call_args[0][1]
        assert msg["type"] == "test.plugin:new_message"
        assert msg["content"] == "hello"
        assert msg["room_id"] == "room1"

    async def test_broadcast_with_exclude_user(self, bridge, ws_manager):
        frame = {
            "type": FrameType.BUS_BROADCAST_ROOM.value,
            "room_id": "room1",
            "action": "typing",
            "exclude_user": "alice",
            "_plugin_id": "test.plugin",
        }
        await bridge._handle_plugin_frame("test.plugin", frame)

        call_kwargs = ws_manager.broadcast_to_room.call_args[1]
        assert call_kwargs["exclude_user"] == "alice"


class TestNotifyUser:
    async def test_notify_user(self, bridge, ws_manager):
        frame = {
            "type": FrameType.BUS_NOTIFY_USER.value,
            "username": "alice",
            "action": "room_update",
            "room_id": "room1",
            "_plugin_id": "test.plugin",
        }
        await bridge._handle_plugin_frame("test.plugin", frame)

        ws_manager.notify_user.assert_called_once()
        call_args = ws_manager.notify_user.call_args
        assert call_args[0][0] == "alice"
        msg = call_args[0][1]
        assert msg["type"] == "test.plugin:room_update"


class TestNotifyAll:
    async def test_notify_all(self, bridge, ws_manager):
        frame = {
            "type": FrameType.BUS_NOTIFY_ALL.value,
            "action": "announcement",
            "text": "Server restarting",
            "_plugin_id": "test.plugin",
        }
        await bridge._handle_plugin_frame("test.plugin", frame)

        ws_manager.notify_all_users.assert_called_once()
        msg = ws_manager.notify_all_users.call_args[0][0]
        assert msg["type"] == "test.plugin:announcement"
        assert msg["text"] == "Server restarting"


class TestReply:
    async def test_reply(self, bridge, ws_manager):
        frame = {
            "type": FrameType.BUS_REPLY.value,
            "reply_to": "token123",
            "action": "error",
            "message": "Something went wrong",
            "_plugin_id": "test.plugin",
        }
        await bridge._handle_plugin_frame("test.plugin", frame)

        ws_manager.send_reply.assert_called_once()
        call_args = ws_manager.send_reply.call_args
        assert call_args[0][0] == "token123"
        msg = call_args[0][1]
        assert msg["type"] == "test.plugin:error"
        assert msg["message"] == "Something went wrong"


class TestEmitEvent:
    async def test_emit_event(self, bridge, ws_manager):
        frame = {
            "type": FrameType.BUS_EMIT_EVENT.value,
            "event_type": "message_sent",
            "_plugin_id": "test.plugin",
        }
        await bridge._handle_plugin_frame("test.plugin", frame)

        ws_manager.emit_event.assert_called_once()
        event = ws_manager.emit_event.call_args[0][0]
        assert event["type"] == "test.plugin:message_sent"


# ---------------------------------------------------------------------------
# Tests: CoreAPI requests
# ---------------------------------------------------------------------------

class TestCoreAPIRequest:
    async def test_get_room_members(self, bridge, bus_server):
        bus_server.send_to_plugin = AsyncMock(return_value=True)

        frame = {
            "type": FrameType.CORE_API_REQUEST.value,
            "method": "get_room_members",
            "request_id": "req1",
            "params": {"room_id": "room1"},
            "_plugin_id": "test.plugin",
        }
        await bridge._handle_plugin_frame("test.plugin", frame)

        bus_server.send_to_plugin.assert_called_once()
        call_args = bus_server.send_to_plugin.call_args
        assert call_args[0][0] == "test.plugin"
        response = call_args[0][1]
        assert response["type"] == FrameType.CORE_API_RESPONSE.value
        assert response["request_id"] == "req1"
        assert response["result"] == ["alice", "bob"]

    async def test_get_room_info(self, bridge, bus_server):
        bus_server.send_to_plugin = AsyncMock(return_value=True)

        frame = {
            "type": FrameType.CORE_API_REQUEST.value,
            "method": "get_room_info",
            "request_id": "req2",
            "params": {"room_id": "room1"},
            "_plugin_id": "test.plugin",
        }
        await bridge._handle_plugin_frame("test.plugin", frame)

        response = bus_server.send_to_plugin.call_args[0][1]
        assert response["result"]["id"] == "room1"
        assert "alice" in response["result"]["members"]

    async def test_is_user_connected(self, bridge, bus_server):
        bus_server.send_to_plugin = AsyncMock(return_value=True)

        frame = {
            "type": FrameType.CORE_API_REQUEST.value,
            "method": "is_user_connected",
            "request_id": "req3",
            "params": {"username": "alice"},
            "_plugin_id": "test.plugin",
        }
        await bridge._handle_plugin_frame("test.plugin", frame)

        response = bus_server.send_to_plugin.call_args[0][1]
        assert response["result"] is True

    async def test_unknown_method_returns_error(self, bridge, bus_server):
        bus_server.send_to_plugin = AsyncMock(return_value=True)

        frame = {
            "type": FrameType.CORE_API_REQUEST.value,
            "method": "nonexistent_method",
            "request_id": "req4",
            "params": {},
            "_plugin_id": "test.plugin",
        }
        await bridge._handle_plugin_frame("test.plugin", frame)

        response = bus_server.send_to_plugin.call_args[0][1]
        assert "error" in response
        assert "nonexistent_method" in response["error"]

    async def test_mark_room_read(self, bridge, bus_server, core_api):
        bus_server.send_to_plugin = AsyncMock(return_value=True)
        core_api.mark_room_read = MagicMock()

        frame = {
            "type": FrameType.CORE_API_REQUEST.value,
            "method": "mark_room_read",
            "request_id": "req5",
            "params": {"room_id": "room1", "username": "alice", "message_id": 42},
            "_plugin_id": "test.plugin",
        }
        await bridge._handle_plugin_frame("test.plugin", frame)

        core_api.mark_room_read.assert_called_once_with("room1", "alice", 42)
        response = bus_server.send_to_plugin.call_args[0][1]
        assert response["result"] == {"ok": True}


# ---------------------------------------------------------------------------
# Tests: Room action dispatch (core → plugin)
# ---------------------------------------------------------------------------

class TestDispatchRoomAction:
    async def test_dispatch_room_action(self, bridge, bus_server):
        bus_server.send_to_plugin = AsyncMock(return_value=True)

        result = await bridge.dispatch_room_action(
            plugin_id="test.plugin",
            room_id="room1",
            action="message",
            username="alice",
            msg={"content": "hello"},
            reply_to="token123",
            user_role="user",
            room_role="member",
        )
        assert result is True

        frame = bus_server.send_to_plugin.call_args[0][1]
        assert frame["type"] == FrameType.ROOM_ACTION.value
        assert frame["room_id"] == "room1"
        assert frame["action"] == "message"
        assert frame["username"] == "alice"
        assert frame["reply_to"] == "token123"
        assert frame["data"] == {"content": "hello"}

    async def test_dispatch_returns_false_when_plugin_not_connected(self, bridge, bus_server):
        bus_server.send_to_plugin = AsyncMock(return_value=False)

        result = await bridge.dispatch_room_action(
            plugin_id="missing.plugin",
            room_id="room1",
            action="message",
            username="alice",
            msg={},
            reply_to="token",
            user_role="user",
            room_role=None,
        )
        assert result is False


# ---------------------------------------------------------------------------
# Tests: Callbacks
# ---------------------------------------------------------------------------

class TestCallbacks:
    async def test_send_callback_timeout(self, bridge, bus_server):
        """Callback times out when plugin doesn't respond."""
        bus_server.send_to_plugin = AsyncMock(return_value=True)

        result = await bridge.send_callback("test.plugin", "/unread-count", {"room_id": "r1"}, timeout=0.1)
        assert result is None

    async def test_send_callback_plugin_not_connected(self, bridge, bus_server):
        """Callback returns None when plugin is not connected."""
        bus_server.send_to_plugin = AsyncMock(return_value=False)

        result = await bridge.send_callback("missing.plugin", "/health", {})
        assert result is None

    async def test_callback_response_resolves_future(self, bridge, bus_server):
        """Plugin sending callback_response resolves the pending future."""
        bus_server.send_to_plugin = AsyncMock(return_value=True)

        # Start callback in background
        async def respond_later():
            await asyncio.sleep(0.05)
            # Find the request_id from the sent frame
            frame = bus_server.send_to_plugin.call_args[0][1]
            request_id = frame["request_id"]
            # Simulate plugin response
            await bridge._handle_callback_response("test.plugin", {
                "type": FrameType.CALLBACK_RESPONSE.value,
                "request_id": request_id,
                "result": {"count": 3},
            })

        task = asyncio.create_task(respond_later())
        result = await bridge.send_callback("test.plugin", "/unread-count", {"room_id": "r1"}, timeout=2.0)
        await task

        assert result == {"count": 3}


# ---------------------------------------------------------------------------
# Tests: Lifecycle events
# ---------------------------------------------------------------------------

class TestLifecycleEvents:
    async def test_room_created_forwarded_to_plugin(self, bridge, bus_server, ws_manager):
        """Room creation event is forwarded to the owning plugin."""
        bus_server.send_to_plugin = AsyncMock(return_value=True)
        # Register a room type mapping
        bus_server._room_type_map["chat"] = "test.plugin"

        await bridge._on_room_created({
            "type": "core:room_created",
            "room_id": "room1",
            "room_type": "chat",
            "creator": "alice",
        })

        bus_server.send_to_plugin.assert_called_once()
        frame = bus_server.send_to_plugin.call_args[0][1]
        assert frame["type"] == FrameType.LIFECYCLE_ROOM_CREATED.value
        assert frame["room_id"] == "room1"
        assert frame["creator"] == "alice"

    async def test_room_deleted_forwarded(self, bridge, bus_server):
        bus_server.send_to_plugin = AsyncMock(return_value=True)
        bus_server._room_type_map["chat"] = "test.plugin"

        await bridge._on_room_deleted({
            "type": "core:room_deleted",
            "room_id": "room1",
            "room_type": "chat",
        })

        frame = bus_server.send_to_plugin.call_args[0][1]
        assert frame["type"] == FrameType.LIFECYCLE_ROOM_DELETED.value

    async def test_user_joined_forwarded(self, bridge, bus_server):
        bus_server.send_to_plugin = AsyncMock(return_value=True)
        bus_server._room_type_map["chat"] = "test.plugin"

        await bridge._on_user_joined({
            "type": "core:user_joined_room",
            "room_id": "room1",
            "username": "bob",
            "room_type": "chat",
        })

        frame = bus_server.send_to_plugin.call_args[0][1]
        assert frame["type"] == FrameType.LIFECYCLE_USER_JOINED.value
        assert frame["username"] == "bob"

    async def test_lifecycle_ignored_for_unknown_room_type(self, bridge, bus_server):
        bus_server.send_to_plugin = AsyncMock()

        await bridge._on_room_created({
            "type": "core:room_created",
            "room_id": "room1",
            "room_type": "unknown_type",
            "creator": "alice",
        })

        bus_server.send_to_plugin.assert_not_called()


# ---------------------------------------------------------------------------
# Tests: Teardown
# ---------------------------------------------------------------------------

class TestTeardown:
    def test_teardown_removes_event_listeners(self, bridge, ws_manager):
        """Bridge teardown removes all registered event listeners."""
        assert len(ws_manager._event_listeners.get("core:room_created", [])) == 1

        bridge.teardown()

        assert len(ws_manager._event_listeners.get("core:room_created", [])) == 0

    def test_get_bus_plugin_for_room_type(self, bridge, bus_server):
        bus_server._room_type_map["todo"] = "four43.room-type-todo"
        assert bridge.get_bus_plugin_for_room_type("todo") == "four43.room-type-todo"
        assert bridge.get_bus_plugin_for_room_type("unknown") is None
