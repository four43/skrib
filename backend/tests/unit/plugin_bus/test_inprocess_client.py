"""InProcessClient must satisfy the same contract as BusClient."""
import asyncio

import pytest

from skrib_plugin_sdk.inprocess import InProcessClient


@pytest.mark.asyncio
async def test_send_reaches_the_frame_sink():
    """Outbound frames are handed to the sink with the plugin id."""
    seen = []

    async def sink(plugin_id, frame):
        seen.append((plugin_id, frame))

    client = InProcessClient("test.plugin", sink)
    await client.connect()
    await client.send({"type": "bus.notify_user", "username": "alice"})

    assert seen == [("test.plugin", {"type": "bus.notify_user", "username": "alice"})]


@pytest.mark.asyncio
async def test_deliver_dispatches_to_registered_handler():
    """Inbound frames go to the handler registered for their type."""
    async def sink(plugin_id, frame):
        pass

    received = []
    client = InProcessClient("test.plugin", sink)
    client.on_frame("room.action", lambda f: _collect(received, f))
    await client.connect()

    await client.deliver({"type": "room.action", "action": "message"})

    assert received == [{"type": "room.action", "action": "message"}]


async def _collect(bucket, frame):
    bucket.append(frame)


@pytest.mark.asyncio
async def test_request_resolves_when_response_is_delivered():
    """request() blocks until a frame with the matching request_id arrives."""
    client = InProcessClient("test.plugin", None)

    async def sink(plugin_id, frame):
        # Simulate core answering asynchronously.
        asyncio.get_running_loop().call_soon(
            asyncio.create_task,
            client.deliver({
                "type": "core_api.response",
                "request_id": frame["request_id"],
                "result": {"alice": "all"},
            }),
        )

    client._frame_sink = sink
    await client.connect()

    response = await client.request(
        {"type": "core_api.request", "request_id": "abc123", "method": "get_notify_levels"}
    )

    assert response["result"] == {"alice": "all"}


@pytest.mark.asyncio
async def test_request_without_request_id_raises():
    """Matches BusClient: a request frame must carry a request_id."""
    async def sink(plugin_id, frame):
        pass

    client = InProcessClient("test.plugin", sink)
    await client.connect()

    with pytest.raises(ValueError, match="request_id"):
        await client.request({"type": "core_api.request"})


@pytest.mark.asyncio
async def test_request_times_out_when_no_response_arrives():
    """A dropped response surfaces as TimeoutError, not a hang."""
    async def sink(plugin_id, frame):
        pass

    client = InProcessClient("test.plugin", sink)
    await client.connect()

    with pytest.raises(TimeoutError):
        await client.request(
            {"type": "core_api.request", "request_id": "never"}, timeout=0.05
        )


@pytest.mark.asyncio
async def test_send_before_connect_raises():
    """Matches BusClient's guard against sending on a dead transport."""
    async def sink(plugin_id, frame):
        pass

    client = InProcessClient("test.plugin", sink)

    with pytest.raises(RuntimeError, match="Not connected"):
        await client.send({"type": "bus.notify_all"})
