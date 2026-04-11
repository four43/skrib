"""Tests for middleware SSRF prevention and CoreAPI auth."""
import pytest
from unittest.mock import MagicMock, AsyncMock, patch

from fastapi import FastAPI
from fastapi.testclient import TestClient

from skrib.plugins.middleware import PluginAuthMiddleware
from skrib.plugins.core_api_routes import router as core_api_router, require_plugin_auth


# ---------------------------------------------------------------------------
# SSRF prevention tests
# ---------------------------------------------------------------------------

class TestSSRFPrevention:
    def test_localhost_allowed(self):
        assert PluginAuthMiddleware._is_localhost_url("http://127.0.0.1:8001") is True

    def test_localhost_name_allowed(self):
        assert PluginAuthMiddleware._is_localhost_url("http://localhost:9001") is True

    def test_ipv6_localhost_allowed(self):
        assert PluginAuthMiddleware._is_localhost_url("http://[::1]:8001") is True

    def test_external_host_rejected(self):
        assert PluginAuthMiddleware._is_localhost_url("http://evil.com:8001") is False

    def test_internal_ip_rejected(self):
        assert PluginAuthMiddleware._is_localhost_url("http://192.168.1.1:8001") is False

    def test_internal_service_rejected(self):
        assert PluginAuthMiddleware._is_localhost_url("http://internal.admin.service:8000") is False


# ---------------------------------------------------------------------------
# CoreAPI auth tests
# ---------------------------------------------------------------------------

@pytest.fixture
def core_api_client():
    """FastAPI test client with CoreAPI routes and mocked dependencies."""
    app = FastAPI()
    app.include_router(core_api_router)

    mock_bus = MagicMock()
    mock_conn = MagicMock()
    mock_conn.status = MagicMock()
    mock_conn.status.value = "approved"

    # Make ApprovalStatus comparison work
    from skrib.plugin_bus.protocol import ApprovalStatus
    mock_conn.status = ApprovalStatus.APPROVED

    mock_bus.get_plugin.return_value = mock_conn

    with patch("skrib.plugins.core_api_routes._get_bus_server", return_value=mock_bus):
        with patch("skrib.plugins.core_api_routes._get_core_api") as mock_core_api:
            api = MagicMock()
            api.get_room_members.return_value = ["alice", "bob"]
            api.is_user_connected.return_value = True
            mock_core_api.return_value = api
            yield TestClient(app), mock_bus


class TestCoreAPIAuth:
    def test_missing_plugin_id_header_returns_403(self, core_api_client):
        client, _ = core_api_client
        resp = client.get("/core/rooms/room1/members")
        assert resp.status_code == 403
        assert "Missing" in resp.json()["detail"]

    def test_unknown_plugin_returns_403(self, core_api_client):
        client, mock_bus = core_api_client
        mock_bus.get_plugin.return_value = None
        resp = client.get(
            "/core/rooms/room1/members",
            headers={"X-Skrib-Plugin-Id": "unknown.plugin"},
        )
        assert resp.status_code == 403

    def test_approved_plugin_succeeds(self, core_api_client):
        client, _ = core_api_client
        resp = client.get(
            "/core/rooms/room1/members",
            headers={"X-Skrib-Plugin-Id": "test.plugin"},
        )
        assert resp.status_code == 200
        assert resp.json()["members"] == ["alice", "bob"]


# ---------------------------------------------------------------------------
# Proxy status check tests — middleware must only proxy to APPROVED plugins
# ---------------------------------------------------------------------------

class TestProxyApprovalStatus:
    """The middleware must not proxy HTTP requests to non-approved plugins.

    When a plugin connects to the bus as 'pending' (awaiting admin approval),
    the bus stores it with its http_base_url.  If the middleware proxies to
    it, requests hit a server that may have shut down (the SDK exits early
    for non-approved plugins), resulting in a 502.
    """

    def _mock_bus(self, plugin_id, status_str, http_base_url):
        from skrib.plugin_bus.protocol import ApprovalStatus
        conn = MagicMock()
        conn.http_base_url = http_base_url
        conn.status = ApprovalStatus(status_str)
        bus = MagicMock()
        bus.get_plugin.return_value = conn
        return bus

    def _setup(self, plugin_id, status_str, http_base_url):
        """Build a test app with middleware and a mocked plugin bus."""
        mock_bus = self._mock_bus(plugin_id, status_str, http_base_url)

        # Mirror the real app: inner API app mounted at /api
        api = FastAPI()

        @api.get(f"/plugins/{plugin_id}/health")
        async def fallback():
            return {"source": "in_process"}

        outer = FastAPI()
        api.add_middleware(PluginAuthMiddleware)
        outer.mount("/api", api)

        import skrib.main
        saved = getattr(skrib.main.app.state, "plugin_bus", None)
        skrib.main.app.state.plugin_bus = mock_bus
        return outer, saved

    @staticmethod
    def _teardown(saved):
        import skrib.main
        if saved is not None:
            skrib.main.app.state.plugin_bus = saved
        else:
            del skrib.main.app.state.plugin_bus

    def test_pending_plugin_not_proxied(self):
        """Pending plugin with http_base_url must NOT be proxied."""
        plugin_id = "test.reactions"
        app, saved = self._setup(plugin_id, "pending_approval", "http://127.0.0.1:59999")
        try:
            client = TestClient(app)
            resp = client.get(f"/api/plugins/{plugin_id}/health")
            # Must fall through to in-process route, not 502 from proxy
            assert resp.status_code == 200, (
                f"Expected 200 (in-process fallback), got {resp.status_code}: {resp.text}"
            )
            assert resp.json()["source"] == "in_process"
        finally:
            self._teardown(saved)

    def test_approved_plugin_is_proxied(self):
        """Approved plugin with http_base_url SHOULD be proxied."""
        plugin_id = "test.chat"
        app, saved = self._setup(plugin_id, "approved", "http://127.0.0.1:59999")
        try:
            client = TestClient(app)
            resp = client.get(f"/api/plugins/{plugin_id}/health")
            # Should attempt proxy (and fail to connect → 502)
            assert resp.status_code == 502
        finally:
            self._teardown(saved)
