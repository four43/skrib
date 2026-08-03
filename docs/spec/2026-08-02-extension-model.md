# Extension model: kinds, runtimes, and where the process boundary belongs

**Date:** 2026-08-02
**Status:** Approved design, ready for implementation planning
**Depends on:** `2026-08-02-core-log-and-signal.md`

## Problem

The out-of-process plugin migration (`ed3534f` → `47cbd8d`) is well-built — 191
green unit tests, a clean `plugin_bus/{server,bridge,protocol,approvals,settings}`
separation, and a solid security posture per `docs/plugin-system-review.md`. But
the boundary was drawn in the wrong place, and five concrete problems follow.

1. **Isolation is spent where there is no risk, and absent where there is.**
   `four43.chat-typing` declares only `bus.send`/`bus.receive` and no storage at
   all — pure ephemeral fan-out — yet it does cross-process round-trips for state
   with a three-second lifespan. Meanwhile **link previews, which fetch arbitrary
   user-supplied URLs, live *inside* the chat plugin**
   (`four43.room-type-chat/backend/plugin_bus.py:33`), and attachments parse
   untrusted image bytes with Pillow in a process that also owns storage.

2. **The hot path pays per-member RPC.** `four43.room-type-chat` holds the
   `core_api` permission and calls `get_notify_level` **once per member in a
   loop**, then notifies each. That is N sequential round-trips at ~10–50 ms
   inside a single message handler, and it is the leading hypothesis for the
   unresolved "msg 2 fails after msg 1" bug in `TODO-fix-e2e-tests.md`.

3. **The security model defends a threat that does not exist yet.** Every plugin
   is `four43.*` — first-party, written by the developer. Approvals,
   manifest-hash re-approval, per-frame permission enforcement, rate limiting and
   plugin secrets all guard against an untrusted plugin author. The only mention
   of one anywhere in the docs is
   `docs/planning/plugin-system-design.md:878`, "Phase 6: Plugin Marketplace
   (Future)".

4. **The admin pays for all of it and receives nothing.** `backend/util/start-plugins`
   is fire-and-forget bash writing PID files — **no supervision, no restart, no
   health check**. `run-plugins.py` swallows per-plugin exceptions
   (`plugin-system-review.md:37`). Chat is a plugin, so forgetting to run a shell
   script means the server has no messaging. There is no health signal in the
   admin UI.

5. **What the admin approves is not what the plugin does.** Manifest keys are
   `author, description, entry, hooks, id, name, permissions, styles, version`.
   **Subscriptions and room types appear nowhere in them.** Subscriptions are
   Python class attributes (`four43.attachments/backend/plugin_bus.py:14`,
   `four43.web-push/backend/plugin_bus.py:18`) and room types are registered at
   runtime via `register.room_type`. So the two declarations most relevant to
   cross-plugin data access are invisible to the approving admin and outside the
   manifest hash that gates re-approval.

There are also three unrelated extension mechanisms with nothing in common:
**plugins** (`backend/plugins/*/manifest.json`, over the bus, approved, with
settings), **themes** (`backend/themes/`, zip bundles served by core
`skrib/themes/routes.py` — no manifest, no approval, no settings), and **room
types**, which are not a mechanism at all but a *naming convention*
(`room-type-chat` versus `chat-typing`, distinguished only by folder name).

## Goals

- Make the process boundary a **deployment choice**, movable per plugin without
  rewriting the plugin.
- Put isolation where the actual risk is: code that talks to the outside world,
  and code you do not trust.
- Give the bus and its permission model a real job instead of retiring them.
- One extension mechanism, one loader, one approval flow, covering all kinds.
- An admin who never needs to know that plugins are processes.
- Everything security-relevant is declared in the manifest, so approval means
  something.

## Non-goals

- Building a marketplace. This makes one possible later; it does not build one.
- Deleting the bus, `plugin_bus/`, or the 191 tests. They are repositioned, not
  discarded.
- Sandboxing in-process plugins. In-process code is trusted by definition (§3).

## Key facts that shape the design

- **Permissions declared per plugin today** (from the manifests):

  | Plugin | Permissions | Shape |
  | --- | --- | --- |
  | `room-type-chat` | `bus.*`, `http.routes`, `storage.*`, **`core_api`** | hot path, per-member RPC |
  | `room-type-todo` | `bus.*`, `http.routes`, `storage.*` | small writes |
  | `chat-typing` | `bus.send`, `bus.receive` only — **no storage** | pure ephemeral |
  | `message-reactions` | `bus.*`, `http.routes`, `storage.*`, `dom.messages` | small writes |
  | `emoji-picker` | `http.routes`, `storage.*` — **no bus** | data serving |
  | `attachments` | `bus.*`, `http.routes`, `storage.*`, `dom.*` | untrusted bytes |
  | `web-push` | `bus.receive`, `http.routes`, `storage.*`, `core_api` | outbound network |

- **`web-push` subscribes to `four43.room-type-chat:message` by name**
  (`plugin_bus.py:18`) — a hard cross-plugin dependency, so push only works for
  one room type.
- **Pillow is a runtime dependency** (`docs/spec/2026-08-02-docker-multistage-nonroot-design.md`
  risks section). Image parsing of untrusted uploads is a real memory-safety
  surface.
- **The SDK API is decorator-driven** (`@on_room_action`, `@on_lifecycle`,
  `@callback`) with a context-merging `ActionContext` — an API shape that does not
  inherently require a process boundary.

## Design

### 1. Two new manifest fields

```json
{
  "id": "four43.room-type-chat",
  "kind": "room_type",
  "runtime": "in_process",
  "applies_to": ["chat"],
  "subscriptions": ["core:item_appended"]
}
```

| Field | Values | Purpose |
| --- | --- | --- |
| `kind` | `room_type` \| `feature` \| `theme` | What sort of extension this is |
| `runtime` | `in_process` \| `process` | Where it runs |
| `applies_to` | list of room types, or `"*"` | Which surfaces a `feature` attaches to |
| `subscriptions` | list of event names | **Moved out of Python class attributes** |

`subscriptions` moving into the manifest is the fix for problem 5 — it brings
cross-plugin data access under the manifest hash, so changing what a plugin
eavesdrops on triggers re-approval, and the admin can see it before saying yes.
Room types registered dynamically must likewise be declared here and validated
against the runtime registration.

`applies_to` closes a gap that is currently undefined behaviour: nothing says
whether reactions apply to todo items, or whether a typing indicator belongs in a
video room. Feature plugins attach globally today because there is no way to say
otherwise.

### 2. `kind` in the manifest, not in the directory layout

One `backend/plugins/` directory, one loader, one approval flow, one admin list
grouped by `kind`.

Directory-as-taxonomy is rejected because **it is what themes already do, and it
does not compose.** A plugin that is both a room type and a feature has nowhere
to live, and a fourth kind means a fourth directory and a fourth loader. Themes
fold into this system, gaining the approval and settings machinery that already
exists and that they currently lack entirely.

### 3. Runtime is a deployment detail, not an API difference

**The same SDK, the same decorators, both runtimes.** `runtime` selects how the
plugin is hosted; it does not change how it is written.

This is the central move of this spec. It makes the boundary an experiment rather
than a refactor: flipping `four43.room-type-chat` to `in_process` is a one-line
change, which makes "is msg-2 caused by bus latency?" directly testable instead of
architectural.

#### 3.1 The security model bifurcates by runtime

In-process means the same memory space, so **permissions are unenforceable** —
a plugin sharing the interpreter can reach anything. Rather than pretend
otherwise:

| | `in_process` | `process` |
| --- | --- | --- |
| Trust | Trusted by definition | Untrusted |
| Approval | A yes/no install decision: do you trust this code? | Per-frame permission enforcement, rate limits, secrets |
| Suitable for | First-party code you ship | Third-party code, anything you have not read |

**This is what gives the bus a real job.** It stops being the default path for
your own code and becomes the sandbox for code you do not trust — which is
precisely what a marketplace would need. The 191 tests, the permission whitelist,
the manifest-hash re-approval, and the SSRF gating all keep their value; they
simply apply where an actual adversary might exist.

### 4. Where the line falls

**The rule: out-of-process is for I/O with the outside world, and for code you do
not trust. Everything else is a library.**

| Extension | Lands | Why |
| --- | --- | --- |
| item log, unread, read receipts, fan-out | **Core** | Core's own data model — see the log spec |
| typing indicators | **Core** (signal) | Pure ephemeral fan-out; declares no storage at all |
| `room-type-chat` | **in_process** | Hot path. Becomes a renderer once core owns the log |
| `room-type-todo` | **in_process** | Small writes, interprets core log items |
| `message-reactions` | **in_process** | Appends `reaction` log items; small, frequent |
| `emoji-picker` | **in_process** | Data serving, no bus permission at all |
| **link previews** | **`process`** — *and split out of the chat plugin* | Fetches arbitrary user-supplied URLs: SSRF, hangs, hostile payloads |
| `attachments` | **`process`** | Parses untrusted bytes with Pillow; blob I/O can be heavy or hostile |
| `web-push` | **`process`** | Outbound HTTP to FCM/APNs; third-party network dependency |

Note this is close to the *inverse* of the current arrangement, and that the two
strongest isolation candidates in the codebase — link previews and image parsing —
are currently the two things running with no isolation at all.

#### 4.1 Batch the core API regardless of runtime

`get_notify_level` called per member is a design mistake at any transport. It
becomes `get_notify_levels(room_id) -> dict`, turning N round-trips into one.

This matters because it may fix msg-2 on its own, which would mean the bug was an
API-granularity error rather than evidence against out-of-process. **Fix it
before concluding anything about the boundary** — otherwise the wrong lesson gets
learned from the timebox.

#### 4.2 Cross-plugin coupling dissolves

`web-push` currently subscribes to `four43.room-type-chat:message` by name, so
push works for exactly one room type. Once core owns the log it subscribes to
core log items instead, and push works for every room type without knowing any of
them exist.

### 5. The admin never learns that plugins are processes

**The app owns the plugin lifecycle.** On startup, core reads the manifests,
spawns every `runtime: "process"` plugin, supervises them, restarts on crash with
backoff, and surfaces per-plugin health in the admin UI. `start-plugins` remains
only as a dev convenience for running a plugin under a debugger.

This is the condition on out-of-process surviving at all. An operator who must
remember a shell script, notice a silent crash, and diagnose a dead plugin is
paying real cost for a boundary that benefits them not at all. If the supervisor
is more work than it is worth, then in-process everywhere is the more honest
engineering — but with the line drawn as in §4, only three plugins need
supervising, and none of them are on the critical path for basic messaging.

Also resolved by core-owned lifecycle: the documented
"seed-script-must-run-before-plugin-start" ordering hazard
(`plugin-system-review.md:62`), which currently has nothing enforcing it.

### 6. What gets deleted

- `four43.chat-typing` — becomes the core signal channel.
- The chat plugin's `messages` and `link_previews` tables — messages move to the
  core log, previews move to their own out-of-process plugin.
- `run-plugins.py` — superseded by core-owned supervision.
- Nothing in `plugin_bus/`.

## Verification

- `docker compose up` with no `start-plugins` invocation serves a working chat
  room, including unread badges.
- Killing an out-of-process plugin results in an automatic restart and a visible
  degraded state in the admin UI before that restart completes.
- Flipping `room-type-chat` between `in_process` and `process` requires editing
  only the manifest, and the plugin's Python is unchanged.
- A `feature` plugin with `applies_to: ["chat"]` does not load into a todo room.
- Editing a plugin's `subscriptions` in the manifest triggers re-approval;
  the admin approval screen lists subscriptions and claimed room types.
- A plugin whose runtime `register.room_type` disagrees with its manifest is
  refused.
- `get_notify_levels` issues one round-trip for an N-member room, verified with
  `SKRIB_TIMING=1`.
- Themes appear in the same admin extension list as plugins, grouped by `kind`.

## Risks

- **`plugin-system.md` needs surgery, not patches.** 38 KB of it describes the
  current boundary, and §20 already misdescribes the e2e tests as not spawning
  plugin processes, which the fixtures now do.
- **The supervisor is new code on the startup path.** A bug there takes down the
  whole app rather than one plugin. Mitigation: a plugin that fails to spawn is
  logged and marked unhealthy, never fatal to core.
- **In-process plugins can crash the server.** That is the accepted cost of
  trusting first-party code; it is why untrusted code is not eligible for
  `in_process`.
- **`kind: theme` folds a working mechanism into a new one.** Themes function
  today. Migrating them buys consistency and approval coverage, but it is churn
  with no user-visible benefit — reasonable to schedule last.
- **Batching `get_notify_levels` may fix msg-2**, which would remove the
  motivating evidence for the boundary change. The change still stands on the
  admin-experience and misplaced-isolation arguments, but the urgency drops and
  the ordering in `2026-08-02-roadmap-phases.md` should reflect that.
