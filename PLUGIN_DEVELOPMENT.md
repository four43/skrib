# Plugin & Theme Development Guide

This guide covers how to create, package, and distribute plugins and themes for Mini Chat.

## Architecture Overview

Mini Chat uses a zip-based plugin system where plugins are:
1. Developed as self-contained directories
2. Zipped for distribution
3. Extracted to `backend/plugins/` or `backend/themes/`
4. Served by the backend
5. Dynamically loaded by the frontend

## Plugin Structure

### Directory Layout

```
com.yourcompany.plugin-name/
  manifest.json           # Required: Plugin metadata
  frontend/
    plugin.js            # Required: Main entry point
    plugin.css           # Optional: Styles
  backend/               # Optional: Server-side code
    __init__.py
    routes.py
  assets/                # Optional: Images, fonts, etc.
    icon.png
  README.md              # Recommended: Documentation
```

### Manifest Format

**`manifest.json`:**
```json
{
  "id": "com.yourcompany.plugin-name",
  "name": "Plugin Display Name",
  "version": "1.0.0",
  "description": "What this plugin does",
  "author": "Your Name",
  "entry": "frontend/plugin.js",
  "namespace": "pluginname",
  "permissions": [
    "websocket.send",
    "websocket.receive",
    "dom.message-area"
  ],
  "hooks": {
    "onRoomChange": true,
    "onMessageSend": true
  }
}
```

**Fields:**
- `id` (required): Unique identifier in reverse domain notation
- `name` (required): Display name for users
- `version` (required): Semantic version (e.g., "1.0.0")
- `description` (required): Brief description
- `author` (required): Plugin author
- `entry` (required): Path to main JavaScript file
- `namespace` (required): Short namespace for WebSocket events
- `permissions` (optional): Required permissions
- `hooks` (optional): Lifecycle hooks the plugin uses

### Frontend Plugin Code

**`frontend/plugin.js`:**
```javascript
/**
 * Your Plugin Name
 */

const YourPlugin = (function() {
    let context = null;

    /**
     * Initialize the plugin
     * @param {object} ctx - Plugin context
     */
    async function init(ctx) {
        context = ctx;
        console.log('[YourPlugin] Initializing...');

        // Register WebSocket message handler
        ctx.registerHandler('yournamespace', handleMessage);

        // Set up UI elements
        setupUI();

        console.log('[YourPlugin] Initialized');
    }

    /**
     * Handle incoming WebSocket messages
     */
    function handleMessage(action, data, ctx) {
        console.log('[YourPlugin] Received:', action, data);

        if (action === 'your_event') {
            // Handle your event
        }
    }

    /**
     * Set up UI elements
     */
    function setupUI() {
        // Create and inject your UI elements
    }

    /**
     * Clean up when room changes (optional)
     */
    function onRoomChange() {
        // Reset state for new room
    }

    // Public API
    return {
        init,
        onRoomChange
    };
})();

// Export for plugin loader
window.YourPlugin = YourPlugin;
```

### Context API

The plugin context (`ctx`) provides:

```javascript
{
    // Register WebSocket message handler
    registerHandler: (namespace, handler) => void,

    // Send WebSocket message
    sendMessage: (message) => void,

    // Get current room ID
    currentRoom: () => string,

    // Get current username
    currentUsername: () => string,

    // Display system message
    displaySystemMessage: (message, type) => void
}
```

### WebSocket Messages

**Sending:**
```javascript
ctx.sendMessage({
    type: 'yournamespace.action',
    room_id: ctx.currentRoom(),
    data: { ... }
});
```

**Receiving:**
```javascript
ctx.registerHandler('yournamespace', (action, data, ctx) => {
    // action = 'user_action' (from 'yournamespace.user_action')
    // data = message payload
});
```

## Theme Structure

### Directory Layout

```
com.yourcompany.theme-name/
  manifest.json           # Required: Theme metadata
  css/
    base.css             # Base styles and CSS variables
    components.css       # UI component styles
    rooms.css            # Room-specific styles
  assets/
    logo.png
    favicon.ico
    background.jpg
  README.md
```

### Theme Manifest

**`manifest.json`:**
```json
{
  "id": "com.yourcompany.theme-name",
  "name": "Theme Name",
  "version": "1.0.0",
  "description": "Theme description",
  "author": "Your Name",
  "type": "theme",
  "variants": [
    {
      "id": "dark",
      "name": "Dark",
      "default": true
    },
    {
      "id": "light",
      "name": "Light"
    }
  ],
  "assets": {
    "css": [
      "css/base.css",
      "css/components.css",
      "css/rooms.css"
    ],
    "images": {
      "logo": "assets/logo.png",
      "favicon": "assets/favicon.ico",
      "background": "assets/background.jpg"
    }
  },
  "customization": {
    "colors": {
      "primary": {
        "type": "color",
        "default": "#6366f1",
        "description": "Primary accent color"
      }
    },
    "fonts": {
      "family": {
        "type": "select",
        "options": ["system-ui", "Inter", "Roboto"],
        "default": "system-ui"
      }
    }
  }
}
```

### Theme CSS

**Required CSS Variables:**
```css
:root {
    /* Colors */
    --primary-color: #6366f1;
    --background-color: #1e1e2e;
    --text-color: #ffffff;
    --border-color: #2a2a3e;
    --hover-color: #2a2a3e;

    /* Fonts */
    --font-family: system-ui;
    --font-size: 14px;

    /* Spacing */
    --spacing-xs: 4px;
    --spacing-sm: 8px;
    --spacing-md: 16px;
    --spacing-lg: 24px;
}
```

## Development Workflow

### 1. Create Your Plugin/Theme

```bash
mkdir -p backend/plugins/com.yourcompany.plugin-name/frontend
cd backend/plugins/com.yourcompany.plugin-name

# Create manifest
cat > manifest.json << 'EOF'
{
  "id": "com.yourcompany.plugin-name",
  "name": "My Plugin",
  "version": "1.0.0",
  "description": "My awesome plugin",
  "author": "Your Name",
  "entry": "frontend/plugin.js",
  "namespace": "myplugin",
  "permissions": ["websocket.send"],
  "hooks": {}
}
EOF

# Create plugin code
cat > frontend/plugin.js << 'EOF'
const MyPlugin = (function() {
    async function init(ctx) {
        console.log('[MyPlugin] Initialized');
    }
    return { init };
})();
window.MyPlugin = MyPlugin;
EOF
```

### 2. Test Locally

```bash
# Backend serves from backend/plugins/ automatically
# No restart needed - just refresh the frontend

# Check plugin loaded
# Open browser console, should see: [Plugins] Loading plugin: My Plugin
```

### 3. Package for Distribution

```bash
cd backend/plugins
zip -r com.yourcompany.plugin-name.zip com.yourcompany.plugin-name/

# Distribute the .zip file
```

### 4. Installation

Users extract to `backend/plugins/`:
```bash
cd backend/plugins
unzip com.yourcompany.plugin-name.zip
```

## Example Plugins

### Typing Indicators

See: `backend/plugins/com.four43.chat-typing/`

**Features:**
- Real-time typing notifications
- Debounced events
- Multiple user support
- Display name integration

### Custom Reactions

**Concept:** Add emoji reactions to messages

```javascript
const ReactionsPlugin = (function() {
    async function init(ctx) {
        ctx.registerHandler('reactions', handleReaction);
        attachReactionButtons();
    }

    function handleReaction(action, data, ctx) {
        if (action === 'message_reaction') {
            updateReactionUI(data.message_id, data.emoji, data.count);
        }
    }

    function attachReactionButtons() {
        // Add reaction buttons to messages
    }

    return { init };
})();
window.ReactionsPlugin = ReactionsPlugin;
```

## Security Considerations

### Permissions

Plugins should declare required permissions in manifest:
- `websocket.send` - Send WebSocket messages
- `websocket.receive` - Receive WebSocket messages
- `dom.message-area` - Modify message area
- `dom.input` - Access message input
- `storage.local` - Use localStorage

### Path Traversal Prevention

Backend routes prevent path traversal:
```python
# ❌ BAD
/api/plugins/distributed/com.example/file/../../../secrets

# ✅ GOOD - Resolved paths are validated against plugin directory
```

### Content Security

- Plugins served with appropriate MIME types
- CSS/JS validated before serving
- No inline script execution

## API Reference

### Backend Endpoints

**List Plugins:**
```
GET /api/plugins/distributed
Response: [{ id, name, version, ... }]
```

**Get Plugin Manifest:**
```
GET /api/plugins/distributed/{plugin_id}/manifest
Response: { id, name, version, ... }
```

**Get Plugin File:**
```
GET /api/plugins/distributed/{plugin_id}/file/{path}
Response: File content with appropriate MIME type
```

**List Themes:**
```
GET /api/themes/
Response: [{ id, name, version, ... }]
```

**Get Theme File:**
```
GET /api/themes/{theme_id}/file/{path}
Response: File content (CSS, images, etc.)
```

### Frontend Plugin Loader

```javascript
// Plugins are loaded automatically on page load
// Access via window object:
window.TypingPlugin.init(context);
```

## Troubleshooting

### Plugin Not Loading

1. Check browser console for errors
2. Verify manifest.json is valid JSON
3. Confirm entry path matches actual file
4. Check namespace matches in manifest and code

### WebSocket Messages Not Received

1. Verify namespace registered correctly
2. Check backend logs for routing
3. Confirm message type format: `namespace.action`

### CSS Not Applying

1. Check CSS file path in manifest
2. Verify CSS variables are defined
3. Check browser dev tools for CSS conflicts

## Best Practices

1. **Namespace Everything** - Use plugin ID as prefix for DOM IDs, CSS classes
2. **Clean Up** - Implement lifecycle hooks to clean up on room change
3. **Error Handling** - Wrap async operations in try/catch
4. **Logging** - Use consistent log prefix: `[PluginName]`
5. **Documentation** - Include README.md with examples
6. **Versioning** - Follow semantic versioning
7. **Testing** - Test with multiple users, rooms, and scenarios

## Resources

- Example Plugin: `backend/plugins/com.four43.chat-typing/`
- Example Theme: `backend/themes/com.four43.theme-default/`
- WebSocket Protocol: `docs/websocket-protocol.md`
- API Documentation: `backend/README.md`
