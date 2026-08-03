# Plugin Multi-Process Architecture — Code Review

Review of the migration to out-of-process plugins on branch `feat-plugins-new-process`.
Commits in scope: `ed3534f` → `47cbd8d` (and uncommitted work).

## Status: working well

- **Architecture is clean.** `plugin_bus/{server,bridge,protocol,approvals,settings,rate_limit}.py` cleanly separate concerns. The bridge is a thin translator between bus frames and `UnifiedConnectionManager` + `CoreAPI`.
- **Tests pass.** 191 plugin-bus unit tests green; covers handshake, permission enforcement, room-type conflicts, approval lifecycle, rate limiting, manifest-hash re-approval, settings, middleware proxy gating, message-size enforcement, subscribe-without-receive guard, room-type metadata, and approval deletion.
- **Security defaults are right**: identifier regex (`SAFE_IDENTIFIER_RE`), permission whitelist (`VALID_PERMISSIONS`), manifest-hash re-approval (`_manifest_hash` only over security fields), localhost-only proxy + file fetch (`_is_localhost_url`), `hmac.compare_digest` on secrets, path-traversal check in `routes.py:191-197`, `0o600` perms on secret files, anti-spoofing strip of client `x-skrib-*` headers in `middleware.py:188`, websocket `max_size` limit.
- **In-process registry is fully gone.** `plugins/registry.py`, `plugins/callbacks.py`, and every `plugin.py` were deleted. No more dual code paths in `ws/handlers.py` — the bridge is now the only dispatch path.
- **SDK ergonomics are good.** Decorator-driven (`@on_room_action`, `@on_lifecycle`, `@callback`), context-merging `ActionContext`, automatic reconnect with backoff, automatic schema init.

## Cleanups already applied

- [x] **Forgeable-auth `/api/core/*` endpoints** removed entirely (see #1 below).
- [x] **Cleaner room-action error path** in `ws/handlers.py` with logger.error and a clearer client message.
- [x] **Pinned secret resolution** to env var → `{SKRIB_DATA_DIR}/plugin-secrets/{id}.secret` (default `backend/data`).
- [x] **#4 — Double-namespacing in `bus.emit_event` fixed.** SDK no longer prefixes; bridge is the single source of namespacing. Bridge also enforces that plugins can only emit into their own namespace or the privileged `core:` namespace.
- [x] **#5 — `_pending_callbacks` moved to instance** on `PluginBusBridge`.
- [x] **#6 — `max_message_size` enforced** at the websockets layer (`max_size=MAX_MESSAGE_SIZE` on `ws_serve`); oversized frames close with code 1009. Constant lives in one place and is advertised in `hello_ack`.
- [x] **#7 — `bus.receive` permission checked** in `broadcast_to_subscribers` before delivery. Subscriptions without the permission are silently dropped.
- [x] **#8 — `register.room_type` carries `display_name`/`icon`/`description`.** SDK pulls from optional `room_type_meta` class attribute, falling back to manifest `name`/`description` for single-room plugins. Bus stores `conn.room_type_meta`; routes expose it.
- [x] **#9 — Plugin file proxy now uses `_is_localhost_url`** before fetching from `conn.http_base_url`.
- [x] **#10 — Proxy body cap**: `MAX_PROXY_BODY = 16 MiB`. Requests over the cap return 413.
- [x] **#11 — Stale-pending cleanup**: `DELETE /api/admin/plugins/{plugin_id}` and `approvals.delete_approval()` for admins to drop pending records.
- [x] **#12 — Shared `httpx.AsyncClient` closed on shutdown** via `close_http_client()` in `shutdown_event`.
- [x] **`register.frontend` wired into plugin listing.** `routes.py:_get_bus_plugins` now prefers dynamically registered scripts/styles over the on-disk manifest.

## Blocking — still open

1. **Bus-server crash recovery.** With in-process fallback gone, any bridge failure makes every room action error out. Deferred. Track-list: `start-plugins` lacks restart-on-crash (only `run-plugins.py` keeps tasks alive), the bridge has no health probe, admins have no UI signal that the bus dropped.

## Should fix — still open

- **Per-plugin permissions split.** `bus.send` covers room broadcast, user notify, and notify-all. A compromised or malicious plugin can spam every connected user. Split into `bus.send.room` / `bus.send.user` / `bus.send.all` and require the strongest one for `notify_all`.
- **`run-plugins.py` swallows per-plugin exceptions** (`run-plugins.py:55-57`) and prints. Once a plugin fails, it stays dead until the parent is restarted. Tied to the watchdog story above.
- **Cross-plugin events from `core:` namespace are partially exercised.** The chat plugin emits `core:message_deleted` (now correctly delivered to subscribers via `broadcast_to_subscribers`), but core itself does not currently emit `core:room_deleted` etc. through that path — only as `lifecycle.room_deleted` to the room-type owner. Audit which of attachments' `subscriptions = ["core:room_deleted", "core:message_deleted"]` is actually firing, and either route the lifecycle events through `broadcast_to_subscribers` too or drop the subscription.

## Security review (summary)

| Concern | Status |
|---|---|
| Header spoofing on `/api/plugins/*` | Mitigated (middleware strips, re-injects) |
| Header spoofing on `/api/core/*` | Resolved (endpoints deleted) |
| Path traversal in plugin file serving | Mitigated (`relative_to`) |
| SSRF via `http_base_url` | Mitigated for proxy and `/file/` (both call `_is_localhost_url`) |
| Bus secret theft | Mitigated (file mode 0600 + `hmac.compare_digest`); env var fallback is a developer footgun |
| Privilege escalation via permissions | Permissions enforced per-frame; `bus.receive` now checked on subscriptions |
| Rate limiting | Per-IP connection bucket + per-plugin token bucket; no per-room or per-user granularity |
| `notify_all` abuse | Same `bus.send` permission as room broadcast — split needed (open) |
| Plugin DoS via large payloads | Bus message size capped (65 KiB); HTTP proxy body capped (16 MiB) |
| Manifest tampering | SHA-256 over security-only fields; cosmetic edits don't trigger re-approval |
| Plugin namespace spoofing | Mitigated — bridge rejects `bus.emit_event` for namespaces other than the plugin's own or `core:` |

## Still TODO

- Watchdog/restart for crashed plugins in `start-plugins`.
- Per-plugin permissions: split `bus.send`.
- Audit `core:*` lifecycle event delivery (see above).
- Observability: counter for rate-limited frames per plugin, surface in admin UI.
- Document seed-script-must-run-before-plugin-start ordering, or have `start-plugins` wait for approved status.

## Bottom line

The migration is well-structured and cleaning out the in-process path simplified things substantially. After this review pass, the security posture is solid: no forgeable headers, all SSRF paths gated, bus and HTTP payload sizes capped, namespace-spoofing prevented, permissions enforced on both send and receive sides. Remaining items are operational (watchdog, observability) or scoped feature work (permission splits, lifecycle event audit) rather than open holes.
