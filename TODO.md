# Skrīb — live task list

Single source of truth for outstanding work. Absorbed `TODO-fix-e2e-tests.md`, the
previous hand-written wishlist (now §Product wishlist), `docs/legacy/api-todo-cleanup.md`,
and the open items from `docs/spec/2026-05-02-plugin-multiprocess-review.md` and
`docs/spec/2026-04-04-security-audit-findings.md`.

Phase numbering follows `docs/spec/2026-08-02-roadmap-phases.md`.

---

## P0 — Authentication is bypassable

**These outrank everything else, including the broken test suite.** Both are
documented in `docs/reference/auth.md:82-88` as "Known Issue," which
substantially understates them.

- [ ] **Session tokens are forgeable.** The token is
      `base64("username:random_hex")` and the random portion is *never stored or
      verified* — only the username is checked against the DB. So
      `base64("alice:anything")` is a valid session token for alice. Anyone who
      knows a username has full account access.
      **Fix:** a `sessions` table, validate the full token on every request. This
      also buys expiration, revocation, and session listing, none of which exist.
- [ ] **WebAuthn assertions are not verified.** `credential_id` and `public_key`
      are stored as raw strings with no attestation verification, and assertion
      signatures are not checked on login. A `curl` with fabricated values creates
      a working user.
      **Fix:** integrate `py_webauthn` for attestation on registration and
      signature verification on login.

**Why this is above everything:** E2E encryption is worthless if identity is
forgeable. The zero-knowledge model assumes the server correctly identifies whom
it distributes room keys to. An attacker who can forge alice's token gets added to
rooms as alice and receives room keys encrypted to a public key they control. No
amount of client-side crypto compensates. The security pillar has a hole
underneath it.

Related, and cheaper once the above is fixed:

- [ ] `S2` — no rate limiting on passphrase recovery attempts (`auth.md:279`)
- [ ] `S3` — session token forgery chains with key recovery (`auth.md:285`)

---

## P0 — Unblock the repository

Nothing ships from a red branch. `feat-plugins-new-process` is unmerged and ~20
e2e tests have been red since 2026-05-04.

- [x] **Batch `get_notify_levels(room_id) -> dict`.** Currently
      `get_notify_level` is called once per member in a loop inside the chat
      plugin's `handle_message`, so an N-member room does N sequential bus
      round-trips at ~10–50 ms each.
      **Do this first.** It may fix the msg-2 bug outright, in which case that bug
      was an API-granularity error and says nothing about the process boundary.
      Getting this order wrong means learning the wrong lesson from the timebox
      below.
      **Done 2026-08-03 (dual-runtime-plugins Task 1).** Landed alone, then
      re-ran `markdown-and-input.spec.js` "Headings render" — still red, same
      failure (only "Heading 1" ever renders; message 2 never arrives). The
      full affected batch is unchanged too: 11 failed / 36 passed, same 5/3/2/1
      split across the four spec files as the baseline below. So the msg-2 bug
      is **not** API granularity — the process boundary is implicated. Task 6
      (move `room-type-chat` to `runtime: in_process`) is the fix, not a
      cleanup. See `.superpowers/sdd/2026-08-03-dual-runtime-plugins/task-1-report.md`
      for full command output.
- [x] **Timebox the "msg 2 fails after msg 1" bug to two focused sessions.**
      Green → merge and move on. Still red → that is the decision to move
      `room-type-chat` to `runtime: in_process`, taken without regret. An
      unbounded "just fix it" is the plan that already failed for three months.

      **Resolved 2026-08-03.** Still red after batching (above), so
      `room-type-chat` moved to `runtime: in_process` (dual-runtime-plugins
      Task 6) — and that fixed it. Full e2e sweep after the change: 326
      passed, 2 failed, 2 flaky (both green on retry), against a baseline of
      ~20 hard failures. Backend suite: 432 passed. **The msg-2 bug is fixed,
      and the cause was the process boundary, not API granularity** — batching
      the per-member `get_notify_level` calls into one round-trip changed
      nothing on its own. The 2 remaining failures are
      `link-previews.spec.js:35` and `:130`, confirmed pre-existing (see the
      P3 note on splitting link previews out of the chat plugin).

  Reproducer: `markdown-and-input.spec.js` "Headings render" is the simplest —
  three sequential messages, no menu interaction.

  ```bash
  cd frontend && SKRIB_TEST_DATA_DIR=1 SKRIB_TIMING=1 npx playwright test \
    --project=e2e --reporter=line --grep "Headings render"
  ```

  Backend logs `[WS] Error for u1s4t1: Cannot call "send" once a close message has
  been sent` from the catch-all in `ws/routes.py:57`, so something sends on an
  already-closed socket and breaks the receive loop.

  Cheapest hypothesis to disprove first: wrap the individual `ws.send_json` calls
  in `ws/handlers.py` (the `room:error` path) and in `manager.py`
  `_dispatch_plugin_namespace` error paths in `try/except`, so a closed-socket
  send cannot propagate.

  Already ruled out: room-type sort order, encryption key availability, menu item
  ordering.

  Affected specs: `chat-messages.spec.js:169,192,212,261,291`,
  `markdown-and-input.spec.js:86,101`, `core.spec.js:96,376,415`,
  `websocket-reconnect.spec.js:51`.

- [x] Re-run the auth e2e batch — `registration-and-authentication.spec.js:107`
      and `:324` were likely fixed by the fixture change that makes `_backend`
      always spawn plugins. Cheapest signal available; do it before deep debugging.
      **Done: 19 passed, 0 failed** in the 2026-08-03 sweep.
- [x] Fix the page-reload teardown flake (`todo-rooms.spec.js:197` and similar,
      `page.reload: net::ERR_ABORTED` while the WS is closing). Passes on retry,
      low priority.
      **Clear as of the 2026-08-03 sweep** — the plugin batch containing
      `todo-rooms.spec.js` is 50 passed / 0 failed / 0 flaky.
- [ ] Merge `feat-plugins-new-process` into `master`.

---

## P1 — Onboarding

Spec: `docs/spec/2026-08-02-onboarding-invite-links.md`. The only work with
verified user evidence: the app was deployed and users could not get through
sign-up.

- [ ] **Seed `invite_only` as the default registration mode**
      (`database.py:282` currently seeds `approval_required`). One line, highest
      value per character in the list — it removes the wall that ended the last
      deployment. Also correct `auth.md`, which documents the default as `closed`.
- [ ] Invite links carrying the key-wrapping secret in the **URL fragment**.
- [ ] Delete the user-invented passphrase from registration entirely.
- [ ] PRF-first credential path; generated 6-word phrase as fallback.
- [ ] `S6` — make the PRF salt per-user, not static (`auth.md:297`). **Blocks**
      promoting PRF to the primary key path.
- [ ] `S5` — "Skip recovery" must not silently replace the encryption identity
      (`auth.md:291`). Warn explicitly or remove the option.
- [ ] Multi-use-until-enrollment link semantics; re-wrap and delete the
      link-wrapped blob atomically on enrollment.
- [ ] `invite:ttl_days` server setting, default 30.
- [ ] Expiry sweep that **de-credentials rather than deletes** (scheduler pattern
      from `backups/services.py:301`).
- [ ] Redemption notification with a working revoke action.
- [ ] Second-session prompt: PWA install first, recovery second, with
      platform-specific install instructions.
- [ ] `navigator.storage.persist()` on install; document storage durability in
      `reference/progressive-web-app.md`.
- [ ] Visible "account expires in N days" indicator outside settings.
- [ ] Relax username rules (`^[a-zA-Z0-9_]{4,15}$` rejects "Bob" and
      "seth.miller").
- [ ] Raise the 5-minute registration-token TTL, or make the passkey step
      resumable.

**Exit criterion: re-deploy to the same friends and watch them get in.**

---

## P2 — Core primitives

Spec: `docs/spec/2026-08-02-core-log-and-signal.md`.

- [ ] Core per-room append-only item log (`seq` + `ulid`, `parent_id`,
      `key_epoch`, opaque payload).
- [ ] `room_users.last_read_message_id` becomes a real foreign key into it.
- [ ] Tombstone items plus hard payload wipe for deletes; supersede items for
      edits. **Write the red/green test before implementing** — a bug here
      destroys content irrecoverably.
- [ ] Core owns the E2E envelope; room types choose only the plaintext schema.
- [ ] Signal channel: fire-and-forget only, `to: room` and `to: member`, per-type
      rate limits, member whitelist.
- [ ] Encrypt directed signals with the room key.
- [ ] Key rotation on member removal; remaining members retain every epoch.
- [ ] Chat becomes a renderer over the log; delete its `messages` table.
- [ ] Delete `four43.chat-typing` (it was the signal primitive implemented as a
      plugin).
- [ ] Content-free push payloads; service-worker decryption with a generic
      fallback.
- [ ] Move `@mention` detection client-side.

---

## P3 — Extension model

Spec: `docs/spec/2026-08-02-extension-model.md`.

- [ ] **Natural next step after dual-runtime-plugins:** flip the remaining
      four `runtime: process` plugins — `four43.room-type-todo`,
      `four43.message-reactions`, `four43.emoji-picker`, `four43.chat-typing`
      — to `runtime: in_process`. They were deliberately left on the bus so
      any regression from the `runtime` change would be attributable to one
      manifest key; that key has now proven itself on `four43.room-type-chat`,
      so each of these four is a one-line change. `four43.chat-typing`
      disappears entirely instead once the P2 core signal channel lands.
- [ ] `kind`, `runtime`, `applies_to`, `subscriptions` manifest fields.
- [ ] **Move `subscriptions` out of Python class attributes into the manifest.**
      Today they live in code
      (`four43.attachments/backend/plugin_bus.py:14`,
      `four43.web-push/backend/plugin_bus.py:18`), so an approving admin cannot see
      what a plugin listens to and the manifest hash does not cover it.
- [ ] Declare claimed room types in the manifest and validate runtime
      `register.room_type` against it.
- [ ] Same SDK for both runtimes; `runtime` selects hosting only.
- [ ] **`skrib_plugin_sdk/loader.py` silently writes into a plugin's source
      tree.** `load_plugin_class` does `Path.touch()` on a missing
      `backend/__init__.py`. That was a narrow, process-startup-only side
      effect before; `InProcessHost` now calls the same loader from core's
      own boot path, so an ordinary server start can mutate a plugin's source
      tree — including in the production image, where `/app` is writable by
      `app-user`.
- [ ] **Core-owned plugin supervision** — spawn, restart with backoff, health in
      the admin UI. Replaces `start-plugins` (fire-and-forget bash, no
      supervision) and retires `run-plugins.py` (swallows per-plugin exceptions).
      Also resolves the undocumented-and-unenforced seed-before-plugin-start
      ordering hazard.
- [ ] **Split link previews out of the chat plugin** into their own
      `runtime: process` plugin. Fetching arbitrary user-supplied URLs is the
      best isolation candidate in the codebase and currently has none. The two
      e2e failures left after the dual-runtime-plugins work
      (`link-previews.spec.js:35` and `:130`, pre-existing — confirmed by
      A/B testing the `runtime` key) live in exactly this code, which
      strengthens the case for splitting it out rather than debugging it
      further in place.
- [ ] Move attachments to `runtime: process` (Pillow parsing untrusted uploads).
- [ ] `web-push` subscribes to core log items instead of
      `four43.room-type-chat:message` by name.
- [ ] Split `bus.send` into `bus.send.room` / `bus.send.user` / `bus.send.all`;
      require the strongest for `notify_all`.
- [ ] Audit which `core:*` lifecycle events actually reach subscribers; either
      route lifecycle events through `broadcast_to_subscribers` or drop the
      subscriptions that never fire.
- [ ] **One confirmed instance of the audit above: `four43.web-push`'s
      subscription never fires.** It declares
      `subscriptions = ["four43.room-type-chat:message"]` and an `@on_event`
      handler for it, but the chat plugin's only `emit_event` call is
      `core:message_deleted` — it never emits
      `four43.room-type-chat:message`. So push-on-new-message is dead code,
      and `docs/reference/websocket-bus.md` documents the wiring as if it works.
- [ ] **A tenth bus-only call site: `notify_plugin_config_updated` never
      reaches an in-process plugin.**
      `backend/skrib/plugin_bus/settings.py:198` calls
      `plugin_bus.send_to_plugin` directly instead of going through
      `PluginRegistry`/the bridge, so a settings change for an in-process
      plugin silently never sends a `config.updated` frame. Fully latent
      today: no bundled plugin declares `settings`, and no SDK code handles
      a `config.updated` frame yet, so there's nothing observable to break.
      Fix when the first in-process plugin adopts settings.
- [ ] Observability: per-plugin rate-limited-frame counter, surfaced in admin UI.
- [ ] Fold themes into the same mechanism (`kind: theme`). **Schedule last** —
      churn with no user-visible benefit.
- [ ] Obsidian-style `register*` auto-cleanup so plugins don't hand-track
      resources (carried forward from the retired research recommendations).

---

## P4 — Daily use

- [ ] Client-side search index over the log.
- [ ] Threads (`parent_id` already exists; no schema change needed).
- [ ] Message quoting and replying (also `parent_id`).
- [ ] Message editing and deletion surfaced in the UI (supersede/tombstone from P2).
- [ ] Calls: P2P mesh capped at four
      (`docs/spec/2026-08-02-calls-mesh-p2p.md`). Retires `research/server.py` and
      port 8080.

---

## Product wishlist

Carried over from the previous hand-written `TODO.md`. Not phase-scheduled; pick
from here when a phase completes.

> Improve the New Direct Message box: multi-select with search. Selected entries
> get added to a list below the search box, each with a small `x` to remove. The
> search should only offer people not already selected.

- [ ] Notifications in the UI — **mobile still outstanding** (desktop done). Ties
      into P1's PWA install work, since iOS Web Push requires an installed PWA.
- [ ] Room auth states: open (requestable, listable), invite-only, private (no
      invites). Partially built — `visibility` and `join_requests` exist per
      `docs/spec/2026-03-03-room-joining-discoverability.md`; the three-state model
      is not complete.
- [ ] Slash-command autocomplete on `/help` (`command-autocomplete.spec.js` exists —
      confirm what's already covered before starting).
- [ ] Plugin system for custom slash commands and message actions.
- [ ] Message pinning and starring.
- [ ] User groups.
- [ ] Pixel font? Lean into a mini/retro look?
    - [ ] Emoji packs — https://github.com/linusg/serenityos-emoji-font

Marked done since the previous list was written: user profiles with custom status
messages and avatars (commit `1d005e3`, covered by `user-profiles.spec.js`), and
message formatting/markdown (`markdown-and-input.spec.js`).

---

## Cross-cutting — API consistency

From the retired `api-todo-cleanup.md`.

- [x] WebSocket namespace separator `:` vs `.` — code uses `:`; `CLAUDE.md`
      documented `.` from 2026-02-22 until 2026-08-02. **Fixed in `CLAUDE.md`.**
- [ ] Inconsistent error response shapes — HTTP uses `detail`, WS uses `message`,
      plugin HTTP mixes `{"success": true}` with bare payloads.
- [ ] Plugin `name` vs `id` mismatch — `four43.room-type-chat` reports
      `name = "room-type-chat"`; `four43.chat-typing` reports its full id.
- [ ] List responses inconsistently wrapped — users/rooms wrapped,
      themes/plugins bare.
- [ ] Plugin WS namespacing inconsistent — chat and todo use the core `room:`
      namespace (todo's `room:todo_added` is a collision risk), typing uses its
      own, reactions has no WS events at all.
- [ ] Duplicated permission logic.
- [ ] Plugin route prefixes inconsistent — chat uses absolute paths, others
      relative.
- [ ] `camelCase` in auth schemas, inconsistent with the rest.
- [ ] No transaction safety for multi-step operations.
- [ ] Auth dependency naming.

---

## Cross-cutting — code complexity

From `docs/spec/2026-04-04-security-audit-findings.md`. Several may be resolved or
made moot by P2/P3; re-triage after those land.

- [ ] Two `PluginBus` classes with the same name.
- [ ] `run()` and `run_forever()` duplicate ~80 lines.
- [ ] Approval flow scattered across three files.
- [ ] Three code paths for plugin HTTP routing.
- [ ] Dynamic imports in `settings.py` to dodge circular deps.
- [ ] Settings schema lost on plugin disconnect.
- [ ] Disabled plugins remain in `room_type_map`.
- [ ] Two plugin base classes with no shared interface.

---

## Cross-cutting — test hygiene

- [ ] `backend/tests/integration/test_rooms.py:80-81`'s `_create_room_direct` seeds the
      in-memory `ROOMS` module global (`rooms/services.py:10`) directly, and
      nothing ever clears it between tests. An autouse `ROOMS.clear()` fixture
      is owed before this leaks a room id from one test into another.

---

## Documentation debt

- [x] Three-layer `docs/` structure with `docs/README.md` as the index.
- [x] Retire superseded planning docs to `docs/legacy/` with supersession notes.
- [x] Split plugin research into `reference/plugin-architecture-comparison.md`
      plus a legacy recommendations file with a retrospective.
- [x] Merge the three overlapping security docs and the two E2E docs.
- [x] Correct `CLAUDE.md`: separator, doc paths, phantom `messages/` module.
- [x] Correct confirmed drift in `websocket-bus.md`, `admin-and-moderation.md`,
      `architecture.md`.
- [ ] **`reference/plugin-system.md` needs surgery, not patches.** 38 KB
      describing the old boundary. Its §20 also claims e2e tests don't spawn
      plugin processes, which the fixtures now always do. Also now stale: it
      still describes the bus server's connection map as the source of truth
      for which plugins are active. `backend/skrib/plugins/registry.py` is
      that answer now, unifying in-process and bus-connected plugins behind
      one interface (see `docs/reference/architecture.md`'s Implementation
      Files table).
- [ ] Rewrite `reference/auth.md` registration flow once P1 lands. The two-page
      rationale (line 38, "so the browser's credential manager detects the
      passphrase field") is obsoleted by deleting the passphrase.
- [ ] Manifest example uses wrong field names (audit finding 22, HIGH).
- [ ] Frontend context object documentation incomplete; permissions table
      incomplete.
- [ ] `frontend/README.md` references a `chat.js` that no longer exists; plugin
      directory structure shows wrong paths.
- [ ] `reference/rooms-and-membership.md` and `reference/users.md` have not been
      validated against code yet — the only two reference docs still unreviewed.

---

## Not scheduled

- `docs/spec/2026-04-11-community-key-profile-encryption.md` — designed, never
  implemented. Re-evaluate after P2; the log and envelope work may change the
  approach.
- SSO/OIDC — needs its own spec, and it conflicts with WebAuthn-only auth.
- Federation, SFU/SFrame calls beyond four, third-party plugin marketplace,
  native mobile and desktop apps.
