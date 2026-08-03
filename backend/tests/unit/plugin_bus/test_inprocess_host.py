"""In-process plugins must be reachable through the same bridge paths.

The ``bridge`` fixture here is local to this file rather than added to
``conftest.py``: ``test_bridge.py`` already builds its bridge inline with
lightweight fakes rather than through a shared fixture, so this follows the
same pattern instead of reshaping the shared conftest (which also hosts the
unrelated ``seeded_room`` fixture).
"""
from unittest.mock import MagicMock

import pytest

from skrib.plugin_bus.bridge import PluginBusBridge
from skrib.plugin_bus.server import PluginBusServer


class _FakeWSManager:
    """Minimal stand-in for UnifiedConnectionManager's event registration."""

    def on_event(self, event_type, callback):
        pass

    def off_event(self, event_type, callback):
        pass


@pytest.fixture
def bridge():
    return PluginBusBridge(PluginBusServer(), _FakeWSManager(), MagicMock())


@pytest.mark.asyncio
async def test_send_to_plugin_prefers_inprocess(bridge):
    """A registered in-process plugin receives frames without the bus server."""
    delivered = []

    async def deliver(frame):
        delivered.append(frame)

    bridge.register_inprocess("four43.room-type-chat", deliver, ["chat"])

    sent = await bridge._send_to_plugin(
        "four43.room-type-chat", {"type": "room.action", "action": "message"}
    )

    assert sent is True
    assert delivered == [{"type": "room.action", "action": "message"}]


def test_room_type_lookup_resolves_inprocess_plugins(bridge):
    """get_bus_plugin_for_room_type must find in-process room types too,
    so ws/handlers.py needs no runtime-specific branching."""
    async def deliver(frame):
        pass

    bridge.register_inprocess("four43.room-type-chat", deliver, ["chat"])

    assert bridge.get_bus_plugin_for_room_type("chat") == "four43.room-type-chat"


def test_unregister_removes_room_types(bridge):
    """Unregistering drops the plugin's room types from the lookup."""
    async def deliver(frame):
        pass

    bridge.register_inprocess("four43.room-type-chat", deliver, ["chat"])
    bridge.unregister_inprocess("four43.room-type-chat")

    assert bridge.get_bus_plugin_for_room_type("chat") is None


@pytest.mark.asyncio
async def test_send_to_plugin_returns_false_when_inprocess_deliver_raises(bridge):
    """An in-process handler exception must not propagate.

    A raise here is exactly what would otherwise tear down the caller's
    entire WebSocket connection (ws/routes.py's outer except Exception),
    reproducing the msg-2 teardown symptom this plan exists to fix. The
    in-process branch must fail the same way the bus branch already does:
    catch, log, return False.
    """
    async def deliver(frame):
        raise ValueError("boom")

    bridge.register_inprocess("four43.room-type-chat", deliver, ["chat"])

    sent = await bridge._send_to_plugin(
        "four43.room-type-chat", {"type": "room.action", "action": "message"}
    )

    assert sent is False


def test_reregister_inprocess_drops_stale_room_types(bridge):
    """Re-registering a plugin with a shrunk room_types list must not leave
    a stale mapping to a room type it no longer owns."""
    async def deliver(frame):
        pass

    bridge.register_inprocess("four43.room-type-chat", deliver, ["chat", "chat-legacy"])
    bridge.register_inprocess("four43.room-type-chat", deliver, ["chat"])

    assert bridge.get_bus_plugin_for_room_type("chat") == "four43.room-type-chat"
    assert bridge.get_bus_plugin_for_room_type("chat-legacy") is None


import json

from skrib.plugin_bus.inprocess_host import discover_inprocess_plugins


def test_discover_only_returns_in_process_plugins(tmp_path):
    """Only manifests declaring runtime: in_process are discovered."""
    for pid, runtime in [
        ("four43.alpha", "in_process"),
        ("four43.beta", "process"),
        ("four43.gamma", None),  # omitted -> defaults to process
    ]:
        d = tmp_path / pid
        d.mkdir()
        manifest = {"id": pid, "version": "1.0.0", "permissions": []}
        if runtime is not None:
            manifest["runtime"] = runtime
        (d / "manifest.json").write_text(json.dumps(manifest))

    found = discover_inprocess_plugins(tmp_path)

    assert [pid for pid, _ in found] == ["four43.alpha"]


def test_discover_ignores_directories_without_manifests(tmp_path):
    """A stray directory must not break discovery."""
    (tmp_path / "four43.orphan").mkdir()

    assert discover_inprocess_plugins(tmp_path) == []


from pathlib import Path

from skrib.plugin_bus.inprocess_host import _load_plugin_class

PLUGINS_DIR = Path(__file__).resolve().parents[3] / "plugins"


@pytest.mark.parametrize("plugin_id", [
    "four43.room-type-chat",
    "four43.room-type-todo",
    "four43.message-reactions",
    "four43.emoji-picker",
    "four43.chat-typing",
])
def test_every_in_process_candidate_actually_loads(plugin_id):
    """Each plugin targeted for the in-process runtime must import cleanly.

    These plugins use relative imports (`from . import services`), which a bare
    spec_from_file_location cannot satisfy.
    """
    cls = _load_plugin_class(PLUGINS_DIR / plugin_id)

    assert cls.id == plugin_id


import logging

from skrib.plugin_bus.inprocess_host import InProcessHost


def _write_plugin(plugin_dir: Path, plugin_id: str, *, broken: bool) -> None:
    """Write a minimal in-process plugin dir, healthy or one that blows up on import."""
    backend_dir = plugin_dir / "backend"
    backend_dir.mkdir(parents=True)
    (plugin_dir / "manifest.json").write_text(
        json.dumps({"id": plugin_id, "version": "1.0.0", "runtime": "in_process", "permissions": []})
    )
    if broken:
        (backend_dir / "plugin_bus.py").write_text(
            "raise RuntimeError('boom - intentionally broken for test')\n"
        )
    else:
        (backend_dir / "plugin_bus.py").write_text(
            "from skrib_plugin_sdk import SkribPlugin\n\n\n"
            "class Plugin(SkribPlugin):\n"
            f"    id = {plugin_id!r}\n"
            "    version = '1.0.0'\n"
        )


@pytest.mark.asyncio
async def test_start_records_failure_without_raising(tmp_path, bridge, caplog):
    """A plugin that fails to load must not raise, but must not be silent either.

    This pins the "fail loudly" half of the in-process host: a bare
    `except Exception: pass` in start() would pass every other test in this
    suite while silently loading nothing, and no one would find out until a
    plugin mysteriously handled no traffic.
    """
    _write_plugin(tmp_path / "test.broken", "test.broken", broken=True)
    host = InProcessHost(bridge, tmp_path)

    with caplog.at_level(logging.ERROR):
        started = await host.start()

    assert "test.broken" not in started
    assert "test.broken" in host.failures
    assert host.failures["test.broken"]  # non-empty failure message
    assert any(
        record.levelno == logging.ERROR and "test.broken" in record.getMessage()
        for record in caplog.records
    )


@pytest.mark.asyncio
async def test_start_starts_healthy_plugin_despite_sibling_failure(tmp_path, bridge):
    """One broken plugin must not prevent a healthy sibling from starting."""
    _write_plugin(tmp_path / "test.broken", "test.broken", broken=True)
    _write_plugin(tmp_path / "test.healthy", "test.healthy", broken=False)
    host = InProcessHost(bridge, tmp_path)

    started = await host.start()

    assert started == ["test.healthy"]
    assert set(host.failures) == {"test.broken"}


@pytest.mark.asyncio
async def test_started_plugin_gets_an_http_server_and_a_record(bridge, tmp_path, monkeypatch):
    """A started in-process plugin exposes an http_base_url and a full record."""
    host = InProcessHost(bridge, PLUGINS_DIR)
    await host._start_one("four43.room-type-todo", PLUGINS_DIR / "four43.room-type-todo")
    try:
        records = {r["id"]: r for r in host.plugin_records()}
        rec = records["four43.room-type-todo"]

        assert rec["runtime"] == "in_process"
        assert rec["room_types"] == ["todo"]
        assert rec["http_base_url"].startswith("http://127.0.0.1:")
        assert set(rec) == {
            "id", "version", "permissions", "room_types", "room_type_meta",
            "frontend_scripts", "frontend_styles", "http_base_url", "runtime",
        }
    finally:
        await host.stop()


@pytest.mark.asyncio
async def test_stop_shuts_down_the_http_server(bridge):
    """stop() must not leave a listening socket behind."""
    host = InProcessHost(bridge, PLUGINS_DIR)
    await host._start_one("four43.room-type-todo", PLUGINS_DIR / "four43.room-type-todo")
    url = host.plugin_records()[0]["http_base_url"]
    await host.stop()

    assert host.plugin_records() == []
    import httpx
    with pytest.raises(Exception):
        async with httpx.AsyncClient(timeout=1.0) as c:
            await c.get(f"{url}/")


@pytest.mark.asyncio
async def test_start_registers_settings_schema(tmp_path, bridge):
    """An in-process plugin's settings schema becomes visible through the
    same lookup the bus server's connections use (get_settings_schema), so
    the settings API and admin routes don't need runtime-specific branching.

    None of the real in-process candidate plugins declare `settings`, so this
    uses a minimal fake plugin (same pattern as `_write_plugin`) to exercise
    the registration path directly.
    """
    plugin_dir = tmp_path / "test.withsettings"
    backend_dir = plugin_dir / "backend"
    backend_dir.mkdir(parents=True)
    (plugin_dir / "manifest.json").write_text(json.dumps(
        {"id": "test.withsettings", "version": "1.0.0", "runtime": "in_process", "permissions": []}
    ))
    (backend_dir / "plugin_bus.py").write_text(
        "from skrib_plugin_sdk import SkribPlugin\n\n\n"
        "class Plugin(SkribPlugin):\n"
        "    id = 'test.withsettings'\n"
        "    version = '1.0.0'\n"
        "    settings = [{'key': 'greeting', 'label': 'Greeting', 'type': 'string',\n"
        "                 'default': 'hi', 'scope': 'server'}]\n"
    )
    host = InProcessHost(bridge, tmp_path)

    await host._start_one("test.withsettings", plugin_dir)
    try:
        from skrib.plugin_bus.settings import get_settings_schema
        assert get_settings_schema("test.withsettings") == [
            {"key": "greeting", "label": "Greeting", "type": "string",
             "default": "hi", "scope": "server"}
        ]
    finally:
        await host.stop()


@pytest.mark.asyncio
async def test_failure_after_http_server_starts_leaves_no_orphaned_port(tmp_path, bridge, monkeypatch):
    """A plugin whose on_connect() raises after its HTTP server started must
    not leak a bound port.

    start() catches per-plugin exceptions and continues (see
    test_start_records_failure_without_raising), so without cleanup here a
    half-started plugin would leave a listening socket with nothing left to
    close it while the rest of the server runs on normally.
    """
    plugin_dir = tmp_path / "test.failsafterhttp"
    backend_dir = plugin_dir / "backend"
    backend_dir.mkdir(parents=True)
    (plugin_dir / "manifest.json").write_text(json.dumps(
        {"id": "test.failsafterhttp", "version": "1.0.0", "runtime": "in_process", "permissions": []}
    ))
    (backend_dir / "plugin_bus.py").write_text(
        "from skrib_plugin_sdk import SkribPlugin\n\n\n"
        "class Plugin(SkribPlugin):\n"
        "    id = 'test.failsafterhttp'\n"
        "    version = '1.0.0'\n"
        "    http_port = 0\n\n"
        "    async def on_connect(self):\n"
        "        raise RuntimeError('boom - fails after the http server is already up')\n"
    )

    # Spy on the real run_http_server so the test can learn which port was
    # bound, without changing what it does.
    import skrib_plugin_sdk.http as sdk_http
    original_run_http_server = sdk_http.run_http_server
    ports: list[int] = []

    async def spying_run_http_server(app, host="127.0.0.1", port=0):
        server, actual_port = await original_run_http_server(app, host=host, port=port)
        ports.append(actual_port)
        return server, actual_port

    monkeypatch.setattr(sdk_http, "run_http_server", spying_run_http_server)

    host = InProcessHost(bridge, tmp_path)
    started = await host.start()

    assert "test.failsafterhttp" not in started
    assert "test.failsafterhttp" in host.failures
    assert ports, "the http server never started — test setup is wrong"

    import httpx
    with pytest.raises(Exception):
        async with httpx.AsyncClient(timeout=1.0) as c:
            await c.get(f"http://127.0.0.1:{ports[0]}/")


class TestInprocessSettingsSchemaResetBetweenTests:
    """Two tests, relying on pytest's default (non-randomized) file order,
    to prove the autouse reset fixture in conftest.py actually runs — a
    single test calling the reset function directly wouldn't prove that."""

    def test_a_registers_a_schema_without_cleanup(self):
        from skrib.plugin_bus.settings import register_inprocess_settings_schema

        register_inprocess_settings_schema("test.leaky", [{"key": "x"}])
        # Intentionally no unregister call — the autouse fixture must do it.

    def test_b_registry_is_empty_at_start(self):
        from skrib.plugin_bus.settings import get_settings_schema

        assert get_settings_schema("test.leaky") == []
