"""Unified WebSocket connection manager.

Replaces both ConnectionManager (per-room) and ListSubscriptionManager (per-user)
with a single bus that handles namespaced message routing.
"""
import json
import uuid
from typing import Callable, Dict, Set, Awaitable
from fastapi import WebSocket


class UnifiedConnectionManager:
    """Single WebSocket bus for all real-time communication.

    Tracks two scopes:
    - User connections: every socket a user has open (for user-scoped events like room.update)
    - Room subscriptions: sockets that sent room.join for a specific room (for room-scoped events)
    """

    def __init__(self):
        # user-level: username -> set of WebSocket
        self.user_connections: Dict[str, Set[WebSocket]] = {}
        # room-level: room_id -> set of WebSocket
        self.room_subscriptions: Dict[str, Set[WebSocket]] = {}
        # reverse lookups for cleanup
        self.ws_to_user: Dict[WebSocket, str] = {}
        self.ws_to_rooms: Dict[WebSocket, Set[str]] = {}
        # namespace -> async handler(bus, ws, username, msg)
        self.namespace_handlers: Dict[str, Callable[..., Awaitable]] = {}
        # event_type -> list of async callbacks for cross-namespace listening
        self.event_listeners: Dict[str, list[Callable[[dict], Awaitable]]] = {}
        # reply_token -> WebSocket (for plugin reply-to pattern)
        self._reply_tokens: Dict[str, WebSocket] = {}

    def register_namespace(self, namespace: str, handler: Callable[..., Awaitable]):
        """Register an async handler for a message namespace (e.g. 'system', 'room')."""
        self.namespace_handlers[namespace] = handler

    def on_event(self, event_type: str, callback: Callable[[dict], Awaitable]):
        """Register a callback to be notified when an event of this type is broadcast.

        This allows plugins to observe events from other namespaces without
        intercepting the message flow.

        Args:
            event_type: The message type (e.g., "room.message", "typing.start")
            callback: Async function(event_data: dict) to call
        """
        if event_type not in self.event_listeners:
            self.event_listeners[event_type] = []
        self.event_listeners[event_type].append(callback)

    def off_event(self, event_type: str, callback: Callable[[dict], Awaitable]):
        """Remove a previously registered event listener."""
        listeners = self.event_listeners.get(event_type)
        if listeners:
            try:
                listeners.remove(callback)
            except ValueError:
                pass
            if not listeners:
                del self.event_listeners[event_type]

    async def _trigger_event_listeners(self, message: dict):
        """Notify all registered listeners for this message type.

        Args:
            message: The message dict being broadcast
        """
        event_type = message.get("type")
        if event_type and event_type in self.event_listeners:
            for callback in self.event_listeners[event_type]:
                try:
                    await callback(message)
                except Exception as e:
                    print(f"[WS] Error in event listener for {event_type}: {e}")

    def connect(self, ws: WebSocket, username: str):
        """Register a new authenticated WebSocket connection."""
        self.ws_to_user[ws] = username
        self.ws_to_rooms[ws] = set()
        if username not in self.user_connections:
            self.user_connections[username] = set()
        self.user_connections[username].add(ws)
        print(f"[WS] {username} connected. Total sockets: {len(self.user_connections[username])}")

    def disconnect(self, ws: WebSocket):
        """Clean up a disconnected WebSocket."""
        username = self.ws_to_user.pop(ws, None)
        if not username:
            return

        # Remove from user connections
        if username in self.user_connections:
            self.user_connections[username].discard(ws)
            if not self.user_connections[username]:
                del self.user_connections[username]

        # Remove from all room subscriptions
        for room_id in self.ws_to_rooms.pop(ws, set()):
            if room_id in self.room_subscriptions:
                self.room_subscriptions[room_id].discard(ws)
                if not self.room_subscriptions[room_id]:
                    del self.room_subscriptions[room_id]

        print(f"[WS] {username} disconnected.")

    def join_room(self, ws: WebSocket, room_id: str):
        """Subscribe a socket to room-scoped broadcasts."""
        if room_id not in self.room_subscriptions:
            self.room_subscriptions[room_id] = set()
        self.room_subscriptions[room_id].add(ws)
        self.ws_to_rooms.setdefault(ws, set()).add(room_id)

    def leave_room(self, ws: WebSocket, room_id: str):
        """Unsubscribe a socket from room-scoped broadcasts."""
        if room_id in self.room_subscriptions:
            self.room_subscriptions[room_id].discard(ws)
            if not self.room_subscriptions[room_id]:
                del self.room_subscriptions[room_id]
        rooms = self.ws_to_rooms.get(ws)
        if rooms:
            rooms.discard(room_id)

    async def broadcast_to_room(self, room_id: str, message: dict, exclude_user: str = None):
        """Send a message to all sockets subscribed to a room."""
        sockets = self.room_subscriptions.get(room_id, set()).copy()
        disconnected = []
        for ws in sockets:
            if exclude_user and self.ws_to_user.get(ws) == exclude_user:
                continue
            try:
                await ws.send_json(message)
            except Exception:
                disconnected.append(ws)
        for ws in disconnected:
            self.disconnect(ws)

        # Trigger event listeners (for plugins to observe)
        await self._trigger_event_listeners(message)

    async def notify_user(self, username: str, message: dict):
        """Send a message to all of a user's sockets (user-scoped)."""
        sockets = self.user_connections.get(username, set()).copy()
        disconnected = []
        for ws in sockets:
            try:
                await ws.send_json(message)
            except Exception:
                disconnected.append(ws)
        for ws in disconnected:
            self.disconnect(ws)

        # Trigger event listeners (for plugins to observe)
        await self._trigger_event_listeners(message)

    async def notify_all_users(self, message: dict):
        """Send a message to every connected user."""
        for username in list(self.user_connections.keys()):
            await self.notify_user(username, message)

    async def emit_event(self, event_data: dict):
        """Emit an internal event to listeners without broadcasting to WebSocket clients.

        Used for lifecycle events (core:room_created, core:room_deleted, etc.)
        that plugins need to observe but clients don't need to receive directly.
        """
        await self._trigger_event_listeners(event_data)

    # --- Reply Token API ---

    def create_reply_token(self, ws: WebSocket) -> str:
        """Create an opaque reply token for a WebSocket connection.

        Plugins use the token with PluginBus.send_error() instead of
        accessing the raw WebSocket directly.
        """
        token = uuid.uuid4().hex
        self._reply_tokens[token] = ws
        return token

    def invalidate_reply_token(self, token: str):
        """Remove a reply token after the handler completes."""
        self._reply_tokens.pop(token, None)

    async def send_reply(self, token: str, message: dict):
        """Send a message to the WebSocket associated with a reply token."""
        ws = self._reply_tokens.get(token)
        if ws:
            try:
                await ws.send_json(message)
            except Exception:
                self.disconnect(ws)

    async def dispatch(self, ws: WebSocket, username: str, raw: str):
        """Parse incoming JSON and route to the appropriate namespace handler."""
        try:
            msg = json.loads(raw)
        except json.JSONDecodeError:
            await ws.send_json({"type": "system:error", "message": "Invalid JSON"})
            return

        msg_type = msg.get("type", "")
        parts = msg_type.split(":", 1)
        if len(parts) != 2:
            await ws.send_json({"type": "system:error", "message": f"Invalid message type: {msg_type}"})
            return

        namespace = parts[0]
        handler = self.namespace_handlers.get(namespace)
        if not handler:
            await ws.send_json({"type": "system:error", "message": f"Unknown namespace: {namespace}"})
            return

        await handler(self, ws, username, msg)
