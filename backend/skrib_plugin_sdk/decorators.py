"""Decorators for registering plugin handlers.

These decorators mark methods on SkribPlugin subclasses so the SDK
can auto-register them during connection setup.
"""
from __future__ import annotations

from typing import Callable


def _mark(attr: str, key: str) -> Callable:
    """Generic marker decorator: stores metadata on the function."""
    def decorator(fn: Callable) -> Callable:
        if not hasattr(fn, "_skrib_handlers"):
            fn._skrib_handlers = []
        fn._skrib_handlers.append((attr, key))
        return fn
    return decorator


def on_room_action(action: str) -> Callable:
    """Register a method as a handler for a specific room action.

    Example::

        @on_room_action("send_message")
        async def handle_send(self, ctx):
            ...
    """
    return _mark("room_action", action)


def on_lifecycle(event: str) -> Callable:
    """Register a method as a handler for a lifecycle event.

    Valid events: room_created, room_deleted, user_joined, user_left.

    Example::

        @on_lifecycle("room_deleted")
        async def handle_delete(self, ctx):
            ...
    """
    return _mark("lifecycle", event)


def on_event(event_type: str) -> Callable:
    """Register a method as a handler for a cross-plugin bus event.

    Example::

        @on_event("four43.room-type-chat:message")
        async def handle_chat_message(self, ctx):
            ...
    """
    return _mark("event", event_type)


def callback(endpoint: str) -> Callable:
    """Register a method as a callback handler.

    Example::

        @callback("/unread-count")
        async def get_unread(self, ctx):
            return {"count": 42}
    """
    return _mark("callback", endpoint)
