# E2E Test Summary

End-to-end tests using Playwright with Chromium. Each Playwright worker gets an isolated backend with its own temp SQLite database (see `fixtures.js`). Virtual WebAuthn authenticators are created via Chrome DevTools Protocol (CDP).

Run all tests: `frontend/util/test-e2e`
Run a single file: `frontend/util/test-e2e tests/e2e/<file>.spec.js`

Those scripts each build the frontend using vite.

YOU MUST write tests that are fully isolated from one another so these may all run in a parallel.

---

## fixtures.js

Shared test fixtures providing:

- **`_workerBackend`** (worker-scoped) — Spawns an isolated uvicorn backend per Playwright worker on port 8800+workerIndex with a temp data directory. Serves the built frontend from `dist/`.
- **`baseURL`** — Overridden to point at the per-worker backend.
- **`authenticatedPage`** — A Page with a CTAP2 virtual WebAuthn authenticator (discoverable credentials, auto-verified). Torn down after test.
- **`registeredUser`** — Registers a fresh user via the full UI flow (register form, passkey enrollment). Returns `{ page, username }`.

Also create a state where there are 3 successfully registered users in the system for tests.

Each shared fixture must be able to create multiple users. The first user that's created is auto approved, but subsequent users will need to be approved, or the server must be switched to `open` registration mode for those tests.

---

## registration-and-authentication.spec.js

Core registration, login, and chat functionality.

Create a test for each of these scenarios:

- Full registration flow - Login page renders with a Register button, register form has username, 2 new password/passphrase fields.
  - User A tries invalid user name with reserved words and gets error
  - User A tries too short username and gets error
  - User A tries too long username and gets error
  - User A tries mismatched passphrase and gets error
  - User A successfully tries valid username and passphrase and registers successfully, then is prompted to create a passkey credential
    - Passkey registration fails, shows helpful error.
    - User A creates passkey credential and is logged in, sees chat UI, sends a message "Hello World" and sees it in the chat.
      - User A logs out and logs in again with passkey, sees chat UI
      - For another, new user, User B, start from login page
        - User B tries to register with a username that already exists, duplicate username error
        - User B successfully registers with a different username, creates passkey, sees pending registration page.
          - Admin (User A) approves User B. User B can log in with passkey and sees chat UI
            - User B logs out, clears all local storage (IndexDB and others), logs in again and is prompted with a recovery option
              (since the passkey credential is gone but the server has it). User A successfully recovers by entering the correct
              passphrase, sees User A's "Hello World" message
        chat UI, and old messages are still there that says Hello World.
          - Admin (User A) declines User B, User B cannot log in
      - User A logs out, clears all local storage (IndexDB and others), logs in again and is prompted with a recovery option (since
        the passkey credential is gone but the server has it). User A successfully recovers by entering the correct passphrase, sees
        chat UI, and old messages are still there that says Hello World.
      - User A logs out, clears all local storage, tries to log in again but enters wrong passphrase, gets error and stays on login
        page.
  - User tries to log in with invalid username and gets error
  - User tries to log in with valid username but no passkey and gets error
  - User tries to log in with valid username but wrong passkey and gets error
  - Unauthenticated user tries to access app.html and is redirected to login page

## core.spec.js

This is for core functionality, once the user is logged in. This tests assumes a state of having at least 3 registered users (an admin, User A, and 2 other users, User B and User C) in the system, so it can test interactions between them. The tests in this file should be focused on core room management functionality. It leans on the chat plugin for testing, but the focus is on core room management and not plugin-specific behavior.

- User A creates a room "test-room-a", user A is the only one in the room.
  - User A can send a message "Hello World" to the room, the message is visible to User A.
    - User A can invite User B to the room, a small invite message shows in the room
      - User B has the room "test-room-a" in their room list, and can see User A's "Hello World" message
    - User A can invite User B and User C to the room, using the Add User button and pop up. Those users can see the existing
      messages in the room when they join.
      - User B can send a message "Hi User A" and User A can see it
      - User C can send a message "Hi User A and B" and User A and User B can see it
  - User B creates a room "test-room-b", with no messages.
    - They can invites User A, a message displaying that User A was invited appears in the room.
      - User A can see the room in their room list, but doesn't see any messages until they click into the room.
      - User A can click into the room and see no messages (since user B never sent any). User A can send a message "Hello User B" and User B can see it.
- User A creates a room "topic-room" and invites User B.
  - User A sets the topic to "Welcome to topic room" via /topic command. The topic appears in the room header for User A.
    - User B sees the updated topic in their room header (real-time via WebSocket).
    - User B (a regular member) tries to set the topic and gets a permission error.
  - User A sets the topic to "Welcome to topic room" via room settings UI button and page. When navigating back to the room, the
    changed topic is visible.
    - User B sees the updated topic in their room header (real-time via WebSocket).
    - User B (a regular member) navigates to the room settings UI via button, but the topic input is disabled and they cannot change
      it.
- User A creates a room "leave-room" and invites User B and User C.
  - User B sends a message, then leaves the room via /leave command.
    - "leave-room" disappears from User B's room list.
    - User A and User C see a system message that User B left.
    - User B can no longer access the room or send messages to it.
- User A creates a room "kick-room" and invites User B and User C.
  - User A kicks User B via /kick command.
    - "kick-room" disappears from User B's room list.
    - User A and User C see a system message that User B was kicked.
    - User C (a regular member) tries to /kick User A and gets a permission error.
- User A creates a room "delete-room" and invites User B.
  - User A sends a message so the room has content.
  - User A deletes the room.
    - The room disappears from both User A's and User B's room lists.
    - User B (non-owner) creates a room "nodelete-room" with User A — User A cannot delete it (only owner/admin).
- User A creates a DM with User B.
  - Both users can see the DM in their room list with the other user's name as the display name.
  - User A sends a message "DM hello" and User B can see it.
  - User B tries /leave on the DM and gets an error (cannot leave DMs).
  - User A creates another DM with User B — it returns the same existing DM, not a duplicate.
  - User A creates a group DM with User B and User C. All three see it in their room lists.
- User A creates a room "unread-room" and invites User B.
  - User B is viewing a different room. User A sends 3 messages.
    - User B sees an unread count badge on "unread-room" in the room list.
    - User B clicks into "unread-room" and the unread count clears.
    - User A sends another message while User B is in the room — no unread badge (already viewing).
- User A creates a room "realtime-room" and invites User B.
  - User A and User B both have the room open. User A sends "live message".
    - The message appears in User B's chat without refreshing the page (WebSocket delivery).
  - User B sends "reply message" — it appears for User A in real-time as well.
- User A is in "test-room-a", navigates to "test-room-b", then refreshes the page.
  - After refresh, User A is still viewing "test-room-b" (room selection persists).

---

## chat-messages.spec.js

Tests for the chat room type plugin (four43.room-type-chat). Covers message editing, deletion, and message-specific UI. Assumes 3 registered users (admin User A, User B, User C).

- User A creates a room "edit-room" and invites User B.
  - User A sends "original message". User A clicks the message and sees a hover bar with Edit (pencil icon) and a "..." more menu.
    - User A clicks Edit: the message content becomes an inline editable text field with the original text.
      - User A changes it to "edited message" and presses Enter. The message updates in place and shows an "(edited)" indicator.
      - User B sees the updated message text and "(edited)" indicator in real-time (no refresh).
    - User A clicks Edit, then presses Escape — edit is cancelled, original text remains.
  - User B sends "User B's message". User B clicks it and sees Edit and "..." menu.
    - User A clicks User B's message — User A does NOT see Edit (not the author), but sees "..." with Delete (User A is admin/owner).
    - User B clicks Edit on their own message, changes it to "User B edited" and saves — both users see the update.
  - User A sends a message, then clicks "..." and selects Delete.
    - The message content is replaced with "[deleted]" for both User A and User B.
    - The deleted message no longer shows a hover bar when clicked.
  - User A deletes User B's message via "..." menu (admin privilege).
    - The message shows "[deleted]" for both users.
  - User B sends a message. User B clicks "..." and selects Delete — message shows "[deleted]".
    - User C is invited. User C sends a message. User B clicks User C's message — User B does NOT see a delete option (User B is a regular member, not op/admin).
- User A creates a room "history-room" and invites User B.
  - User A sends 5 messages. User B opens the room and sees all 5 messages in order.
  - User B refreshes the page — all 5 messages are still visible (loaded from server history).
- User A creates a room "read-receipt-room" and invites User B.
  - User B is in a different room. User A sends 3 messages.
  - User B sees an unread badge on "read-receipt-room".
  - User B clicks into the room — the unread badge clears.
  - User B navigates away, then back — no unread badge (read position was persisted).
  - User A sends a new message while User B is away — badge reappears with count 1.

## todo-rooms.spec.js

Tests for the todo list room type plugin (four43.room-type-todo). Assumes 3 registered users (admin User A, User B, User C).

- User A creates a room "todo-room" with room type "todo". The room opens showing a todo list UI (not a chat input).
  - The UI shows filter buttons: "All", "Active", "Done".
  - The UI shows a task counter (e.g., "0 active, 0 done").
  - An empty state message is visible (e.g., "No tasks yet").
  - User A types a title "Buy groceries" in the new task input and presses Enter (or clicks Add).
    - The task appears in the list with title "Buy groceries", User A's username, and today's date.
    - The counter updates to "1 active, 0 done".
  - User A adds another task "Walk the dog" with description "Take the long route".
    - Both tasks are visible. The second task shows its description below the title.
    - Counter: "2 active, 0 done".
  - User A tries to add a task with an empty title — nothing is added (title required).
- User A invites User B to "todo-room".
  - User B opens the room and sees both existing tasks.
  - User B adds a task "Reply to emails". All three tasks are visible to both users.
  - User B clicks the checkbox on "Buy groceries" to mark it done.
    - The task shows as completed (checked) for both User A and User B in real-time.
    - Counter updates to "2 active, 1 done" for both users.
  - User A clicks the "Done" filter — only "Buy groceries" is shown.
  - User A clicks the "Active" filter — only "Walk the dog" and "Reply to emails" are shown.
  - User A clicks the "All" filter — all three tasks are shown.
  - User A unchecks "Buy groceries" — it returns to active state for both users.
- User A clicks Edit on "Walk the dog" (User A is the creator).
  - The task becomes an inline edit form with title and description fields and Save/Cancel buttons.
  - User A changes the title to "Walk the dog later" and clicks Save.
    - The task updates for both users in real-time.
  - User B tries to click Edit on "Walk the dog later" — User B does NOT see an Edit button (User B is not the creator, not an op/admin).
  - User B CAN click the checkbox on any task (toggling done is allowed for all members).
  - User B clicks Edit on "Reply to emails" (User B is the creator) — edit form appears, User B can save changes.
- User A clicks Delete on "Buy groceries" (User A is the creator).
  - A confirmation dialog appears. User A confirms.
  - The task is removed from the list for both users in real-time.
  - Counter updates accordingly.
  - User B tries to delete "Walk the dog later" — User B does NOT see a Delete button (not creator/op/admin).
- User A refreshes the page. All remaining tasks are still present (persisted to database).
- User A invites User C. User C opens the room and sees the current task list.
  - User C adds a task. All three users see it appear in real-time.

## message-reactions.spec.js

Tests for the emoji reactions plugin (four43.message-reactions). Assumes 3 registered users (admin User A, User B, User C).

- User A creates a room "reactions-room" and invites User B and User C.
  - User A sends "React to this message".
  - User A clicks the message — the hover bar shows emoji reaction buttons (including at minimum a thumbs-up).
    - User A clicks the thumbs-up (👍) emoji button.
      - A reaction pill appears below the message showing "👍 1".
      - The pill is highlighted (current user has reacted).
      - User B and User C see the "👍 1" pill appear in real-time.
    - User B clicks the message, then clicks 👍.
      - The pill updates to "👍 2" for all three users.
      - Hovering/inspecting the pill shows both User A and User B's usernames.
    - User A clicks the 👍 pill to toggle off their reaction.
      - The pill updates to "👍 1" for all users. The pill is no longer highlighted for User A.
    - User B clicks the 👍 pill to remove their reaction.
      - The pill disappears entirely (count went to 0).
  - User A sends "Multi-react message".
    - User A adds 👍, User B adds ❤️, User C adds 👍 and 😂.
      - The message shows three pills: "👍 2", "❤️ 1", "😂 1".
      - Each pill is highlighted only for the user who reacted with that emoji.
  - User A refreshes the page — all reactions are still visible (loaded from server).
  - User B sends "User B's message". User C adds a reaction to it — the reaction appears for all users in real-time.

## typing-indicators.spec.js

Tests for the typing indicator plugin (four43.chat-typing). Assumes 2 registered users (User A, User B).

- User A creates a room "typing-room" and invites User B. Both users open the room.
  - User A types in the message input field (without sending).
    - User B sees a typing indicator (e.g., "User A is typing...") appear near the message input area.
    - User A does NOT see their own typing indicator.
  - User A stops typing and waits ~3 seconds.
    - The typing indicator disappears for User B.
  - User A types and then sends the message (presses Enter).
    - The typing indicator disappears for User B (replaced by the actual message).
  - User B types in the input. User A sees "User B is typing...".
  - Both User A and User B type simultaneously.
    - User A sees "User B is typing...", User B sees "User A is typing..." (each sees only the other).
  - User A is typing in "typing-room", then switches to a different room.
    - The typing indicator for User A disappears for User B (room switch sends stop).
  - User A opens "typing-room" again and types. The indicator reappears for User B.

---

## admin-panel.spec.js

Tests for the admin panel UI and server management. Assumes 3 registered users (admin User A, User B, User C).

- Admin server settings
  - Admin can view and update the server name via admin panel
  - Admin can change registration mode via the slider (open, approval_required, invite_only, closed)
  - Invite section appears when registration mode is set to invite_only
- User management
  - Admin sees user list with roles and action buttons for all registered users
  - Admin can promote a user to moderator and demote back to user
  - Admin can promote a user to admin
  - Admin can delete a user, user disappears from the user list
  - Cannot delete the last admin (server protection)
- Moderator access
  - Moderator can access admin panel but only sees Users section (Server and Appearance hidden)
  - Regular user navigating to admin panel is redirected to app.html

---

## user-settings.spec.js

Tests for user settings page functionality. Assumes 3 registered users (admin User A, User B, User C).

- Nickname management
  - User sets nickname via settings page, verifies it persists via API
  - User sets nickname via /nick slash command, other users see the display name in chat
  - User clears nickname via settings page clear button
- Appearance settings
  - User can switch color scheme between auto, dark, and light
  - Color scheme persists across page reload
  - User color picker updates the username color
- Session management
  - Logout button clears session and redirects to login page

---

## room-folders.spec.js

Tests for room folder organization system. Assumes 3 registered users (admin User A, User B, User C).

- Folder CRUD
  - Admin can create a folder via API and it appears in the sidebar
  - Admin can rename a folder
  - Admin can delete a folder
  - Admin can create nested folders (parent → child)
- Room organization
  - Admin can move a room into a folder
  - Deleting a folder moves rooms back to root
  - Folder structure is visible to non-admin members after reload
- Permissions
  - Regular user cannot create folders (403)
  - Regular user cannot delete folders (403)
  - Moderator can create and delete folders

---

## encryption.spec.js

Tests for end-to-end encryption and zero-knowledge verification. Assumes 3 registered users (admin User A, User B, User C).

- Zero-knowledge encryption
  - Messages stored on server are ciphertext (not plaintext), validated encrypted envelope format (v, epoch, iv, ct)
  - Server stores key_epoch on messages
- Key distribution
  - Room creator has encrypted keys stored on server after room creation
  - Invited user receives encrypted room keys after being invited
  - Invited user can decrypt messages sent before they joined
  - Each user has their own encrypted copy of room keys (different ciphertext, same epoch)
- Public key management
  - User public key is available via API after registration (base64-encoded SPKI)

---

## security-boundaries.spec.js

Tests for authorization enforcement and security boundaries at the API level.

- Unauthenticated access
  - Unauthenticated API requests to protected endpoints return 401
  - Invalid session token returns 401
  - Unauthenticated user navigating to app.html is redirected to login
- Admin-only endpoint protection
  - Non-admin cannot update server settings (403)
  - Non-admin cannot change user roles (403)
  - Non-admin cannot delete users (403)
  - Non-admin cannot create invite tokens (403)
- Room access enforcement
  - User cannot access rooms they are not a member of (403)
  - User cannot send messages to rooms they are not a member of (403)
  - Non-owner/non-admin cannot delete a room (403)
  - User cannot fetch keys for rooms they are not a member of (403)
- Registration mode enforcement
  - Closed registration rejects new users (form disabled)
- Server info
  - GET /api/server is publicly accessible without auth

---

## websocket-reconnect.spec.js

Tests for WebSocket reconnection behavior and multi-tab scoping.

- WebSocket reconnection
  - Client reconnects after WebSocket is forcibly closed and receives new messages
  - Room selection persists through WebSocket reconnection
- Multi-tab scoping
  - room:update events reach all tabs for a user (new room visible in both tabs)

---

## pwa.spec.js

Tests for Progressive Web App features, avatar generation, theme system, and plugin system.

- PWA manifest and metadata
  - app.html includes PWA manifest link
  - manifest.json is valid and contains required PWA fields (name, display: standalone, icons)
  - Service worker registers successfully
- Avatar generation
  - User avatar is auto-generated on registration (PNG image returned)
  - Server icon is auto-generated (PNG image returned)
- Theme system
  - Themes API returns available themes with required fields
  - Theme CSS is served correctly with text/css content type
- Plugin system
  - Plugins API returns list of plugins with manifests (chat and todo plugins present)
  - Plugin frontend files are served correctly
