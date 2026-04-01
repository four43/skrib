# Plugin System Research: Discord, Slack, Obsidian, and VS Code

A comparative analysis of plugin architectures from Discord, Slack, Obsidian, and VS Code — with recommendations for Skrib's plugin system.

---

## Table of Contents

- [Discord](#discord)
- [Slack](#slack)
- [Obsidian](#obsidian)
- [VS Code](#vs-code)
- [Cross-Platform Comparison](#cross-platform-comparison)
- [Common Pain Points](#common-pain-points-across-all-four)
- [Recommendations for Skrib](#recommendations-for-skrib)
- [Sources](#sources)

---

## Discord

### Architecture

Discord apps are external services that communicate with Discord's platform via two connection models:

1. **Gateway (WebSocket)** — Persistent connection. The bot authenticates with a token, maintains a heartbeat, and receives all subscribed events in real-time. Required for reading messages, reactions, presence, and voice state. Resource-intensive — bots in many servers process enormous event streams.

2. **Interactions Endpoint (HTTP Webhook)** — The app registers an HTTPS endpoint. Discord POSTs to it when users trigger slash commands, click buttons, or use menus. Enables serverless architectures (Lambda, Cloudflare Workers). Cannot receive passive events like message creation.

These models are not mutually exclusive per-application.

### Registration and Installation

- Apps are created in the Developer Portal (client ID + client secret).
- A Bot User is the identity the app uses inside servers.
- Installation is via OAuth2 with specific scopes and permission bits.
- Two install types: **Guild Install** (added to a server) and **User Install** (added to a user's account, available across servers).

### Extension Points

**Application Commands (3 types):**

- **Slash Commands** (`/command`) — Typed commands with names, descriptions, options (string, user, role, channel), subcommands. Discord's client handles autocomplete, validation, and in-line help.
- **User Context Menu Commands** — Right-click on a user.
- **Message Context Menu Commands** — Right-click on a message.

**Components v2 (March 2025):**
Three-layer UI system:

- Layout: Action Row, Section, Container (recursive nesting), Separator
- Content: Text Display (Markdown), Thumbnail, Media Gallery, File
- Interactive: Button, Select Menus (String/User/Role/Channel), Text Input, File Upload

Messages can contain up to 40 components. Replaces the old embed+content model — messages are built entirely from components.

**Modals:** Pop-up forms for structured input.

**Activities (Embedded Apps):** Full web applications in sandboxed iframes using `@discord/embedded-app-sdk`. All traffic routes through Discord's Cloudflare proxy. Supports multiplayer games, collaborative tools, and social experiences.

**Gateway Intents:** Control which real-time events the bot receives. Three are privileged (GuildMembers, GuildPresences, MessageContent) and require verification at scale.

### Permissions Model

Multi-layered:

| Layer | Scope | Mechanism |
|-------|-------|-----------|
| OAuth2 Scopes | Installation-time | What the app can do at a platform level |
| Permission Bits | Per-server, 53-bit integer | Granted at install, restricted by admins via role hierarchy |
| Gateway Intents | Event-level | Which real-time events the bot receives |
| Activities Sandbox | Runtime | Iframe isolation, CSP, proxy-only network, no eval() |

Verification escalation: unverified apps work under 75 servers. At 100+ servers, identity verification (Stripe), data usage documentation, and intent justification are required.

### What Works Well

- **Slash commands** replaced prefix-based commands — Discord's client handles parsing, validation, type checking, and autocomplete natively.
- **Components v2** enables genuinely interactive UIs without leaving Discord.
- **Large ecosystem** of mature client libraries (discord.js, discord.py, JDA, Serenity).
- **Activities SDK** enables full embedded web apps.
- **Immediate reach** — bots are discovered organically. The App Directory provides official discovery.

### What Doesn't Work Well

- **Persistent connection requirement** — Gateway bots must run 24/7, consuming resources even when idle. Prevents serverless for event-driven bots. Developers have long advocated for webhook delivery of all gateway events.
- **Frequent breaking changes** — 2025 alone saw token format changes, endpoint deprecations, permission restructuring, and rate limit additions.
- **Verification process is opaque** — Unclear rejection reasons, inconsistent enforcement.
- **Aggressive rate limiting** on member fetching, message sending, and command registration.
- **Privileged intents gatekeeping** broke existing bots and forced rewrites.

---

## Slack

### Architecture

Slack offers two hosting models:

1. **Self-hosted (Bolt SDK)** — App runs on your infrastructure. Bolt handles auth, rate limits, and event routing. Available for JavaScript, Python, and Java.
2. **Slack-hosted (Deno SDK)** — Deployed to Slack's infrastructure. Function-oriented, composable architecture with sandboxed Deno runtime.

Every app is defined by a **manifest file** (YAML, JSON, or TypeScript) — the single source of truth for configuration. Sections: `display_information`, `features`, `oauth_config`, `settings`, `functions`, `workflows`, `datastores`.

### Registration and Installation

- Created via `slack create` CLI or the web app settings page.
- Installed via OAuth2: app redirects user to Slack's auth URL, user approves scopes, Slack returns an authorization code exchanged for tokens.
- Scopes are **additive** — re-authorizing with new scopes adds them; scopes cannot be downgraded.
- Internal apps are workspace-only. Marketplace apps go through the App Directory (~7 day review, 36-item checklist).

### Extension Points

**Surfaces (where apps appear):**

- Messages, Modals, App Home (dedicated dashboard tab), Canvases

**Entry Points:**

- **Slash Commands** — Max 50 per app. User types `/command text`.
- **Shortcuts** — Global (composer/search) or Message (context menu). Max 10 per app.
- **Events API** — Push-based. Two delivery methods: HTTP webhooks (must respond within 3 seconds) or Socket Mode (WebSocket, no public endpoint needed).
- **Block Kit** — Component-based UI framework: buttons, select menus, date pickers, text inputs, rich layouts.
- **Incoming Webhooks** — Simple URL-based one-way message posting.

**New Platform — Functions and Workflows:**

- **Custom Functions** — The core building block. Defined with typed input/output parameters. 60-second execution timeout. Must return success or error.
- **Workflows** — Chains of function steps with variable interpolation between steps. Can include built-in Slack functions and custom functions.
- **Triggers** — Link (URL), Shortcut (UI), Scheduled (cron), Event-based.
- **Datastores** — Built-in key-value storage declared in the manifest.
- **Workflow Builder integration** — Custom functions become reusable blocks for non-developers. 80% of Workflow Builder users are non-developers.

### Permissions Model

- Every API method requires specific OAuth scopes.
- Scopes split into **bot scopes** (app identity) and **user scopes** (user identity).
- Workspace owners can require admin approval before installation.
- Admins classify scopes as High/Medium/Low risk; rules auto-approve low-risk apps.
- Desktop client (Electron): full sandbox, no Node.js access in renderers, context isolation via `contextBridge`.
- Deno platform: sandboxed runtime, execution time limits (60s deployed, 15s local, 10s interactive).

### What Works Well

- **Manifest as source of truth** — Declarative, versionable, CLI-manageable.
- **Bolt SDK** — Handles boilerplate so developers focus on logic.
- **Block Kit** — Rich, consistent UI without fighting the platform.
- **Socket Mode** — Eliminates public endpoints during development.
- **Composable functions → workflows** — Non-developers remix developer-built primitives.
- **Developer sandboxes** — Free Enterprise org environments for testing.
- **Fast marketplace approval** (~7 days).

### What Doesn't Work Well

- **Aggressive rate limits on non-Marketplace apps** (2025 change) — 1 request/minute and 15 objects/request for commercially distributed non-Marketplace apps.
- **Broken bot token recovery** — No way to force-uninstall and get a new token.
- **Cross-platform rendering issues** — Messages from bots display incorrectly on iOS.
- **No billing integration** — No built-in way to charge through the Marketplace.
- **No app metrics** — Developers can't see install counts, usage stats, or rankings.
- **No user reviews/ratings** in the App Directory.
- **Block Kit limitations** — Only 5 buttons per block, restricted menu access.
- **Two-platform confusion** — Traditional Bolt vs new Deno SDK with gradually converging but distinct models.

---

## Obsidian

### Architecture

Obsidian plugins are **in-process JavaScript modules** running in the same Electron/Node.js context as the main application. Every plugin lives in `.obsidian/plugins/<plugin-id>/` and requires:

- `manifest.json` — Plugin metadata (id, name, version, minAppVersion, description, author, isDesktopOnly)
- `main.js` — Compiled from TypeScript, exports a class extending `Plugin`

The class hierarchy: **Component** (lifecycle/cleanup base) → **Plugin** (registration methods, data persistence) → **Your Plugin** (custom logic).

Every plugin receives `this.app` (type `App`) — the central gateway to all subsystems: `app.vault` (files), `app.workspace` (UI), `app.metadataCache` (parsed markdown), `app.fileManager`, `app.plugins` (other plugins).

Core features like backlinks, graph view, and file explorer are themselves implemented as "core plugins" using the same architecture.

### Extension Points

All registered during `onload()`:

| Method | Purpose |
|--------|---------|
| `addCommand(cmd)` | Register command palette action (3 callback types: always, conditional, editor-only) |
| `registerView(type, factory)` | Custom UI panels (sidebars, main area) |
| `addSettingTab(tab)` | Settings panel in Obsidian Settings |
| `registerEvent(handler)` | App-level events (vault, workspace, metadata) with auto-cleanup |
| `registerEditorExtension(ext)` | CodeMirror 6 extensions (state fields, decorations, keymaps) |
| `addRibbonIcon(icon, title, cb)` | Left sidebar icon |
| `addStatusBarItem()` | Status bar element |
| `registerMarkdownPostProcessor(fn)` | Transform rendered markdown |
| `registerMarkdownCodeBlockProcessor(lang, fn)` | Custom code block languages |
| `registerEditorSuggest(suggest)` | Autocomplete/suggestion popups |
| `registerDomEvent(el, type, cb)` | DOM listener with auto-cleanup |
| `registerInterval(id)` | setInterval with auto-cleanup |

### Lifecycle

```
Detected → Disabled → Initializing → Active → Unloading → Disabled
```

| Hook | When | Purpose |
|------|------|---------|
| `onload()` | Plugin enabled or updated | Register all capabilities, load settings |
| `onUserEnable()` | First time user enables (v1.7.2+) | One-time setup |
| `onExternalSettingsChange()` | data.json modified externally (v1.5.7+) | Reload settings |
| `onunload()` | Plugin disabled or app quits | Manual cleanup only |

**Auto-cleanup is the standout design decision.** Everything registered via `register*` methods is automatically cleaned up on unload. Developers rarely track resources manually. The official guidance: "Only implement `onunload()` for cleanup that cannot be registered."

Settings are stored as JSON in `.obsidian/plugins/<plugin-id>/data.json` via `loadData()`/`saveData()`.

Updates are automatic: developers create a GitHub release, and within 6 hours the Obsidian bot picks it up. Users see notifications and update with one click.

### Settings UI

Two-part system: `PluginSettingTab` (defines the panel) and `Setting` (individual rows). Available controls: text input, text area, toggle, dropdown, slider, button, color picker, search, date format picker. The `display()` method is imperative DOM manipulation, rebuilt fresh each time.

### Permissions and Sandboxing

**There is essentially no sandboxing.** Plugins run in the same JavaScript context with full access to:

- Filesystem (not just the vault)
- Network requests
- Child processes and system commands
- Hardware (camera, microphone)
- `eval()` and `new Function()`
- Other plugins' data and state

Security measures: initial code review on submission (not on updates), open source requirement, Safe Mode to disable community plugins, restricted plugin flagging, community reporting. The official recommendation: treat installing a plugin like installing software from the internet.

### Inter-Plugin Communication

No official mechanism. Community patterns:

1. **Global namespace export** — `window["my-plugin-api.v0"] = new MyPluginAPI(this)`
2. **Plugin registry access** — `this.app.plugins.plugins["other-plugin-id"]?.api`
3. **NPM type packages** — Published type definitions for API consumers

Limitations: no dependency resolution, no load ordering, no event bus between plugins, undocumented API access.

### What Works Well

- **`register*` auto-cleanup** eliminates resource leak bugs entirely.
- **Core features as plugins** keeps the API honest and capable.
- **TypeScript-first** with shipped type definitions.
- **Local-first, file-based** — no server APIs, no auth tokens, no rate limits.
- **2000+ community plugins** as reference implementations.
- **CodeMirror 6 integration** for sophisticated editor features.

### What Doesn't Work Well

- **Documentation gaps** — API reference is sparse. Developers reverse-engineer from other plugins.
- **Slow, opaque review process** — Single reviewer. Weeks without feedback. Undocumented requirements.
- **Plugin abandonment breaks workflows** — No mechanism for community takeover. Heavy plugin dependence "transforms Obsidian into a maintenance project."
- **Plugin conflicts** — No formal conflict or dependency declarations.
- **No sandboxing** — Full system access from community code.
- **Closed-source tension** — Commercial product relying on free community labor for its ecosystem.

---

## VS Code

### Architecture

VS Code extensions run in a **dedicated Node.js process** called the **Extension Host**, separate from the main editor UI process. This is the defining architectural decision — extensions never have direct access to the DOM or the main thread. Communication between the Extension Host and the renderer uses a bidirectional RPC protocol: the renderer exposes `MainThread*` actors, and the Extension Host exposes `ExtHost*` actors.

This process isolation means a misbehaving extension cannot freeze the editor. Users can always open, type, and save files regardless of what extensions are doing. VS Code also loads extensions **lazily** — extensions that aren't needed during a session consume zero memory.

There are multiple Extension Host types for different contexts:
- **Local Extension Host** — Node.js process on the local machine
- **Remote Extension Host** — Runs on a remote machine (SSH, containers, WSL)
- **Web Extension Host** — Runs in the browser (for vscode.dev / github.dev), restricted to browser APIs only

### Registration and Installation

- Extensions are packaged as `.vsix` files using the `vsce` CLI tool.
- Published to the [Visual Studio Marketplace](https://marketplace.visualstudio.com/) under a **publisher** identity (Microsoft or Personal Azure DevOps account).
- Installation is one-click from the Marketplace or via `code --install-extension`.
- Publishing is **immediate** — no review queue. Extensions appear in search within minutes.
- Post-publish, automated malware scanning runs on all incoming packages. If malware is detected, the extension is blocked immediately.
- Since VS Code 1.97, first-time installs from third-party publishers show a **trust confirmation dialog**.

### Extension Manifest (`package.json`)

The `package.json` serves as the extension manifest, mixing standard Node.js fields with VS Code-specific fields:

- `activationEvents` — When to load the extension (lazy activation)
- `contributes` — Static declarations of what the extension adds (contribution points)
- `extensionDependencies` — Other extensions this one depends on
- `extensionKind` — Whether it runs in the UI process or workspace process (relevant for remote dev)

### Extension Points

VS Code uses two complementary systems:

**Contribution Points (Declarative, in `package.json`):**

| Contribution | Purpose |
|---|---|
| `commands` | Register Command Palette actions |
| `menus` | Context menus, editor title bar, SCM title, etc. |
| `keybindings` | Keyboard shortcuts |
| `views` | Custom panels in sidebar, panel area |
| `viewsContainers` | New sidebar/panel containers |
| `languages` | Language declarations (ID, extensions, aliases) |
| `grammars` | TextMate grammars for syntax highlighting |
| `themes` | Color themes and icon themes |
| `snippets` | Code snippets |
| `debuggers` | Debug adapter configurations |
| `taskDefinitions` | Custom task types |
| `jsonValidation` | JSON schema associations |
| `configuration` | Settings entries in the Settings UI |
| `walkthroughs` | Getting started walkthroughs |

**Programmatic API (in `activate()`):**

| API Namespace | Purpose |
|---|---|
| `vscode.languages.*` | Hovers, completions, diagnostics, CodeLens, formatting, go-to-definition |
| `vscode.window.*` | Editors, terminals, notifications, quick picks, input boxes, status bar |
| `vscode.workspace.*` | File system, configuration, text documents, workspace folders |
| `vscode.commands.*` | Register and execute commands |
| `vscode.debug.*` | Debug sessions and breakpoints |
| `vscode.tests.*` | Test discovery and execution |
| `vscode.authentication.*` | Authentication providers |
| `vscode.comments.*` | Comment threads (used by PR extensions) |

**Webviews** provide fully custom HTML/CSS/JS UI panels, rendered in sandboxed iframes with Content Security Policy enforcement. Communication between the webview and extension uses message passing (`postMessage`/`onDidReceiveMessage`). A **Webview UI Toolkit** provides VS Code-native web components.

### Lifecycle

```
Installed → Inactive → Activating → Active → Deactivating → Inactive
```

| Hook | When | Purpose |
|------|------|---------|
| `activate(context)` | Activation event fires | Register capabilities, initialize state |
| `deactivate()` | Extension disabled or VS Code shuts down | Clean up resources |

**Activation Events** control lazy loading:

- `onCommand:myExtension.doThing` — When a specific command is invoked
- `onLanguage:python` — When a file of that language is opened
- `onView:myCustomView` — When a specific view becomes visible
- `onFileSystem:myScheme` — When a file with a custom URI scheme is opened
- `onStartupFinished` — After VS Code has started (non-blocking)
- `*` — Activate immediately on startup (discouraged)

Since VS Code 1.74.0, commands declared in `contributes.commands` auto-generate activation events — explicit `onCommand` entries are no longer required.

**Cleanup:** The `activate()` function receives an `ExtensionContext` with a `subscriptions` array. Anything pushed into `subscriptions` (event listeners, disposables) is automatically disposed when the extension deactivates. This is similar to Obsidian's `register*` pattern.

```typescript
export function activate(context: vscode.ExtensionContext) {
    // Auto-disposed on deactivate:
    context.subscriptions.push(
        vscode.commands.registerCommand('myExt.hello', () => { ... }),
        vscode.languages.registerHoverProvider('javascript', myProvider),
        vscode.window.onDidChangeActiveTextEditor(handler)
    );
}
```

### Permissions and Sandboxing

**The Extension Host has the same permissions as VS Code itself.** Extensions can:

- Read and write files anywhere on the filesystem
- Make arbitrary network requests
- Spawn child processes and system commands
- Modify workspace settings
- Access environment variables and credentials

There is **no API-level permission system**. Unlike Android, Chrome extensions, or mobile app stores, VS Code does not require extensions to declare or request access to specific capabilities. Any extension can call any API.

**What is isolated:**

- Extensions cannot access the DOM — all UI goes through the VS Code API or sandboxed webviews
- Extensions run in a separate process from the editor — crashes don't take down the UI
- Webviews enforce Content Security Policy and have restricted filesystem access via `localResourceRoots`
- Web extensions (vscode.dev) are restricted to browser-available APIs only

**Marketplace security measures:**

- Automated malware scanning on publish and periodic rescans
- Publisher trust dialog on first install (since v1.97)
- Community "Report a concern" link on extension pages
- Dynamic runtime behavior analysis in sandboxed VMs

### Inter-Extension Communication

VS Code has an **official mechanism** for inter-extension APIs:

1. **Exporting an API:** Return an object from `activate()` — it becomes the extension's public API surface.
2. **Consuming an API:** Declare `extensionDependencies` in `package.json`, then use `vscode.extensions.getExtension('publisher.extensionId')?.exports` to access it.
3. **Dependency resolution:** `extensionDependencies` ensures the dependency activates first.
4. **Commands as loose coupling:** Any extension can invoke any other extension's commands via `vscode.commands.executeCommand()` — no dependency declaration needed.

**Limitation:** API sharing only works between extensions running in the same Extension Host. UI extensions and Workspace extensions (in remote scenarios) cannot share APIs directly — they must use commands instead.

### What Works Well

- **Process isolation** — Extensions can't crash the editor. The UI stays responsive regardless of extension behavior. This is a stronger guarantee than Obsidian's in-process model.
- **Lazy activation** — Extensions are loaded only when needed, keeping startup fast. A user with 50 installed extensions may only activate 5 on a given session.
- **`ExtensionContext.subscriptions` auto-cleanup** — Same pattern as Obsidian's `register*`, preventing resource leaks.
- **Rich, typed API surface** — Comprehensive TypeScript definitions. Language features, UI, debugging, testing, SCM, and authentication all have dedicated API namespaces.
- **Contribution points** — Declarative JSON for static UI (menus, keybindings, views) means extensions integrate consistently without imperative DOM manipulation.
- **Official inter-extension API** — First-class dependency declaration and API export, unlike Obsidian's unofficial hacks.
- **Instant publishing** — No review queue. Publish and it's live within minutes.
- **Massive ecosystem** — 50,000+ extensions. Abundant reference implementations for any pattern.
- **Remote/web extension support** — Extensions can run on remote machines or in browsers without modification (if they follow the API constraints).

### What Doesn't Work Well

- **No permission system** — Extensions get full system access with no granularity. A syntax highlighter has the same privileges as a deployment tool. A [2024 research paper](https://arxiv.org/html/2411.07479v1) found widespread data exposure risks in the ecosystem. There's been a [long-standing feature request](https://github.com/microsoft/vscode/issues/52116) (since 2018) for permission sandboxing that remains unimplemented.
- **Webview limitations** — Custom UI requires webviews (sandboxed iframes), which have no control over panel size/position, suffer from state management complexity, and carry performance/accessibility costs. The official guidance is "only use webviews if you absolutely need them."
- **No UI primitives beyond contribution points** — If your UI doesn't fit into the predefined contribution points (views, menus, status bar), your only option is a webview. There's no component system like Discord's Components v2 or Slack's Block Kit.
- **Security relies on trust, not enforcement** — Malware scanning catches known patterns, but a malicious extension that passes the scan has full system access. Reporting mechanisms exist but are hard to find.
- **Remote/web extension split** — Extensions must handle running in local, remote, or web contexts. API availability differs across contexts, creating complexity for extension authors who want broad compatibility.
- **Extension conflicts** — No formal mechanism for detecting or preventing conflicts between extensions that modify the same features.

---

## Cross-Platform Comparison

| | Discord | Slack | Obsidian | VS Code | Skrib (current) |
|---|---|---|---|---|---|
| **Plugin runs** | External server | External or Slack-hosted | In-process (same JS context) | Separate process (Extension Host) | In-process (same Python process) |
| **Communication** | WebSocket + HTTP | HTTP + Socket Mode | Direct function calls | RPC over IPC | Namespaced event bus + HTTP routes |
| **UI system** | Components v2 | Block Kit | Commands, views, editor extensions | Contribution points + Webviews | Manifest-declared frontend JS |
| **Manifest** | Developer Portal | `manifest.yaml` (declarative) | `manifest.json` (simple) | `package.json` (declarative) | `manifest.json` |
| **Database** | BYO | Built-in Datastores | File-based `data.json` | `globalState`/`workspaceState` (key-value) | Isolated SQLite per plugin |
| **Sandboxing** | Iframes for Activities | Deno sandbox; Electron sandbox | None | Process isolation (no DOM access); Webviews sandboxed | None (planned Phase 5) |
| **Auto-cleanup** | N/A (external) | N/A (external) | Yes (`register*` pattern) | Yes (`subscriptions` / `Disposable`) | No |
| **Inter-plugin comms** | N/A (independent) | N/A (independent) | Unofficial hacks | Official (`activate()` exports + `extensionDependencies`) | Bus event subscriptions |
| **Core as plugins** | No | No | Yes | Partially (built-in extensions) | Yes (`room-type-chat`, `room-type-todo`) |
| **Permission enforcement** | OAuth scopes + intents | OAuth scopes per API method | None | None (full system access) | Declared but not enforced |

---

## Common Pain Points Across All Four

1. **Breaking changes without migration paths** — All four platforms frustrate developers with API changes that require rewrites. VS Code's rapid release cycle (monthly) means APIs can shift frequently, though deprecation warnings are generally provided.

2. **Opaque review/approval processes** — Discord verification, Slack marketplace, and Obsidian's single reviewer all have complaints about unclear criteria and slow turnaround. VS Code avoids this with instant publishing but trades it for weaker quality control.

3. **Documentation gaps** — Even the best-documented platform (Slack) has gaps. Obsidian developers rely on reading other plugins' source code. VS Code has extensive official docs but complex patterns (multi-root workspaces, remote extensions) are under-documented.

4. **Plugin abandonment** — No platform has a good answer for when maintainers disappear and users depend on the plugin.

5. **Inter-plugin communication** — Obsidian has no official mechanism. Discord and Slack don't need it (apps are independent services). VS Code has the best story here with official API exports and `extensionDependencies`, but it breaks down across remote/local boundaries.

6. **No permission granularity** — Obsidian and VS Code both give extensions full system access. Discord and Slack enforce scopes, but their models are complex. No platform has found the sweet spot between security and developer friction.

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

## Sources

### Discord

- [Discord Developer Portal — Introduction](https://docs.discord.com/developers/intro)
- [Discord Application Commands Documentation](https://discord.com/developers/docs/interactions/application-commands)
- [Discord Components v2 System — DeepWiki](https://deepwiki.com/discord/discord-api-docs/3.2-components-v2-system)
- [Discord Activities Overview & Architecture — DeepWiki](https://deepwiki.com/discord/discord-api-docs/5.1-activities-overview-and-architecture)
- [Discord Development 2025 Year-in-Review & API Migration Guide](https://discord-media.com/en/news/development-2025-the-complete-year-in-review-api-migration-guide.html)
- [Discord Bot Permissions and Intents Explained 2025](https://friendify.net/blog/discord-bot-permissions-and-intents-explained-2025.html)
- [Discord Privileged Intents: The 2025 Access Protocol](https://discord-media.com/en/news/discord-privileged-intents.html)
- [How Do I Get My App Verified — Discord Developer Support](https://support-dev.discord.com/hc/en-us/articles/23926564536471-How-Do-I-Get-My-App-Verified)
- [Why Discord Bot Development is Flawed — DEV Community](https://dev.to/chand1012/why-discord-bot-development-is-flawed-5d9f)
- [Architecting Discord Bot the Right Way — DEV Community](https://dev.to/itsnikhil/architecting-discord-bot-the-right-way-383e)
- [Discord OAuth2 Documentation](https://discord.com/developers/docs/topics/oauth2)
- [Discord Interactions — Receiving and Responding](https://discord.com/developers/docs/interactions/receiving-and-responding)

### Slack

- [Slack Platform Overview](https://docs.slack.dev/)
- [App Manifest Reference](https://docs.slack.dev/reference/app-manifest/)
- [Bolt for JavaScript](https://tools.slack.dev/bolt-js/)
- [Installing with OAuth](https://docs.slack.dev/authentication/installing-with-oauth/)
- [The Events API](https://docs.slack.dev/apis/events-api/)
- [Creating Custom Functions (Deno SDK)](https://docs.slack.dev/tools/deno-slack-sdk/guides/creating-custom-functions/)
- [Creating Workflows (Deno SDK)](https://docs.slack.dev/tools/deno-slack-sdk/guides/creating-workflows/)
- [The App Sandbox — Slack Engineering](https://slack.engineering/the-app-sandbox/)
- [Security Best Practices](https://docs.slack.dev/security/)
- [Rate Limit Changes for Non-Marketplace Apps (2025)](https://docs.slack.dev/changelog/2025/05/29/rate-limit-changes-for-non-marketplace-apps/)
- [The Slack App Directory Developer Review — DEV Community](https://dev.to/yvoschaap/the-slack-app-directory-developer-review-34go)
- [Make Work Flow Faster with Slack's New Platform](https://slack.com/blog/developers/make-work-flow-faster-with-slacks-new-platform)

### Obsidian

- [Obsidian Developer Documentation](https://docs.obsidian.md/)
- [Build a Plugin](https://docs.obsidian.md/Plugins/Getting+started/Build+a+plugin)
- [Plugin Class Reference](https://docs.obsidian.md/Reference/TypeScript+API/Plugin)
- [Settings](https://docs.obsidian.md/Plugins/User+interface/Settings)
- [Editor Extensions](https://docs.obsidian.md/Plugins/Editor/Editor+extensions)
- [Plugin Guidelines](https://docs.obsidian.md/Plugins/Releasing/Plugin+guidelines)
- [Obsidian Plugin Development — DeepWiki](https://deepwiki.com/obsidianmd/obsidian-api/3-plugin-development)
- [Obsidian Sample Plugin Repository](https://github.com/obsidianmd/obsidian-sample-plugin)
- [Obsidian API Type Definitions](https://github.com/obsidianmd/obsidian-api)
- [Inter-Plugin Communication — Obsidian Forum](https://forum.obsidian.md/t/inter-plugin-communication-expose-api-to-other-plugins/23618)
- [Plugin Submission Frustrations — Obsidian Forum](https://forum.obsidian.md/t/has-anyone-else-had-a-negative-experience-trying-to-release-a-plugin-for-obsidian/91762)
- [Security of the Plugins — Obsidian Forum](https://forum.obsidian.md/t/security-of-the-plugins/7544)
- [Obsidian's Reliance on Plugins — XDA Developers](https://www.xda-developers.com/obsidians-reliance-on-plugins/)
- [On the Security of Plugins — Standard Notes Blog](https://standardnotes.com/blog/on-the-security-of-plugins)

### VS Code

- [VS Code Extension API — Overview](https://code.visualstudio.com/api)
- [Extension Anatomy](https://code.visualstudio.com/api/get-started/extension-anatomy)
- [Extension Capabilities Overview](https://code.visualstudio.com/api/extension-capabilities/overview)
- [Activation Events Reference](https://code.visualstudio.com/api/references/activation-events)
- [Contribution Points Reference](https://code.visualstudio.com/api/references/contribution-points)
- [VS Code API Reference](https://code.visualstudio.com/api/references/vscode-api)
- [Extension Host](https://code.visualstudio.com/api/advanced-topics/extension-host)
- [Webview API Guide](https://code.visualstudio.com/api/extension-guides/webview)
- [Extension Manifest (package.json)](https://code.visualstudio.com/api/references/extension-manifest)
- [Publishing Extensions](https://code.visualstudio.com/api/working-with-extensions/publishing-extension)
- [Extension Runtime Security](https://code.visualstudio.com/docs/configure/extensions/extension-runtime-security)
- [Migrating VS Code to Process Sandboxing — VS Code Blog](https://code.visualstudio.com/blogs/2022/11/28/vscode-sandbox)
- [Our Approach to Extensibility — VS Code Docs](https://vscode-docs.readthedocs.io/en/stable/extensions/our-approach/)
- [Extension System — DeepWiki](https://deepwiki.com/microsoft/vscode/3-product-configuration-and-policy)
- [Extension Permissions / Security Sandboxing Proposal — GitHub Issue #52116](https://github.com/microsoft/vscode/issues/52116)
- [Developers Are Victims Too: Analysis of the VS Code Extension Ecosystem — arXiv](https://arxiv.org/html/2411.07479v1)
- [Security and Trust in Visual Studio Marketplace — Microsoft Developer Blog](https://developer.microsoft.com/blog/security-and-trust-in-visual-studio-marketplace)
