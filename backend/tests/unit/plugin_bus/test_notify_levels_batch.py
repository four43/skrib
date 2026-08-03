"""The batched notify-level lookup must return one dict for the whole room."""
import pytest

from skrib.rooms.services import get_notify_levels, set_notify_level


# ---------------------------------------------------------------------------
# Fixtures — use a temp database for isolation
# ---------------------------------------------------------------------------

@pytest.fixture(autouse=True)
def temp_db(tmp_path, monkeypatch):
    """Point skrib.database at a fresh, fully-initialized temp DB per test."""
    from skrib import database

    monkeypatch.setattr(database, "DB_FILE", str(tmp_path / "test.db"))
    database.close_all_connections()
    database.init_db()

    yield

    database.close_all_connections()


def test_get_notify_levels_returns_all_members(seeded_room):
    """One call returns a level for every member, defaulting to 'all'."""
    room_id, members = seeded_room  # members: ["alice", "bob", "carol"]
    set_notify_level(room_id, "bob", "mentions")

    levels = get_notify_levels(room_id)

    assert levels == {"alice": "all", "bob": "mentions", "carol": "all"}


def test_get_notify_levels_unknown_room_is_empty():
    """An unknown room yields an empty mapping rather than raising."""
    assert get_notify_levels("no-such-room") == {}
