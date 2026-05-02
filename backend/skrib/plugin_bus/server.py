"""Plugin Bus WebSocket server.

Accepts connections from plugin processes, handles hello handshake,
enforces permissions, rate-limits, and routes frames between core and plugins.

Uses the ``websockets`` library directly (not Starlette) since this server
runs on its own port, independent of the FastAPI app.
"""
from __future__ import annotations

import asyncio
import hmac
import json
import logging
from dataclasses import dataclass, field
from typing import Any, Callable, Awaitable

import websockets
from websockets.asyncio.server import ServerConnection

from .protocol import (
    FrameType,
    ApprovalStatus,
    VALID_PERMISSIONS,
    validate_frame,
    validate_manifest,
    check_permission,
    error_frame,
    FrameValidationError,
)
from .rate_limit import TokenBucket

logger = logging.getLogger(__name__)


# Maximum size of a single WebSocket frame on the bus. Frames larger than this
# are rejected by the ``websockets`` library before this server sees them
# (connection closes with code 1009). Advertised to plugins in ``hello_ack``.
MAX_MESSAGE_SIZE = 65536


# ---------------------------------------------------------------------------
# Connected plugin state
# ---------------------------------------------------------------------------

@dataclass
class PluginConnection:
    """State for a single connected plugin."""

    plugin_id: str
    version: str
    ws: ServerConnection
    permissions: set[str] = field(default_factory=set)
    manifest: dict = field(default_factory=dict)
    status: ApprovalStatus = ApprovalStatus.APPROVED
    rate_limiter: TokenBucket = field(default_factory=TokenBucket)

    # Registrations made by this plugin
    room_types: list[str] = field(default_factory=list)
    # room_type → {display_name, icon, description}
    room_type_meta: dict[str, dict] = field(default_factory=dict)
    published_events: list[str] = field(default_factory=list)
    subscriptions: list[str] = field(default_factory=list)
    frontend_scripts: list[str] = field(default_factory=list)
    frontend_styles: list[str] = field(default_factory=list)
    callbacks: list[str] = field(default_factory=list)
    settings_schema: list[dict] = field(default_factory=list)
    http_base_url: str | None = None


# ---------------------------------------------------------------------------
# Plugin Bus Server
# ---------------------------------------------------------------------------

class PluginBusServer:
    """WebSocket server managing plugin connections.

    Responsibilities:
    - Accept plugin connections with hello handshake
    - Validate permissions on every outgoing frame
    - Rate limit per-plugin
    - Route frames to/from core bridge
    - Track room type registrations and published events
    """

    # Connection rate limiting: max attempts per IP within window
    CONNECTION_RATE_LIMIT = 10
    CONNECTION_RATE_WINDOW = 60.0  # seconds

    def __init__(
        self,
        approve_plugin: Callable[[str, dict], Awaitable[ApprovalStatus]] | None = None,
        get_plugin_secret: Callable[[str], str | None] | None = None,
    ):
        self._plugins: dict[str, PluginConnection] = {}
        self._room_type_map: dict[str, str] = {}
        self._approve_plugin = approve_plugin or self._auto_approve
        self._get_plugin_secret = get_plugin_secret
        self._core_handler: Callable[[str, dict], Awaitable[None]] | None = None
        self._lock = asyncio.Lock()
        self._connection_attempts: dict[str, list[float]] = {}

    @staticmethod
    async def _auto_approve(plugin_id: str, manifest: dict) -> ApprovalStatus:
        return ApprovalStatus.APPROVED

    def set_core_handler(self, handler: Callable[[str, dict], Awaitable[None]]) -> None:
        """Set the callback for frames that core needs to handle."""
        self._core_handler = handler

    @property
    def plugins(self) -> dict[str, PluginConnection]:
        return dict(self._plugins)

    @property
    def room_type_map(self) -> dict[str, str]:
        return dict(self._room_type_map)

    def get_plugin(self, plugin_id: str) -> PluginConnection | None:
        return self._plugins.get(plugin_id)

    # ------------------------------------------------------------------
    # WebSocket endpoint handler
    # ------------------------------------------------------------------

    def _check_connection_rate(self, remote_ip: str) -> bool:
        """Check if a remote IP has exceeded the connection rate limit.

        Returns True if the connection should be allowed.
        """
        import time
        now = time.monotonic()
        attempts = self._connection_attempts.get(remote_ip, [])
        # Prune old entries
        cutoff = now - self.CONNECTION_RATE_WINDOW
        attempts = [t for t in attempts if t > cutoff]
        self._connection_attempts[remote_ip] = attempts

        if len(attempts) >= self.CONNECTION_RATE_LIMIT:
            return False

        attempts.append(now)
        return True

    # IPs exempt from connection rate limiting (local plugin processes)
    RATE_LIMIT_EXEMPT_IPS = {"127.0.0.1", "::1"}

    async def handle_connection(self, ws: ServerConnection) -> None:
        """Handle a single plugin WebSocket connection lifecycle.

        This is the handler passed to ``websockets.serve()``.
        """
        # Rate limit connections per IP (exempt localhost — local plugins)
        remote_ip = ws.remote_address[0] if ws.remote_address else "unknown"
        if remote_ip not in self.RATE_LIMIT_EXEMPT_IPS and not self._check_connection_rate(remote_ip):
            await self._send(ws, error_frame("rate_limited", "Too many connection attempts"))
            await ws.close(4029, "rate_limited")
            return

        conn: PluginConnection | None = None
        try:
            conn = await self._handle_hello(ws)
            if conn is None:
                return
            await self._message_loop(conn)
        except websockets.ConnectionClosed:
            if conn:
                logger.info("[PluginBus] Plugin '%s' disconnected", conn.plugin_id)
        except Exception:
            if conn:
                logger.exception("[PluginBus] Error in plugin '%s' connection", conn.plugin_id)
            else:
                logger.exception("[PluginBus] Error in unauthenticated connection")
        finally:
            if conn:
                await self._cleanup_plugin(conn)

    # ------------------------------------------------------------------
    # Hello handshake
    # ------------------------------------------------------------------

    async def _handle_hello(self, ws: ServerConnection) -> PluginConnection | None:
        try:
            raw = await asyncio.wait_for(ws.recv(), timeout=10.0)
        except asyncio.TimeoutError:
            await self._send(ws, error_frame("timeout", "Expected hello within 10 seconds"))
            await ws.close(4000, "timeout")
            return None

        try:
            data = json.loads(raw)
        except (json.JSONDecodeError, TypeError):
            await self._send(ws, error_frame("invalid_json", "Hello frame is not valid JSON"))
            await ws.close(4001, "invalid_json")
            return None

        try:
            frame_type = validate_frame(data)
        except FrameValidationError as e:
            await self._send(ws, error_frame(e.code, e.message))
            await ws.close(4001, "validation_error")
            return None

        if frame_type != FrameType.HELLO:
            await self._send(ws, error_frame("protocol_error", "First frame must be 'hello'"))
            await ws.close(4002, "protocol_error")
            return None

        plugin_id = data["plugin_id"]
        manifest = data["manifest"]
        permissions = set(manifest.get("permissions", []))
        invalid_perms = permissions - VALID_PERMISSIONS
        if invalid_perms:
            await self._send(ws, error_frame(
                "invalid_permissions",
                f"Unknown permissions: {', '.join(sorted(invalid_perms))}",
            ))
            await ws.close(4003, "invalid_permissions")
            return None

        try:
            validate_manifest(manifest)
        except FrameValidationError as e:
            await self._send(ws, error_frame(e.code, e.message))
            await ws.close(4003, "invalid_manifest")
            return None

        async with self._lock:
            if plugin_id in self._plugins:
                await self._send(ws, error_frame(
                    "already_connected",
                    f"Plugin '{plugin_id}' is already connected",
                ))
                await ws.close(4004, "already_connected")
                return None

        status = await self._approve_plugin(plugin_id, manifest)

        # Validate secret for approved plugins
        if status == ApprovalStatus.APPROVED and self._get_plugin_secret:
            expected_secret = self._get_plugin_secret(plugin_id)
            if expected_secret:
                provided_secret = data.get("secret", "")
                if not hmac.compare_digest(str(expected_secret), str(provided_secret)):
                    await self._send(ws, error_frame(
                        "invalid_secret",
                        f"Invalid secret for plugin '{plugin_id}'",
                    ))
                    await ws.close(4006, "invalid_secret")
                    return None

        conn = PluginConnection(
            plugin_id=plugin_id,
            version=data["version"],
            ws=ws,
            permissions=permissions,
            manifest=manifest,
            status=status,
            published_events=manifest.get("published_events", []),
            subscriptions=manifest.get("subscriptions", []),
            http_base_url=data.get("http_base_url"),
        )

        async with self._lock:
            self._plugins[plugin_id] = conn

        ack: dict[str, Any] = {"type": FrameType.HELLO_ACK.value, "status": status.value}
        if status == ApprovalStatus.APPROVED:
            ack["config"] = {"max_message_size": 65536}
            logger.info("[PluginBus] Plugin '%s' v%s connected and approved", plugin_id, data["version"])
        elif status == ApprovalStatus.PENDING:
            ack["message"] = "Awaiting admin approval. Plugin will activate once approved."
            logger.info("[PluginBus] Plugin '%s' connected, pending approval", plugin_id)
        else:
            ack["message"] = "Plugin has been rejected."
            logger.info("[PluginBus] Plugin '%s' rejected", plugin_id)

        await self._send(ws, ack)

        if status == ApprovalStatus.REJECTED:
            await ws.close(4005, "rejected")
            async with self._lock:
                self._plugins.pop(plugin_id, None)
            return None

        return conn

    # ------------------------------------------------------------------
    # Admin approval actions (called by API routes)
    # ------------------------------------------------------------------

    async def activate_plugin(self, plugin_id: str) -> bool:
        """Activate a pending plugin after admin approval.

        Sends an updated hello_ack with status=approved and changes the
        connection status so the plugin can start sending frames.
        Returns True if the plugin was pending and is now approved.
        """
        async with self._lock:
            conn = self._plugins.get(plugin_id)
            if not conn or conn.status != ApprovalStatus.PENDING:
                return False
            conn.status = ApprovalStatus.APPROVED

        ack = {
            "type": FrameType.HELLO_ACK.value,
            "status": ApprovalStatus.APPROVED.value,
            "config": {"max_message_size": MAX_MESSAGE_SIZE},
        }
        try:
            await self._send(conn.ws, ack)
            logger.info("[PluginBus] Plugin '%s' activated by admin", plugin_id)
            return True
        except Exception:
            logger.exception("[PluginBus] Failed to activate plugin '%s'", plugin_id)
            return False

    async def deactivate_plugin(self, plugin_id: str, reason: str = "rejected") -> bool:
        """Reject or disable a connected plugin, closing its connection.

        Returns True if the plugin was connected and has been disconnected.
        """
        conn = self._plugins.get(plugin_id)
        if not conn:
            return False

        try:
            await self._send(conn.ws, {
                "type": FrameType.HELLO_ACK.value,
                "status": ApprovalStatus.REJECTED.value,
                "message": f"Plugin has been {reason} by admin.",
            })
            await conn.ws.close(4005, reason)
        except Exception:
            pass

        await self._cleanup_plugin(conn)
        logger.info("[PluginBus] Plugin '%s' %s by admin", plugin_id, reason)
        return True

    # ------------------------------------------------------------------
    # Message loop
    # ------------------------------------------------------------------

    async def _message_loop(self, conn: PluginConnection) -> None:
        async for raw in conn.ws:
            try:
                data = json.loads(raw)
            except (json.JSONDecodeError, TypeError):
                await self._send(conn.ws, error_frame("invalid_json", "Frame is not valid JSON"))
                continue

            try:
                frame_type = validate_frame(data)
            except FrameValidationError as e:
                await self._send(conn.ws, error_frame(e.code, e.message, data.get("request_id")))
                continue

            if not conn.rate_limiter.consume():
                await self._send(conn.ws, error_frame(
                    "rate_limited",
                    f"Plugin '{conn.plugin_id}' is being rate limited",
                    data.get("request_id"),
                ))
                continue

            if conn.status == ApprovalStatus.PENDING and frame_type != FrameType.GOODBYE:
                await self._send(conn.ws, error_frame(
                    "pending_approval",
                    "Plugin is pending approval and cannot send frames",
                    data.get("request_id"),
                ))
                continue

            try:
                check_permission(frame_type, conn.permissions)
            except FrameValidationError as e:
                await self._send(conn.ws, error_frame(e.code, e.message, data.get("request_id")))
                continue

            await self._handle_frame(conn, frame_type, data)

    # ------------------------------------------------------------------
    # Frame handling
    # ------------------------------------------------------------------

    async def _handle_frame(self, conn: PluginConnection, frame_type: FrameType, data: dict) -> None:
        if frame_type == FrameType.REGISTER_ROOM_TYPE:
            await self._handle_register_room_type(conn, data)
        elif frame_type == FrameType.REGISTER_FRONTEND:
            await self._handle_register_frontend(conn, data)
        elif frame_type == FrameType.REGISTER_SETTINGS:
            await self._handle_register_settings(conn, data)
        elif frame_type == FrameType.REGISTER_CALLBACK:
            await self._handle_register_callback(conn, data)
        elif frame_type == FrameType.GOODBYE:
            await conn.ws.close(1000, "goodbye")
        else:
            if self._core_handler:
                data["_plugin_id"] = conn.plugin_id
                await self._core_handler(conn.plugin_id, data)
            else:
                await self._send(conn.ws, error_frame(
                    "no_core",
                    "Core bridge not connected",
                    data.get("request_id"),
                ))

    async def _handle_register_room_type(self, conn: PluginConnection, data: dict) -> None:
        room_type = data["room_type"]
        manifest_room_types = conn.manifest.get("room_types", [])
        if room_type not in manifest_room_types:
            await self._send(conn.ws, error_frame(
                "room_type_not_in_manifest",
                f"Room type '{room_type}' not declared in plugin manifest",
            ))
            return
        async with self._lock:
            existing = self._room_type_map.get(room_type)
            if existing and existing != conn.plugin_id:
                await self._send(conn.ws, error_frame(
                    "room_type_conflict",
                    f"Room type '{room_type}' already registered by '{existing}'",
                ))
                return
            self._room_type_map[room_type] = conn.plugin_id
            if room_type not in conn.room_types:
                conn.room_types.append(room_type)
            conn.room_type_meta[room_type] = {
                "display_name": data["display_name"],
                "icon": data.get("icon", ""),
                "description": data.get("description", ""),
            }
        logger.info("[PluginBus] Plugin '%s' registered room type '%s'", conn.plugin_id, room_type)

    async def _handle_register_frontend(self, conn: PluginConnection, data: dict) -> None:
        conn.frontend_scripts = data.get("scripts", [])
        conn.frontend_styles = data.get("styles", [])
        logger.info("[PluginBus] Plugin '%s' registered frontend assets", conn.plugin_id)

    async def _handle_register_settings(self, conn: PluginConnection, data: dict) -> None:
        conn.settings_schema = data.get("settings", [])
        logger.info("[PluginBus] Plugin '%s' registered %d settings", conn.plugin_id, len(conn.settings_schema))

    async def _handle_register_callback(self, conn: PluginConnection, data: dict) -> None:
        endpoint = data["endpoint"]
        if endpoint not in conn.callbacks:
            conn.callbacks.append(endpoint)
        logger.info("[PluginBus] Plugin '%s' registered callback '%s'", conn.plugin_id, endpoint)

    # ------------------------------------------------------------------
    # Sending frames to plugins
    # ------------------------------------------------------------------

    async def send_to_plugin(self, plugin_id: str, frame: dict) -> bool:
        """Send a frame to a specific plugin. Returns True if sent."""
        conn = self._plugins.get(plugin_id)
        if not conn or conn.status != ApprovalStatus.APPROVED:
            return False
        try:
            await self._send(conn.ws, frame)
            return True
        except Exception:
            logger.exception("[PluginBus] Failed to send to plugin '%s'", plugin_id)
            return False

    async def broadcast_to_subscribers(self, event_type: str, data: dict) -> None:
        """Send an event to all plugins subscribed to this event type.

        Event type format is ``plugin_id:event_name`` or ``core:event_name``.
        Plugin-namespaced events are only delivered if the publishing plugin
        declared the name in ``published_events``. The ``core:`` namespace is
        reserved for events emitted by core/bridge and is always allowed.
        """
        if ":" in event_type:
            source_plugin_id, event_name = event_type.split(":", 1)
            if source_plugin_id != "core":
                source_conn = self._plugins.get(source_plugin_id)
                if not source_conn or event_name not in source_conn.published_events:
                    logger.warning(
                        "[PluginBus] Dropping event '%s' — not in published_events of '%s'",
                        event_type, source_plugin_id,
                    )
                    return

        for conn in list(self._plugins.values()):
            if conn.status != ApprovalStatus.APPROVED:
                continue
            if "bus.receive" not in conn.permissions:
                continue
            for sub in conn.subscriptions:
                if event_type == sub or event_type.startswith(sub + ":"):
                    try:
                        await self._send(conn.ws, data)
                    except Exception:
                        logger.exception("[PluginBus] Failed to broadcast to '%s'", conn.plugin_id)
                    break

    # ------------------------------------------------------------------
    # Cleanup
    # ------------------------------------------------------------------

    async def _cleanup_plugin(self, conn: PluginConnection) -> None:
        async with self._lock:
            self._plugins.pop(conn.plugin_id, None)
            for rt in conn.room_types:
                if self._room_type_map.get(rt) == conn.plugin_id:
                    del self._room_type_map[rt]
        logger.info("[PluginBus] Cleaned up plugin '%s'", conn.plugin_id)

    # ------------------------------------------------------------------
    # Helpers
    # ------------------------------------------------------------------

    @staticmethod
    async def _send(ws: ServerConnection, data: dict) -> None:
        await ws.send(json.dumps(data))
