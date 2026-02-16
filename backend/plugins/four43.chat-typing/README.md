# Typing Indicators Plugin

Shows real-time typing indicators when users are typing in chat rooms.

## Features

- Real-time typing notifications via WebSocket
- Debounced typing events (500ms)
- Auto-stop after 3 seconds of inactivity
- Supports multiple simultaneous typers
- Display names integration

## Installation

1. Extract the plugin to `backend/plugins/four43.chat-typing/`
2. Restart the backend server
3. The plugin will be automatically loaded by the frontend

## Permissions

- `websocket.send` - Send typing events to server
- `websocket.receive` - Receive typing events from other users
- `dom.input` - Attach listeners to message input
- `dom.message-area` - Insert typing indicator UI

## WebSocket Events

### Outgoing
- `typing.start` - User started typing
- `typing.stop` - User stopped typing

### Incoming
- `typing.user_typing` - Another user's typing status changed
