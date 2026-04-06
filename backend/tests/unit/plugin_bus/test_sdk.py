"""Tests for the plugin SDK — client connection, plugin class, and decorator-based handlers."""
import asyncio
import json

import pytest
import pytest_asyncio
import websockets
from websockets.asyncio.server import serve as ws_serve

from skrib.plugin_bus.protocol import ApprovalStatus
from skrib.plugin_bus.server import PluginBusServer
from skrib_plugin_sdk.client import BusClient
from skrib_plugin_sdk.plugin import SkribPlugin, ActionContext
from skrib_plugin_sdk.decorators import on_room_action, on_lifecycle, callback


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


async def start_bus_server(bus_server, host="127.0.0.1", port=0):
    server = await ws_serve(bus_server.handle_connection, host, port)
    actual_port = server.sockets[0].getsockname()[1]
    return server, actual_port


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
# SDK Client tests
# ---------------------------------------------------------------------------

class TestBusClient:
    @pytest.mark.asyncio
    async def test_connect(self, bus, bus_url):
        server, _ = bus
        client = BusClient(
            bus_url=bus_url,
            plugin_id="sdk.test",
            version="1.0.0",
            secret="secret",
            manifest=make_manifest(id="sdk.test"),
        )
        ack = await client.connect()
        try:
            assert ack["status"] == "approved"
            assert client.connected
            assert "sdk.test" in server.plugins
        finally:
            await client.close()

    @pytest.mark.asyncio
    async def test_connect_rejected(self):
        async def reject(pid, m):
            return ApprovalStatus.REJECTED

        server = PluginBusServer(approve_plugin=reject)
        ws_server, port = await start_bus_server(server)
        url = f"ws://127.0.0.1:{port}"
        client = BusClient(
            bus_url=url,
            plugin_id="sdk.test",
            version="1.0.0",
            secret="secret",
            manifest=make_manifest(id="sdk.test"),
        )
        try:
            with pytest.raises(ConnectionError, match="rejected"):
                await client.connect()
        finally:
            ws_server.close()
            await ws_server.wait_closed()

    @pytest.mark.asyncio
    async def test_send_and_receive(self, bus, bus_url):
        server, _ = bus
        client = BusClient(
            bus_url=bus_url,
            plugin_id="sdk.test",
            version="1.0.0",
            secret="secret",
            manifest=make_manifest(id="sdk.test"),
        )
        await client.connect()

        received = []
        client.on_frame("room.action", lambda data: received.append(data))
        run_task = asyncio.create_task(client.run())

        try:
            await server.send_to_plugin("sdk.test", {
                "type": "room.action",
                "room_id": "r1",
                "action": "test_action",
                "username": "alice",
                "reply_to": "tok1",
            })
            await asyncio.sleep(0.05)
            assert len(received) == 1
            assert received[0]["action"] == "test_action"
        finally:
            await client.close()
            run_task.cancel()
            try:
                await run_task
            except asyncio.CancelledError:
                pass

    @pytest.mark.asyncio
    async def test_close_clears_connected(self, bus, bus_url):
        client = BusClient(
            bus_url=bus_url,
            plugin_id="sdk.close",
            version="1.0.0",
            secret="s",
            manifest=make_manifest(id="sdk.close"),
        )
        await client.connect()
        assert client.connected
        await client.close()
        assert not client.connected


# ---------------------------------------------------------------------------
# SDK Plugin class tests
# ---------------------------------------------------------------------------

class TestSkribPlugin:
    @pytest.mark.asyncio
    async def test_decorated_room_action(self, bus, bus_url):
        server, _ = bus

        class TestPlugin(SkribPlugin):
            id = "test.decorated"
            version = "1.0.0"
            secret = "s"
            permissions = ["bus.send", "bus.receive"]
            handled_actions = []

            @on_room_action("ping")
            async def handle_ping(self, ctx: ActionContext):
                self.handled_actions.append(("ping", ctx.room_id, ctx.username))

        plugin = TestPlugin()
        run_task = asyncio.create_task(plugin.run(bus_url))
        await asyncio.sleep(0.1)

        try:
            await server.send_to_plugin("test.decorated", {
                "type": "room.action",
                "room_id": "room1",
                "action": "ping",
                "username": "bob",
                "reply_to": "tok1",
            })
            await asyncio.sleep(0.05)
            assert plugin.handled_actions == [("ping", "room1", "bob")]
        finally:
            await plugin._client.close()
            run_task.cancel()
            try:
                await run_task
            except asyncio.CancelledError:
                pass

    @pytest.mark.asyncio
    async def test_decorated_lifecycle(self, bus, bus_url):
        server, _ = bus

        class TestPlugin(SkribPlugin):
            id = "test.lifecycle"
            version = "1.0.0"
            secret = "s"
            permissions = ["bus.send", "bus.receive"]
            deleted_rooms = []

            @on_lifecycle("room_deleted")
            async def handle_delete(self, ctx: ActionContext):
                self.deleted_rooms.append(ctx.room_id)

        plugin = TestPlugin()
        run_task = asyncio.create_task(plugin.run(bus_url))
        await asyncio.sleep(0.1)

        try:
            await server.send_to_plugin("test.lifecycle", {
                "type": "lifecycle.room_deleted",
                "room_id": "room42",
                "room_type": "chat",
            })
            await asyncio.sleep(0.05)
            assert plugin.deleted_rooms == ["room42"]
        finally:
            await plugin._client.close()
            run_task.cancel()
            try:
                await run_task
            except asyncio.CancelledError:
                pass

    @pytest.mark.asyncio
    async def test_decorated_callback(self, bus, bus_url):
        server, _ = bus

        class TestPlugin(SkribPlugin):
            id = "test.callback"
            version = "1.0.0"
            secret = "s"
            permissions = ["bus.send", "bus.receive", "callbacks.register"]
            callbacks_list = ["/unread-count"]

            @callback("/unread-count")
            async def get_unread(self, ctx: ActionContext):
                return {"count": 7}

        plugin = TestPlugin()
        run_task = asyncio.create_task(plugin.run(bus_url))
        await asyncio.sleep(0.1)

        try:
            core_received = []
            async def core_handler(plugin_id, data):
                core_received.append(data)
            server.set_core_handler(core_handler)

            await server.send_to_plugin("test.callback", {
                "type": "callback.request",
                "request_id": "cb123",
                "endpoint": "/unread-count",
                "room_id": "r1",
            })
            await asyncio.sleep(0.1)

            assert len(core_received) == 1
            resp = core_received[0]
            assert resp["type"] == "callback.response"
            assert resp["request_id"] == "cb123"
            assert resp["count"] == 7
        finally:
            await plugin._client.close()
            run_task.cancel()
            try:
                await run_task
            except asyncio.CancelledError:
                pass

    @pytest.mark.asyncio
    async def test_room_type_registration(self, bus, bus_url):
        server, _ = bus

        class ChatPlugin(SkribPlugin):
            id = "test.chat"
            version = "1.0.0"
            secret = "s"
            permissions = ["bus.send", "room_type.register"]
            room_types = ["chat"]

        plugin = ChatPlugin()
        run_task = asyncio.create_task(plugin.run(bus_url))
        await asyncio.sleep(0.2)

        try:
            assert server.room_type_map.get("chat") == "test.chat"
        finally:
            await plugin._client.close()
            run_task.cancel()
            try:
                await run_task
            except asyncio.CancelledError:
                pass

    @pytest.mark.asyncio
    async def test_multiple_decorators_on_same_class(self, bus, bus_url):
        server, _ = bus

        class MultiPlugin(SkribPlugin):
            id = "test.multi"
            version = "1.0.0"
            secret = "s"
            permissions = ["bus.send", "bus.receive"]
            events = []

            @on_room_action("action_a")
            async def handle_a(self, ctx):
                self.events.append("a")

            @on_room_action("action_b")
            async def handle_b(self, ctx):
                self.events.append("b")

            @on_lifecycle("user_joined")
            async def handle_join(self, ctx):
                self.events.append("join")

        plugin = MultiPlugin()
        run_task = asyncio.create_task(plugin.run(bus_url))
        await asyncio.sleep(0.1)

        try:
            await server.send_to_plugin("test.multi", {
                "type": "room.action", "room_id": "r1", "action": "action_a",
                "username": "u", "reply_to": "t",
            })
            await server.send_to_plugin("test.multi", {
                "type": "room.action", "room_id": "r1", "action": "action_b",
                "username": "u", "reply_to": "t",
            })
            await server.send_to_plugin("test.multi", {
                "type": "lifecycle.user_joined", "room_id": "r1", "username": "alice",
            })
            await asyncio.sleep(0.1)
            assert plugin.events == ["a", "b", "join"]
        finally:
            await plugin._client.close()
            run_task.cancel()
            try:
                await run_task
            except asyncio.CancelledError:
                pass
