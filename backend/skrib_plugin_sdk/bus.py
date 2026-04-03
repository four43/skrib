"""PluginBus — high-level methods for sending frames to core.

Wraps the raw WebSocket client with typed, namespaced methods.
"""
from __future__ import annotations

from typing import Any, TYPE_CHECKING

if TYPE_CHECKING:
    from .client import BusClient


class PluginBus:
    """Scoped bus for a connected plugin. All actions are auto-namespaced."""

    def __init__(self, client: BusClient, plugin_id: str):
        self._client = client
        self._plugin_id = plugin_id

    async def broadcast_to_room(
        self,
        room_id: str,
        action: str,
        *,
        exclude_user: str | None = None,
        **fields: Any,
    ) -> None:
        """Broadcast a message to all clients in a room."""
        frame: dict[str, Any] = {
            "type": "bus.broadcast_room",
            "room_id": room_id,
            "action": action,
            **fields,
        }
        if exclude_user:
            frame["exclude_user"] = exclude_user
        await self._client.send(frame)

    async def notify_user(self, username: str, action: str, **fields: Any) -> None:
        """Send a message to all of a user's connected sockets."""
        await self._client.send({
            "type": "bus.notify_user",
            "username": username,
            "action": action,
            **fields,
        })

    async def notify_all(self, action: str, **fields: Any) -> None:
        """Send a message to every connected user."""
        await self._client.send({
            "type": "bus.notify_all",
            "action": action,
            **fields,
        })

    async def reply(self, reply_to: str, action: str, **fields: Any) -> None:
        """Reply to a specific client via reply token."""
        await self._client.send({
            "type": "bus.reply",
            "reply_to": reply_to,
            "action": action,
            **fields,
        })

    async def send_error(self, reply_to: str, message: str, room_id: str = "") -> None:
        """Send an error reply to a specific client."""
        await self.reply(reply_to, "error", message=message, room_id=room_id)

    async def emit_event(self, event_type: str | dict, **fields: Any) -> None:
        """Emit an internal event to subscribed plugins.

        Accepts either an event_type string or a dict with a "type" key
        (for compatibility with in-process emit_event calls).
        """
        if isinstance(event_type, dict):
            # In-process compatibility: emit_event({"type": "core:foo", ...})
            event_data = event_type
            et = event_data.pop("type", "")
            await self._client.send({
                "type": "bus.emit_event",
                "event_type": et,
                **event_data,
            })
        else:
            await self._client.send({
                "type": "bus.emit_event",
                "event_type": f"{self._plugin_id}:{event_type}",
                **fields,
            })
