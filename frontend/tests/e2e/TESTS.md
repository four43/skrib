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

Also create a state where there are 2 successfully registered users in the system for tests.

Each shared fixture must be able to create multiple users. The first user that's created is auto approved, but subsequent users will need to be approved, or the server must be switched to `open` registration mode for those tests.

---

## registration-and-authentication.spec.js

Core registration, login, and chat functionality.

- Full registration flow - Login page renders with a Register button, register form has username, 2 new password/passphrase fields.
  - User tries invalid user name with reserved words and gets error
  - User tries too short username and gets error
  - User tries too long username and gets error
  - User tries mismatched passphrase and gets error
  - User successfully tries valid username and passphrase and registers successfully, then is prompted to create a passkey credential
    - Passkey registration fails, shows helpful error.
    - User creates passkey credential and is logged in, sees chat UI
      - User logs out and logs in again with passkey, sees chat UI
      - For another, new user, start from login page
        - tries to register with a username that already exists, duplicate username error
        - successfully registers with a different username, creates passkey, sees pending registration page.
          - Admin approves user, user can log in with passkey and sees chat UI
          - Admin declines user, user cannot log in
  - Unauthenticated user tries to access app.html and is redirected to login page

Room stuff:

- Send a message in a room
- Create a new room and verify it appears in sidebar

