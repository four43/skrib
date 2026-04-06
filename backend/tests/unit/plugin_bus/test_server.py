"""Tests for the plugin bus server — hello handshake, permissions, rate limiting,
room type registration, frame routing, and cleanup on disconnect."""
import asyncio
import json

import pytest
import pytest_asyncio
import websockets
from websockets.asyncio.server import serve as ws_serve

from skrib.plugin_bus.protocol import FrameType, ApprovalStatus
from skrib.plugin_bus.rate_limit import TokenBucket
from skrib.plugin_bus.server import PluginBusServer


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def make_manifest(**overrides):
    base = {
        "id": "test.plugin",
        "version": "1.0.0",
        "permissions": ["bus.send", "bus.receive"],
        "published_events": [],
        "subscriptions": [],
    }
    base.update(overrides)
    return base


def make_hello(plugin_id="test.plugin", version="1.0.0", secret="s3cret", **manifest_overrides):
    return {
        "type": "hello",
        "plugin_id": plugin_id,
        "version": version,
        "secret": secret,
        "manifest": make_manifest(id=plugin_id, **manifest_overrides),
    }


async def start_bus_server(bus_server, host="127.0.0.1", port=0):
    server = await ws_serve(bus_server.handle_connection, host, port)
    actual_port = server.sockets[0].getsockname()[1]
    return server, actual_port


async def connect_and_hello(url, hello_data=None):
    ws = await websockets.connect(url)
    await ws.send(json.dumps(hello_data or make_hello()))
    ack = json.loads(await ws.recv())
    return ws, ack


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

@pytest_asyncio.fixture
async def bus():
    server = PluginBusServer()
    ws_server, port = await start_bus_server(server)
    yield server, port
    ws_server.close()
    await ws_server.wait_closed()


@pytest.fixture
def bus_url(bus):
    _, port = bus
    return f"ws://127.0.0.1:{port}"


# ---------------------------------------------------------------------------
# Hello handshake tests
# ---------------------------------------------------------------------------

class TestHelloHandshake:
    @pytest.mark.asyncio
    async def test_approved(self, bus, bus_url):
        server, _ = bus
        ws, ack = await connect_and_hello(bus_url)
        try:
            assert ack["type"] == "hello_ack"
            assert ack["status"] == "approved"
            assert "test.plugin" in server.plugins
        finally:
            await ws.close()

    @pytest.mark.asyncio
    async def test_missing_fields(self, bus_url):
        ws = await websockets.connect(bus_url)
        try:
            await ws.send(json.dumps({"type": "hello", "plugin_id": "x"}))
            resp = json.loads(await ws.recv())
            assert resp["type"] == "error"
            assert resp["code"] == "missing_fields"
        finally:
            await ws.close()

    @pytest.mark.asyncio
    async def test_invalid_json(self, bus_url):
        ws = await websockets.connect(bus_url)
        try:
            await ws.send("not json {{{")
            resp = json.loads(await ws.recv())
            assert resp["type"] == "error"
            assert resp["code"] == "invalid_json"
        finally:
            await ws.close()

    @pytest.mark.asyncio
    async def test_not_first_frame(self, bus_url):
        ws = await websockets.connect(bus_url)
        try:
            await ws.send(json.dumps({
                "type": "bus.broadcast_room",
                "room_id": "r1",
                "action": "test",
            }))
            resp = json.loads(await ws.recv())
            assert resp["type"] == "error"
            assert resp["code"] == "protocol_error"
        finally:
            await ws.close()

    @pytest.mark.asyncio
    async def test_invalid_permissions(self, bus_url):
        ws = await websockets.connect(bus_url)
        try:
            hello = make_hello(permissions=["bus.send", "bogus.perm"])
            await ws.send(json.dumps(hello))
            resp = json.loads(await ws.recv())
            assert resp["type"] == "error"
            assert resp["code"] == "invalid_permissions"
        finally:
            await ws.close()

    @pytest.mark.asyncio
    async def test_duplicate_connection(self, bus, bus_url):
        ws1, ack1 = await connect_and_hello(bus_url)
        try:
            assert ack1["status"] == "approved"
            ws2, ack2 = await connect_and_hello(bus_url)
            try:
                assert ack2["type"] == "error"
                assert ack2["code"] == "already_connected"
            finally:
                await ws2.close()
        finally:
            await ws1.close()

    @pytest.mark.asyncio
    async def test_rejected(self):
        async def reject_all(pid, m):
            return ApprovalStatus.REJECTED

        server = PluginBusServer(approve_plugin=reject_all)
        ws_server, port = await start_bus_server(server)
        url = f"ws://127.0.0.1:{port}"
        try:
            ws = await websockets.connect(url)
            await ws.send(json.dumps(make_hello()))
            ack = json.loads(await ws.recv())
            assert ack["status"] == "rejected"
            await asyncio.sleep(0.05)  # Let server cleanup complete
            assert "test.plugin" not in server.plugins
        finally:
            ws_server.close()
            await ws_server.wait_closed()

    @pytest.mark.asyncio
    async def test_pending(self):
        async def pend_all(pid, m):
            return ApprovalStatus.PENDING

        server = PluginBusServer(approve_plugin=pend_all)
        ws_server, port = await start_bus_server(server)
        url = f"ws://127.0.0.1:{port}"
        try:
            ws, ack = await connect_and_hello(url)
            try:
                assert ack["status"] == "pending_approval"
                assert "test.plugin" in server.plugins
                assert server.plugins["test.plugin"].status == ApprovalStatus.PENDING
            finally:
                await ws.close()
        finally:
            ws_server.close()
            await ws_server.wait_closed()


# ---------------------------------------------------------------------------
# Permission enforcement tests
# ---------------------------------------------------------------------------

class TestPermissions:
    @pytest.mark.asyncio
    async def test_frame_denied_without_permission(self, bus, bus_url):
        hello = make_hello(plugin_id="limited.plugin", permissions=["bus.receive"])
        ws, ack = await connect_and_hello(bus_url, hello)
        try:
            assert ack["status"] == "approved"
            await ws.send(json.dumps({
                "type": "bus.broadcast_room",
                "room_id": "r1",
                "action": "test",
            }))
            resp = json.loads(await ws.recv())
            assert resp["type"] == "error"
            assert resp["code"] == "permission_denied"
        finally:
            await ws.close()

    @pytest.mark.asyncio
    async def test_pending_plugin_cannot_send(self):
        async def pend_all(pid, m):
            return ApprovalStatus.PENDING

        server = PluginBusServer(approve_plugin=pend_all)
        ws_server, port = await start_bus_server(server)
        url = f"ws://127.0.0.1:{port}"
        try:
            ws, ack = await connect_and_hello(url)
            assert ack["status"] == "pending_approval"
            try:
                await ws.send(json.dumps({
                    "type": "bus.broadcast_room",
                    "room_id": "r1",
                    "action": "test",
                }))
                resp = json.loads(await ws.recv())
                assert resp["type"] == "error"
                assert resp["code"] == "pending_approval"
            finally:
                await ws.close()
        finally:
            ws_server.close()
            await ws_server.wait_closed()


# ---------------------------------------------------------------------------
# Rate limiting tests
# ---------------------------------------------------------------------------

class TestRateLimiting:
    @pytest.mark.asyncio
    async def test_rate_limited_after_burst(self):
        server = PluginBusServer()
        ws_server, port = await start_bus_server(server)
        url = f"ws://127.0.0.1:{port}"

        received = []
        async def core_handler(plugin_id, data):
            received.append(data)
        server.set_core_handler(core_handler)

        ws = await websockets.connect(url)
        await ws.send(json.dumps(make_hello(permissions=["bus.send"])))
        ack = json.loads(await ws.recv())
        assert ack["status"] == "approved"

        try:
            # Set very low burst
            conn = server.get_plugin("test.plugin")
            conn.rate_limiter = TokenBucket(rate=1, burst=2)

            # Send 3 frames — third should be rate limited
            for i in range(3):
                await ws.send(json.dumps({
                    "type": "bus.broadcast_room",
                    "room_id": "r1",
                    "action": f"msg_{i}",
                }))

            await asyncio.sleep(0.1)

            # Drain any error responses
            errors = []
            try:
                while True:
                    raw = await asyncio.wait_for(ws.recv(), timeout=0.1)
                    data = json.loads(raw)
                    if data.get("type") == "error":
                        errors.append(data)
            except (asyncio.TimeoutError, websockets.ConnectionClosed):
                pass

            assert any(e["code"] == "rate_limited" for e in errors)
            assert len(received) == 2
        finally:
            await ws.close()
            ws_server.close()
            await ws_server.wait_closed()


# ---------------------------------------------------------------------------
# Room type registration tests
# ---------------------------------------------------------------------------

class TestRoomTypeRegistration:
    @pytest.mark.asyncio
    async def test_register_room_type(self, bus, bus_url):
        server, _ = bus
        hello = make_hello(permissions=["bus.send", "room_type.register"], room_types=["chat"])
        ws, ack = await connect_and_hello(bus_url, hello)
        try:
            await ws.send(json.dumps({
                "type": "register.room_type",
                "room_type": "chat",
                "display_name": "Chat Room",
            }))
            await asyncio.sleep(0.05)
            assert server.room_type_map.get("chat") == "test.plugin"
        finally:
            await ws.close()

    @pytest.mark.asyncio
    async def test_conflict(self, bus, bus_url):
        server, _ = bus
        hello1 = make_hello(plugin_id="plugin.a", permissions=["bus.send", "room_type.register"], room_types=["chat"])
        ws1, _ = await connect_and_hello(bus_url, hello1)
        await ws1.send(json.dumps({
            "type": "register.room_type",
            "room_type": "chat",
            "display_name": "Chat",
        }))
        await asyncio.sleep(0.05)

        try:
            hello2 = make_hello(plugin_id="plugin.b", permissions=["bus.send", "room_type.register"], room_types=["chat"])
            ws2, _ = await connect_and_hello(bus_url, hello2)
            await ws2.send(json.dumps({
                "type": "register.room_type",
                "room_type": "chat",
                "display_name": "Chat 2",
            }))
            resp = json.loads(await ws2.recv())
            assert resp["type"] == "error"
            assert resp["code"] == "room_type_conflict"
            await ws2.close()
        finally:
            await ws1.close()

    @pytest.mark.asyncio
    async def test_room_type_not_in_manifest_rejected(self, bus, bus_url):
        """Plugin cannot register a room type not declared in its manifest."""
        server, _ = bus
        hello = make_hello(permissions=["bus.send", "room_type.register"], room_types=["chat"])
        ws, ack = await connect_and_hello(bus_url, hello)
        try:
            await ws.send(json.dumps({
                "type": "register.room_type",
                "room_type": "hijacked_type",
                "display_name": "Hijacked",
            }))
            resp = json.loads(await ws.recv())
            assert resp["type"] == "error"
            assert resp["code"] == "room_type_not_in_manifest"
            assert "hijacked_type" not in server.room_type_map
        finally:
            await ws.close()


# ---------------------------------------------------------------------------
# Frame routing tests
# ---------------------------------------------------------------------------

class TestFrameRouting:
    @pytest.mark.asyncio
    async def test_core_handler_receives_frames(self, bus, bus_url):
        server, _ = bus
        received = []
        async def core_handler(plugin_id, data):
            received.append((plugin_id, data))
        server.set_core_handler(core_handler)

        ws, ack = await connect_and_hello(bus_url)
        try:
            await ws.send(json.dumps({
                "type": "bus.broadcast_room",
                "room_id": "room1",
                "action": "new_message",
                "content": "hello",
            }))
            await asyncio.sleep(0.05)
            assert len(received) == 1
            plugin_id, data = received[0]
            assert plugin_id == "test.plugin"
            assert data["action"] == "new_message"
            assert data["_plugin_id"] == "test.plugin"
        finally:
            await ws.close()

    @pytest.mark.asyncio
    async def test_send_to_plugin(self, bus, bus_url):
        server, _ = bus
        ws, ack = await connect_and_hello(bus_url)
        try:
            sent = await server.send_to_plugin("test.plugin", {
                "type": "room.action",
                "room_id": "r1",
                "action": "send_message",
                "username": "alice",
                "reply_to": "tok123",
            })
            assert sent is True
            resp = json.loads(await ws.recv())
            assert resp["type"] == "room.action"
            assert resp["action"] == "send_message"
        finally:
            await ws.close()

    @pytest.mark.asyncio
    async def test_send_to_nonexistent_plugin(self, bus, bus_url):
        server, _ = bus
        sent = await server.send_to_plugin("no.such.plugin", {"type": "room.action"})
        assert sent is False


# ---------------------------------------------------------------------------
# Cleanup tests
# ---------------------------------------------------------------------------

# ---------------------------------------------------------------------------
# Secret validation tests
# ---------------------------------------------------------------------------

# ---------------------------------------------------------------------------
# Event subscription ACL tests
# ---------------------------------------------------------------------------

class TestEventSubscriptionACL:
    @pytest.mark.asyncio
    async def test_event_delivered_when_published(self, bus, bus_url):
        """Event is delivered to subscribers when publisher declared it."""
        server, _ = bus
        # Plugin A publishes "notify" event
        hello_a = make_hello(
            plugin_id="plugin.a",
            permissions=["bus.send"],
            published_events=["notify"],
        )
        ws_a, _ = await connect_and_hello(bus_url, hello_a)

        # Plugin B subscribes to plugin.a:notify
        hello_b = make_hello(
            plugin_id="plugin.b",
            permissions=["bus.receive"],
            subscriptions=["plugin.a:notify"],
        )
        ws_b, _ = await connect_and_hello(bus_url, hello_b)

        try:
            await server.broadcast_to_subscribers(
                "plugin.a:notify",
                {"type": "event", "event_type": "plugin.a:notify", "data": "hello"},
            )
            resp = json.loads(await asyncio.wait_for(ws_b.recv(), timeout=1.0))
            assert resp["event_type"] == "plugin.a:notify"
        finally:
            await ws_a.close()
            await ws_b.close()

    @pytest.mark.asyncio
    async def test_event_dropped_when_not_published(self, bus, bus_url):
        """Event is NOT delivered if publisher didn't declare it."""
        server, _ = bus
        # Plugin A does NOT declare "secret_event" in published_events
        hello_a = make_hello(
            plugin_id="plugin.a",
            permissions=["bus.send"],
            published_events=["notify"],
        )
        ws_a, _ = await connect_and_hello(bus_url, hello_a)

        # Plugin B subscribes to it anyway
        hello_b = make_hello(
            plugin_id="plugin.b",
            permissions=["bus.receive"],
            subscriptions=["plugin.a:secret_event"],
        )
        ws_b, _ = await connect_and_hello(bus_url, hello_b)

        try:
            await server.broadcast_to_subscribers(
                "plugin.a:secret_event",
                {"type": "event", "event_type": "plugin.a:secret_event", "data": "leaked"},
            )
            # Plugin B should NOT receive anything
            with pytest.raises(asyncio.TimeoutError):
                await asyncio.wait_for(ws_b.recv(), timeout=0.2)
        finally:
            await ws_a.close()
            await ws_b.close()


# ---------------------------------------------------------------------------
# Manifest validation tests
# ---------------------------------------------------------------------------

class TestManifestValidation:
    @pytest.mark.asyncio
    async def test_invalid_room_type_rejected(self, bus_url):
        hello = make_hello(room_types=["<script>"])
        ws = await websockets.connect(bus_url)
        try:
            await ws.send(json.dumps(hello))
            resp = json.loads(await ws.recv())
            assert resp["type"] == "error"
            assert resp["code"] == "invalid_manifest"
        finally:
            await ws.close()

    @pytest.mark.asyncio
    async def test_valid_manifest_accepted(self, bus, bus_url):
        hello = make_hello(
            room_types=["chat"],
            published_events=["message.sent"],
            subscriptions=["four43.web-push"],
        )
        ws, ack = await connect_and_hello(bus_url, hello)
        try:
            assert ack["status"] == "approved"
        finally:
            await ws.close()


# ---------------------------------------------------------------------------
# Secret validation tests
# ---------------------------------------------------------------------------

class TestSecretValidation:
    @pytest.mark.asyncio
    async def test_correct_secret_accepted(self):
        stored_secrets = {"test.plugin": "correct_secret_123"}
        server = PluginBusServer(get_plugin_secret=lambda pid: stored_secrets.get(pid))
        ws_server, port = await start_bus_server(server)
        url = f"ws://127.0.0.1:{port}"
        try:
            hello = make_hello(secret="correct_secret_123")
            ws, ack = await connect_and_hello(url, hello)
            try:
                assert ack["status"] == "approved"
            finally:
                await ws.close()
        finally:
            ws_server.close()
            await ws_server.wait_closed()

    @pytest.mark.asyncio
    async def test_wrong_secret_rejected(self):
        stored_secrets = {"test.plugin": "correct_secret_123"}
        server = PluginBusServer(get_plugin_secret=lambda pid: stored_secrets.get(pid))
        ws_server, port = await start_bus_server(server)
        url = f"ws://127.0.0.1:{port}"
        try:
            hello = make_hello(secret="wrong_secret")
            ws = await websockets.connect(url)
            await ws.send(json.dumps(hello))
            resp = json.loads(await ws.recv())
            assert resp["type"] == "error"
            assert resp["code"] == "invalid_secret"
            await ws.close()
        finally:
            ws_server.close()
            await ws_server.wait_closed()

    @pytest.mark.asyncio
    async def test_pending_plugin_skips_secret_check(self):
        """Pending plugins don't have a secret yet, so check is skipped."""
        async def pend_all(pid, m):
            return ApprovalStatus.PENDING

        server = PluginBusServer(
            approve_plugin=pend_all,
            get_plugin_secret=lambda pid: None,
        )
        ws_server, port = await start_bus_server(server)
        url = f"ws://127.0.0.1:{port}"
        try:
            hello = make_hello(secret="anything")
            ws, ack = await connect_and_hello(url, hello)
            try:
                assert ack["status"] == "pending_approval"
            finally:
                await ws.close()
        finally:
            ws_server.close()
            await ws_server.wait_closed()

    @pytest.mark.asyncio
    async def test_no_secret_callback_skips_validation(self):
        """When no get_plugin_secret callback is set, all secrets accepted (backwards compat)."""
        server = PluginBusServer()
        ws_server, port = await start_bus_server(server)
        url = f"ws://127.0.0.1:{port}"
        try:
            hello = make_hello(secret="anything")
            ws, ack = await connect_and_hello(url, hello)
            try:
                assert ack["status"] == "approved"
            finally:
                await ws.close()
        finally:
            ws_server.close()
            await ws_server.wait_closed()


# ---------------------------------------------------------------------------
# Cleanup tests
# ---------------------------------------------------------------------------

# ---------------------------------------------------------------------------
# Connection rate limiting tests
# ---------------------------------------------------------------------------

# ---------------------------------------------------------------------------
# Confirming tests: pending plugins cannot access CoreAPI (vuln #2)
# ---------------------------------------------------------------------------

class TestPendingPluginCoreAPIBlocked:
    @pytest.mark.asyncio
    async def test_pending_plugin_core_api_blocked(self):
        """Pending plugins get pending_approval error for CORE_API_REQUEST frames."""
        async def pend_all(pid, m):
            return ApprovalStatus.PENDING

        server = PluginBusServer(approve_plugin=pend_all)
        ws_server, port = await start_bus_server(server)
        url = f"ws://127.0.0.1:{port}"
        try:
            hello = make_hello(permissions=["core_api"])
            ws, ack = await connect_and_hello(url, hello)
            assert ack["status"] == "pending_approval"
            try:
                await ws.send(json.dumps({
                    "type": "core_api.request",
                    "method": "get_room_members",
                    "request_id": "req1",
                    "params": {"room_id": "room1"},
                }))
                resp = json.loads(await ws.recv())
                assert resp["type"] == "error"
                assert resp["code"] == "pending_approval"
            finally:
                await ws.close()
        finally:
            ws_server.close()
            await ws_server.wait_closed()


class TestConnectionRateLimiting:
    @pytest.mark.asyncio
    async def test_rate_limited_after_burst(self):
        server = PluginBusServer()
        server.CONNECTION_RATE_LIMIT = 3
        server.CONNECTION_RATE_WINDOW = 60.0
        ws_server, port = await start_bus_server(server)
        url = f"ws://127.0.0.1:{port}"

        connections = []
        try:
            # First 3 connections should succeed
            for i in range(3):
                hello = make_hello(plugin_id=f"plugin.{i}")
                ws, ack = await connect_and_hello(url, hello)
                assert ack["status"] == "approved"
                connections.append(ws)

            # 4th connection should be rate limited
            ws4 = await websockets.connect(url)
            resp = json.loads(await ws4.recv())
            assert resp["type"] == "error"
            assert resp["code"] == "rate_limited"
            await ws4.close()
        finally:
            for ws in connections:
                await ws.close()
            ws_server.close()
            await ws_server.wait_closed()


class TestCleanup:
    @pytest.mark.asyncio
    async def test_cleanup_on_disconnect(self, bus, bus_url):
        server, _ = bus
        hello = make_hello(permissions=["bus.send", "room_type.register"], room_types=["whiteboard"])
        ws, ack = await connect_and_hello(bus_url, hello)
        await ws.send(json.dumps({
            "type": "register.room_type",
            "room_type": "whiteboard",
            "display_name": "Whiteboard",
        }))
        await asyncio.sleep(0.05)
        assert "whiteboard" in server.room_type_map

        await ws.close()
        await asyncio.sleep(0.1)

        assert "test.plugin" not in server.plugins
        assert "whiteboard" not in server.room_type_map
