# Plugin System Overview

Skrīb uses a plugin architecture to extend functionality without modifying core code. Plugins can add new room types (e.g., chat, whiteboard), cross-cutting features (e.g., typing indicators, reactions), REST endpoints, and frontend UI.

## Plugin Structure

Plugins are provided limited init structure so they can be as isolated as possible from core. At some point these should
be able to run in a separate process or separate docker container, potentially even on a separate server.

They will be provided with the following on startup:

1. A Bus/Interface - They will receive all messages with their namespace on the bus as well as other namespaces they request in the manifest. All messages sent from the plugin will be prefixed with the plugin namespace and delivered to any listeners in core or other plugins that listen to that namespace.
1. Persistence Directory - A directory they can read/write to persist data. Data base operations should be done completely within the plugin and save to that provided directory. This directory should be the {main data directory}/{plugin-id}
1. HTTP API - A way to receive pre-authenticated authenticated API requests. The core will proxy requests to the plugin.

Each plugin lives in `backend/plugins/{plugin-id}/` using GitHub-style `owner.repo` naming:

```
backend/plugins/four43.example-plugin/
  manifest.json           # Required: metadata
  backend/
    plugin.py             # Required: Plugin subclass
    services.py           # Optional: business logic
    routes.py             # Optional: REST endpoints
    ws_handlers.py        # Optional: WebSocket handlers
    database.py           # Optional: DB operations
  frontend/
    plugin.js             # Required: frontend entry point
    plugin.css            # Optional: styles
```

### Manifest

The `manifest.json` declares metadata and frontend integration:

```json
{
  "id": "four43.message-reactions",
  "name": "Message Reactions",
  "version": "1.0.0",
  "description": "Add emoji reactions to messages",
  "author": "Four43",
  "entry": "frontend/plugin.js",
  "permissions": ["websocket.send", "websocket.receive", "dom.messages"],
  "hooks": {"onRoomChange": true}
}
```

The `entry` field is the path (relative to the plugin directory) to the frontend script. The `permissions` and `hooks` fields are declarative metadata.
