"""ASGI middleware that pre-authenticates requests to plugin endpoints.

Injects x-skrib-username, x-skrib-user-role, and x-skrib-room-role
headers into requests to /api/plugins/* routes. Plugins read these
headers via the helpers in skrib.plugins.auth instead of importing
core auth/permission functions directly.
"""
import re
import time
import threading
from urllib.parse import unquote

# Match /rooms/{room_id} segment in plugin route paths
_ROOM_ID_RE = re.compile(r'/rooms/([^/]+)')
_SKRIB_HEADER_PREFIX = b'x-skrib-'

# Short-lived cache for token→(username, role) lookups (30s TTL).
# Avoids 2 DB queries per plugin request for the same session.
_AUTH_CACHE_TTL = 30
_auth_cache = {}  # token -> (username, role, expires_at)
_auth_cache_lock = threading.Lock()


def _get_cached_auth(token: str):
    """Return (username, role) from cache if still valid, else None."""
    with _auth_cache_lock:
        entry = _auth_cache.get(token)
        if entry and entry[2] > time.monotonic():
            return entry[0], entry[1]
        _auth_cache.pop(token, None)
    return None


def _set_cached_auth(token: str, username: str, role: str):
    with _auth_cache_lock:
        _auth_cache[token] = (username, role, time.monotonic() + _AUTH_CACHE_TTL)
        # Evict expired entries periodically (keep cache bounded)
        if len(_auth_cache) > 200:
            now = time.monotonic()
            expired = [k for k, v in _auth_cache.items() if v[2] <= now]
            for k in expired:
                del _auth_cache[k]


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

        # Check cache first to avoid DB queries
        cached = _get_cached_auth(token)
        if cached:
            username, user_role = cached
        else:
            username = verify_token(token)
            if not username:
                return dict(scope, headers=headers)
            user_role = get_global_role(username)
            _set_cached_auth(token, username, user_role)

        # Inject authenticated user context
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
