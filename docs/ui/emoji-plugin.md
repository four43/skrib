# Emoji Picker Plugin

**Plugin ID**: `four43.emoji-picker`

Reusable emoji picker with search, categories, and custom emoji (PNG/GIF) upload support. Exposes a global `window.SkribEmojiPicker` API for use by other plugins and core UI.

## Architecture

```
backend/plugins/four43.emoji-picker/
  manifest.json
  backend/
    plugin.py          # EmojiPickerPlugin class, DB schema
    routes.py          # REST endpoints for custom emoji CRUD + image serving
    services.py        # CustomEmojiStore (DB + filesystem)
    schemas.py         # Pydantic models
  frontend/
    src/plugin.js      # IIFE: picker UI + global SkribEmojiPicker API
    data/emoji.json    # Unicode emoji dataset (~1,800 emoji, static file)
    plugin.css         # Picker styling
    vite.config.js
    package.json
```

## Backend

### Database Schema

Custom emoji metadata stored in plugin-scoped SQLite DB (`data/plugins/four43.emoji-picker.db`):

```sql
CREATE TABLE IF NOT EXISTS custom_emoji (
    shortcode TEXT PRIMARY KEY,
    display_name TEXT NOT NULL,
    filename TEXT NOT NULL,
    content_type TEXT NOT NULL,
    file_size INTEGER NOT NULL,
    category TEXT NOT NULL DEFAULT 'custom',
    uploaded_by TEXT NOT NULL,
    created_at TEXT NOT NULL
);
```

Image files stored at: `data/plugins/four43.emoji-picker/files/{filename}`

### API Endpoints

All routes under `/api/plugins/four43.emoji-picker/`:

| Method | Path | Auth | Description |
| ------ | ---- | ---- | ----------- |
| GET | `/custom-emoji` | user | List all custom emoji |
| GET | `/custom-emoji/{shortcode}` | user | Serve emoji image file |
| POST | `/custom-emoji` | admin | Upload new custom emoji (multipart form) |
| DELETE | `/custom-emoji/{shortcode}` | admin | Delete custom emoji |
| PATCH | `/custom-emoji/{shortcode}` | admin | Update emoji metadata |

### Validation Rules

- **shortcode**: `^[a-z0-9-]+$` (lowercase alphanumeric and hyphens only)
- **file**: max 256KB, must be `image/png` or `image/gif`
- **shortcode uniqueness**: enforced by PRIMARY KEY

## Frontend

### Unicode Emoji Dataset

Static JSON at `frontend/data/emoji.json`, lazy-loaded on first picker open:

```json
{"emoji": "...", "name": "grinning-face", "keywords": ["happy", "smile"], "category": "smileys"}
```

**Categories**: recents, smileys, people, animals, food, travel, activities, objects, symbols, flags, custom

### Picker UI

Floating popover positioned relative to an anchor element:

```
+----------------------------------------------+
| [Search input____________________________]   |
| [Recents] [Smileys] [People] [Animals] ...   |
+----------------------------------------------+
| emoji grid (scrollable)                      |
+----------------------------------------------+
```

- **Search**: Client-side filter on name + keywords, debounced
- **Recents**: Last 32 used emoji in `localStorage`
- **Custom emoji**: Rendered as `<img>` tags
- **Positioning**: Flips if near viewport edge
- **Dismiss**: Click outside or Escape
- **z-index**: 250 (above modals)

### Global API

```js
window.SkribEmojiPicker = {
    // Open picker near anchor element. Returns selected emoji or null.
    open({ anchor, onSelect? }) -> Promise<{ emoji, shortcode, isCustom, url } | null>,

    // Search emoji programmatically (for autocomplete).
    search(query) -> [{ emoji, name, shortcode, isCustom }]
};
```

### Admin Management

Admins see a "Manage" button in the custom category tab, opening a panel to:

- View existing custom emoji with delete buttons
- Upload new custom emoji (shortcode, display name, file, category)

## Integration Points

### Reactions Plugin

- "+" button added to hover bar after quick-emoji row
- Opens picker via `window.SkribEmojiPicker.open()`
- Custom emoji stored as `:shortcode:` in reactions DB, rendered as `<img>`

### Settings Status Emoji

- Replaces `prompt()` in `promptStatusEmoji()` with picker
- Falls back to `prompt()` if plugin not loaded
