---

## passphrase-key-recovery.spec.js

Passphrase-based encryption key recovery (PBKDF2 + AES-GCM wrapping).

- Registration stores passphrase-wrapped key on server with correct structure (v1, salt, iv, ct, 600k iterations)
- Key recovery via passphrase after losing local keys (same public key modulus, no regeneration warning)
- Wrong passphrase shows error and allows retry with correct passphrase
- Skipping passphrase recovery generates new key pair with regeneration warning
- Passphrase recovery preserves old message readability

---

## prf-key-recovery.spec.js

PRF (Pseudo-Random Function) based key recovery using CTAP 2.1 authenticators.

- Registration with PRF stores encrypted private key on server
- Key recovery via PRF after losing local keys
- Registration without PRF does not store encrypted private key
- Login without PRF warns about lost private key when no local key exists
- Existing user login uploads PRF backup retroactively when missing

---

## key-loss-recovery.spec.js

Encryption key loss with no recovery (skip passphrase), testing room key regeneration.

- Login generates fresh key pair when local keys are lost (no PRF)
- Old messages unreadable after key loss, new messages work after room key regen
- System message warns user about key regeneration
- Key regeneration uploads new public key to server

---

## app-key-recovery-redirect.spec.js

App.html detection of missing IndexedDB keys with valid session, triggering login redirect for recovery.

- Redirects to login when IndexedDB key is missing but session is valid
- Full round-trip: app redirect, login, passphrase recovery, key restored, old messages readable
- Does NOT redirect when no recoverable key exists on server (no recovery possible)

---

## pending-user-keys.spec.js

Encryption key storage during `approval_required` registration mode. Tests modify the server's registration mode and restore it via `afterEach`.

- approval_required registration stores encryption keys on server, keys accessible after approval
- Pending user can login after approval and recover keys via passphrase
- Auto-approved registration still stores encryption keys

---

## registration-modes.spec.js

Registration mode enforcement (closed, invite_only). Tests modify the server's registration mode and restore it via `afterEach`.

- Closed mode disables registration form with "Registration is currently closed" message
- Closed mode rejects backend registration attempt with 403
- invite_only mode disables form without invite token
- invite_only mode allows registration with valid invite token
- Invite token is consumed after use (reuse rejected)
- Login page hides register button in closed mode

---

## auth-edge-cases.spec.js

WebAuthn cancellation handling, session edge cases, and input validation.

- Cancelling passkey enrollment shows error and allows retry
- Cancelling login passkey shows error and stays on login page
- Invalid session token is cleared on login page
- Invalid session token on app page redirects to login
- Register then clear session then login preserves user data
- Username validation rejects reserved words ("admin_user", "thesystem")
- Short username (< 3 chars) is rejected
- Passphrase mismatch prevents registration
- Weak passphrase is rejected

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
