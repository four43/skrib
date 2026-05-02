"""Tests for middleware SSRF prevention."""
import pytest
from unittest.mock import MagicMock, patch

from fastapi import FastAPI
from fastapi.testclient import TestClient

from skrib.plugins.middleware import PluginAuthMiddleware


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
