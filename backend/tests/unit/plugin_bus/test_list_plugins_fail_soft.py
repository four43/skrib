"""``GET /plugins`` must never 500 because of one bad active-plugin record.

Before this fix, ``list_plugins`` iterated ``registry.all()`` unguarded, and
``_plugin_info_from_registry`` caught only ``HTTPException`` — so a record
missing a key raised ``KeyError``, and a raising ``plugin_records()`` (e.g.
after Task 5 wires in an ``InProcessHost``) took the whole endpoint down.
The old ``_get_bus_plugins()`` this replaced wrapped its whole enumeration in
``except Exception: return []`` — this restores that fail-soft guarantee
without going back to returning nothing for everyone.
"""
import json

import pytest

from skrib.plugins import routes as routes_mod
from skrib.plugins.routes import list_plugins


class _FakeRegistry:
    def __init__(self, records=None, raise_on_all=False):
        self._records = records or []
        self._raise = raise_on_all

    def all(self):
        if self._raise:
            raise RuntimeError("boom")
        return self._records


def _write_manifest(plugins_dir, plugin_id, **overrides):
    plugin_dir = plugins_dir / plugin_id
    plugin_dir.mkdir()
    manifest = {
        "id": plugin_id, "name": plugin_id, "version": "1.0.0", "description": "",
        "author": "", "entry": "frontend/plugin.js", "permissions": [], "hooks": {},
    }
    manifest.update(overrides)
    (plugin_dir / "manifest.json").write_text(json.dumps(manifest))
    return plugin_dir


def _record(plugin_id: str, **overrides) -> dict:
    rec = {
        "id": plugin_id, "version": "1.0.0", "permissions": [], "room_types": [],
        "room_type_meta": {}, "frontend_scripts": [], "frontend_styles": [],
        "http_base_url": None, "runtime": "in_process",
    }
    rec.update(overrides)
    return rec


@pytest.fixture
def plugins_dir(tmp_path, monkeypatch):
    monkeypatch.setattr(routes_mod, "PLUGINS_DIR", tmp_path)
    return tmp_path


@pytest.fixture
def installed_registry():
    """Install a fake registry on app.state, restoring whatever was there."""
    from skrib.main import app

    installed = {}

    def _install(registry):
        installed["saved"] = getattr(app.state, "plugin_registry", None)
        app.state.plugin_registry = registry

    yield _install

    if "saved" in installed:
        if installed["saved"] is not None:
            app.state.plugin_registry = installed["saved"]
        else:
            del app.state.plugin_registry


async def test_malformed_record_is_skipped_but_others_still_list(plugins_dir, installed_registry):
    """A record missing keys (KeyError-prone) must not crash the listing —
    and since it can't be built as an active entry, it falls back to a
    'known but not enabled' filesystem entry rather than vanishing."""
    _write_manifest(plugins_dir, "four43.good")
    _write_manifest(plugins_dir, "four43.bad")

    good = _record("four43.good")
    bad = {"id": "four43.bad"}  # missing every other RECORD_KEYS entry
    installed_registry(_FakeRegistry([good, bad]))

    plugins = await list_plugins()

    by_id = {p.id: p for p in plugins}
    assert by_id["four43.good"].enabled is True
    assert by_id["four43.bad"].enabled is False


async def test_raising_all_does_not_500_the_listing(plugins_dir, installed_registry):
    """A registry whose all() raises (e.g. a broken in-process host) must
    degrade to filesystem-only listing, not a 500."""
    _write_manifest(plugins_dir, "four43.onlydisk")
    installed_registry(_FakeRegistry(raise_on_all=True))

    plugins = await list_plugins()

    assert [p.id for p in plugins] == ["four43.onlydisk"]
    assert plugins[0].enabled is False


async def test_healthy_record_is_unaffected(plugins_dir, installed_registry):
    """Baseline: a well-formed active record still lists as enabled."""
    _write_manifest(plugins_dir, "four43.good")
    installed_registry(_FakeRegistry([_record("four43.good", room_types=["chat"])]))

    plugins = await list_plugins()

    assert len(plugins) == 1
    assert plugins[0].id == "four43.good"
    assert plugins[0].enabled is True
    assert plugins[0].room_types == ["chat"]


async def test_none_record_among_healthy_ones_is_skipped(plugins_dir, installed_registry):
    """A non-dict entry (e.g. ``None`` from a buggy host) must not crash the
    listing — ``record.get(...)`` on it would raise ``AttributeError`` if
    touched outside a guard."""
    _write_manifest(plugins_dir, "four43.good")
    installed_registry(_FakeRegistry([_record("four43.good"), None]))

    plugins = await list_plugins()

    assert [p.id for p in plugins] == ["four43.good"]
    assert plugins[0].enabled is True


async def test_raising_inprocess_host_still_lists_bus_plugins(plugins_dir, installed_registry):
    """The real registry, wired with a raising in-process host and a working
    bus, must still list the bus plugin — proving the fail-soft guarantee
    holds per-source, not just for the endpoint as a whole."""
    from skrib.plugin_bus.protocol import ApprovalStatus
    from skrib.plugins.registry import PluginRegistry

    _write_manifest(plugins_dir, "four43.bus-plugin")

    class _RaisingHost:
        def plugin_records(self):
            raise RuntimeError("in-process host is broken")

    class _Conn:
        plugin_id = "four43.bus-plugin"
        version = "1.0.0"
        permissions = {"bus.send"}
        room_types = ["chat"]
        room_type_meta = {}
        frontend_scripts = []
        frontend_styles = []
        http_base_url = None
        status = ApprovalStatus.APPROVED

    class _FakeBus:
        room_type_map = {"chat": "four43.bus-plugin"}
        plugins = {"four43.bus-plugin": _Conn()}

        def get_plugin(self, plugin_id):
            return self.plugins.get(plugin_id)

    installed_registry(PluginRegistry(_FakeBus(), _RaisingHost()))

    plugins = await list_plugins()

    assert [p.id for p in plugins] == ["four43.bus-plugin"]
    assert plugins[0].enabled is True
