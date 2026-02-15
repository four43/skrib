"""Plugin system for Mini Chat.

This module provides the plugin infrastructure for extending Mini Chat
with new features, room types, and integrations.
"""
from .base import Plugin
from .registry import PluginRegistry, registry

__all__ = ['Plugin', 'PluginRegistry', 'registry']
