"""Tests for the plugin loader — verifies all 7 plugins can be loaded."""
import pytest
import os

from skrib_plugin_sdk.loader import load_plugin_class

PLUGINS_DIR = os.path.join(os.path.dirname(__file__), "..", "plugins")

EXPECTED_PLUGINS = {
    "four43.chat-typing": "ChatTypingPlugin",
    "four43.emoji-picker": "EmojiPickerPlugin",
    "four43.message-reactions": "MessageReactionsPlugin",
    "four43.attachments": "AttachmentsPlugin",
    "four43.web-push": "WebPushPlugin",
    "four43.room-type-todo": "RoomTypeTodoPlugin",
    "four43.room-type-chat": "RoomTypeChatPlugin",
}


@pytest.mark.parametrize("plugin_dir_name,class_name", EXPECTED_PLUGINS.items())
def test_load_plugin(plugin_dir_name, class_name):
    """Each plugin can be loaded via the loader and has the expected class."""
    plugin_dir = os.path.join(PLUGINS_DIR, plugin_dir_name)
    mod = load_plugin_class(plugin_dir)
    cls = getattr(mod, class_name)
    instance = cls()
    assert instance.id == plugin_dir_name


def test_plugin_has_handlers():
    """Chat-typing plugin has the expected room action handlers."""
    plugin_dir = os.path.join(PLUGINS_DIR, "four43.chat-typing")
    mod = load_plugin_class(plugin_dir)
    plugin = mod.ChatTypingPlugin()
    assert "start" in plugin._room_action_handlers
    assert "stop" in plugin._room_action_handlers


def test_room_type_plugin_has_room_types():
    """Room-type-chat plugin declares room_types."""
    plugin_dir = os.path.join(PLUGINS_DIR, "four43.room-type-chat")
    mod = load_plugin_class(plugin_dir)
    plugin = mod.RoomTypeChatPlugin()
    assert "chat" in plugin.room_types
    assert "/unread-count" in plugin.callbacks_list


def test_todo_plugin_has_actions():
    """Todo plugin has the expected room action handlers."""
    plugin_dir = os.path.join(PLUGINS_DIR, "four43.room-type-todo")
    mod = load_plugin_class(plugin_dir)
    plugin = mod.RoomTypeTodoPlugin()
    assert "todo_add" in plugin._room_action_handlers
    assert "todo_update" in plugin._room_action_handlers
    assert "todo_delete" in plugin._room_action_handlers
