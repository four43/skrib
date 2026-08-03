"""In-process transport for the Skrib plugin SDK.

Implements the same interface as ``BusClient`` but delivers frames by direct
call instead of over a WebSocket. Because ``PluginBus``, ``CoreAPI`` and
``SkribPlugin`` all talk to their transport only through this interface, a
plugin runs unchanged in either runtime.

Trust model: an in-process plugin shares the interpreter with core, so
permissions are unenforceable and none are checked here. Only code you trust
is eligible for ``runtime: "in_process"`` — see
docs/spec/2026-08-02-extension-model.md §3.1.
"""
from __future__ import annotations

import asyncio
import logging
from typing import Awaitable, Callable

logger = logging.getLogger(__name__)

FrameSink = Callable[[str, dict], Awaitable[None]]


class InProcessClient:
    """Transport that hands plugin frames straight to the bridge."""

    def __init__(self, plugin_id: str, frame_sink: FrameSink):
        self._plugin_id = plugin_id
        self._frame_sink = frame_sink
        self._connected = False
        self._frame_handlers: dict[str, Callable[[dict], Awaitable[None]]] = {}
        self._pending: dict[str, asyncio.Future] = {}

    @property
    def connected(self) -> bool:
        return self._connected

    def on_frame(self, frame_type: str, handler: Callable[[dict], Awaitable[None]]) -> None:
        """Register a handler for a specific frame type."""
        self._frame_handlers[frame_type] = handler

    async def connect(self) -> dict:
        """No handshake is needed in-process; report an approved ack."""
        self._connected = True
        return {"type": "hello_ack", "status": "approved", "runtime": "in_process"}

    async def run(self) -> None:
        """No receive loop in-process. Frames arrive via deliver()."""
        return None

    async def run_with_reconnect(self) -> None:
        """No connection to lose in-process."""
        return None

    async def send(self, frame: dict) -> None:
        """Hand an outbound frame to core."""
        if not self._connected:
            raise RuntimeError("Not connected to bus server")
        await self._frame_sink(self._plugin_id, frame)

    async def request(self, frame: dict, timeout: float = 10.0) -> dict:
        """Send a frame and wait for a correlated response."""
        request_id = frame.get("request_id")
        if not request_id:
            raise ValueError("Frame must include 'request_id' for request/response")

        future: asyncio.Future[dict] = asyncio.get_running_loop().create_future()
        self._pending[request_id] = future

        try:
            await self.send(frame)
            return await asyncio.wait_for(future, timeout=timeout)
        except asyncio.TimeoutError:
            self._pending.pop(request_id, None)
            raise TimeoutError(
                f"No response for request_id={request_id} within {timeout}s"
            )

    async def deliver(self, frame: dict) -> None:
        """Deliver a core→plugin frame. Mirrors BusClient's receive-loop logic."""
        request_id = frame.get("request_id")
        if request_id and request_id in self._pending:
            future = self._pending.pop(request_id)
            if not future.done():
                future.set_result(frame)
            return

        handler = self._frame_handlers.get(frame.get("type", ""))
        if handler is None:
            logger.debug(
                "[SDK:inprocess] No handler for frame type '%s'", frame.get("type")
            )
            return
        try:
            await handler(frame)
        except Exception:
            logger.exception(
                "[SDK:inprocess] Error in handler for '%s'", frame.get("type")
            )

    async def close(self) -> None:
        """Drop pending requests and mark disconnected."""
        self._connected = False
        for future in self._pending.values():
            if not future.done():
                future.cancel()
        self._pending.clear()
