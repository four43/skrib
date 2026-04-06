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
