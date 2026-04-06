"""ASGI middleware that pre-authenticates requests to plugin endpoints.

Injects x-skrib-username, x-skrib-user-role, and x-skrib-room-role
headers into requests to /api/plugins/* routes. Plugins read these
headers via the helpers in skrib.plugins.auth instead of importing
core auth/permission functions directly.

For bus-connected plugins with ``http_base_url``, this middleware also
proxies HTTP requests to the plugin's external process.
"""
import logging
import re
import time
import threading
from urllib.parse import unquote

import httpx

logger = logging.getLogger(__name__)

# Match /rooms/{room_id} segment in plugin route paths
_ROOM_ID_RE = re.compile(r'/rooms/([^/]+)')
_SKRIB_HEADER_PREFIX = b'x-skrib-'
# Match /api/plugins/{plugin_id}/... to extract plugin_id and sub-path
_PLUGIN_ROUTE_RE = re.compile(r'^/api/plugins/([^/]+)(/.*)?$')

# Short-lived cache for token→(username, role) lookups (30s TTL).
# Avoids 2 DB queries per plugin request for the same session.
_AUTH_CACHE_TTL = 30
_auth_cache = {}  # token -> (username, role, expires_at)
_auth_cache_lock = threading.Lock()

# Shared async HTTP client for proxying (created lazily)
_http_client: httpx.AsyncClient | None = None


def _get_http_client() -> httpx.AsyncClient:
    global _http_client
    if _http_client is None:
        _http_client = httpx.AsyncClient(timeout=30.0)
    return _http_client


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
    """Pre-authenticate plugin HTTP requests and inject auth context headers.

    For bus-connected plugins that have an ``http_base_url``, requests to
    ``/api/plugins/{plugin_id}/...`` are proxied to the plugin's HTTP server
    with auth headers injected.
    """

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] == "http":
            path = scope.get("path", "")
            if path.startswith("/api/plugins/"):
                scope = self._inject_auth(scope, path)

                # Check if this plugin is bus-connected with an HTTP server.
                # File and manifest requests are always served from the core
                # server (filesystem), not proxied to the plugin process.
                m = _PLUGIN_ROUTE_RE.match(path)
                sub_path = m.group(2) if m else ""
                if not (sub_path.startswith("/file/") or sub_path == "/manifest"):
                    proxy_url = self._get_proxy_url(scope, path)
                    if proxy_url:
                        await self._proxy_request(scope, receive, send, proxy_url)
                        return

        await self.app(scope, receive, send)

    def _get_proxy_url(self, scope: dict, path: str) -> str | None:
        """Check if this request should be proxied to a bus-connected plugin."""
        m = _PLUGIN_ROUTE_RE.match(path)
        if not m:
            return None

        plugin_id = m.group(1)
        sub_path = m.group(2) or ""

        try:
            from ..main import app as main_app
            plugin_bus = getattr(main_app.state, 'plugin_bus', None)
            if not plugin_bus:
                return None
            conn = plugin_bus.get_plugin(plugin_id)
            if not conn or not conn.http_base_url:
                return None
            if not self._is_localhost_url(conn.http_base_url):
                logger.warning("[Middleware] Rejecting non-localhost http_base_url for plugin '%s': %s",
                               plugin_id, conn.http_base_url)
                return None
            return f"{conn.http_base_url.rstrip('/')}{sub_path}"
        except Exception:
            return None

    @staticmethod
    def _is_localhost_url(url: str) -> bool:
        """Validate that a URL points to localhost only."""
        from urllib.parse import urlparse
        parsed = urlparse(url)
        return parsed.hostname in ("localhost", "127.0.0.1", "::1")

    async def _proxy_request(self, scope: dict, receive, send, proxy_url: str) -> None:
        """Proxy an HTTP request to a bus-connected plugin's HTTP server."""
        # Collect the request body
        body = b""
        while True:
            message = await receive()
            body += message.get("body", b"")
            if not message.get("more_body", False):
                break

        # Build headers from scope, including injected x-skrib-* headers
        headers = {}
        for k, v in scope.get("headers", []):
            name = k.decode("latin-1")
            # Skip hop-by-hop headers
            if name.lower() in ("host", "transfer-encoding"):
                continue
            headers[name] = v.decode("latin-1")

        method = scope.get("method", "GET")
        query_string = scope.get("query_string", b"")
        url = proxy_url
        if query_string:
            url += "?" + query_string.decode("latin-1")

        client = _get_http_client()
        try:
            resp = await client.request(method, url, headers=headers, content=body)
        except Exception as e:
            # Return 502 Bad Gateway
            await send({"type": "http.response.start", "status": 502, "headers": [
                [b"content-type", b"application/json"],
            ]})
            import json
            await send({"type": "http.response.body", "body": json.dumps(
                {"detail": f"Plugin proxy error: {e}"}
            ).encode()})
            return

        # Forward response headers (exclude hop-by-hop)
        resp_headers = [
            [k.encode("latin-1"), v.encode("latin-1")]
            for k, v in resp.headers.items()
            if k.lower() not in ("transfer-encoding", "connection")
        ]
        await send({"type": "http.response.start", "status": resp.status_code, "headers": resp_headers})
        await send({"type": "http.response.body", "body": resp.content})

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
