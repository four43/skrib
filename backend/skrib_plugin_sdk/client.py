"""WebSocket client for connecting to the Skrib plugin bus.

Handles connection, hello handshake, reconnection with exponential backoff,
frame dispatch to registered handlers, and request/response correlation.
"""
from __future__ import annotations

import asyncio
import json
import logging
from typing import Any, Callable, Awaitable

import websockets
from websockets.asyncio.client import ClientConnection

logger = logging.getLogger(__name__)

# Reconnection parameters
INITIAL_BACKOFF = 1.0
MAX_BACKOFF = 30.0
BACKOFF_MULTIPLIER = 2.0


class BusClient:
    """WebSocket client that connects a plugin to the bus server."""

    def __init__(
        self,
        bus_url: str,
        plugin_id: str,
        version: str,
        secret: str,
        manifest: dict,
        http_base_url: str | None = None,
        on_connect_callback: Callable[[], Awaitable[None]] | None = None,
    ):
        self._bus_url = bus_url
        self._plugin_id = plugin_id
        self._version = version
        self._secret = secret
        self._manifest = manifest
        self._http_base_url = http_base_url
        self._on_connect_callback = on_connect_callback

        self._ws: ClientConnection | None = None
        self._connected = asyncio.Event()
        self._closing = False

        # Handler registries
        self._frame_handlers: dict[str, Callable[[dict], Awaitable[None]]] = {}
        # Pending request/response correlation
        self._pending: dict[str, asyncio.Future] = {}

    @property
    def connected(self) -> bool:
        return self._connected.is_set()

    def on_frame(self, frame_type: str, handler: Callable[[dict], Awaitable[None]]) -> None:
        """Register a handler for a specific frame type."""
        self._frame_handlers[frame_type] = handler

    async def connect(self) -> dict:
        """Connect to the bus server and perform the hello handshake.

        Returns the hello_ack data dict.
        Raises ConnectionError if handshake fails.
        """
        self._closing = False
        self._ws = await websockets.connect(self._bus_url)

        hello = {
            "type": "hello",
            "plugin_id": self._plugin_id,
            "version": self._version,
            "secret": self._secret,
            "manifest": self._manifest,
        }
        if self._http_base_url:
            hello["http_base_url"] = self._http_base_url

        await self._ws.send(json.dumps(hello))

        raw = await self._ws.recv()
        ack = json.loads(raw)

        if ack.get("type") == "error":
            await self._ws.close()
            raise ConnectionError(f"Bus rejected hello: {ack.get('message')}")

        if ack.get("type") != "hello_ack":
            await self._ws.close()
            raise ConnectionError(f"Unexpected response: {ack.get('type')}")

        if ack.get("status") == "rejected":
            await self._ws.close()
            raise ConnectionError("Plugin was rejected by the bus server")

        self._connected.set()
        print(f"[Plugins] {self._plugin_id} connected to bus (status: {ack.get('status')})")
        return ack

    async def run(self) -> None:
        """Run the receive loop. Dispatches incoming frames to handlers.

        Call this after connect(). Blocks until disconnected.
        """
        if not self._ws:
            raise RuntimeError("Not connected — call connect() first")

        try:
            async for raw in self._ws:
                try:
                    data = json.loads(raw)
                except json.JSONDecodeError:
                    logger.warning("[SDK] Received non-JSON frame, ignoring")
                    continue

                frame_type = data.get("type", "")
                request_id = data.get("request_id")

                # Check if this is a response to a pending request
                if request_id and request_id in self._pending:
                    future = self._pending.pop(request_id)
                    if not future.done():
                        future.set_result(data)
                    continue

                # Dispatch to registered handler
                handler = self._frame_handlers.get(frame_type)
                if handler:
                    try:
                        await handler(data)
                    except Exception:
                        logger.exception("[SDK] Error in handler for '%s'", frame_type)
                else:
                    logger.debug("[SDK] No handler for frame type '%s'", frame_type)

        except websockets.ConnectionClosed:
            logger.info("[SDK] Connection closed")
        finally:
            self._connected.clear()

    async def run_with_reconnect(self) -> None:
        """Connect and run with automatic reconnection on disconnect."""
        backoff = INITIAL_BACKOFF
        while not self._closing:
            try:
                ack = await self.connect()
                if ack.get("status") != "approved":
                    logger.warning("[SDK] Plugin '%s' not approved (status=%s)",
                                   self._plugin_id, ack.get("status"))
                    await self.close()
                    return
                backoff = INITIAL_BACKOFF  # Reset on successful connect
                if self._on_connect_callback:
                    await self._on_connect_callback()
                await self.run()
            except (ConnectionError, OSError, websockets.ConnectionClosed) as e:
                if self._closing:
                    break
                print(f"[Plugins] {self._plugin_id} disconnected ({e}), reconnecting in {backoff:.1f}s")
                await asyncio.sleep(backoff)
                backoff = min(backoff * BACKOFF_MULTIPLIER, MAX_BACKOFF)

    async def send(self, frame: dict) -> None:
        """Send a frame to the bus server."""
        if not self._ws or not self._connected.is_set():
            raise RuntimeError("Not connected to bus server")
        await self._ws.send(json.dumps(frame))

    async def request(self, frame: dict, timeout: float = 10.0) -> dict:
        """Send a frame and wait for a correlated response.

        The frame must include a ``request_id``. Returns the response dict.
        """
        request_id = frame.get("request_id")
        if not request_id:
            raise ValueError("Frame must include 'request_id' for request/response")

        future: asyncio.Future[dict] = asyncio.get_event_loop().create_future()
        self._pending[request_id] = future

        try:
            await self.send(frame)
            return await asyncio.wait_for(future, timeout=timeout)
        except asyncio.TimeoutError:
            self._pending.pop(request_id, None)
            raise TimeoutError(f"No response for request_id={request_id} within {timeout}s")

    async def close(self) -> None:
        """Gracefully close the connection."""
        self._closing = True
        self._connected.clear()
        if self._ws:
            try:
                await self._ws.send(json.dumps({"type": "goodbye"}))
                await self._ws.close()
            except Exception:
                pass
            self._ws = None

        # Cancel pending requests
        for future in self._pending.values():
            if not future.done():
                future.cancel()
        self._pending.clear()
