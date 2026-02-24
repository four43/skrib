
## registration-modes.spec.js

Registration mode enforcement (closed, invite_only). Tests modify the server's registration mode and restore it via `afterEach`.

- Closed mode disables registration form with "Registration is currently closed" message
- Closed mode rejects backend registration attempt with 403
- invite_only mode disables form without invite token
- invite_only mode allows registration with valid invite token
- Invite token is consumed after use (reuse rejected)
- Login page hides register button in closed mode

---

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
