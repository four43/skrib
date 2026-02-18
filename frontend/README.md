# Frontend - Skrīb

Vanilla JavaScript (ES modules) + HTML + CSS, built with Vite.

## Directory Structure

```
frontend/
├── src/
│   ├── chat.js        # Main chat logic (WebSocket, rooms, messages)
│   ├── login.js       # Login page (WebAuthn assertion)
│   ├── register.js    # Registration page (WebAuthn credential creation)
│   ├── utils.js       # Shared utilities (escapeHtml, API helpers)
│   └── style.css      # All styles (desktop + mobile)
├── index.html         # Login page
├── login.html         # Login page (alternate entry)
├── register.html      # Registration page
└── chat.html          # Main chat interface
```

## Page Flow

1. `index.html` / `login.html` - User logs in with passkey
2. `register.html` - New users register (receive approval code to give admin)
3. `chat.html` - Main chat interface (requires authentication)

## State Management (chat.js)

```javascript
let sessionToken = null;        // Auth token (Base64)
let currentUsername = null;      // Logged-in username
let currentRole = null;          // 'user' or 'admin'
let currentRoom = null;          // Selected room ID
let lastMessageId = 0;           // Last seen message ID (for dedup)
let websocket = null;            // Per-room WebSocket connection
let roomsWs = null;             // Room list subscription WebSocket
let roomMeta = {};              // Cache of room_id -> { room_type, display_name, members }
let reconnectAttempts = 0;       // Reconnection counter
let maxReconnectAttempts = 5;    // Max reconnect tries
let userColors = {};             // Cache of username -> color mappings
```

## WebSocket Connections

### Per-room chat (`/api/rooms/{room_id}/ws?token=...`)

```javascript
// Client -> Server
{ type: "message", message: "Hello!" }

// Server -> Client
{ type: "connected", room: "general", username: "alice" }
{ type: "message", data: { id: 42, username: "bob", message: "Hi!", timestamp: "..." } }
{ type: "error", message: "Invalid JSON" }
```

### Room list subscription (`/api/rooms?token=...`)

Same path as `GET /api/rooms`, upgraded to WebSocket. Pushes updates when the user's room list changes (new DM, channel created/deleted).

```javascript
// Server -> Client
{ type: "update" }  // Client should reload room list
```

## Key Behaviors

- **Session Check**: Auto-redirects to login if not authenticated
- **Room List**: Sidebar split into Channels (`#name`) and Direct Messages (other user's name)
- **Room Selection**: Clears messages, loads history via HTTP, connects WebSocket
- **DM Creation**: User picker modal, `POST /rooms/dm`, auto-selects new DM room
- **Room List Subscription**: WebSocket on `/api/rooms` auto-reloads sidebar when rooms change
- **Channel Validation**: Names must be lowercase + hyphens (e.g. `my-channel`), validated client & server
- **Message Display**: Unified `displayMessage()` for both history and real-time
- **Reconnection**: Exponential backoff (1s, 2s, 4s, 8s, 10s max), up to 5 attempts
- **Message Deduplication**: Tracks `lastMessageId`; HTTP uses `?since={lastMessageId}` (exclusive)
- **Mobile Sidebar**: Slide-out room list, auto-hides after room selection, hamburger toggle

## Mobile Support

- Responsive layout, breakpoint at 768px
- Sidebar hidden by default on mobile, shown when no room selected
- Hides on room select or overlay tap

## Environment Variables

- `VITE_API_URL` - API base URL (default: `/api`)

## Running

```bash
npm install
npm run dev  # Vite dev server on port 5173
```

## Adding Features

- Update `chat.js` and expose functions via `window.{funcName}`
- Styles go in `style.css`
- New pages need corresponding HTML files
