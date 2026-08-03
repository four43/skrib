# Core primitives: the room item log and the signal channel

**Date:** 2026-08-02
**Status:** Approved design, ready for implementation planning

## Problem

Core depends on a plugin for core's own data model.

`backend/skrib/database.py:172` defines `room_users.last_read_message_id`, but the
`messages` table it points into lives in the chat plugin's own SQLite file
(`backend/plugins/four43.room-type-chat/backend/plugin_bus.py:21`), owned by a
separate process. Concretely:

1. **No referential integrity is possible.** They are separate database files, so
   `last_read_message_id` is an integer pointing at a rowid in a database core
   cannot join against.
2. **Unread counting requires a cross-process round-trip.** Core asks the chat
   plugin to run `SELECT COUNT(*) FROM messages WHERE room_id = ? AND id > ?`
   (`plugin_bus.py:97`). A core UI badge depends on a plugin process being alive.
3. **Message search cannot exist.** `CLAUDE.md` advertises a
   `backend/skrib/messages/` module for search. There is no such directory —
   messages moved into the chat plugin and search never followed.
4. **Every new room type reimplements messaging.** To write a room type today you
   must build your own persistence, broadcast, and notification. This is the real
   reason there are two room types (`chat`, `todo`) rather than ten.

Separately, there is no primitive for transient room traffic. Typing indicators
are implemented as a *plugin* (`four43.chat-typing`) doing bus round-trips through
a separate process for state with a three-second lifespan. WebRTC signalling has
no home at all, so the prototype in `research/server.py` runs its own aiohttp
server on port 8080.

## Goals

- Core owns the durable, ordered, per-room record of what happened.
- Core owns the E2E envelope, so no plugin author can get crypto wrong.
- Writing a new room type means defining a payload schema and a renderer, nothing
  more.
- A single transient channel for ephemeral room traffic, replacing the typing
  plugin and hosting WebRTC signalling.
- `last_read_message_id` becomes a real foreign key.

## Non-goals

- Implementing search. This spec provides the feed a client-side index consumes;
  the index itself is a later spec.
- Implementing threads. `parent_id` exists so threads are possible later without
  a schema change.
- Federation. Item identity is chosen to not preclude it (see §1.2), but no
  server-to-server protocol is designed here.
- Migrating existing data. Per `CLAUDE.md`, there are no migrations in early
  development; `data/` is deleted and recreated.

## Key facts that shape the design

- **The envelope format already exists.** `docs/end-to-end-encryption.md:71`
  defines the per-message envelope with a `ct` ciphertext field, and the design
  already carries a key `epoch`, so multi-epoch reads are anticipated.
- **`room_keys` is keyed on `room_id + key_epoch + username`**
  (`docs/architecture.md:92`), so per-epoch key retention is already expressible.
- **Read state is already core.** `room_users.last_read_message_id`
  (`database.py:172`) is in the core schema; only the thing it references is not.
- **A background scheduler pattern already exists.**
  `backend/skrib/backups/services.py:301` (`start_backup_scheduler` +
  `_scheduler_loop`) is the template for any periodic sweep this spec needs.
- **The chat plugin already hard-deletes on room deletion**
  (`plugin_bus.py:74`, `DELETE FROM messages WHERE room_id = ?`), so hard deletion
  of ciphertext is established behaviour, not a new concept.

## Design

### 1. The item log

One core table per the whole server, not per plugin. Append-only.

| Column | Type | Notes |
| --- | --- | --- |
| `room_id` | TEXT | FK → `rooms.room_id` |
| `seq` | INTEGER | Monotonic **per room**, starting at 1 |
| `ulid` | TEXT | Globally sortable unique id |
| `item_type` | TEXT | Namespaced, e.g. `chat.message`, `todo.task`, `call.started` |
| `author` | TEXT | FK → `users.username` |
| `created_at` | TEXT | Server-assigned timestamp |
| `parent_id` | INTEGER | Nullable; references `seq` in the same room |
| `key_epoch` | INTEGER | Which room key epoch encrypted this item |
| `payload` | BLOB | The E2E envelope. Opaque to the server. |

Primary key is `(room_id, seq)`.

#### 1.1 Why core owns this

Everything that needs to be consistent across room types lives here: ordering,
unread math, read receipts, retention, the encryption envelope, and the feed a
client-side search index consumes. Room types own only the *plaintext schema
inside* `payload`.

Making core bigger is what makes the extensibility pillar real. A new room type
becomes a payload schema plus a renderer, rather than a reimplementation of
storage, broadcast, and notification.

#### 1.2 Dual identity: `seq` and `ulid`

Both, deliberately:

- **`seq`** — per-room monotonic integer. Makes unread trivially cheap
  (`SELECT COUNT(*) WHERE room_id = ? AND seq > ?`) and gives
  `last_read_message_id` a real foreign key target for the first time.
- **`ulid`** — globally sortable, collision-free without coordination. Needed for
  cross-room sync, client-side index keys, and any future federation, where a
  per-room counter from another server is meaningless.

Adding `ulid` later would be a painful retrofit; adding it now is a column.

#### 1.3 Append-only, with tombstones

The log is append-only. Edits and deletions are expressed as new items, and the
*view* folds them:

- **Edit** — a `supersede` item carrying `parent_id` = the superseded `seq`, plus
  a fresh payload. Clients render the newest superseding item in a chain.
- **Delete** — a `tombstone` item referencing the target `seq`, **and** a hard
  overwrite of the target row's `payload` to `NULL`.

The hard overwrite is not optional. Under an inviolable E2E pillar, a "delete"
that leaves recoverable ciphertext on disk is not a delete — it is a delay. But
an ordered marker is still required so other clients learn the deletion happened
and can drop it from their local index. Hence both: the tombstone is the event,
the payload wipe is the effect.

Consequence: `seq` values are never reused and rows are never removed, so
`parent_id` chains and read pointers stay valid across deletion.

#### 1.4 The envelope is core's, not the room type's

Core defines the payload envelope — version, `key_epoch`, IV, ciphertext — per the
existing format in `docs/end-to-end-encryption.md:71`. A room type chooses the
plaintext schema it encrypts *inside* that envelope and never touches the
envelope itself.

This is non-negotiable and follows directly from E2E being an inviolable pillar.
If plugin authors could select or assemble their own encryption, a single mistaken
room type would silently produce server-readable content — the same
"one config slip and it all falls apart" failure mode that ruled out per-room
encryption toggles. Plugin authors must not be in a position to get crypto wrong.

#### 1.5 Key epochs and member removal

Removing a member rotates the room key, minting a new `key_epoch`. Existing items
keep the epoch they were written under.

- Remaining members **retain every epoch key they have ever held**, so their
  history stays readable. `room_keys` rows for continuing members are never
  pruned.
- The removed member's `room_keys` rows are deleted. Anything they already
  downloaded locally remains theirs — unavoidable in any E2E system, and worth
  stating plainly rather than implying otherwise.

### 2. The signal channel

Transient room traffic. Never persisted, no ordering guarantee, no replay.

**The test for log versus signal:** *would someone joining tomorrow need to see
it?* Yes → log. No → signal.

#### 2.1 Fire-and-forget only

Signals are events. There is deliberately **no last-write-wins state flavour**,
because the cases that seemed to need one don't:

- **Typing indicators** — a user joining mid-keystroke simply doesn't see the
  indicator. Accepted; not worth a second primitive.
- **"A call is happening now"** — this is a **projection over the log**, not
  ephemeral state. Call lifecycle items (`call.started`, `call.ended`) are durable
  because they belong in the transcript anyway, so liveness is derivable: the most
  recent `call.started` in a room with no matching `call.ended`. That survives a
  server restart and cannot race.
- **Mute state in a call** — arrives in-band via WebRTC renegotiation when a new
  participant joins. Peer state, not server state.

If a future feature genuinely needs join-visible ephemeral state (for example
"3 people are viewing this room"), it will need revisiting. Nothing in this spec
requires it, so nothing is built for it.

#### 2.2 Two delivery modes

| Mode | Use |
| --- | --- |
| `to: room` | Broadcast to every joined member. Typing, live reactions, nudges. |
| `to: member` | Directed at one specific member. |

Directed delivery is a hard requirement, not a convenience: WebRTC mesh
negotiation is pairwise. A four-person call is six independent negotiations, each
exchanging SDP with exactly one peer. `research/server.py` sidesteps this by
pairing clients into rooms of two; a real mesh cannot.

#### 2.3 Encryption

- **Directed signals are encrypted with the room key.** SDP and ICE candidates
  contain participants' IP addresses. The server already learns every IP from the
  WebSocket connection, so this leaks nothing today — but the room key is already
  in hand, so the cost is near zero and it keeps the option of running behind a
  relay where that stops being true.
- **Broadcast signals are plaintext.** "alice is typing" is low-stakes, and the
  server already knows she is connected.

#### 2.4 Registration, permission, and rate limits

- A signal type is registered with a declared delivery mode and rate limit.
- **Members** may emit a whitelisted set of signal types. Without a whitelist the
  channel becomes an unbounded broadcast primitive for any authenticated client.
- **Plugins** may emit within their own namespace (the existing bridge rule).
- **Rate limits are per signal type,** because frequency spans three orders of
  magnitude: `typing` is roughly 0.3/s, while `cursor` and audio-level signals run
  10–30/s. A single global bucket cannot serve both.

#### 2.5 What this replaces

- `four43.chat-typing` largely evaporates — it was the signal primitive
  implemented as a plugin for want of anywhere else to live.
- WebRTC signalling gets a home, retiring the standalone aiohttp server in
  `research/server.py` and port 8080.

### 3. What core owns after this

| Concern | Owner |
| --- | --- |
| Item persistence, ordering, `seq`/`ulid` assignment | Core |
| Fan-out to joined members | Core |
| Unread counts, read receipts | Core |
| E2E envelope, key epochs, rotation | Core |
| Retention and purge | Core |
| Signal transport, whitelist, rate limits | Core |
| Plaintext payload schema, rendering, room behaviour | Room type |
| Outbound I/O (push, previews, blobs) | Feature plugin |

### 4. Consequences for existing features

#### 4.1 Unread becomes a real foreign key

`room_users.last_read_message_id` is renamed to reference `(room_id, seq)` and
gains an actual constraint. Unread counting becomes a local `COUNT(*)` in core
with no cross-process call, so unread badges no longer depend on a plugin process
being alive.

#### 4.2 Mentions must move to the client

`@mention` detection requires reading message content, which core cannot do. So
mention badges and mention-triggered notifications are computed **client-side on
sync**. There is no server-side path to this under E2E.

#### 4.3 Push notifications carry a pointer, not content

The server cannot read content, so a push payload carries only
`{room_id, seq}` — a wake-up. The **service worker** (not a web worker; web
workers cannot receive push events) reads the private key from IndexedDB, uses
`crypto.subtle`, fetches and decrypts the item, and calls `showNotification()`
with real content. This is how Signal and Matrix clients behave.

Two consequences:

- **A generic fallback is mandatory.** If the SW is offline, the fetch fails, or
  no key is present on that device, it must still show "New message" — Chrome's
  `userVisibleOnly` contract means failing to call `showNotification()` promptly
  gets the browser's own "site updated in background" notice instead.
- **On iOS, Web Push requires an installed PWA.** This is a feature, not a
  limitation: it gives the install prompt in
  `2026-08-02-onboarding-invite-links.md` a user-visible benefit
  ("install this and notifications will tell you what was said") rather than an
  abstract one about storage durability.

Because the payload is only a pointer, the web-push plugin never needs content
access and can hold a minimal permission set.

#### 4.4 Search becomes client-side, permanently

Server-side message search is impossible under E2E and always will be. The log is
the feed: clients index decrypted payloads locally, keyed by `ulid`. `CLAUDE.md`
must stop advertising a `backend/skrib/messages/` module, which does not exist.

#### 4.5 Threads are a later spec, unblocked

`parent_id` is in the schema from day one, so threading needs no migration when
it arrives. It is also already used by `supersede` and `tombstone`, so the column
earns its place immediately.

### 5. The stale-call reaper

Because call liveness is a log projection (§2.1), a call whose participants all
crash leaves no `call.ended` item, and the projection reports a phantom live call
forever.

A periodic sweep closes calls with no participant activity for a threshold
interval by appending a synthetic `call.ended` item. Built on the existing
`backups/services.py:301` scheduler pattern.

## Verification

- Creating a room, appending items, and deleting one leaves `seq` gaps in the
  *rendered* view but no reused `seq` values and no orphaned `parent_id`.
- A deleted item's `payload` is `NULL` on disk, verifiable by reading the SQLite
  file directly. A tombstone item exists for it.
- Unread counting issues no cross-process call: with all plugin processes stopped,
  unread badges still render correctly.
- Removing a member mints a new `key_epoch`; a remaining member can still decrypt
  items from every prior epoch.
- A four-participant mesh completes six pairwise negotiations over directed
  signals.
- Directed signal payloads are ciphertext when inspected at the bus.
- A signal type exceeding its declared rate limit is dropped without affecting
  other types.
- Killing every participant's browser mid-call results in a synthetic
  `call.ended` within the reaper interval, and the room stops reporting a live
  call.

## Risks

- **The fold is now the client's job.** Rendering requires collapsing supersede
  chains and tombstones. A client bug shows deleted or stale content. Mitigation:
  fold once in shared frontend code, not per room type.
- **Storage grows monotonically.** Edits append rather than overwrite. Acceptable
  at this scale, and retention/purge is core's responsibility.
- **`plugin-system.md` is now substantially wrong.** It is 38 KB describing a
  world where the chat plugin owns messages. It needs real surgery, not patches.
- **Hard payload wipe is irreversible.** A bug in tombstone handling destroys
  content with no recovery path. Mitigation: wipe only on explicit tombstone
  creation, never as a side effect of any other operation, and cover it with a
  red/green test before implementing.
- **Client-side-only search is a visible downgrade** versus every competitor. It
  is the price of the E2E pillar and should be documented as a deliberate choice
  rather than a gap.
