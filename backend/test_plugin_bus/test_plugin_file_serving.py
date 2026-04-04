"""Tests for plugin file serving — verifies that /plugins/{id}/file/{path}
works for plugins both with and without their own HTTP sub-routers.

This reproduces a Starlette routing issue where a plugin sub-router mounted
at /plugins/four43.web-push/ prefix-matches and swallows requests for
/plugins/four43.web-push/file/..., returning 404 instead of falling back
to the generic /{plugin_id}/file/{file_path} route.
"""
import os
import tempfile

import pytest
from fastapi import APIRouter, FastAPI
from fastapi.testclient import TestClient

from skrib.plugins.routes import (
    router as plugins_router,
    fallback_router as plugins_fallback_router,
    get_plugin_dir,
)


@pytest.fixture
def app_with_plugin_subrouter(tmp_path):
    """Create a FastAPI app that mimics the REAL production setup:
    - A top-level app
    - An API sub-app mounted at /api (just like main.py does)
    - Generic plugin routes on the sub-app
    - A plugin sub-router on the sub-app
    - A test file on disk to serve

    This is critical — the bug only manifests with the nested mount.
    """
    # Create a fake plugin directory with a file
    plugin_dir = tmp_path / "test.plugin"
    plugin_dir.mkdir()
    (plugin_dir / "manifest.json").write_text('{"id":"test.plugin","name":"Test","version":"1.0.0","description":"","author":"","entry":"frontend/plugin.js","permissions":[],"hooks":{}}')
    frontend_dir = plugin_dir / "frontend"
    frontend_dir.mkdir()
    (frontend_dir / "plugin.js").write_text("console.log('hello');")

    # Mirror production: top-level app + API sub-app
    outer_app = FastAPI()
    api = FastAPI()

    # 1. Register the generic plugin routes (list, patch)
    api.include_router(plugins_router)

    # 2. Register a plugin-specific sub-router (like web-push does)
    plugin_subrouter = APIRouter(tags=["test-plugin"])

    @plugin_subrouter.get("/custom-endpoint")
    async def custom_endpoint():
        return {"ok": True}

    api.include_router(plugin_subrouter, prefix="/plugins/test.plugin")

    # 3. Register fallback parametric routes (file, manifest)
    api.include_router(plugins_fallback_router)

    # Mount sub-app at /api (same as production)
    outer_app.mount("/api", api)

    # Patch PLUGINS_DIR to point to our temp dir
    import skrib.plugins.routes as routes_mod
    original_plugins_dir = routes_mod.PLUGINS_DIR
    routes_mod.PLUGINS_DIR = tmp_path

    yield TestClient(outer_app)

    routes_mod.PLUGINS_DIR = original_plugins_dir


class TestPluginFileServingRealApp:
    """Test against the actual skrib app to catch production-only issues."""

    def test_file_serving_plugin_with_routes(self):
        """web-push has its own sub-router — file serving must still work."""
        from skrib.main import app
        client = TestClient(app, raise_server_exceptions=False)
        resp = client.get("/api/plugins/four43.web-push/file/frontend/dist/plugin.js")
        assert resp.status_code == 200, f"Expected 200, got {resp.status_code}: {resp.text}"
        assert len(resp.content) > 0

    def test_file_serving_plugin_without_routes(self):
        """chat-typing has no sub-router — baseline that should work."""
        from skrib.main import app
        client = TestClient(app, raise_server_exceptions=False)
        resp = client.get("/api/plugins/four43.chat-typing/file/frontend/dist/plugin.js")
        assert resp.status_code == 200

    def test_manifest_plugin_with_routes(self):
        """Manifest for a plugin with its own sub-router."""
        from skrib.main import app
        client = TestClient(app, raise_server_exceptions=False)
        resp = client.get("/api/plugins/four43.web-push/manifest")
        assert resp.status_code == 200
        assert resp.json()["id"] == "four43.web-push"

    def test_plugin_own_route_still_works(self):
        """Plugin's own endpoints still work."""
        from skrib.main import app
        client = TestClient(app, raise_server_exceptions=False)
        resp = client.get("/api/plugins/four43.web-push/vapid-key")
        # May 401 without auth, but should NOT be 404
        assert resp.status_code != 404


class TestPluginFileServing:
    def test_plugin_custom_endpoint_works(self, app_with_plugin_subrouter):
        """Plugin's own endpoint is accessible."""
        resp = app_with_plugin_subrouter.get("/api/plugins/test.plugin/custom-endpoint")
        assert resp.status_code == 200
        assert resp.json() == {"ok": True}

    def test_file_serving_with_subrouter(self, app_with_plugin_subrouter):
        """File serving works for a plugin that has its own sub-router.

        This is the key test — it fails when Starlette's prefix matching
        enters the plugin sub-router and 404s without falling back.
        """
        resp = app_with_plugin_subrouter.get("/api/plugins/test.plugin/file/frontend/plugin.js")
        assert resp.status_code == 200
        assert "hello" in resp.text

    def test_manifest_with_subrouter(self, app_with_plugin_subrouter):
        """Manifest route works for a plugin with a sub-router."""
        resp = app_with_plugin_subrouter.get("/api/plugins/test.plugin/manifest")
        assert resp.status_code == 200
        assert resp.json()["id"] == "test.plugin"

    def test_file_404_for_missing_file(self, app_with_plugin_subrouter):
        """Proper 404 (not generic) for a file that doesn't exist."""
        resp = app_with_plugin_subrouter.get("/api/plugins/test.plugin/file/nonexistent.js")
        assert resp.status_code == 404
        assert "not found" in resp.json()["detail"].lower()
