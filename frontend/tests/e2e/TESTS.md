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
