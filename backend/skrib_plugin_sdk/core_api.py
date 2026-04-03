"""CoreAPI client for out-of-process plugins.

Sends core_api.request frames over the bus and awaits responses.
Provides the same method signatures as the in-process CoreAPI class.
"""
from __future__ import annotations

import uuid
from typing import TYPE_CHECKING, Optional

if TYPE_CHECKING:
    from .client import BusClient


class CoreAPI:
    """Client that sends core_api.request frames over the plugin bus."""

    def __init__(self, client: BusClient):
        self._client = client

    async def _call(self, method: str, **params) -> dict:
        """Send a core_api.request and await the response."""
        request_id = uuid.uuid4().hex[:12]
        frame = {
            "type": "core_api.request",
            "method": method,
            "request_id": request_id,
            "params": params,
        }
        response = await self._client.request(frame, timeout=10.0)
        if "error" in response:
            raise RuntimeError(f"CoreAPI error: {response['error']}")
        return response.get("result")

    async def get_room_members(self, room_id: str) -> list[str]:
        return await self._call("get_room_members", room_id=room_id)

    async def get_room_info(self, room_id: str) -> Optional[dict]:
        return await self._call("get_room_info", room_id=room_id)

    async def get_notify_level(self, room_id: str, username: str) -> str:
        return await self._call("get_notify_level", room_id=room_id, username=username)

    async def get_unread_count(self, room_id: str, username: str) -> int:
        return await self._call("get_unread_count", room_id=room_id, username=username)

    async def mark_room_read(self, room_id: str, username: str, message_id: int):
        await self._call("mark_room_read", room_id=room_id, username=username, message_id=message_id)

    async def is_user_connected(self, username: str) -> bool:
        return await self._call("is_user_connected", username=username)
