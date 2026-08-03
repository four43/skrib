"""The registry must present both runtimes through one interface."""
from skrib.plugin_bus.protocol import ApprovalStatus
from skrib.plugin_bus.server import PluginConnection
from skrib.plugins.registry import RECORD_KEYS, PluginRegistry


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
    (dict[id, conn]), ``room_type_map``, and a ``get_plugin`` lookup — see
    server.py."""

    def __init__(self, conns, room_type_map=None):
        self._conns = conns
        self.room_type_map = room_type_map if room_type_map is not None else {"chat": "four43.bus-one"}

    @property
    def plugins(self):
        return dict(self._conns)

    def get_plugin(self, plugin_id):
        return self._conns.get(plugin_id)


class _FakeHost:
    def __init__(self, records=None):
        self._records = records if records is not None else [{
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

    def plugin_records(self):
        return self._records


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

    assert shapes == {frozenset(RECORD_KEYS)}


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

    def test_missing_status_fails_closed(self):
        """A security gate must fail closed: if a connection object somehow
        has no ``status`` at all, treat it as not-approved rather than
        defaulting to APPROVED. Unreachable with the real ``PluginConnection``
        dataclass (its ``status`` field always defaults to APPROVED), but
        worth guarding since ``_record_from_conn`` reads every other
        attribute with a permissive ``getattr(..., default)``.
        """
        conn = _FakeConn("four43.no-status")
        del conn.status
        reg = PluginRegistry(_FakeBusServer({"four43.no-status": conn}), None)

        assert reg.get("four43.no-status") is None
        assert reg.is_active("four43.no-status") is False


class TestRoomTypeOwner:
    """room_type_owner(room_type) -> plugin id, for callers that only need
    the owning id (room creation / DM room-type validation) rather than a
    full record — see rooms/routes.py and server/routes.py.
    """

    def test_resolves_bus_owned_room_type(self):
        reg = PluginRegistry(_FakeBusServer({}, room_type_map={"chat": "four43.bus-chat"}), None)

        assert reg.room_type_owner("chat") == "four43.bus-chat"

    def test_resolves_in_process_owned_room_type(self):
        reg = PluginRegistry(_FakeBusServer({}, room_type_map={}), _FakeHost())

        assert reg.room_type_owner("todo") == "four43.inproc-one"

    def test_unknown_room_type_returns_none(self):
        reg = PluginRegistry(_FakeBusServer({}, room_type_map={}), _FakeHost())

        assert reg.room_type_owner("nonexistent") is None

    def test_in_process_wins_when_both_own_the_same_room_type(self):
        reg = PluginRegistry(
            _FakeBusServer({}, room_type_map={"todo": "four43.bus-todo"}),
            _FakeHost(),
        )

        assert reg.room_type_owner("todo") == "four43.inproc-one"


def test_record_matches_a_real_plugin_connection():
    """A hand-rolled fake conn double can silently drift from the real
    ``PluginConnection`` dataclass if a field is ever renamed. Build a real
    one and assert the record reflects it, so that drift fails a test
    instead of failing silently in production.
    """
    conn = PluginConnection(
        plugin_id="four43.real-one",
        version="3.2.1",
        ws=None,
        permissions={"bus.send", "core.read"},
        room_types=["chat"],
        room_type_meta={"chat": {"display_name": "Chat"}},
        frontend_scripts=["frontend/dist/plugin.js"],
        frontend_styles=["frontend/dist/plugin.css"],
        http_base_url="http://127.0.0.1:9333",
    )
    reg = PluginRegistry(_FakeBusServer({"four43.real-one": conn}), None)

    record = reg.get("four43.real-one")
    permissions = record.pop("permissions")
    assert set(permissions) == {"bus.send", "core.read"}
    assert record == {
        "id": "four43.real-one",
        "version": "3.2.1",
        "room_types": ["chat"],
        "room_type_meta": {"chat": {"display_name": "Chat"}},
        "frontend_scripts": ["frontend/dist/plugin.js"],
        "frontend_styles": ["frontend/dist/plugin.css"],
        "http_base_url": "http://127.0.0.1:9333",
        "runtime": "process",
    }
