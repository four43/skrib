"""Unified WebSocket bus — singleton instance."""
from .manager import UnifiedConnectionManager
from .handlers import register_core_handlers

bus = UnifiedConnectionManager()
register_core_handlers(bus)
