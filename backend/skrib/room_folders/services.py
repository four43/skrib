"""Business logic for room folders."""
import uuid
from datetime import datetime
from typing import Dict, List, Optional

from ..database import get_db

MAX_NESTING_DEPTH = 5

# Sentinel for distinguishing "not provided" from None
_SENTINEL = object()


def get_all_folders() -> List[Dict]:
    """Get all folders ordered by position."""
    with get_db() as conn:
        cursor = conn.execute(
            'SELECT folder_id, name, parent_folder_id, position FROM room_folders ORDER BY position'
        )
        return [dict(row) for row in cursor]


def get_room_positions() -> List[Dict]:
    """Get folder_id and sort_position for all non-deleted rooms."""
    with get_db() as conn:
        cursor = conn.execute(
            'SELECT room_id, folder_id, sort_position as position FROM rooms WHERE deleted = 0'
        )
        return [dict(row) for row in cursor]


def _get_next_position(parent_folder_id: Optional[str]) -> float:
    """Get the next position value for a sibling list."""
    with get_db() as conn:
        if parent_folder_id is None:
            cursor = conn.execute(
                'SELECT MAX(position) as max_pos FROM room_folders WHERE parent_folder_id IS NULL'
            )
        else:
            cursor = conn.execute(
                'SELECT MAX(position) as max_pos FROM room_folders WHERE parent_folder_id = ?',
                (parent_folder_id,)
            )
        row = cursor.fetchone()
        max_pos = row['max_pos'] if row and row['max_pos'] is not None else -1
        return max_pos + 1


def _get_ancestor_ids(folder_id: str) -> set:
    """Walk up the ancestor chain and return all ancestor folder_ids."""
    ancestors = set()
    current = folder_id
    with get_db() as conn:
        while current:
            cursor = conn.execute(
                'SELECT parent_folder_id FROM room_folders WHERE folder_id = ?',
                (current,)
            )
            row = cursor.fetchone()
            if not row or row['parent_folder_id'] is None:
                break
            parent = row['parent_folder_id']
            if parent in ancestors:
                break  # safety: cycle detected
            ancestors.add(parent)
            current = parent
    return ancestors


def _get_depth(folder_id: Optional[str]) -> int:
    """Get the nesting depth of a folder (0 = root level)."""
    depth = 0
    current = folder_id
    with get_db() as conn:
        while current:
            cursor = conn.execute(
                'SELECT parent_folder_id FROM room_folders WHERE folder_id = ?',
                (current,)
            )
            row = cursor.fetchone()
            if not row or row['parent_folder_id'] is None:
                break
            depth += 1
            current = row['parent_folder_id']
    return depth


def _get_subtree_depth(folder_id: str) -> int:
    """Get the max depth of children below this folder (0 = no children)."""
    with get_db() as conn:
        cursor = conn.execute(
            'SELECT folder_id FROM room_folders WHERE parent_folder_id = ?',
            (folder_id,)
        )
        children = [row['folder_id'] for row in cursor]

    if not children:
        return 0

    return 1 + max(_get_subtree_depth(child) for child in children)


def create_folder(name: str, parent_folder_id: Optional[str], created_by: str) -> str:
    """Create a new folder. Returns the folder_id."""
    if parent_folder_id is not None:
        # Verify parent exists
        with get_db() as conn:
            cursor = conn.execute(
                'SELECT folder_id FROM room_folders WHERE folder_id = ?',
                (parent_folder_id,)
            )
            if not cursor.fetchone():
                raise ValueError('Parent folder not found')

        # Check nesting depth
        parent_depth = _get_depth(parent_folder_id)
        if parent_depth + 1 >= MAX_NESTING_DEPTH:
            raise ValueError(f'Maximum nesting depth of {MAX_NESTING_DEPTH} exceeded')

    folder_id = str(uuid.uuid4())
    now = datetime.now().isoformat()
    position = _get_next_position(parent_folder_id)

    with get_db() as conn:
        conn.execute(
            'INSERT INTO room_folders (folder_id, name, parent_folder_id, position, created_at, created_by) '
            'VALUES (?, ?, ?, ?, ?, ?)',
            (folder_id, name, parent_folder_id, position, now, created_by)
        )
        conn.commit()

    return folder_id


def update_folder(folder_id: str, name: Optional[str] = None,
                  parent_folder_id: object = None, position: Optional[float] = None) -> bool:
    """Update a folder's name, parent, or position. Returns False if not found.

    parent_folder_id uses a sentinel to distinguish "not provided" from "set to None (root)".
    Pass the string value or None to move, or don't include it to skip.
    """
    with get_db() as conn:
        cursor = conn.execute(
            'SELECT folder_id, parent_folder_id FROM room_folders WHERE folder_id = ?',
            (folder_id,)
        )
        if not cursor.fetchone():
            return False

    updates = []
    params = []

    if name is not None:
        updates.append('name = ?')
        params.append(name)

    if parent_folder_id is not _SENTINEL:
        # Circular reference check
        if parent_folder_id is not None:
            if parent_folder_id == folder_id:
                raise ValueError('A folder cannot be its own parent')
            ancestors = _get_ancestor_ids(parent_folder_id)
            ancestors.add(parent_folder_id)
            if folder_id in ancestors:
                raise ValueError('Circular reference detected')

            # Depth check: depth_of_new_parent + 1 + subtree_depth_of_this_folder must be < MAX
            new_parent_depth = _get_depth(parent_folder_id) + 1
            subtree_depth = _get_subtree_depth(folder_id)
            if new_parent_depth + subtree_depth >= MAX_NESTING_DEPTH:
                raise ValueError(f'Maximum nesting depth of {MAX_NESTING_DEPTH} exceeded')

        updates.append('parent_folder_id = ?')
        params.append(parent_folder_id)

    if position is not None:
        updates.append('position = ?')
        params.append(position)

    if not updates:
        return True

    params.append(folder_id)
    with get_db() as conn:
        conn.execute(
            f'UPDATE room_folders SET {", ".join(updates)} WHERE folder_id = ?',
            params
        )
        conn.commit()

    return True



def delete_folder(folder_id: str) -> bool:
    """Delete a folder and all child folders. Affected rooms become unfiled."""
    with get_db() as conn:
        cursor = conn.execute(
            'SELECT folder_id FROM room_folders WHERE folder_id = ?',
            (folder_id,)
        )
        if not cursor.fetchone():
            return False

    # Collect all descendant folder IDs
    to_delete = _collect_descendants(folder_id)
    to_delete.add(folder_id)

    with get_db() as conn:
        # Unfiled rooms in all deleted folders
        placeholders = ','.join('?' * len(to_delete))
        conn.execute(
            f'UPDATE rooms SET folder_id = NULL WHERE folder_id IN ({placeholders})',
            list(to_delete)
        )
        # Delete folders (children first to satisfy FK, but SQLite doesn't enforce by default)
        conn.execute(
            f'DELETE FROM room_folders WHERE folder_id IN ({placeholders})',
            list(to_delete)
        )
        conn.commit()

    return True


def _collect_descendants(folder_id: str) -> set:
    """Recursively collect all descendant folder IDs."""
    descendants = set()
    with get_db() as conn:
        cursor = conn.execute(
            'SELECT folder_id FROM room_folders WHERE parent_folder_id = ?',
            (folder_id,)
        )
        children = [row['folder_id'] for row in cursor]

    for child in children:
        descendants.add(child)
        descendants.update(_collect_descendants(child))

    return descendants


def move_room(room_id: str, folder_id: Optional[str], position: float):
    """Move a room to a folder (or unfiled if folder_id is None)."""
    if folder_id is not None:
        with get_db() as conn:
            cursor = conn.execute(
                'SELECT folder_id FROM room_folders WHERE folder_id = ?',
                (folder_id,)
            )
            if not cursor.fetchone():
                raise ValueError('Folder not found')

    with get_db() as conn:
        conn.execute(
            'UPDATE rooms SET folder_id = ?, sort_position = ? WHERE room_id = ? AND deleted = 0',
            (folder_id, position, room_id)
        )
        conn.commit()


def batch_reorder(folders: list, rooms: list):
    """Bulk update positions for folders and rooms in a single transaction."""
    with get_db() as conn:
        for f in folders:
            conn.execute(
                'UPDATE room_folders SET parent_folder_id = ?, position = ? WHERE folder_id = ?',
                (f.get('parent_folder_id'), f['position'], f['folder_id'])
            )
        for r in rooms:
            conn.execute(
                'UPDATE rooms SET folder_id = ?, sort_position = ? WHERE room_id = ? AND deleted = 0',
                (r.get('folder_id'), r['position'], r['room_id'])
            )
        conn.commit()
