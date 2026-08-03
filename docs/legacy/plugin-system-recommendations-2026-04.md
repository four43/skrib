# Plugin System Recommendations (2026-04)

> **Superseded — retained for history.** These were the Skrīb-specific
> recommendations from `plugin-system-research.md` (2026-04-02). Some were
> implemented, one rested on a premise that turned out to be wrong, and the
> priority order has been replaced by
> `docs/spec/2026-08-02-extension-model.md`.
>
> The platform comparison the recommendations were drawn from is still live at
> `docs/reference/plugin-architecture-comparison.md`.
>
> **Read the footer of this file before acting on anything in it.**

---

## Recommendations for Skrib

### What Skrib Already Does Well

Skrib's current plugin system has strong foundations drawing from patterns across all four platforms:

- **Isolated databases per plugin** — Better than Obsidian's single `data.json` or VS Code's key-value `globalState`, comparable to Slack's Datastores.
- **Namespaced event bus** — Cleaner than Obsidian's shared `app` object, similar to Discord's gateway and VS Code's RPC model.
- **Core features as plugins** (`room-type-chat`, `room-type-todo`) — The Obsidian pattern that keeps the API honest. VS Code does this partially with built-in extensions.
- **Manifest-driven config** — Aligns with Slack's manifest-as-source-of-truth and VS Code's declarative `package.json` contribution points.
- **5-phase decoupling roadmap** — Heading toward the process isolation that VS Code already achieves with Extension Hosts, and Slack's model where plugins can be external processes.

### What to Adopt

#### 1. Obsidian's `register*` Auto-Cleanup Pattern

**Priority: High | Effort: Low**

Skrib's `on_startup`/`on_shutdown` hooks exist, but plugins manually manage resources. Add registration methods that return handles auto-cleaned on disable/shutdown:

```python
# Instead of manual tracking:
self.bus.on_event("core:room_deleted", self.handle_delete)
# ...and hoping on_shutdown() remembers to unregister

# Auto-cleanup registration:
self.register_event("core:room_deleted", self.handle_delete)
# Framework cleans up automatically on disable/shutdown
```

This eliminates an entire class of resource leak bugs. Both Obsidian (2000+ plugins) and VS Code (50,000+ extensions) prove this pattern works at scale — VS Code's `Disposable`/`subscriptions` pattern is essentially the same idea.

#### 2. Slack's Declarative Permission Enforcement

**Priority: High | Effort: Medium**

Skrib's manifest already declares permissions (`"permissions": ["websocket.send", "dom.messages"]`) but they aren't enforced. Once the proxy pre-auth layer exists (Phase 1), enforce these:

- A plugin declaring `websocket.send` gets a bus that can send; one without it gets a read-only bus.
- A plugin declaring `dom.messages` can inject UI into the message list; one without it cannot.

This is Slack's scope model applied locally. Start with a small set of capabilities: `messages`, `rooms`, `users`, `websocket`, `storage`.

#### 3. Slack's Composable Functions Model

**Priority: Medium | Effort: Medium**

Instead of plugins being monoliths, they could expose **typed functions** that other plugins or core can invoke:

```json
{
  "functions": {
    "get_unread_count": {
      "input": {"room_id": "string", "since_message_id": "string"},
      "output": {"count": "integer"}
    }
  }
}
```

This solves inter-plugin communication (Obsidian's weakness), makes the Phase 4/5 HTTP callback model more natural, and opens the door to a Workflow Builder-like feature where non-developers compose plugin functions.

#### 4. Discord's Structured UI Components

**Priority: Medium | Effort: Higher**

For frontend plugins, consider a component declaration system similar to Discord's Components v2 or Slack's Block Kit. Instead of plugins injecting raw DOM, they declare UI structures:

```json
{
  "type": "action_row",
  "components": [
    {"type": "button", "label": "React", "style": "secondary", "action": "add_reaction"},
    {"type": "button", "label": "Reply", "style": "primary", "action": "start_reply"}
  ]
}
```

The frontend renders these consistently. This gives a sandboxing surface on the frontend and ensures visual consistency.

#### 5. Slack's Socket Mode for Development

**Priority: Low | Effort: Low**

Skrib's WebSocket bus already serves this role, but explicitly supporting a "dev mode" where out-of-process plugins can connect via WebSocket (without being in the same Python process) would accelerate the Phase 5 transition and improve the developer experience.

### What to Avoid

- **Discord's persistent connection requirement** — Skrib's event bus with listen-and-dispatch is already better. Don't force plugins to maintain idle connections.

- **Obsidian's lack of sandboxing** — Skrib is a multi-user server app. The "trust the plugin" model is not viable. The Phase 5 process isolation roadmap is the right goal.

- **Slack's scope-creep complexity** — Hundreds of scopes, multiple auth flows, and a confusing traditional-vs-new-platform split. Keep Skrib's permission model to a small, enforceable set of capabilities.

- **VS Code's "no permissions" model** — VS Code proves that a great developer experience can coexist with zero permission enforcement — but only because it's a single-user desktop app. Skrib is a multi-user server. Don't follow VS Code's lead here.

- **Over-investing in marketplace/review infrastructure now** — All four platforms struggle with this. Since Skrib is early and plugins are first-party, don't build review processes yet. VS Code's instant-publish model is tempting but only works with automated malware scanning at scale.

### Recommended Priority Order

| # | Action | Effort | Impact | Inspired By |
|---|--------|--------|--------|-------------|
| 1 | Auto-cleanup registration pattern | Low | Immediate reliability win | Obsidian, VS Code |
| 2 | Enforce manifest permissions on PluginBus | Medium | Security foundation | Slack |
| 3 | Typed function exports between plugins | Medium | Solves coupling, enables composition | Slack new platform, VS Code `activate()` exports |
| 4 | Frontend component declaration system | Higher | Safe plugin UI, visual consistency | Discord Components v2, Slack Block Kit, VS Code contribution points |
| 5 | Process isolation for plugins | Medium | Stability + security | VS Code Extension Host |
| 6 | Dev mode for out-of-process plugin testing | Low | Accelerates Phase 5 | Slack Socket Mode |

These align with the existing Phase 1-2 roadmap in [plugin-plan.md](plugin-plan.md) and would put Skrib's plugin system ahead of Obsidian and VS Code on security (permission enforcement), ahead of Discord on developer ergonomics, and comparable to Slack's new platform on composability — without the complexity overhead. VS Code's Extension Host model validates that process isolation is achievable without sacrificing developer experience, reinforcing the Phase 5 roadmap.

---

## Retrospective — why these changed (2026-08-02)

### What was implemented

| # | Recommendation | Outcome |
|---|---|---|
| 2 | Enforce manifest permissions on the bus | **Done.** `VALID_PERMISSIONS` whitelist, per-frame enforcement, `bus.receive` checked on subscriptions. |
| 5 | Process isolation for plugins | **Done**, then partially reversed. See below. |
| 6 | Dev mode for out-of-process plugin testing | **Done** — `backend/util/start-plugins`. |

### What was never done

Items 1 (Obsidian-style `register*` auto-cleanup), 3 (typed function exports),
and 4 (declarative frontend components) were not implemented. Item 1 in
particular is still a good idea and carries forward into the combined TODO.

### The premise that was wrong

Under **What to Avoid**, this document argued:

> *"Obsidian's lack of sandboxing — Skrib is a multi-user server app. The 'trust
> the plugin' model is not viable."*

The reasoning was sound but the premise conflated two different populations.
"Plugins" was treated as one category needing one trust policy. In practice
Skrīb has two:

- **First-party plugins** shipped with the server, written by the maintainer. For
  these, "trust the plugin" is not a weakness — it is simply an accurate
  description. Every plugin in the repository is `four43.*`.
- **Third-party plugins**, which do need sandboxing — and which do not exist yet.

Because the distinction was missed, the containment model was built for a
population of zero, and applied to the population that did not need it. The
result was that the *core chat feature* became a supervised external process
requiring approval, secrets, and per-frame permission checks, while the two
genuinely risky components — link-preview fetching of arbitrary user-supplied
URLs, and Pillow parsing of untrusted uploads — ran with no isolation at all.

### Where recommendation 5 landed

Process isolation was rated "Medium effort / Stability + security." The realised
outcome was the opposite on both counts:

- **Stability got worse, not better.** Chat is a plugin, so with the in-process
  path deleted, any bridge failure made every room action fail. Isolation
  normally buys crash containment; here it converted the core feature into a
  distributed dependency with no supervisor, no health probe, and no
  restart-on-crash.
- **The security benefit applied to a threat that did not exist**, per above.
- **Cost was underestimated.** Per-member `core_api` round-trips inside the
  message handler are the leading cause of the ~20 e2e test failures that stalled
  the project from 2026-05 to 2026-08.

The correction is not to abandon process isolation but to make it a *deployment
choice* rather than the default: `runtime: in_process | process` in the manifest,
with the same SDK either way. Untrusted code gets the sandbox this document
correctly argued for; trusted first-party code runs in-process. The bus, the
permission model, and its 191 tests all keep their value — they become the
mechanism that makes a future third-party marketplace safe, rather than overhead
on the maintainer's own code.

Full reasoning: `docs/spec/2026-08-02-extension-model.md`.
