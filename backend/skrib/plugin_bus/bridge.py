"""Core-side bus bridge — translates between the plugin bus and the WebSocket manager.

The bridge registers itself as the core handler on the PluginBusServer and
translates plugin frames into calls on the UnifiedConnectionManager (and vice
versa). It also handles core_api.request frames by calling CoreAPI methods and
sending responses back to plugins.

Lifecycle events (room created/deleted, user joined/left) are forwarded from
core → plugin via the bus server.
"""
from __future__ import annotations

import asyncio
import logging
from typing import TYPE_CHECKING

from .protocol import (
    FrameType,
    FrameValidationError,
    make_request_id,
    validate_identifier,
    SAFE_SUBSCRIPTION_RE,
    error_frame,
)

if TYPE_CHECKING:
    from .server import PluginBusServer
    from ..ws.manager import UnifiedConnectionManager
    from ..plugins.core_api import CoreAPI

logger = logging.getLogger(__name__)


class PluginBusBridge:
    """Bridges the plugin bus server with core's WebSocket manager and CoreAPI.

    Responsibilities:
    - Receives plugin→core frames and translates them into UnifiedConnectionManager calls
    - Sends core→plugin frames (room actions, lifecycle events, callbacks)
    - Translates core_api.request frames into CoreAPI calls and sends responses
    """

    def __init__(
        self,
        bus_server: PluginBusServer,
        ws_manager: UnifiedConnectionManager,
        core_api: CoreAPI,
    ):
        self._server = bus_server
        self._ws = ws_manager
        self._core_api = core_api
        self._pending_callbacks: dict[str, asyncio.Future] = {}

        # Register ourselves as the core handler on the bus server
        self._server.set_core_handler(self._handle_plugin_frame)

        # Register event listeners on the WS manager for lifecycle events
        self._ws.on_event("core:room_created", self._on_room_created)
        self._ws.on_event("core:room_deleted", self._on_room_deleted)
        self._ws.on_event("core:user_joined_room", self._on_user_joined)
        self._ws.on_event("core:user_left_room", self._on_user_left)

    def teardown(self):
        """Remove event listeners."""
        self._ws.off_event("core:room_created", self._on_room_created)
        self._ws.off_event("core:room_deleted", self._on_room_deleted)
        self._ws.off_event("core:user_joined_room", self._on_user_joined)
        self._ws.off_event("core:user_left_room", self._on_user_left)

    # ------------------------------------------------------------------
    # Plugin → Core frame handler (called by PluginBusServer)
    # ------------------------------------------------------------------

    async def _handle_plugin_frame(self, plugin_id: str, data: dict) -> None:
        """Handle a frame from a plugin that the bus server routes to core."""
        frame_type = data.get("type")

        try:
            if frame_type == FrameType.BUS_BROADCAST_ROOM.value:
                await self._handle_broadcast_room(plugin_id, data)
            elif frame_type == FrameType.BUS_NOTIFY_USER.value:
                await self._handle_notify_user(plugin_id, data)
            elif frame_type == FrameType.BUS_NOTIFY_ALL.value:
                await self._handle_notify_all(plugin_id, data)
            elif frame_type == FrameType.BUS_REPLY.value:
                await self._handle_reply(plugin_id, data)
            elif frame_type == FrameType.BUS_EMIT_EVENT.value:
                await self._handle_emit_event(plugin_id, data)
            elif frame_type == FrameType.CORE_API_REQUEST.value:
                await self._handle_core_api_request(plugin_id, data)
            elif frame_type == FrameType.CALLBACK_RESPONSE.value:
                await self._handle_callback_response(plugin_id, data)
            else:
                logger.warning("[Bridge] Unhandled frame type '%s' from plugin '%s'", frame_type, plugin_id)
        except FrameValidationError as e:
            await self._server.send_to_plugin(plugin_id, error_frame(e.code, e.message, data.get("request_id")))

    # ------------------------------------------------------------------
    # Bus operations: plugin → client WebSockets
    # ------------------------------------------------------------------

    def _validate_action(self, data: dict) -> str:
        """Validate and return the action field from a frame."""
        action = data["action"]
        validate_identifier(action, "action")
        return action

    async def _handle_broadcast_room(self, plugin_id: str, data: dict) -> None:
        room_id = data["room_id"]
        action = self._validate_action(data)
        exclude_user = data.get("exclude_user")
        # Build the client-facing message with plugin namespace
        message = {
            "type": f"{plugin_id}:{action}",
            "room_id": room_id,
            **{k: v for k, v in data.items()
               if k not in ("type", "room_id", "action", "exclude_user", "_plugin_id", "request_id")},
        }
        await self._ws.broadcast_to_room(room_id, message, exclude_user=exclude_user)

    async def _handle_notify_user(self, plugin_id: str, data: dict) -> None:
        username = data["username"]
        action = self._validate_action(data)
        message = {
            "type": f"{plugin_id}:{action}",
            **{k: v for k, v in data.items()
               if k not in ("type", "username", "action", "_plugin_id", "request_id")},
        }
        await self._ws.notify_user(username, message)

    async def _handle_notify_all(self, plugin_id: str, data: dict) -> None:
        action = self._validate_action(data)
        message = {
            "type": f"{plugin_id}:{action}",
            **{k: v for k, v in data.items()
               if k not in ("type", "action", "_plugin_id", "request_id")},
        }
        await self._ws.notify_all_users(message)

    async def _handle_reply(self, plugin_id: str, data: dict) -> None:
        reply_to = data["reply_to"]
        action = self._validate_action(data)
        message = {
            "type": f"{plugin_id}:{action}",
            **{k: v for k, v in data.items()
               if k not in ("type", "reply_to", "action", "_plugin_id", "request_id")},
        }
        await self._ws.send_reply(reply_to, message)

    async def _handle_emit_event(self, plugin_id: str, data: dict) -> None:
        raw_event_type = data["event_type"]
        if not isinstance(raw_event_type, str) or not SAFE_SUBSCRIPTION_RE.match(raw_event_type):
            raise FrameValidationError(
                f"Invalid event_type: {raw_event_type!r}",
                code="invalid_event_type",
            )

        # Bare event names are auto-namespaced. Pre-namespaced names pass through
        # only if the prefix is the plugin's own id or the privileged "core" namespace —
        # plugins cannot emit into other plugins' namespaces.
        if ":" in raw_event_type:
            prefix = raw_event_type.split(":", 1)[0]
            if prefix not in (plugin_id, "core"):
                raise FrameValidationError(
                    f"Plugin '{plugin_id}' cannot emit into namespace '{prefix}'",
                    code="namespace_forbidden",
                )
            full_event_type = raw_event_type
        else:
            full_event_type = f"{plugin_id}:{raw_event_type}"

        payload_fields = {k: v for k, v in data.items()
                          if k not in ("type", "event_type", "_plugin_id", "request_id")}
        await self._ws.emit_event({"type": full_event_type, **payload_fields})
        await self._server.broadcast_to_subscribers(
            full_event_type,
            {"type": FrameType.EVENT.value, "event_type": full_event_type, **payload_fields},
        )

    # ------------------------------------------------------------------
    # CoreAPI: plugin requests core data
    # ------------------------------------------------------------------

    async def _handle_core_api_request(self, plugin_id: str, data: dict) -> None:
        request_id = data["request_id"]
        method = data["method"]
        params = data.get("params", {})

        try:
            result = await self._call_core_api(method, params)
            response = {
                "type": FrameType.CORE_API_RESPONSE.value,
                "request_id": request_id,
                "result": result,
            }
        except Exception as e:
            response = {
                "type": FrameType.CORE_API_RESPONSE.value,
                "request_id": request_id,
                "error": str(e),
            }

        await self._server.send_to_plugin(plugin_id, response)

    async def _call_core_api(self, method: str, params: dict):
        """Dispatch a core_api method call."""
        if method == "get_room_members":
            return self._core_api.get_room_members(params["room_id"])
        elif method == "get_room_info":
            return self._core_api.get_room_info(params["room_id"])
        elif method == "get_notify_level":
            return self._core_api.get_notify_level(params["room_id"], params["username"])
        elif method == "get_notify_levels":
            return self._core_api.get_notify_levels(params["room_id"])
        elif method == "get_unread_count":
            return await self._core_api.get_unread_count(params["room_id"], params["username"])
        elif method == "mark_room_read":
            self._core_api.mark_room_read(params["room_id"], params["username"], params["message_id"])
            return {"ok": True}
        elif method == "is_user_connected":
            return self._core_api.is_user_connected(params["username"])
        else:
            raise ValueError(f"Unknown core_api method: {method}")

    # ------------------------------------------------------------------
    # Callback responses from plugins
    # ------------------------------------------------------------------

    async def _handle_callback_response(self, plugin_id: str, data: dict) -> None:
        request_id = data["request_id"]
        future = self._pending_callbacks.pop(request_id, None)
        if future and not future.done():
            future.set_result(data.get("result"))

    async def send_callback(self, plugin_id: str, endpoint: str, payload: dict, timeout: float = 5.0):
        """Send a callback request to a plugin and await its response."""
        request_id = make_request_id()
        future = asyncio.get_running_loop().create_future()
        self._pending_callbacks[request_id] = future

        frame = {
            "type": FrameType.CALLBACK_REQUEST.value,
            "request_id": request_id,
            "endpoint": endpoint,
            "data": payload,
        }
        sent = await self._server.send_to_plugin(plugin_id, frame)
        if not sent:
            self._pending_callbacks.pop(request_id, None)
            return None

        try:
            return await asyncio.wait_for(future, timeout=timeout)
        except asyncio.TimeoutError:
            self._pending_callbacks.pop(request_id, None)
            logger.warning("[Bridge] Callback '%s' to '%s' timed out", endpoint, plugin_id)
            return None

    # ------------------------------------------------------------------
    # Core → Plugin: dispatch room actions to bus-connected plugins
    # ------------------------------------------------------------------

    async def dispatch_room_action(
        self,
        plugin_id: str,
        room_id: str,
        action: str,
        username: str,
        msg: dict,
        reply_to: str,
        user_role: str,
        room_role: str | None,
    ) -> bool:
        """Send a room action to a bus-connected plugin. Returns True if sent."""
        frame = {
            "type": FrameType.ROOM_ACTION.value,
            "room_id": room_id,
            "action": action,
            "username": username,
            "reply_to": reply_to,
            "user_role": user_role,
            "room_role": room_role or "",
            "data": msg,
        }
        return await self._server.send_to_plugin(plugin_id, frame)

    # ------------------------------------------------------------------
    # Core → Plugin: lifecycle events
    # ------------------------------------------------------------------

    async def _broadcast_core_event(self, event_name: str, payload: dict) -> None:
        """Deliver a ``core:*`` event to feature plugins that subscribed to it.

        The room-type owner receives the typed ``lifecycle.*`` frame separately;
        this is how everyone else (attachments, etc.) hears about lifecycle changes.
        """
        await self._server.broadcast_to_subscribers(
            f"core:{event_name}",
            {"type": FrameType.EVENT.value, "event_type": f"core:{event_name}", **payload},
        )

    async def _on_room_created(self, event: dict) -> None:
        room_id = event.get("room_id")
        room_type = event.get("room_type")
        creator = event.get("creator")
        if not room_id or not room_type:
            return
        # Typed lifecycle frame to the room-type owner
        plugin_id = self._server.room_type_map.get(room_type)
        if plugin_id:
            await self._server.send_to_plugin(plugin_id, {
                "type": FrameType.LIFECYCLE_ROOM_CREATED.value,
                "room_id": room_id,
                "room_type": room_type,
                "creator": creator or "",
            })
        # Generic event for feature plugins subscribed to "core:room_created"
        await self._broadcast_core_event("room_created", {
            "room_id": room_id, "room_type": room_type, "creator": creator or "",
        })

    async def _on_room_deleted(self, event: dict) -> None:
        room_id = event.get("room_id")
        room_type = event.get("room_type")
        if not room_id or not room_type:
            return
        plugin_id = self._server.room_type_map.get(room_type)
        if plugin_id:
            await self._server.send_to_plugin(plugin_id, {
                "type": FrameType.LIFECYCLE_ROOM_DELETED.value,
                "room_id": room_id,
                "room_type": room_type,
            })
        await self._broadcast_core_event("room_deleted", {
            "room_id": room_id, "room_type": room_type,
        })

    async def _on_user_joined(self, event: dict) -> None:
        room_id = event.get("room_id")
        username = event.get("username")
        room_type = event.get("room_type")
        if not room_id or not username:
            return
        if room_type:
            plugin_id = self._server.room_type_map.get(room_type)
            if plugin_id:
                await self._server.send_to_plugin(plugin_id, {
                    "type": FrameType.LIFECYCLE_USER_JOINED.value,
                    "room_id": room_id,
                    "username": username,
                })
        await self._broadcast_core_event("user_joined", {
            "room_id": room_id, "username": username,
            "room_type": room_type or "",
        })

    async def _on_user_left(self, event: dict) -> None:
        room_id = event.get("room_id")
        username = event.get("username")
        room_type = event.get("room_type")
        if not room_id or not username:
            return
        if room_type:
            plugin_id = self._server.room_type_map.get(room_type)
            if plugin_id:
                await self._server.send_to_plugin(plugin_id, {
                    "type": FrameType.LIFECYCLE_USER_LEFT.value,
                    "room_id": room_id,
                    "username": username,
                })
        await self._broadcast_core_event("user_left", {
            "room_id": room_id, "username": username,
            "room_type": room_type or "",
        })

    # ------------------------------------------------------------------
    # Query helpers for handlers.py
    # ------------------------------------------------------------------

    def get_bus_plugin_for_room_type(self, room_type: str) -> str | None:
        """Return plugin_id if a bus-connected plugin handles this room type."""
        return self._server.room_type_map.get(room_type)
