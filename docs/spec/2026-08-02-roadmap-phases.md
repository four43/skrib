# Roadmap: pillars, phases, and the enterprise re-scope

**Date:** 2026-08-02
**Status:** Approved direction
**Companion specs:** `2026-08-02-core-log-and-signal.md`,
`2026-08-02-extension-model.md`, `2026-08-02-onboarding-invite-links.md`,
`2026-08-02-calls-mesh-p2p.md`

## Problem

The project stalled, and the shape of the stall is specific.

Last product commit: **2026-05-02** ("WIP: Plugin updates"). Then a three-month
gap. The only work since is a Docker/devcontainer design doc.
`TODO-fix-e2e-tests.md` is dated **2026-05-04** and documents ~20 failing e2e tests
blocked on one unresolved bug ("send msg 2 fails after msg 1"), with a five-step
debugging plan that was never executed.

So the sequence was: a plugin refactor broke the suite → the bug was genuinely hard
→ work stopped → energy returned three months later as **build tooling** rather
than as the bug or the product.

Two contributing causes, both addressable:

1. **No stated purpose.** Every planning doc starts from features. None states who
   user #1 is. Without that, `enterprise-features.md` generates an infinite
   backlog and nothing is ever the obvious next thing.
2. **The scaffolding outgrew the product.** ~120 KB of plugin-system design across
   three documents, 191 bus unit tests, and a full permission/approval/rate-limit
   model — hosting seven first-party plugins that implement chat, todo, typing,
   reactions, push, attachments, and emoji. More extension mechanism than the app
   it extends.

## The three pillars

Decided, in priority order:

1. **End-to-end encryption — inviolable.** Not a per-room toggle, not a per-room-type
   property. A conditional guarantee is a config bug waiting to happen; an
   absolute one is auditable. This decision has real costs and they are paid
   deliberately (§2).
2. **Extensibility.** Pluggable room types where chat is merely the first one. This
   is a genuine differentiator: Slack and Discord apps are strictly additive,
   Matrix room types are implemented per-client, and Zulip/Mattermost/Rocket.Chat
   all freeze the core message model. The nearest analogue is Obsidian, which
   `docs/planning/plugin-plan.md:250` already cites.
3. **User experience.** Promoted to a pillar because it is the only one with
   verified user evidence: the app was deployed, and **users could not get through
   sign-up.**

### Purpose

**User #1 is the developer and a small group of friends and family.** Success is
"this is our group's chat, and I'd be annoyed if it went away." Enterprise is a
genuine eventual destination, reached in phases — not a justification for building
containment before there is anything to contain.

## 1. What the differentiator actually is

Worth stating precisely, because it was nearly discarded for the wrong reason.

**The differentiator is the seam, not the transport.** Pluggable room types is a
product and API idea. An out-of-process WebSocket bus with per-frame permission
enforcement is a deployment and containment mechanism. Users experience the first
and cannot perceive the second.

So the plugin architecture keeps its value while the process boundary moves.
See `2026-08-02-extension-model.md`.

There is a second correction hidden in this. Today, writing a room type means
reimplementing storage, broadcast, and notification — which is the real reason
there are two room types rather than ten. **Making core bigger is what makes the
extensibility pillar real.** The plugin API is currently deep enough to be hard and
shallow enough to be useless.

## 2. The enterprise re-scope

`enterprise-features.md` was written before E2E was declared inviolable, and much
of it contradicts that decision. `end-to-end-encryption.md:3` states the server
never sees plaintext; the following features all require that it does.

### Permanently cut — needs server-side plaintext, no workaround

| Feature | Tier |
| --- | --- |
| Data Loss Prevention — regex/keyword/ML content scanning | 1 |
| eDiscovery *production* of message content | 1 |
| Compliance archiving — Global Relay / Smarsh journaling | 3 |
| Information barriers *as enforced at search* | 3 |

Only legal hold acknowledged the tension in the original doc. The other three did
not.

### Survives — metadata or identity, not content

SSO/OIDC, SCIM, audit logging, data retention and auto-purge (deleting ciphertext
on a schedule works fine), guest access, presence, threads, file management, HA,
mobile/desktop apps, federation, and information barriers enforced at room-join and
DM-creation.

### Costs paid elsewhere by the pillar

- **Server-side message search is permanently impossible.** Search must be a
  client-side index over decrypted content. Also: `CLAUDE.md` advertises a
  `backend/skrib/messages/` module for search that does not exist.
- **Push notifications cannot describe their content** server-side. Mitigated by
  service-worker decryption — see `2026-08-02-core-log-and-signal.md` §4.3.
- **`@mention` badges must be computed client-side.**
- **Group calls are capped at four** without SFrame. See
  `2026-08-02-calls-mesh-p2p.md` §4.

### An unresolved conflict, flagged not solved

**SSO/OIDC contradicts WebAuthn-only auth** — not E2E. Under OIDC the identity
provider owns identity, so a local passkey stops being the root of trust. This is
resolvable but undecided, and it needs its own spec before Phase 5.

### Priority inversion, corrected

The original table put SSO, audit logging, and data retention at Phase 1, with
**threads and search at Phase 3**. That ordering is by procurement priority. Since
user #1 is a small group, threads and search are used daily and SSO is used never.
The revised order below serves the user who exists.

## 3. Phases

### Phase 0 — Unblock the repository

Nothing ships from a red branch.

- **Batch `get_notify_levels`** (N round-trips → 1). Do this *first*: it may fix
  msg-2 outright, and if it does, the bug was an API-granularity error rather than
  evidence about the process boundary. The wrong lesson is easy to learn here.
- **Timebox msg-2 to two focused sessions.** Green → merge and move on. Still red →
  that is the answer on moving `room-type-chat` to `in_process`, taken without
  regret. An unbounded "just fix the bug" is the plan that already failed for three
  months; a timebox with a predetermined exit cannot lose.
- Get the e2e suite green, merge `feat-plugins-new-process` into `master`.
- Land the Docker/devcontainer work already sitting uncommitted in the working
  tree.

### Phase 1 — Onboarding

The only work with verified user evidence behind it. Independent of the log
rework (auth does not touch messages), so it ships first and gets a real user win
early.

- **`invite_only` as the seeded default.** One line, highest value per character in
  the entire roadmap — it removes the wall that ended the last deployment.
- Invite links with a fragment-carried secret; delete the invented passphrase.
- PRF-first credentials, generated phrase as fallback. Fix `S5` and `S6`.
- Second-session prompt: PWA install first, recovery second.
- TTL sweep with de-credentialing; redemption notifications with a revoke action.
- Relax username rules; raise the registration-token TTL.

**Exit criterion: re-deploy to the same friends and watch them get in.** That is
the test this phase exists to pass.

### Phase 2 — Core primitives

- The per-room append-only item log; `last_read_message_id` becomes a real foreign
  key.
- The signal channel (fire-and-forget, broadcast and directed).
- Chat becomes a renderer over the log rather than the owner of messages.
- Delete `four43.chat-typing`.
- Key rotation on member removal.

### Phase 3 — Extension model

- `kind`, `runtime`, `applies_to`, `subscriptions` in the manifest.
- Core-owned plugin supervision, health in the admin UI; retire `run-plugins.py`.
- Split link previews out of the chat plugin into their own `process` plugin.
- Move attachments to `process`.
- Fold themes into the same mechanism (schedule last — it is churn with no
  user-visible benefit).

### Phase 4 — Daily use

The features a small group actually wants.

- Client-side search index over the log.
- Threads (`parent_id` already exists, so no schema change).
- Calls: mesh, capped at four.

### Phase 5 — Privacy-first organizations

Enterprise, re-scoped to what survives the E2E pillar.

- SSO/OIDC — requires resolving the WebAuthn-only conflict first.
- Audit logging (metadata).
- Data retention and scheduled purge.
- Guest access; bot accounts with API tokens (which must also be key holders).

### Phase 6+ — Deferred

Federation. SFU + SFrame for calls beyond four. A third-party plugin marketplace —
now genuinely possible, since the bus becomes the untrusted-code sandbox rather
than the default path. Native mobile and desktop apps.

## 4. Documentation debt

| Document | Action |
| --- | --- |
| `docs/plugin-system.md` | 38 KB describing the old boundary. Needs surgery, not patches. §20 also misdescribes the e2e tests as not spawning plugin processes. |
| `docs/architecture.md` | Add the log and signal primitives; correct the "in-process plugins still work" claim at line 214, which is false. |
| `docs/auth.md` | Rewrite registration; the two-page rationale at line 38 is obsoleted by deleting the passphrase. Correct the default-mode claim at line 102. |
| `docs/enterprise-features.md` | Apply the cut list in §2; re-order the phase table. |
| `docs/end-to-end-encryption.md` | Add envelope ownership, epoch retention on member removal. |
| `docs/progressive-web-app.md` | Add storage durability and `navigator.storage.persist()`. |
| `CLAUDE.md` | Remove the non-existent `messages/` module; document the log/signal split and the `kind`/`runtime` fields. |
| `TODO-fix-e2e-tests.md` | Fold into Phase 0, then delete. |

## 5. The anti-pattern to watch for

The stall had a signature: three months with no product commits, then a burst of
energy spent on build tooling. Infrastructure work feels productive, is
objectively measurable, and has no user on the other end — which is exactly why it
is where a stalled project goes.

**Checkable rule: if the next commit after this roadmap is infrastructure, and no
user-visible change has shipped since, something has gone wrong.** Phase 0 is the
one deliberate exception, and it is bounded by a timebox for that reason.

## Risks

- **Phase 2 is a large change to a codebase whose test suite has been red for
  three months.** Phase 0 exists specifically so that Phase 2 does not begin
  without a working safety net.
- **The phase order puts a user win before architectural cleanup**, which means
  Phase 1 ships onto the current plugin architecture and may need light rework in
  Phase 2. Accepted deliberately: the failure mode of this project has been
  architecture without users, not the reverse.
- **Enterprise remains a stated destination while four Tier-1/Tier-3 features are
  permanently cut.** If a future enterprise conversation requires DLP or
  compliance archiving, the E2E pillar is what has to break — and that decision
  has already been made in the other direction. This should be revisited
  consciously, not discovered in a sales conversation.
- **`invite_only` as the default means a fresh server has no open registration
  path.** The first user is auto-approved as admin (existing behaviour), so the
  bootstrap works, but the admin must issue links before anyone else can join.
