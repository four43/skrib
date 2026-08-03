"""Configure pytest-asyncio for plugin bus tests."""
import uuid
from datetime import datetime

import pytest


@pytest.fixture
def seeded_room():
    """Create a room with three members: alice, bob, carol.

    Built through the real skrib.rooms.services functions rather than a
    parallel hand-rolled schema, so it stays honest to whatever `create_room`/
    `add_room_member` actually do. Requires an isolated, already-initialized
    DB to be active (e.g. a per-test-module autouse fixture that points
    skrib.database.DB_FILE at a temp file and calls init_db()).
    """
    from skrib.database import get_db
    from skrib.rooms.services import add_room_member, create_room

    members = ["alice", "bob", "carol"]
    now = datetime.now().isoformat()
    with get_db() as conn:
        for username in members:
            conn.execute(
                """INSERT INTO users (username, credential_id, public_key, status, role, color, created_at)
                   VALUES (?, ?, ?, 'active', 'member', '#aaa', ?)""",
                (username, f"cred-{username}", f"pk-{username}", now),
            )
        conn.commit()

    room_id = f"room-{uuid.uuid4().hex[:8]}"
    create_room(room_id, room_type="chat", created_by=members[0])
    for username in members:
        add_room_member(room_id, username)

    return room_id, members
