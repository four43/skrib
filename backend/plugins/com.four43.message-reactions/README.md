# Message Reactions Plugin

Add emoji reactions to messages with real-time synchronization across all connected users.

## Features

- 🎉 React to any message with emojis
- ⚡ Real-time updates via WebSocket
- 💾 Server-side persistence in SQLite
- 👥 See who reacted to each message
- 🎨 Clean, modern UI with animations
- 🌙 Dark mode support

## Installation

This plugin is already installed in the standard Mini Chat distribution.

To install manually:

```bash
# Extract plugin to plugins directory
cd backend/plugins
unzip com.four43.message-reactions.zip

# Restart backend (database tables are created automatically)
```

## Usage

### For Users

1. **Add Reaction**: Click the `+` button below any message
2. **Choose Emoji**: Select from the emoji picker
3. **Toggle Reaction**: Click an existing reaction to add/remove your reaction
4. **See Who Reacted**: Hover over a reaction to see usernames

### For Developers

#### Database Schema

The plugin creates a `message_reactions` table:

```sql
CREATE TABLE message_reactions (
    message_id INTEGER NOT NULL,
    username TEXT NOT NULL,
    emoji TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (message_id, username, emoji),
    FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE,
    FOREIGN KEY (username) REFERENCES users(username) ON DELETE CASCADE
)
```

#### REST API Endpoints

**Add Reaction:**
```http
POST /api/reactions/add
Content-Type: application/json
Authorization: Bearer {token}

{
  "message_id": 123,
  "emoji": "👍"
}
```

**Remove Reaction:**
```http
POST /api/reactions/remove
Content-Type: application/json
Authorization: Bearer {token}

{
  "message_id": 123,
  "emoji": "👍"
}
```

**Get Message Reactions:**
```http
GET /api/reactions/message/123
```

Response:
```json
[
  {
    "emoji": "👍",
    "usernames": ["alice", "bob"],
    "count": 2
  },
  {
    "emoji": "❤️",
    "usernames": ["charlie"],
    "count": 1
  }
]
```

**Get Multiple Messages' Reactions:**
```http
GET /api/reactions/messages?message_ids=123,124,125
```

Response:
```json
{
  "123": [{"emoji": "👍", "usernames": ["alice"], "count": 1}],
  "124": [{"emoji": "❤️", "usernames": ["bob", "charlie"], "count": 2}]
}
```

#### WebSocket Events

**Client → Server:**

```javascript
// Add reaction
{
  type: 'reactions.add',
  room_id: 'general',
  message_id: 123,
  emoji: '👍'
}

// Remove reaction
{
  type: 'reactions.remove',
  room_id: 'general',
  message_id: 123,
  emoji: '👍'
}
```

**Server → Client:**

```javascript
// Reaction added
{
  type: 'reactions.added',
  room_id: 'general',
  data: {
    message_id: 123,
    emoji: '👍',
    username: 'alice'
  }
}

// Reaction removed
{
  type: 'reactions.removed',
  room_id: 'general',
  data: {
    message_id: 123,
    emoji: '👍',
    username: 'alice'
  }
}
```

## Architecture

### Backend Components

- **`database.py`**: Database schema and CRUD operations
- **`routes.py`**: REST API endpoints
- **`ws_handlers.py`**: WebSocket real-time event handlers
- **`__init__.py`**: Plugin initialization and registration

### Frontend Components

- **`plugin.js`**: React UI logic and WebSocket integration
- **`plugin.css`**: Styling with dark mode support

### Data Flow

1. User clicks emoji → WebSocket message sent
2. Server validates and persists to database
3. Server broadcasts to all users in room
4. All clients update UI in real-time
5. On page load, reactions fetched via REST API

## Customization

### Add More Emojis

Edit `frontend/plugin.js`:

```javascript
const COMMON_EMOJIS = ['👍', '❤️', '😂', '😮', '😢', '🎉', '🚀', '👀', '🔥', '💯'];
```

### Styling

Modify `frontend/plugin.css` to match your theme:

```css
.com-four43-reaction-btn {
    /* Customize appearance */
    border-radius: 16px;
    padding: 4px 10px;
}
```

## Performance

- Reactions are loaded once per message on initial render
- WebSocket updates are instantaneous (no polling)
- Database queries use indexes for fast lookups
- Batch API available for loading reactions for multiple messages

## Security

- All endpoints require authentication
- Users can only add/remove their own reactions
- SQL injection prevented via parameterized queries
- WebSocket messages validated before processing

## Troubleshooting

**Reactions not appearing:**
- Check browser console for errors
- Verify WebSocket connection is active
- Check backend logs for database errors

**Reactions not syncing:**
- Ensure you're connected to the same room
- Check WebSocket namespace is registered
- Verify database table was created

**Database errors:**
- Check that `message_id` exists in messages table
- Verify user is authenticated
- Check database file permissions

## License

Same as Mini Chat core (check root LICENSE file)

## Credits

Developed by Four43 for Mini Chat
