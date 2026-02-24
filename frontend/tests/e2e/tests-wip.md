

## room-types.spec.js

Room type plugin functionality (chat and todo).

- Create a chat room and send a message
- Create a todo room and add an item

---

## room-selection-persistence.spec.js

Room selection persistence across login sessions via `skrib_ui_prefs` in localStorage.

- Re-login restores previously selected room
- First login with rooms but no previous selection shows the first room
- First login with no rooms shows blank state

---

## dm-room-types.spec.js

Direct message room creation with different room type plugins.

- Create a chat DM and verify chat UI
- Create a todo DM and verify todo UI
