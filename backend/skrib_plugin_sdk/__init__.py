"""Skrib Plugin SDK — build out-of-process plugins for Skrib.

Provides the base class, decorators, and bus client for writing plugins
that communicate with Skrib core over the WebSocket plugin bus.
"""
from .plugin import SkribPlugin
from .decorators import on_room_action, on_lifecycle, on_event, callback
from .core_api import CoreAPI
from .database import get_plugin_db, init_schema, make_db_provider

__all__ = [
    "SkribPlugin",
    "on_room_action",
    "on_lifecycle",
    "on_event",
    "callback",
    "CoreAPI",
    "get_plugin_db",
    "init_schema",
    "make_db_provider",
]
