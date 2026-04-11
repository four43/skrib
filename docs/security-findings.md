# Security & Quality Audit Findings

**Date**: 2026-04-04
**Scope**: Out-of-process plugin system (`plugin_bus/`, `skrib_plugin_sdk/`, plugin integration points)
**Test status**: All tests passing (187 unit, E2E, frontend unit)
**Status**: All 12 security vulnerabilities FIXED (2026-04-04)

---

## Security Vulnerabilities

### CRITICAL

#### 1. Plugin secret never validated

- **Files**: `backend/skrib/plugin_bus/server.py`, `backend/skrib/plugin_bus/protocol.py`
- **Description**: The `secret` field is required in the HELLO handshake but never checked against any stored value. Any process on the network can connect to port 9000 and impersonate any plugin by sending an arbitrary secret.
- **Impact**: Complete bypass of plugin authentication. The entire process-isolation security model is undermined.
- **Fix**: Store plugin secrets (e.g. HMAC-SHA256 of plugin_id + manifest hash, or explicit config) and validate in `_handle_hello()` before calling `_approve_plugin()`.

### HIGH

#### 2. Pending plugins can access CoreAPI

- **Files**: `backend/skrib/plugin_bus/server.py` (line ~301), `backend/skrib/plugin_bus/bridge.py` (line ~151)
- **Description**: Plugins with `status == PENDING` are blocked from most frames, but `CORE_API_REQUEST` frames can still be routed to the bridge before admin approval. A pending plugin can enumerate rooms, users, and read data via `get_room_members`, `get_room_info`, `get_unread_count`.
- **Impact**: Unapproved plugins can read application data.
- **Fix**: Add explicit approval-status check in bridge before handling any core API request.

#### 3. TOCTOU race condition on approval status

- **Files**: `backend/skrib/plugin_bus/server.py` (lines ~226-250, ~301)
- **Description**: The approval status check in `_message_loop()` happens outside the connection lock. Between checking status and processing the frame, `activate_plugin()` can change the status from another coroutine, creating a time-of-check/time-of-use race.
- **Impact**: Frames could be processed under the wrong approval state.
- **Fix**: Hold the lock during frame processing, or use atomic status transitions.

#### 4. Cross-plugin event subscription — no access control

- **Files**: `backend/skrib/plugin_bus/bridge.py` (line ~142), `backend/skrib/plugin_bus/server.py` (line ~394)
- **Description**: Any plugin can declare a subscription to any event type from any other plugin. The `subscriptions` field in the manifest is never validated to restrict cross-plugin access. A malicious plugin subscribing to `"real.plugin.id:*"` receives all events from that plugin.
- **Impact**: Cross-plugin data leakage.
- **Fix**: Implement an event permission model — require explicit opt-in from the publishing plugin, or whitelist allowed subscriptions during admin approval.

#### 5. Settings schema bypass allows arbitrary keys

- **Files**: `backend/skrib/plugin_bus/settings.py` (lines ~138, ~151)
- **Description**: When settings are updated, validation checks `if key in valid_keys or not schema`. If no schema has been registered (plugin hasn't connected yet, or schema not sent), any key is accepted and stored.
- **Impact**: Arbitrary data injection into plugin settings; potential for stored XSS if settings are rendered.
- **Fix**: Reject all settings updates when no schema is registered.

### MEDIUM-HIGH

#### 6. No input validation on bus broadcast operations

- **Files**: `backend/skrib/plugin_bus/bridge.py` (lines ~91-140)
- **Description**: The bridge forwards plugin `action` and `event_type` strings directly to clients via the WebSocket manager with no sanitization. A plugin sending `action: "<img src=x onerror=alert(1)>"` could inject into client-rendered content.
- **Impact**: Potential XSS if frontend renders action/event_type strings.
- **Fix**: Validate that `action` and `event_type` match a safe pattern (alphanumeric, hyphens, underscores, dots). Sanitize before broadcasting.

#### 7. Room type registration hijacking

- **Files**: `backend/skrib/plugin_bus/server.py` (lines ~343-356)
- **Description**: A plugin can register any room type name, including ones used by core or other plugins. Once registered, it receives all lifecycle events for that room type.
- **Impact**: A malicious approved plugin could intercept room lifecycle events meant for another plugin.
- **Fix**: Validate room types against a whitelist, or require admin approval for new room type registrations.

### MEDIUM

#### 8. Plugin loader — no path containment check

- **Files**: `backend/skrib_plugin_sdk/loader.py` (lines ~16-72)
- **Description**: The loader uses `os.path.abspath()` to canonicalize paths (good), but doesn't verify the resolved path is within the expected plugins directory. If `plugin_dir` is user-controlled, code from anywhere on the filesystem could be loaded.
- **Impact**: Arbitrary code execution if loader input is attacker-controlled.
- **Fix**: Add `os.path.commonpath()` check to verify the resolved path is within the plugins directory.

#### 9. HTTP proxy URL spoofing

- **Files**: `backend/skrib/plugins/middleware.py` (lines ~92-160)
- **Description**: The `http_base_url` is set by the plugin in its HELLO frame and used as the proxy destination. A malicious approved plugin could set this to an internal service URL, causing the proxy to forward requests (with injected auth headers) to that service.
- **Impact**: SSRF — server-side request forgery against internal services.
- **Fix**: Validate that `http_base_url` points to localhost/127.0.0.1, or generate a shared token the plugin HTTP server must present.

#### 10. No rate limiting on HELLO/handshake

- **Files**: `backend/skrib/plugin_bus/server.py` (line ~109)
- **Description**: The WebSocket server accepts unlimited connection attempts with no rate limiting on the handshake. Each HELLO triggers DB operations (`_approve_plugin()`). An attacker can spam connections to exhaust server resources.
- **Impact**: Denial of service.
- **Fix**: Add per-IP rate limiting at the WebSocket accept level or on HELLO attempts.

#### 11. CoreAPI HTTP routes lack plugin authentication

- **Files**: `backend/skrib/plugins/core_api_routes.py` (lines ~38-80)
- **Description**: The core API HTTP endpoints (`/api/core/rooms/*`, `/api/core/users/*`) are exposed without validating that requests come from an approved plugin. The comment says they require `X-Skrib-Plugin-Id` / `X-Skrib-Plugin-Secret` headers, but the code doesn't check them.
- **Impact**: If endpoints are reachable, any authenticated user could call plugin-internal APIs.
- **Fix**: Add plugin authentication middleware, or remove the HTTP endpoints (use bus frames only).

#### 12. Insufficient manifest field validation

- **Files**: `backend/skrib/plugin_bus/server.py` (lines ~163-173)
- **Description**: Permissions are validated against `VALID_PERMISSIONS` (good), but room types, event names, subscriptions, and frontend script URLs are accepted as-is with no format validation. Room types with special characters or extremely long names could break the system.
- **Impact**: Injection or DoS via malformed manifest fields.
- **Fix**: Validate names match a safe pattern (e.g. `^[a-z0-9._-]{1,64}$`). Validate URLs if frontend scripts contain URLs.

---

## Code Complexity Issues

### MEDIUM

#### 13. Two `PluginBus` classes with the same name

- **Files**: `backend/skrib_plugin_sdk/bus.py` (out-of-process), `backend/skrib/plugins/base.py` (in-process)
- **Description**: Both export a class called `PluginBus` but serve different purposes. Reading code without seeing the import path is confusing.
- **Fix**: Rename `skrib_plugin_sdk.bus.PluginBus` to `OutOfProcessBus` or `BusClient`.

#### 14. `run()` and `run_forever()` duplicate ~80 lines

- **Files**: `backend/skrib_plugin_sdk/plugin.py` (lines ~234-313)
- **Description**: Both methods contain nearly identical initialization code. Changing initialization logic means editing two places.
- **Fix**: Extract shared logic into a `_initialize()` method; use a single `run()` with an optional `reconnect` parameter.

#### 15. Approval flow scattered across three files

- **Files**: `backend/skrib/plugin_bus/approvals.py`, `backend/skrib/plugin_bus/server.py`, `backend/skrib/main.py`
- **Description**: DB state is in approvals.py, server calls approval in `_handle_hello()`, and the callback is defined in main.py. New developers must trace three files to understand the flow.
- **Fix**: Create an `ApprovalManager` class that encapsulates state transitions and is injected into the server.

#### 16. Room action dispatch fallback is implicit

- **Files**: `backend/skrib/ws/handlers.py` (lines ~100-115)
- **Description**: The handler tries bus-connected plugins first, then falls back to in-process registry. This fallback is implicit — not obvious from reading either the bridge or registry.
- **Fix**: Create a `RoomActionRouter` that makes the "try bus, fall back to in-process" delegation explicit.

#### 17. Three code paths for plugin HTTP routing

- **Files**: `backend/skrib/main.py`, `backend/skrib/plugins/middleware.py`, `backend/skrib/plugins/routes.py`
- **Description**: In-process plugins use `registry.register_routes()`, bus plugins proxy via middleware, and static files use fallback routes. Three different paths for routing plugin HTTP requests.
- **Fix**: Consolidate into a single `PluginRouter` abstraction that handles the routing decision.

#### 18. Dynamic imports in settings.py to avoid circular deps

- **Files**: `backend/skrib/plugin_bus/settings.py` (lines ~39-46)
- **Description**: Function-body imports of `app.state.plugin_bus` to avoid circular imports. Makes code less readable and creates hidden runtime dependencies.
- **Fix**: Pass `plugin_bus` as a dependency during initialization instead.

### LOW-MEDIUM

#### 19. Settings schema lost on plugin disconnect

- **Files**: `backend/skrib/plugin_bus/settings.py`
- **Description**: Schema is held in memory on the connected plugin. If a plugin disconnects, the schema is gone — can't show settings in admin UI while plugin is offline.
- **Fix**: Persist schema to the database when the plugin connects.

#### 20. Disabled plugins remain in room_type_map

- **Files**: `backend/skrib/plugins/registry.py` (lines ~96-98)
- **Description**: `get_plugin_for_room_type()` doesn't check `is_plugin_enabled()`. A disabled plugin's room types remain registered.
- **Fix**: Prune maps when disabling, or add enabled check to getters.

#### 21. Two plugin base classes with no shared interface

- **Files**: `backend/skrib/plugins/base.py` (`Plugin`), `backend/skrib_plugin_sdk/plugin.py` (`SkribPlugin`)
- **Description**: In-process and out-of-process plugin classes have no common ABC. Different naming, different capabilities.
- **Fix**: Consider a shared `IPlugin` interface, or at minimum consistent naming.

---

## Documentation Issues

### HIGH

#### 22. Manifest example uses wrong field names

- **File**: `docs/plugin-system.md` (lines ~51-69)
- **Description**: Example uses `frontend_entry` (should be `entry`), includes fictitious `type` and `room_type` fields, and is missing required fields (`author`, `hooks`, `styles`). The example manifest would fail validation against actual `PluginInfo`.
- **Fix**: Update to match real manifest structure from any existing plugin.

### MEDIUM

#### 23. Frontend context object documentation incomplete

- **File**: `docs/plugin-system.md` (lines ~207-228)
- **Description**: Missing properties actually provided to plugins: `sendMessage()`, `currentUsername()`, `displaySystemMessage()`, `privateKey()`, `userNicknames()`, `currentRole()`, `loadRoomKeys()`, `slashCommands()`.
- **Fix**: Document all properties from `frontend/src/app.js` lines ~246-274.

#### 24. Frontend README references old `chat.js`

- **File**: `frontend/README.md`
- **Description**: References `src/chat.js` as the main file, but it's now `src/app.js`.
- **Fix**: Update filename reference.

#### 25. Plugin directory structure shows wrong paths

- **File**: `docs/plugin-system.md` (lines ~34-45)
- **Description**: Shows `frontend/plugin.js` as entry point; actual structure is `frontend/src/plugin.js` (source) built to `frontend/dist/plugin.js` (entry).
- **Fix**: Update directory tree to show src/dist split.

#### 26. Permissions table incomplete

- **File**: `docs/plugin-system.md` (lines ~59-69, ~429-444)
- **Description**: Missing `dom.message-area` permission used by `four43.chat-typing`. Lists permissions (`frontend.register`, `callbacks.register`, `room_type.register`) not found in any real manifest.
- **Fix**: Reconcile documented permissions with actual usage across all plugin manifests.

#### 27. In-process plugin system overemphasized

- **File**: `docs/plugin-system.md`
- **Description**: Documentation still presents `backend/plugin.py` prominently. Should clarify that `plugin_bus.py` is the standard path and in-process is a legacy fallback.
- **Fix**: Restructure to lead with out-of-process as primary, in-process as fallback.
