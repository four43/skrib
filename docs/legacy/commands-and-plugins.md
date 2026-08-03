> **Superseded — retained for history.** Written 2026-02-18.
>
> **Contains a claim that is incompatible with the E2E pillar.** It states the server
> "should parse [@mentions] at send time to generate notifications" and store them
> for querying. The server cannot read message content, so mention detection and
> mention badges are computed client-side on sync. See
> `docs/spec/2026-08-02-core-log-and-signal.md` §4.2.
>
> The token patterns themselves (`@user`, `#room`, `:emoji:`, `/command`) were
> implemented and are documented in `docs/reference/rooms-and-membership.md`.

---


## Token Patterns to Support

@mention — User tagging. The server should parse these at send time to generate notifications. Store mentions in a separate table or as metadata so you can query "show me messages where I was mentioned" without scanning every message body.

# room — Room cross-references. The client renders these as clickable links that switch rooms. Server-side validation can confirm the room exists and the user has access

/commands — This is the big IRC pattern. Slash commands give you an extensible way to add features without changing the UI. Examples:

/join #room — join/switch to a room
/leave or /part — leave current room
/nick newname — change display name
/topic New topic here — set the room topic
/me does something — action message (displayed as Seth does something)
/msg username — open a DM
/kick username — admin: remove user from room
/ban username — admin: ban from room
/mute username duration — admin: temporarily mute
/invite username — invite someone to a private room
/who — list users in current room
/whois username — user info
/help — list available commands

This maps perfectly to your existing role-based access system — each command checks permissions before executing.


# Room Type Plugins - Architecture Overview

## Concept

Instead of all rooms being generic chat rooms, plugins can define entirely new room types with custom interfaces and behaviors. Think IRC channels vs. collaborative documents vs. whiteboards - same underlying infrastructure, completely different user experiences.

## Core vs Plugin Boundary

**Core Provides:**

- Room process spawning and lifecycle
- User authentication and room membership
- Message persistence layer
- WebSocket connection management
- Permission enforcement
- Base room metadata (id, name, members, created_at)

**Room Type Plugin Provides:**

- Custom UI layout
- Interaction model (chat vs document vs canvas)
- Data structure and storage schema
- Rendering logic
- Collaboration mechanics

## Room Type Registration

### Plugin Manifest

```json
{
  "id": "collaborative-list",
  "name": "Collaborative List",
  "version": "1.0.0",
  "type": "room_type",
  "room_type_id": "collab_list",
  "display_name": "Shared List",
  "description": "Create shared to-do lists, checklists, and collaborative lists",
  "icon": "📝",
  "permissions": ["database_write", "database_read"],
  "supports_features": {
    "real_time_collaboration": true,
    "message_history": false,
    "file_attachments": false,
    "user_presence": true
  }
}
```

### Room Creation Flow

1. User clicks "Create Room" → selects room type from available plugins
2. Core creates base room record with `room_type: "collab_list"`
3. Core spawns room process
4. Room process loads appropriate plugin
5. Plugin initializes custom data structure
6. Plugin renders custom UI for clients

## Example Room Types

### 1. Collaborative List

**Use Cases:** To-do lists, shopping lists, checklists, task tracking

**Data Structure:**

```json
{
  "items": [
    {
      "id": "uuid",
      "text": "Buy groceries",
      "completed": false,
      "created_by": "user_id",
      "created_at": "timestamp",
      "assignee": "user_id",
      "priority": "high"
    }
  ],
  "settings": {
    "allow_reorder": true,
    "show_completed": true,
    "allow_assignment": true
  }
}
```

**UI Components:**

- Checkbox list interface
- Add item input at top/bottom
- Drag-to-reorder if enabled
- Strikethrough for completed items
- User avatars for assignments
- Real-time cursor positions

**Commands:**

- `/add <item>` - Add list item
- `/complete <item_id>` - Mark complete
- `/assign <item_id> <user>` - Assign to user
- `/priority <item_id> <level>` - Set priority
- `/archive-completed` - Remove completed items

**Events Plugin Emits:**

- `item_added`
- `item_completed`
- `item_reordered`
- `item_assigned`

### 2. Whiteboard/Canvas Room

**Use Cases:** Brainstorming, diagram creation, collaborative drawing

**Data Structure:**

```json
{
  "objects": [
    {
      "id": "uuid",
      "type": "rectangle",
      "x": 100,
      "y": 200,
      "width": 150,
      "height": 100,
      "color": "#ff0000",
      "created_by": "user_id",
      "z_index": 1
    },
    {
      "id": "uuid",
      "type": "text",
      "x": 300,
      "y": 150,
      "text": "Ideas",
      "font_size": 24,
      "created_by": "user_id"
    },
    {
      "id": "uuid",
      "type": "path",
      "points": [[10,20], [30,40], [50,30]],
      "stroke_width": 2,
      "created_by": "user_id"
    }
  ],
  "canvas_size": {"width": 2000, "height": 1500}
}
```

**UI Components:**

- HTML5 Canvas or SVG viewport
- Toolbar: pen, shapes, text, eraser, select
- Color picker
- Real-time cursors showing other users
- Zoom/pan controls
- Layer management

**Commands:**

- `/clear` - Clear canvas (admin only)
- `/export` - Export as PNG/SVG
- `/snapshot` - Save current state as version
- `/grid on/off` - Toggle grid overlay

**Collaboration Features:**

- Operational Transform or CRDT for conflict resolution
- Object locking when being edited
- Undo/redo stack per user
- Real-time cursor tracking

### 3. Kanban Board

**Use Cases:** Project management, workflow tracking, sprint planning

**Data Structure:**

```json
{
  "columns": [
    {
      "id": "uuid",
      "title": "To Do",
      "position": 0,
      "limit": null
    },
    {
      "id": "uuid",
      "title": "In Progress",
      "position": 1,
      "limit": 5
    },
    {
      "id": "uuid",
      "title": "Done",
      "position": 2,
      "limit": null
    }
  ],
  "cards": [
    {
      "id": "uuid",
      "column_id": "uuid",
      "title": "Implement login",
      "description": "Add WebAuthn support",
      "position": 0,
      "assignees": ["user_id"],
      "labels": ["backend", "priority-high"],
      "created_by": "user_id",
      "created_at": "timestamp"
    }
  ]
}
```

**UI Components:**

- Multi-column layout
- Draggable cards between columns
- Card detail modal
- Column customization
- Filter/search bar

**Commands:**

- `/card <title>` - Quick add card to first column
- `/move <card_id> <column>` - Move card
- `/column <title>` - Add new column
- `/archive` - Archive completed cards

### 4. Shared Document/Notes

**Use Cases:** Meeting notes, documentation, braindump

**Data Structure:**

```json
{
  "content": "Markdown or rich text content",
  "cursors": {
    "user_id": {"position": 245, "selection": [245, 260]}
  },
  "version": 42,
  "last_edited": "timestamp",
  "edit_history": []
}
```

**UI Components:**

- Text editor (textarea or rich text)
- Real-time collaborative editing
- User cursor indicators
- Version history sidebar
- Outline/TOC navigation

**Commands:**

- `/title <text>` - Set document title
- `/export markdown` - Export as .md file
- `/snapshot` - Create named version
- `/revert <version>` - Restore old version

### 5. Calendar/Schedule

**Use Cases:** Team availability, event planning, meeting coordination

**Data Structure:**

```json
{
  "events": [
    {
      "id": "uuid",
      "title": "Team meeting",
      "start": "2024-03-15T10:00:00Z",
      "end": "2024-03-15T11:00:00Z",
      "attendees": ["user_id"],
      "created_by": "user_id",
      "recurrence": "weekly"
    }
  ],
  "view_settings": {
    "default_view": "week",
    "timezone": "UTC"
  }
}
```

**UI Components:**

- Calendar grid (day/week/month views)
- Event creation modal
- Drag to resize/move events
- Availability overlay
- Timezone selector

### 6. Poll/Survey Room

**Use Cases:** Decision making, feedback collection, voting

**Data Structure:**

```json
{
  "polls": [
    {
      "id": "uuid",
      "question": "Where should we have lunch?",
      "options": [
        {"id": "uuid", "text": "Pizza Place", "votes": ["user_id"]},
        {"id": "uuid", "text": "Sushi Bar", "votes": ["user_id", "user_id"]}
      ],
      "allow_multiple": false,
      "anonymous": false,
      "created_by": "user_id",
      "expires_at": "timestamp",
      "status": "open"
    }
  ]
}
```

**UI Components:**

- Poll creation form
- Active polls list
- Vote buttons/checkboxes
- Results visualization (bar charts)
- Closed polls archive

### 7. Code Review Room

**Use Cases:** Collaborative code review, pair programming discussion

**Data Structure:**

```json
{
  "files": [
    {
      "id": "uuid",
      "filename": "app.py",
      "content": "def main():\n    pass",
      "language": "python",
      "comments": [
        {
          "id": "uuid",
          "line": 5,
          "text": "Should validate input here",
          "author": "user_id",
          "resolved": false
        }
      ]
    }
  ]
}
```

**UI Components:**

- Code editor with syntax highlighting
- Line-by-line commenting
- Diff view for changes
- Comment threads
- Resolve/unresolve toggles

## Plugin API for Room Types

### Initialization

```python
def init_room(room_id, context):
    """Called when room is first created"""
    return {
        "success": True,
        "initial_state": {
            "items": [],
            "settings": {"default": "values"}
        }
    }
```

### State Updates

```python
def handle_event(event_type, data, context):
    """Handle user actions and state changes"""
    if event_type == "add_item":
        # Validate, update state, broadcast to clients
        new_item = {
            "id": generate_uuid(),
            "text": data["text"],
            "completed": False,
            "created_by": context["user_id"],
            "created_at": timestamp()
        }
        return {
            "success": True,
            "state_update": {"items": ["append", new_item]},
            "broadcast": {
                "type": "item_added",
                "item": new_item
            }
        }
```

### UI Rendering

```python
def render_ui(context):
    """Return UI definition for clients"""
    return {
        "success": True,
        "ui_definition": {
            "type": "custom_room",
            "layout": "list",
            "components": [
                {
                    "type": "input",
                    "placeholder": "Add item...",
                    "submit_event": "add_item"
                },
                {
                    "type": "list",
                    "items_source": "state.items",
                    "item_template": {
                        "type": "checkbox_item",
                        "text_field": "text",
                        "checked_field": "completed",
                        "on_check": "toggle_item"
                    }
                }
            ]
        }
    }
```

## Technical Considerations

### State Synchronization

- **Option 1**: Full state broadcast on every change (simple, inefficient)
- **Option 2**: Delta updates with operational transforms (complex, efficient)
- **Option 3**: Event sourcing - broadcast events, clients rebuild state (middle ground)

**Recommendation**: Start with event sourcing. Plugin emits events like `item_added`, clients apply events to local state.

### Persistence

- Core provides generic key-value storage per room
- Plugin serializes state to JSON
- Core handles persistence and retrieval
- Plugin handles state reconstruction

### Conflict Resolution

- **Optimistic UI**: Apply changes immediately, resolve conflicts if server rejects
- **Last-write-wins**: Simple but can lose data
- **CRDTs**: Complex but conflict-free (for whiteboard, document editing)
- **Locking**: Simple but less collaborative (for kanban cards being edited)

### Real-time Collaboration

- Core broadcasts events to all connected users in room
- Plugin decides what to broadcast (full state vs deltas)
- Client applies updates from other users
- Show presence indicators (cursors, selections, "User X is typing...")

## Room Type Discovery

### UI Flow

```
Create Room → Select Type:
  📝 Shared List - For to-do lists and checklists
  🎨 Whiteboard - Draw and brainstorm together
  📋 Kanban Board - Track tasks and workflows
  📄 Shared Document - Collaborative notes
  📅 Calendar - Schedule and coordinate
  💬 Chat (default) - Traditional messaging
```

### Plugin Installation

1. User/admin installs room type plugin
2. Plugin registers with core
3. Appears in room creation dropdown
4. Admin can disable room types globally
5. Per-room permissions can restrict who can create which types

## Hybrid Rooms

**Possibility**: Rooms could support multiple modes

Example: Chat room that can also be a kanban board

- Default view: chat messages
- Switch to kanban view for task tracking
- Both views persist, user chooses which to display
- Commands work in both contexts

Implementation: Room has multiple plugin instances, shares same membership

## Migration Between Room Types

**Scenario**: Convert existing chat room to collaborative list

**Challenges:**

- Different data structures
- Message history incompatible with list items
- Would lose conversation context

**Approaches:**

1. **No migration** - Create new room, archive old one
2. **Export/import** - Plugin provides export format, new room imports
3. **Parallel modes** - Room supports both types simultaneously
4. **Best-effort conversion** - Plugin attempts to extract data (messages → list items)

**Recommendation**: Keep room types immutable after creation. If users want different type, create new room.

## Default Room Type

**Standard Chat Room** is also a plugin, just enabled by default:

- Message list UI
- Text input
- Slash command support
- File attachments
- Emoji reactions
- Message editing/deletion
- Thread replies (future)

This ensures consistency - all room types use same plugin architecture.

## Implementation Priority

**Phase 1: Foundation**

1. Room type registration system
2. Custom state storage per room
3. Event broadcasting to room members
4. Basic plugin lifecycle for room types

**Phase 2: First Room Type**

1. Collaborative list (simplest to implement)
2. Prove out the architecture
3. Learn from limitations

**Phase 3: Expand**

1. Whiteboard/canvas room
2. Kanban board
3. Shared document

**Phase 4: Advanced Features**

1. Conflict resolution improvements
2. Real-time cursors/presence
3. Room type conversion/migration
4. Hybrid/multi-mode rooms

## Key Insight

Room type plugins transform the app from "chat with commands" into a **platform for collaborative workspaces**. Each room becomes a purpose-built tool while sharing the same authentication, permissions, and membership infrastructure. Users aren't limited to chatting - they can choose the right interface for their collaboration needs.
