# Skrīb documentation

Three layers, with different rules. Put new documents in the right one.

| Layer | What it holds | Naming | Editing rule |
| --- | --- | --- | --- |
| `spec/` | **Decision records.** What was decided, when, and why. | `YYYY-MM-DD-topic.md` | Effectively immutable. Supersede with a new dated spec rather than editing an old one. |
| `reference/` | **Living documentation.** How the system works right now. | `topic.md` | Edit in place. Must always be true of `master`. |
| `legacy/` | **Superseded.** Kept for history. | as-is | Never edit except to correct a supersession note. |
| `assets/` | Images, design files. | as-is | — |

If a `reference/` doc describes behaviour that an approved spec is about to
change, mark it with a `> **Changing.**` blockquote pointing at the spec. That
keeps reference docs honest without pretending the future has already happened.

---

## Current direction

Start here. `spec/2026-08-02-roadmap-phases.md` states the three pillars
(E2E encryption as inviolable, extensibility, user experience), the phase order,
and what was cut from the enterprise scope.

| Spec | Decides |
| --- | --- |
| [`spec/2026-08-02-roadmap-phases.md`](spec/2026-08-02-roadmap-phases.md) | Pillars, phase order, enterprise re-scope, documentation debt |
| [`spec/2026-08-02-core-log-and-signal.md`](spec/2026-08-02-core-log-and-signal.md) | Core owns a per-room append-only item log plus a transient signal channel |
| [`spec/2026-08-02-extension-model.md`](spec/2026-08-02-extension-model.md) | `kind` / `runtime` / `applies_to` manifest fields; where the process boundary belongs |
| [`spec/2026-08-02-onboarding-invite-links.md`](spec/2026-08-02-onboarding-invite-links.md) | Invite links, deferred recovery, PWA install; fixes the sign-up failure |
| [`spec/2026-08-02-calls-mesh-p2p.md`](spec/2026-08-02-calls-mesh-p2p.md) | Voice/video as P2P mesh capped at four participants |
| [`spec/2026-08-02-docker-multistage-nonroot-design.md`](spec/2026-08-02-docker-multistage-nonroot-design.md) | Multi-stage non-root image and devcontainer |

## Earlier decisions

| Spec | Status |
| --- | --- |
| [`spec/2026-05-02-plugin-multiprocess-review.md`](spec/2026-05-02-plugin-multiprocess-review.md) | Review of the out-of-process migration. Its open items are folded into `TODO.md`. |
| [`spec/2026-04-11-community-key-profile-encryption.md`](spec/2026-04-11-community-key-profile-encryption.md) | **Not implemented.** Zero-knowledge encryption of profile fields. |
| [`spec/2026-04-04-security-audit-findings.md`](spec/2026-04-04-security-audit-findings.md) | All 12 findings fixed. |
| [`spec/2026-04-02-emoji-picker-plugin.md`](spec/2026-04-02-emoji-picker-plugin.md) | Implemented. |
| [`spec/2026-03-03-room-joining-discoverability.md`](spec/2026-03-03-room-joining-discoverability.md) | Implemented. |
| [`spec/2026-02-24-nestable-room-folders.md`](spec/2026-02-24-nestable-room-folders.md) | Implemented. |

## Reference

| Doc | Covers |
| --- | --- |
| [`reference/architecture.md`](reference/architecture.md) | System overview, modules, schema, deployment |
| [`reference/auth.md`](reference/auth.md) | Registration and login flows, auth API |
| [`reference/security.md`](reference/security.md) | Boundaries, authorization, threat model, residual risks |
| [`reference/end-to-end-encryption.md`](reference/end-to-end-encryption.md) | Key hierarchy, envelope, epochs and rotation, recovery |
| [`reference/rooms-and-membership.md`](reference/rooms-and-membership.md) | Rooms, roles, membership, slash commands |
| [`reference/users.md`](reference/users.md) | User model, roles, registration modes, user API |
| [`reference/websocket-bus.md`](reference/websocket-bus.md) | Client WebSocket protocol, namespaces, scoping |
| [`reference/plugin-system.md`](reference/plugin-system.md) | Plugin bus protocol, permissions, SDK, approvals |
| [`reference/plugin-architecture-comparison.md`](reference/plugin-architecture-comparison.md) | How Discord, Slack, Obsidian and VS Code do plugins |
| [`reference/admin-and-moderation.md`](reference/admin-and-moderation.md) | Admin panel, server settings, themes, user management |
| [`reference/backups.md`](reference/backups.md) | Backup archives, retention, scheduling |
| [`reference/progressive-web-app.md`](reference/progressive-web-app.md) | Manifest, service worker, Web Push |
| [`reference/playwright-webauthn-testing.md`](reference/playwright-webauthn-testing.md) | CDP virtual authenticators for e2e tests |

## Work in flight

`TODO.md` at the repository root is the single live task list. It absorbed
`TODO-fix-e2e-tests.md`, the open items from the plugin multi-process review, and
`api-todo-cleanup.md`.
