"""ASGI middleware that pre-authenticates requests to plugin endpoints.

Injects x-skrib-username, x-skrib-user-role, and x-skrib-room-role
headers into requests to /api/plugins/* routes. Plugins read these
headers via the helpers in skrib.plugins.auth instead of importing
core auth/permission functions directly.
"""
import re
from urllib.parse import unquote

# Match /rooms/{room_id} segment in plugin route paths
_ROOM_ID_RE = re.compile(r'/rooms/([^/]+)')
_SKRIB_HEADER_PREFIX = b'x-skrib-'


class PluginAuthMiddleware:
    """Pre-authenticate plugin HTTP requests and inject auth context headers."""

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] == "http":
            path = scope.get("path", "")
            if path.startswith("/api/plugins/"):
                scope = self._inject_auth(scope, path)

        await self.app(scope, receive, send)

    def _inject_auth(self, scope, path: str):
        from ..dependencies import verify_token
        from ..permissions import get_global_role
        from ..rooms.services import get_room_role, room_exists

        # Strip any client-supplied x-skrib-* headers to prevent spoofing
        headers = [
            (k, v) for k, v in scope.get("headers", [])
            if not k.startswith(_SKRIB_HEADER_PREFIX)
        ]

        # Extract Bearer token from Authorization header
        auth_value = None
        for k, v in headers:
            if k == b"authorization":
                auth_value = v.decode()
                break

        if not auth_value or not auth_value.startswith("Bearer "):
            return dict(scope, headers=headers)

        token = auth_value[7:]
        username = verify_token(token)
        if not username:
            return dict(scope, headers=headers)

        # Inject authenticated user context
        user_role = get_global_role(username)
        headers.append((b"x-skrib-username", username.encode()))
        headers.append((b"x-skrib-user-role", user_role.encode()))

        # Extract room_id from path and inject room role if user is a member
        m = _ROOM_ID_RE.search(path)
        if m:
            room_id = unquote(m.group(1))
            if room_exists(room_id):
                room_role = get_room_role(room_id, username)
                if room_role:
                    headers.append((b"x-skrib-room-role", room_role.encode()))

        return dict(scope, headers=headers)
