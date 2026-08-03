# Nestable Folders for Rooms

## Context

Rooms are currently flat lists split into "Channels" and "Direct Messages." Users want to organize channels into folders (like Discord categories). Folders are **shared/global** -- admins define the structure and all users see the same layout. DMs stay in their own flat section. Drag-and-drop via SortableJS.

## Database Changes

**File: [database.py](backend/skrib/database.py)**

New `room_folders` table:

```sql
CREATE TABLE IF NOT EXISTS room_folders (
    folder_id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    parent_folder_id TEXT,          -- NULL = root level
    position REAL NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    created_by TEXT,
    FOREIGN KEY (parent_folder_id) REFERENCES room_folders(folder_id)
);
```

New columns on `rooms` table (via ALTER, existing pattern in database.py):

```sql
ALTER TABLE rooms ADD COLUMN folder_id TEXT REFERENCES room_folders(folder_id);
ALTER TABLE rooms ADD COLUMN sort_position REAL NOT NULL DEFAULT 0;
```

**Why REAL positions:** Insert between items (1.5 between 1.0 and 2.0) without re-numbering siblings. The batch reorder endpoint normalizes to clean integers.

## New Backend Module: `backend/skrib/room_folders/`

Follows existing pattern: `__init__.py`, `schemas.py`, `services.py`, `routes.py`.

### Schemas ([room_folders/schemas.py](backend/skrib/room_folders/schemas.py) -- new)

- `FolderInfo`: folder_id, name, parent_folder_id, position
- `CreateFolderRequest`: name, parent_folder_id (optional)
- `CreateFolderResponse`: folder_id
- `UpdateFolderRequest`: name (optional), parent_folder_id (optional), position (optional)
- `MoveRoomRequest`: folder_id (nullable = unfiled), position
- `ReorderRequest`: folders [{folder_id, parent_folder_id, position}], rooms [{room_id, folder_id, position}]
- `FolderTreeResponse`: folders list, room_positions list [{room_id, folder_id, position}]

### Services ([room_folders/services.py](backend/skrib/room_folders/services.py) -- new)

- `get_all_folders()` -- all folders ordered by position
- `get_room_positions()` -- room_id, folder_id, sort_position for all non-deleted rooms
- `create_folder(name, parent_folder_id, created_by)` -- UUID4 id, auto-position at end of siblings
- `update_folder(folder_id, name, parent_folder_id, position)` -- with circular reference prevention
- `delete_folder(folder_id)` -- cascade delete child folders, set affected rooms' folder_id to NULL
- `move_room(room_id, folder_id, position)` -- update rooms table
- `batch_reorder(folders, rooms)` -- bulk position updates in transaction

**Circular reference prevention:** When changing `parent_folder_id`, walk up the ancestor chain. Reject if the folder being moved appears as an ancestor of the new parent.

**Max nesting depth:** Enforce 5 levels server-side.

### Routes ([room_folders/routes.py](backend/skrib/room_folders/routes.py) -- new)

Mutations require admin/moderator role (reuse `get_global_role()` from [permissions.py](backend/skrib/permissions.py)).

| Method | Endpoint | Auth | Purpose |
|--------|----------|------|---------|
| GET | `/room-folders` | Any user | Full folder tree + room positions |
| POST | `/room-folders` | Admin/mod | Create folder |
| PATCH | `/room-folders/{folder_id}` | Admin/mod | Rename, move, reorder folder |
| DELETE | `/room-folders/{folder_id}` | Admin/mod | Delete folder (rooms become unfiled) |
| PUT | `/room-folders/rooms/{room_id}` | Admin/mod | Move room to folder |
| POST | `/room-folders/reorder` | Admin/mod | Batch reorder folders and rooms |

After each mutation, broadcast `room:update` to all connected users so sidebar refreshes everywhere.

### Register in [main.py](backend/skrib/main.py) (line ~60)

```python
from .room_folders.routes import router as room_folders_router
app.include_router(room_folders_router, prefix="/api")
```

## Modify Existing Backend Files

### [rooms/schemas.py](backend/skrib/rooms/schemas.py)

Add to `RoomInfo` (line 6-14):

```python
folder_id: Optional[str] = None
sort_position: float = 0
```

### [rooms/services.py](backend/skrib/rooms/services.py)

Update `get_user_rooms()` SQL (line 42-47) to SELECT `r.folder_id, r.sort_position` and include them in the returned dict (line 57-66).

## Frontend Changes

### Install SortableJS

```bash
cd frontend && npm install sortablejs
```

### [app.html](frontend/pages/app.html)

- Add "create folder" button (folder icon) next to existing "+" channel button in sidebar header
- Add create-folder modal (input for name -- reuse existing modal patterns)

### [app.js](frontend/src/app.js) -- largest change

**Modify `loadRooms()`** (~line 1052):

- Fetch rooms and folders in parallel: `Promise.all([fetch('/rooms'), fetch('/room-folders')])`
- Build folder tree in memory
- Call `renderFolderTree()` instead of flat list

**New `buildFolderTree(folders, channels)`:**

- Map folders by ID, assign children to parents via parent_folder_id
- Assign rooms to their folder_id (or "unfiled" list if null)
- Sort each level by position

**New `renderFolderTree(containerId, folders, channels)`:**

- Clear container, render root folders recursively via `createFolderElement()`
- Render unfiled rooms at root level

**New `createFolderElement(folder)`:**

- Folder header: collapse toggle (triangle) + name + hover action buttons (rename/delete -- admin only)
- Collapsible `.folder-content` div with child folders + rooms
- Collapse state persisted in localStorage (`skrib_collapsed_folders`)

**New `toggleFolder(folderId)`:**

- Toggle `.collapsed` class on content div, update triangle direction
- Persist to localStorage

**New `initDragAndDrop()`:**

- Create SortableJS instance on `#channel-list` and each `.folder-content`
- `group: 'rooms-and-folders'` for cross-container dragging
- `onEnd` handler: collect new order from DOM children, POST to `/room-folders/reorder`
- Only init for admin/moderator users

**Unread badge aggregation:**

- When folder is collapsed, show sum of all contained rooms' unread counts (recursive)
- Computed client-side from roomMeta cache

**Folder CRUD functions:**

- `createFolder()` -- modal input, POST /room-folders, reload
- `renameFolder(folderId)` -- inline edit or prompt, PATCH /room-folders/{id}
- `deleteFolder(folderId)` -- confirm dialog, DELETE /room-folders/{id}

### [style.css](frontend/src/style.css)

New rules:

- `.folder-item` -- wrapper for a folder
- `.folder-header` -- flex row: toggle + name + actions (Discord category style: uppercase, small, bold)
- `.folder-toggle` -- small triangle icon (8px)
- `.folder-name` -- uppercase, letter-spacing, ellipsis overflow
- `.folder-actions` -- hidden by default, shown on `.folder-header:hover`
- `.folder-action-btn` -- small icon buttons
- `.folder-content` -- left-padded container, collapsible
- `.folder-content.collapsed` -- `max-height: 0; overflow: hidden`
- `.folder-badge` -- unread sum badge on collapsed folder header
- `.drag-ghost` -- semi-transparent placeholder during drag
- `.drag-chosen` -- highlight on the item being dragged

## Constraints

- Max nesting depth: 5 levels
- Folder names: 1-50 chars, trimmed, non-empty
- Permissions: admin/moderator for all mutations; any user can view and collapse/expand
- DMs excluded from folder system

## Implementation Order

1. Database: add `room_folders` table and `rooms` columns in `database.py`, `rm data/*` to reset
2. Backend: create `room_folders/` module (schemas, services, routes)
3. Backend: register router in `main.py`
4. Backend: update `rooms/schemas.py` and `rooms/services.py` for folder fields
5. Frontend: `npm install sortablejs`
6. Frontend: update `app.html` (folder button + modal)
7. Frontend: update `app.js` (folder tree rendering, DnD, CRUD)
8. Frontend: update `style.css` (folder styles, DnD states)

## Verification

1. Reset DB (`rm data/*`), restart backend
2. Create admin user, create channels
3. Create folders via UI, nest them, verify all users see same structure
4. Drag rooms between folders, verify order persists on refresh
5. Rename/delete folder, verify rooms become unfiled on delete
6. Non-admin user: verify read-only (no drag, no folder management buttons)
7. Collapse folder with unread rooms, verify aggregated badge
8. Cross-tab: modify folders in one tab, verify other tabs refresh
9. Run existing Playwright e2e tests for regressions
