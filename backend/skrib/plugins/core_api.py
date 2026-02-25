"""Internal API client for plugins to access core data.

Plugins use this instead of importing from skrib.rooms.services or
skrib.permissions. The interface mirrors what would be HTTP calls to
the core REST API. In-process: calls service functions directly.
Out-of-process: would make HTTP calls.
"""
from typing import Optional


class CoreAPI:
    """API client that plugins use to query core data.

    Injected into plugins as ``self.core_api`` during startup.
    """

    def __init__(self, bus=None):
        self._bus = bus

    def get_room_members(self, room_id: str) -> list[str]:
        """Get list of usernames in a room. Mirrors GET /api/rooms/{room_id}."""
        from ..rooms.services import get_room_members
        return get_room_members(room_id)

    def get_room_info(self, room_id: str) -> Optional[dict]:
        """Get full room details including members with roles."""
        from ..rooms.services import get_room_info
        return get_room_info(room_id)

    def get_notify_level(self, room_id: str, username: str) -> str:
        """Get notification level for a user in a room."""
        from ..rooms.services import get_notify_level
        return get_notify_level(room_id, username)

    def get_unread_count(self, room_id: str, username: str) -> int:
        """Get unread message count for a user in a room."""
        from ..rooms.services import get_unread_count_for_room
        return get_unread_count_for_room(room_id, username)

    def mark_room_read(self, room_id: str, username: str, message_id: int):
        """Update the user's last-read position in a room."""
        from ..rooms.services import mark_room_read
        mark_room_read(room_id, username, message_id)

    def is_user_connected(self, username: str) -> bool:
        """Check if a user has any active WebSocket connections.

        Mirrors GET /api/users/{username}/presence.
        """
        if not self._bus:
            return False
        conns = self._bus.user_connections.get(username)
        return bool(conns)
