# Emoji Picker Plugin (`four43.emoji-picker`)

Searchable emoji picker with categories, custom emoji support, and inline autocomplete for the chat input.

## Features

### Emoji Picker Dialog

A floating picker opened via button or API call (`window.SkribEmojiPicker.open()`).

- **Search**: Text input filters emoji by name and keywords
- **Categories**: Recents, Smileys, People, Animals, Food, Travel, Activities, Objects, Symbols, Flags, Custom
- **Recents**: Last 32 selected emoji persisted in localStorage
- **Custom Emoji (Admin)**: Admins can upload/delete custom emoji (PNG/GIF, max 256KB, shortcode pattern `[a-z0-9-]+`)
- **Positioning**: Picker appears near the anchor element, flipping above/below as needed

### Inline Emoji Autocomplete

Typing `:` followed by at least 2 characters in the chat input triggers an inline autocomplete dropdown — similar to the `/command` and `@mention` autocomplete.

- **Trigger**: `:` preceded by whitespace or at position 0, followed by `[a-z0-9-]` characters
- **Search**: Filters both unicode and custom emoji by name/keywords as the user types
- **Dropdown**: Appears above the input (matching command dropdown positioning/styling), shows up to 5 results with no scrollbar. Best match is at the bottom (closest to the input); worse matches stack upward.
- **Navigation**: Arrow Up/Down to move selection (Down moves toward worse matches, Up toward better), Enter/Tab to accept, Escape to dismiss
- **Mouse**: Click an item to select it
- **Insertion**: Replaces `:query` with `:shortcode:` markdown at cursor position (e.g. `:grinning-face:`)
- **Dismissal**: Dropdown closes on blur, Escape, space in query, or when the `:` trigger is removed

### Emoji Markdown Format

Emoji are inserted as `:shortcode:` markdown rather than unicode characters. This ensures consistent rendering across platforms and allows custom emoji to be referenced by name.

### Shortcode Rendering in Messages

When messages are displayed, `:shortcode:` tokens are resolved to visual emoji:

- **Unicode emoji**: Rendered as the character inside a `<span class="emoji-shortcode">` with a title tooltip
- **Custom emoji**: Rendered as an `<img class="emoji-custom-inline">` with the custom image
- **Unknown shortcodes**: Left as-is (no replacement)
- Resolution only applies to text nodes in the HTML — shortcodes inside code blocks or HTML attributes are not affected

The chat plugin calls `resolveShortcodes()` in its rendering pipeline after markdown parsing.

## API

### `window.SkribEmojiPicker`

| Method | Description |
|--------|-------------|
| `open({ anchor, onSelect })` | Opens the picker dialog near `anchor`. Returns `Promise<{emoji, shortcode, isCustom, url} \| null>` |
| `search(query)` | Returns `Array<{emoji, name, shortcode, isCustom}>` matching the query |
| `resolveShortcodes(html)` | Replaces `:shortcode:` tokens in HTML with emoji characters/images. Unknown shortcodes are left as-is. |

## Backend

- `GET /api/plugins/four43.emoji-picker/custom-emoji` — List custom emoji
- `GET /api/plugins/four43.emoji-picker/custom-emoji/{shortcode}` — Serve custom emoji image
- `POST /api/plugins/four43.emoji-picker/custom-emoji` — Upload (admin only)
- `PATCH /api/plugins/four43.emoji-picker/custom-emoji/{shortcode}` — Update metadata (admin only)
- `DELETE /api/plugins/four43.emoji-picker/custom-emoji/{shortcode}` — Delete (admin only)

## File Structure

```
backend/plugins/four43.emoji-picker/
  manifest.json
  backend/
    plugin.py          # Plugin init, DB schema
    routes.py          # Custom emoji CRUD endpoints
    schemas.py         # Pydantic models
    services.py        # Storage and validation logic
  frontend/
    src/plugin.js      # Picker UI, inline autocomplete, public API
    plugin.css         # All styles (picker, dropdown, admin panel)
    data/emoji.json    # Unicode emoji database
    vite.config.js
    package.json
    dist/plugin.js     # Built output
```
