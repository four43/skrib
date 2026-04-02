"""Business logic for room folders."""
import re
import uuid
from datetime import datetime
from typing import Dict, List, Optional

from ..database import get_db

MAX_NESTING_DEPTH = 5
FOLDER_NAME_RE = re.compile(r'^[a-z0-9]+(-[a-z0-9]+)*$')

# Sentinel for distinguishing "not provided" from None
_SENTINEL = object()


def _load_folder_tree() -> Dict[str, Optional[str]]:
    """Load the full folder tree as {folder_id: parent_folder_id}.

    The table is always small (max depth 5), so loading it all is cheaper
    than issuing one query per hop in ancestor/descendant walks.
    """
    with get_db() as conn:
        cursor = conn.execute('SELECT folder_id, parent_folder_id FROM room_folders')
        return {row['folder_id']: row['parent_folder_id'] for row in cursor}


def get_all_folders() -> List[Dict]:
    """Get all folders ordered by position."""
    with get_db() as conn:
        cursor = conn.execute(
            'SELECT folder_id, name, parent_folder_id, position FROM room_folders ORDER BY position'
        )
        return [dict(row) for row in cursor]


def get_room_positions() -> List[Dict]:
    """Get folder_id and sort_position for all rooms."""
    with get_db() as conn:
        cursor = conn.execute(
            'SELECT room_id, folder_id, sort_position as position FROM rooms'
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


def _get_ancestor_ids(folder_id: str, tree: Dict[str, Optional[str]]) -> set:
    """Walk up the ancestor chain using an in-memory tree snapshot."""
    ancestors = set()
    current = folder_id
    while current:
        parent = tree.get(current)
        if parent is None or parent in ancestors:
            break
        ancestors.add(parent)
        current = parent
    return ancestors


def _get_depth(folder_id: Optional[str], tree: Dict[str, Optional[str]]) -> int:
    """Get the nesting depth of a folder (0 = root level) using an in-memory tree."""
    depth = 0
    current = folder_id
    while current:
        parent = tree.get(current)
        if parent is None:
            break
        depth += 1
        current = parent
    return depth


def _get_subtree_depth(folder_id: str, children_map: Dict[str, List[str]]) -> int:
    """Get the max depth of children below this folder (0 = no children)."""
    children = children_map.get(folder_id, [])
    if not children:
        return 0
    return 1 + max(_get_subtree_depth(child, children_map) for child in children)


def _build_children_map(tree: Dict[str, Optional[str]]) -> Dict[str, List[str]]:
    """Build a parent -> [children] lookup from the flat tree."""
    children_map: Dict[str, List[str]] = {}
    for fid, parent in tree.items():
        if parent is not None:
            children_map.setdefault(parent, []).append(fid)
    return children_map


def _collect_descendants(folder_id: str, children_map: Dict[str, List[str]]) -> set:
    """Recursively collect all descendant folder IDs from an in-memory tree."""
    descendants = set()
    for child in children_map.get(folder_id, []):
        descendants.add(child)
        descendants.update(_collect_descendants(child, children_map))
    return descendants


def _validate_folder_name(name: str) -> str:
    """Validate a folder name. Same rules as room names: lowercase alphanumeric and hyphens, max 50 chars."""
    name = name.strip()
    if not name or len(name) > 50:
        raise ValueError('Folder name must be 1-50 characters')
    if not FOLDER_NAME_RE.match(name):
        raise ValueError("Folder name must be lowercase letters, numbers, and hyphens only (e.g. 'my-folder')")
    return name


def create_folder(name: str, parent_folder_id: Optional[str], created_by: str) -> str:
    """Create a new folder. Returns the folder_id."""
    name = _validate_folder_name(name)
    if parent_folder_id is not None:
        tree = _load_folder_tree()
        if parent_folder_id not in tree:
            raise ValueError('Parent folder not found')

        # Check nesting depth
        parent_depth = _get_depth(parent_folder_id, tree)
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
    tree = _load_folder_tree()
    if folder_id not in tree:
        return False

    updates = []
    params = []

    if name is not None:
        name = _validate_folder_name(name)
        updates.append('name = ?')
        params.append(name)

    if parent_folder_id is not _SENTINEL:
        # Circular reference check
        if parent_folder_id is not None:
            if parent_folder_id == folder_id:
                raise ValueError('A folder cannot be its own parent')
            ancestors = _get_ancestor_ids(parent_folder_id, tree)
            ancestors.add(parent_folder_id)
            if folder_id in ancestors:
                raise ValueError('Circular reference detected')

            # Depth check: depth_of_new_parent + 1 + subtree_depth_of_this_folder must be < MAX
            children_map = _build_children_map(tree)
            new_parent_depth = _get_depth(parent_folder_id, tree) + 1
            subtree_depth = _get_subtree_depth(folder_id, children_map)
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
    tree = _load_folder_tree()
    if folder_id not in tree:
        return False

    # Collect all descendant folder IDs from in-memory tree
    children_map = _build_children_map(tree)
    to_delete = _collect_descendants(folder_id, children_map)
    to_delete.add(folder_id)

    with get_db() as conn:
        # Unfile rooms in all deleted folders
        placeholders = ','.join('?' * len(to_delete))
        conn.execute(
            f'UPDATE rooms SET folder_id = NULL WHERE folder_id IN ({placeholders})',
            list(to_delete)
        )
        conn.execute(
            f'DELETE FROM room_folders WHERE folder_id IN ({placeholders})',
            list(to_delete)
        )
        conn.commit()

    return True


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
            'UPDATE rooms SET folder_id = ?, sort_position = ? WHERE room_id = ?',
            (folder_id, position, room_id)
        )
        conn.commit()


def batch_reorder(folders: list, rooms: list):
    """Bulk update positions for folders and rooms in a single transaction.

    Validates the proposed tree before committing:
    - No self-references or circular parent chains
    - Max nesting depth not exceeded
    - Rooms only reference folders that exist
    """
    # Build the proposed tree: start from current state, apply changes on top
    tree = _load_folder_tree()

    # Apply proposed folder parent changes
    for f in folders:
        fid = f['folder_id']
        if fid not in tree:
            continue  # skip unknown folders
        tree[fid] = f.get('parent_folder_id')

    # Validate: no self-references
    for fid, parent in tree.items():
        if parent == fid:
            raise ValueError(f'Folder cannot be its own parent: {fid}')

    # Validate: no circular references and depth limit
    for fid in tree:
        visited = set()
        current = fid
        depth = 0
        while current:
            if current in visited:
                raise ValueError('Circular reference detected in folder tree')
            visited.add(current)
            parent = tree.get(current)
            if parent is None:
                break
            depth += 1
            current = parent
        if depth >= MAX_NESTING_DEPTH:
            raise ValueError(f'Maximum nesting depth of {MAX_NESTING_DEPTH} exceeded')

    # Validate: rooms only reference existing folders
    folder_ids = set(tree.keys())
    for r in rooms:
        rfolder = r.get('folder_id')
        if rfolder is not None and rfolder not in folder_ids:
            raise ValueError(f'Room references non-existent folder: {rfolder}')

    # All valid — apply
    with get_db() as conn:
        for f in folders:
            conn.execute(
                'UPDATE room_folders SET parent_folder_id = ?, position = ? WHERE folder_id = ?',
                (f.get('parent_folder_id'), f['position'], f['folder_id'])
            )
        for r in rooms:
            conn.execute(
                'UPDATE rooms SET folder_id = ?, sort_position = ? WHERE room_id = ?',
                (r.get('folder_id'), r['position'], r['room_id'])
            )
        conn.commit()
