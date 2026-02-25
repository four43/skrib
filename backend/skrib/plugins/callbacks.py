"""Plugin callback dispatcher — core calls plugins via defined callback interface.

Instead of core calling plugin Python methods directly (e.g., plugin.get_unread_count()),
plugins register callback handlers that core invokes through this dispatcher.
In-process: direct function calls. Out-of-process: would be HTTP POST to plugin endpoints.

Callback endpoints plugins can implement:
    POST /unread-count       {room_id, since_message_id} -> {count: int}
    POST /unread-counts-batch  {room_positions: {room_id: since_id}} -> {room_id: count}
    POST /intercept-message  {message_data} -> {message_data} or null
    GET  /health             -> 200 OK
"""
from typing import Optional


class PluginCallbacks:
    """Registry of plugin callback handlers that core can invoke."""

    def __init__(self, plugin):
        self._plugin = plugin
        self._handlers = {}

    def register(self, endpoint: str, handler):
        """Register a callback handler for a given endpoint."""
        self._handlers[endpoint] = handler

    async def invoke(self, endpoint: str, data: dict = None) -> Optional[dict]:
        """Invoke a callback handler. Returns None if no handler registered."""
        handler = self._handlers.get(endpoint)
        if handler is None:
            return None
        result = handler(data or {})
        return result

    @property
    def endpoints(self) -> list[str]:
        """List registered callback endpoints."""
        return list(self._handlers.keys())


def get_unread_count(plugin, room_id: str, since_message_id: int) -> int:
    """Call a plugin's unread-count callback. Falls back to 0."""
    cb = getattr(plugin, '_callbacks', None)
    if cb:
        handler = cb._handlers.get('/unread-count')
        if handler:
            return handler({"room_id": room_id, "since_message_id": since_message_id})
    return 0


def get_unread_counts_batch(plugin, room_positions: dict[str, int]) -> dict[str, int]:
    """Call a plugin's unread-counts-batch callback. Falls back to empty dict."""
    cb = getattr(plugin, '_callbacks', None)
    if cb:
        handler = cb._handlers.get('/unread-counts-batch')
        if handler:
            return handler({"room_positions": room_positions})
    return {}


def intercept_message(plugin, message_data: dict) -> Optional[dict]:
    """Call a plugin's intercept-message callback. Returns message_data unchanged if no handler."""
    cb = getattr(plugin, '_callbacks', None)
    if cb:
        handler = cb._handlers.get('/intercept-message')
        if handler:
            return handler({"message_data": message_data})
    return message_data
