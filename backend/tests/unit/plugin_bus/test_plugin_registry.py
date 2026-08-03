"""The registry must present both runtimes through one interface."""
import pytest

from skrib.plugin_bus.protocol import ApprovalStatus
from skrib.plugins.registry import PluginRegistry


class _FakeConn:
    def __init__(self, plugin_id, status=ApprovalStatus.APPROVED):
        self.plugin_id = plugin_id
        self.version = "1.0.0"
        self.permissions = {"bus.send"}
        self.room_types = ["chat"]
        self.room_type_meta = {}
        self.frontend_scripts = []
        self.frontend_styles = []
        self.http_base_url = "http://127.0.0.1:9111"
        self.status = status


class _FakeBusServer:
    """Mirrors PluginBusServer's actual public surface: a ``plugins`` property
    (dict[id, conn]) and a ``get_plugin`` lookup — see server.py."""

    def __init__(self, conns):
        self._conns = conns
        self.room_type_map = {"chat": "four43.bus-one"}

    @property
    def plugins(self):
        return dict(self._conns)

    def get_plugin(self, plugin_id):
        return self._conns.get(plugin_id)


class _FakeHost:
    def plugin_records(self):
        return [{
            "id": "four43.inproc-one",
            "version": "2.0.0",
            "permissions": ["bus.send"],
            "room_types": ["todo"],
            "room_type_meta": {},
            "frontend_scripts": ["frontend/dist/plugin.js"],
            "frontend_styles": [],
            "http_base_url": "http://127.0.0.1:9222",
            "runtime": "in_process",
        }]


def test_get_resolves_both_runtimes():
    reg = PluginRegistry(_FakeBusServer({"four43.bus-one": _FakeConn("four43.bus-one")}), _FakeHost())

    assert reg.get("four43.bus-one")["runtime"] == "process"
    assert reg.get("four43.inproc-one")["runtime"] == "in_process"
    assert reg.get("four43.nope") is None


def test_is_active_covers_in_process_plugins():
    """This is the manager.py:296 gate — an in-process plugin must pass it."""
    reg = PluginRegistry(_FakeBusServer({}), _FakeHost())

    assert reg.is_active("four43.inproc-one") is True
    assert reg.is_active("four43.nope") is False


def test_all_returns_both_and_does_not_duplicate():
    reg = PluginRegistry(_FakeBusServer({"four43.bus-one": _FakeConn("four43.bus-one")}), _FakeHost())

    ids = sorted(r["id"] for r in reg.all())
    assert ids == ["four43.bus-one", "four43.inproc-one"]


def test_records_share_one_key_set():
    """routes.py merges both sources, so the shapes must agree exactly."""
    reg = PluginRegistry(_FakeBusServer({"four43.bus-one": _FakeConn("four43.bus-one")}), _FakeHost())
    shapes = {frozenset(r) for r in reg.all()}

    assert len(shapes) == 1


def test_works_with_no_in_process_host():
    """The host is optional — a bus-only server must still resolve."""
    reg = PluginRegistry(_FakeBusServer({"four43.bus-one": _FakeConn("four43.bus-one")}), None)

    assert reg.is_active("four43.bus-one") is True
    assert reg.is_active("four43.inproc-one") is False


def test_in_process_wins_when_an_id_appears_in_both_sources():
    """A plugin id could plausibly appear in both sources during a runtime
    migration — in-process must win, and it must not be listed twice."""
    conn = _FakeConn("four43.inproc-one")
    reg = PluginRegistry(_FakeBusServer({"four43.inproc-one": conn}), _FakeHost())

    assert reg.get("four43.inproc-one")["runtime"] == "in_process"
    records = reg.all()
    assert [r["id"] for r in records].count("four43.inproc-one") == 1
    assert [r for r in records if r["id"] == "four43.inproc-one"][0]["runtime"] == "in_process"


class TestPendingBusPluginIsNotActive:
    """A plugin awaiting admin approval stays in the bus server's connection
    map (only a rejected plugin is evicted — see server.py's ``_handle_hello``),
    so the registry must filter it out explicitly rather than trusting bus
    presence alone. Otherwise the middleware would proxy HTTP requests to a
    plugin whose SDK-side HTTP server may have already shut down for a
    non-approved plugin.
    """

    def test_get_returns_none_for_pending_plugin(self):
        conn = _FakeConn("four43.pending-one", status=ApprovalStatus.PENDING)
        reg = PluginRegistry(_FakeBusServer({"four43.pending-one": conn}), None)

        assert reg.get("four43.pending-one") is None

    def test_is_active_is_false_for_pending_plugin(self):
        conn = _FakeConn("four43.pending-one", status=ApprovalStatus.PENDING)
        reg = PluginRegistry(_FakeBusServer({"four43.pending-one": conn}), None)

        assert reg.is_active("four43.pending-one") is False

    def test_all_excludes_pending_plugin(self):
        approved = _FakeConn("four43.bus-one", status=ApprovalStatus.APPROVED)
        pending = _FakeConn("four43.pending-one", status=ApprovalStatus.PENDING)
        reg = PluginRegistry(_FakeBusServer({
            "four43.bus-one": approved,
            "four43.pending-one": pending,
        }), None)

        ids = [r["id"] for r in reg.all()]
        assert ids == ["four43.bus-one"]

    def test_rejected_plugin_is_also_excluded(self):
        conn = _FakeConn("four43.rejected-one", status=ApprovalStatus.REJECTED)
        reg = PluginRegistry(_FakeBusServer({"four43.rejected-one": conn}), None)

        assert reg.get("four43.rejected-one") is None
        assert reg.is_active("four43.rejected-one") is False
