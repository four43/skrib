# Dual-Runtime Plugins Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let each plugin declare `runtime: "in_process" | "process"` in its manifest and run either way with no change to the plugin's own code, then move the four hot-path plugins in-process to clear the ~20 red e2e tests.

**Architecture:** `SkribPlugin` touches its transport only through the `BusClient` interface (`send`, `on_frame`, `request`, `connect`, `run`, `close`), and both `PluginBus` and the SDK's `CoreAPI` wrap that same client. So a second client backend — `InProcessClient` — gives the entire SDK an in-process mode with no duplicated bus, no duplicated CoreAPI, and no changes to any plugin. On the core side, `PluginBusBridge._handle_plugin_frame` is a pure translation layer (permission enforcement lives in `PluginBusServer`, not the bridge), so in-process plugins reuse it wholesale. Every core→plugin path already funnels through `server.send_to_plugin`, so one indirection in the bridge routes to in-process plugins, and `ws/handlers.py` needs no changes at all.

**Tech Stack:** Python 3.13+, FastAPI, `websockets`, SQLite, pytest, Playwright.

## Global Constraints

- **No migration functions.** Modify schema and delete `data/*` to reset (`CLAUDE.md`).
- **Red/green tests first.** Write the failing test, watch it fail, then implement.
- **E2E tests run via `cd frontend && ./util/test-e2e`**, never `npx playwright test` directly — the wrapper sets `SKRIB_TEST_DATA_DIR` and builds the frontend.
- **Plugin bus unit tests:** `cd backend && python -m pytest tests/unit/plugin_bus/ -v`. All 191 must stay green.
- **In-process plugins are trusted by definition.** Permissions are unenforceable in a shared interpreter, so do not add permission checks to the in-process path — that would be theater. See `docs/spec/2026-08-02-extension-model.md` §3.1.
- **Do not touch `skrib/plugin_bus/server.py`.** The bus server stays exactly as it is; in-process plugins are registered alongside it, not inside it.
- **Out of scope:** the core item log and signal channel (`docs/spec/2026-08-02-core-log-and-signal.md`), the `kind` manifest field, folding themes in, and splitting link previews out. Those are separate phases.

---

## File Structure

**Create:**
- `backend/skrib_plugin_sdk/inprocess.py` — `InProcessClient`, a `BusClient`-shaped transport that calls the bridge directly.
- `backend/skrib/plugin_bus/inprocess_host.py` — `InProcessHost`: discovers, imports, instantiates and registers `runtime: in_process` plugins.
- `backend/tests/unit/plugin_bus/test_inprocess_client.py` — unit tests for the client.
- `backend/tests/unit/plugin_bus/test_inprocess_host.py` — unit tests for the host.
- `backend/tests/unit/plugin_bus/test_notify_levels_batch.py` — unit tests for the batched core API method.

**Modify:**
- `backend/skrib/rooms/services.py` — add `get_notify_levels(room_id)`.
- `backend/skrib/plugins/core_api.py` — add `get_notify_levels`.
- `backend/skrib_plugin_sdk/core_api.py` — add `get_notify_levels`.
- `backend/skrib/plugin_bus/bridge.py` — add `get_notify_levels` dispatch; add `_send_to_plugin` indirection and in-process registration; make `get_bus_plugin_for_room_type` consult in-process plugins.
- `backend/plugins/four43.room-type-chat/backend/plugin_bus.py:131-142` — use the batched call.
- `backend/skrib/main.py` — start the `InProcessHost` during `startup_event`.
- The four flipped plugins' `manifest.json` files.
- `backend/plugins/four43.web-push/manifest.json`, `backend/plugins/four43.attachments/manifest.json` — declare `runtime: "process"` explicitly.
- `backend/util/start-plugins` — skip `runtime: in_process` plugins.
- `frontend/tests/e2e/fixtures.js` — `discoverBundledPlugins` skips `runtime: in_process`.

**Not modified:** `backend/skrib/ws/handlers.py`, `backend/skrib/plugin_bus/server.py`, and every plugin's Python source except the chat plugin's notify loop.

---

### Task 1: Batch the per-member notify lookup

This is the diagnostic. `get_notify_level` is currently called once per member inside a single message handler, so an N-member room does N sequential request/response round-trips at ~10–50 ms each. That is a design fault at any transport, and it is the leading hypothesis for the msg-2 bug. Land it alone, then re-run the failing tests: if they go green, the bug was API granularity and not the process boundary.

**Files:**
- Modify: `backend/skrib/rooms/services.py` (after `get_notify_level`, line ~306)
- Modify: `backend/skrib/plugins/core_api.py` (after `get_notify_level`, line ~32)
- Modify: `backend/skrib_plugin_sdk/core_api.py` (after `get_notify_level`, line ~42)
- Modify: `backend/skrib/plugin_bus/bridge.py:205-221` (`_call_core_api`)
- Modify: `backend/plugins/four43.room-type-chat/backend/plugin_bus.py:131-142`
- Test: `backend/tests/unit/plugin_bus/test_notify_levels_batch.py`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `get_notify_levels(room_id: str) -> dict[str, str]` on all three CoreAPI surfaces — core service (sync), `skrib/plugins/core_api.py` (sync), SDK `skrib_plugin_sdk/core_api.py` (async). Maps username → notify level. Members with no row default to `"all"`.

- [ ] **Step 1: Write the failing test**

Create `backend/tests/unit/plugin_bus/test_notify_levels_batch.py`:

```python
"""The batched notify-level lookup must return one dict for the whole room."""
import pytest

from skrib.rooms.services import get_notify_levels, set_notify_level


def test_get_notify_levels_returns_all_members(seeded_room):
    """One call returns a level for every member, defaulting to 'all'."""
    room_id, members = seeded_room  # members: ["alice", "bob", "carol"]
    set_notify_level(room_id, "bob", "mentions")

    levels = get_notify_levels(room_id)

    assert levels == {"alice": "all", "bob": "mentions", "carol": "all"}


def test_get_notify_levels_unknown_room_is_empty():
    """An unknown room yields an empty mapping rather than raising."""
    assert get_notify_levels("no-such-room") == {}
```

Reuse whatever room-seeding fixture `tests/unit/plugin_bus/conftest.py` already provides; if there is no `seeded_room` fixture, add one there that creates a room and three members via `skrib.rooms.services`.

- [ ] **Step 2: Run the test and confirm it fails**

Run: `cd backend && python -m pytest tests/unit/plugin_bus/test_notify_levels_batch.py -v`
Expected: FAIL with `ImportError: cannot import name 'get_notify_levels'`.

- [ ] **Step 3: Add the core service function**

In `backend/skrib/rooms/services.py`, directly after `get_notify_level`:

```python
def get_notify_levels(room_id: str) -> dict[str, str]:
    """Get notification levels for every member of a room, keyed by username.

    One query instead of one per member. Missing values default to 'all',
    matching get_notify_level().
    """
    with get_db() as conn:
        cursor = conn.execute(
            'SELECT username, notify_level FROM room_users WHERE room_id = ?',
            (room_id,),
        )
        return {
            row['username']: (row['notify_level'] or 'all')
            for row in cursor.fetchall()
        }
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `cd backend && python -m pytest tests/unit/plugin_bus/test_notify_levels_batch.py -v`
Expected: PASS (2 passed).

- [ ] **Step 5: Expose it on the in-process CoreAPI**

In `backend/skrib/plugins/core_api.py`, after `get_notify_level`:

```python
    def get_notify_levels(self, room_id: str) -> dict:
        """Get notification levels for all members of a room, keyed by username."""
        from ..rooms.services import get_notify_levels
        return get_notify_levels(room_id)
```

- [ ] **Step 6: Expose it on the SDK CoreAPI**

In `backend/skrib_plugin_sdk/core_api.py`, after `get_notify_level`:

```python
    async def get_notify_levels(self, room_id: str) -> dict:
        return await self._call("get_notify_levels", room_id=room_id)
```

- [ ] **Step 7: Add the bridge dispatch branch**

In `backend/skrib/plugin_bus/bridge.py`, inside `_call_core_api`, after the `get_notify_level` branch:

```python
        elif method == "get_notify_levels":
            return self._core_api.get_notify_levels(params["room_id"])
```

- [ ] **Step 8: Use it in the chat plugin**

Replace `backend/plugins/four43.room-type-chat/backend/plugin_bus.py:131-142`. The old body called `get_notify_level` per member; the new one makes a single call:

```python
        # Notify other members for sidebar badges (best-effort).
        # One batched core_api call, not one per member — N sequential
        # round-trips inside a message handler is what made a second
        # message queue behind the first.
        try:
            levels = await self.core_api.get_notify_levels(room_id) or {}
            for member, level in levels.items():
                if member == ctx.username:
                    continue
                notify_action = "new_message" if level == "all" else "update"
                await ctx.bus.notify_user(
                    member, notify_action,
                    room_id=room_id, sender=ctx.username,
                )
        except Exception:
```

Keep the existing `except Exception:` body exactly as it is. Note this also drops the now-redundant `get_room_members` call, since `get_notify_levels` already returns one entry per member.

- [ ] **Step 9: Run the plugin bus suite**

Run: `cd backend && python -m pytest tests/unit/plugin_bus/ -v`
Expected: PASS, 193 passed (191 existing + 2 new).

- [ ] **Step 10: Run the simplest msg-2 reproducer — this is the diagnostic**

Run: `cd frontend && ./util/test-e2e --grep "Headings render"`
Expected: PASS. This test sends three sequential messages with no menu interaction.

**If it passes:** the msg-2 bug was API granularity. Record that in `TODO.md` under P0-unblock, then run the two batches below and continue with this plan — the in-process work still stands on the admin-experience and misplaced-isolation arguments, but it is no longer an emergency.

**If it still fails:** the boundary is implicated. Record that too, and continue with this plan — Task 6 becomes the fix rather than a cleanup.

Either way, write the answer down before moving on. That answer is the point of doing this task first.

- [ ] **Step 11: Run the two affected e2e batches**

Run: `cd frontend && ./util/test-e2e tests/e2e/chat-messages.spec.js tests/e2e/core.spec.js tests/e2e/markdown-and-input.spec.js tests/e2e/websocket-reconnect.spec.js`
Expected: record the pass/fail count. Baseline before this change was 5 failures in `chat-messages`, 3 in `core`, 2 in `markdown-and-input`, 1 in `websocket-reconnect`.

- [ ] **Step 12: Commit**

```bash
cd /workspace
git add backend/skrib/rooms/services.py backend/skrib/plugins/core_api.py \
        backend/skrib_plugin_sdk/core_api.py backend/skrib/plugin_bus/bridge.py \
        backend/plugins/four43.room-type-chat/backend/plugin_bus.py \
        backend/tests/unit/plugin_bus/test_notify_levels_batch.py
git commit -m "perf: Batch notify-level lookup into one core_api call

get_notify_level was called once per room member inside the chat
plugin's message handler, so an N-member room did N sequential bus
round-trips at ~10-50ms each before the handler returned. Replaced
with get_notify_levels(room_id) -> dict, one query and one frame.

Also drops the now-redundant get_room_members call, since the batched
result already has one entry per member.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: `InProcessClient` — a `BusClient`-shaped transport

**Files:**
- Create: `backend/skrib_plugin_sdk/inprocess.py`
- Test: `backend/tests/unit/plugin_bus/test_inprocess_client.py`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `InProcessClient(plugin_id: str, frame_sink: Callable[[str, dict], Awaitable[None]])`
  - `.connected -> bool`
  - `.on_frame(frame_type: str, handler: Callable[[dict], Awaitable[None]]) -> None`
  - `.connect() -> dict` — returns `{"type": "hello_ack", "status": "approved"}`
  - `.run() -> None` — no-op; there is no receive loop
  - `.send(frame: dict) -> None` — awaits `frame_sink(plugin_id, frame)`
  - `.request(frame: dict, timeout: float = 10.0) -> dict`
  - `.deliver(frame: dict) -> None` — core→plugin entry point; resolves pending requests or dispatches to a registered handler
  - `.close() -> None`

  `frame_sink` will be `bridge._handle_plugin_frame` in production.

- [ ] **Step 1: Write the failing test**

Create `backend/tests/unit/plugin_bus/test_inprocess_client.py`:

```python
"""InProcessClient must satisfy the same contract as BusClient."""
import asyncio

import pytest

from skrib_plugin_sdk.inprocess import InProcessClient


@pytest.mark.asyncio
async def test_send_reaches_the_frame_sink():
    """Outbound frames are handed to the sink with the plugin id."""
    seen = []

    async def sink(plugin_id, frame):
        seen.append((plugin_id, frame))

    client = InProcessClient("test.plugin", sink)
    await client.connect()
    await client.send({"type": "bus.notify_user", "username": "alice"})

    assert seen == [("test.plugin", {"type": "bus.notify_user", "username": "alice"})]


@pytest.mark.asyncio
async def test_deliver_dispatches_to_registered_handler():
    """Inbound frames go to the handler registered for their type."""
    async def sink(plugin_id, frame):
        pass

    received = []
    client = InProcessClient("test.plugin", sink)
    client.on_frame("room.action", lambda f: _collect(received, f))
    await client.connect()

    await client.deliver({"type": "room.action", "action": "message"})

    assert received == [{"type": "room.action", "action": "message"}]


async def _collect(bucket, frame):
    bucket.append(frame)


@pytest.mark.asyncio
async def test_request_resolves_when_response_is_delivered():
    """request() blocks until a frame with the matching request_id arrives."""
    async def sink(plugin_id, frame):
        # Simulate core answering asynchronously.
        asyncio.get_running_loop().call_soon(
            asyncio.create_task,
            client.deliver({
                "type": "core_api.response",
                "request_id": frame["request_id"],
                "result": {"alice": "all"},
            }),
        )

    client = InProcessClient("test.plugin", sink)
    await client.connect()

    response = await client.request(
        {"type": "core_api.request", "request_id": "abc123", "method": "get_notify_levels"}
    )

    assert response["result"] == {"alice": "all"}


@pytest.mark.asyncio
async def test_request_without_request_id_raises():
    """Matches BusClient: a request frame must carry a request_id."""
    async def sink(plugin_id, frame):
        pass

    client = InProcessClient("test.plugin", sink)
    await client.connect()

    with pytest.raises(ValueError, match="request_id"):
        await client.request({"type": "core_api.request"})


@pytest.mark.asyncio
async def test_request_times_out_when_no_response_arrives():
    """A dropped response surfaces as TimeoutError, not a hang."""
    async def sink(plugin_id, frame):
        pass

    client = InProcessClient("test.plugin", sink)
    await client.connect()

    with pytest.raises(TimeoutError):
        await client.request(
            {"type": "core_api.request", "request_id": "never"}, timeout=0.05
        )


@pytest.mark.asyncio
async def test_send_before_connect_raises():
    """Matches BusClient's guard against sending on a dead transport."""
    async def sink(plugin_id, frame):
        pass

    client = InProcessClient("test.plugin", sink)

    with pytest.raises(RuntimeError, match="Not connected"):
        await client.send({"type": "bus.notify_all"})
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `cd backend && python -m pytest tests/unit/plugin_bus/test_inprocess_client.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'skrib_plugin_sdk.inprocess'`.

- [ ] **Step 3: Write the implementation**

Create `backend/skrib_plugin_sdk/inprocess.py`:

```python
"""In-process transport for the Skrib plugin SDK.

Implements the same interface as ``BusClient`` but delivers frames by direct
call instead of over a WebSocket. Because ``PluginBus``, ``CoreAPI`` and
``SkribPlugin`` all talk to their transport only through this interface, a
plugin runs unchanged in either runtime.

Trust model: an in-process plugin shares the interpreter with core, so
permissions are unenforceable and none are checked here. Only code you trust
is eligible for ``runtime: "in_process"`` — see
docs/spec/2026-08-02-extension-model.md §3.1.
"""
from __future__ import annotations

import asyncio
import logging
from typing import Any, Awaitable, Callable

logger = logging.getLogger(__name__)

FrameSink = Callable[[str, dict], Awaitable[None]]


class InProcessClient:
    """Transport that hands plugin frames straight to the bridge."""

    def __init__(self, plugin_id: str, frame_sink: FrameSink):
        self._plugin_id = plugin_id
        self._frame_sink = frame_sink
        self._connected = False
        self._frame_handlers: dict[str, Callable[[dict], Awaitable[None]]] = {}
        self._pending: dict[str, asyncio.Future] = {}

    @property
    def connected(self) -> bool:
        return self._connected

    def on_frame(self, frame_type: str, handler: Callable[[dict], Awaitable[None]]) -> None:
        """Register a handler for a specific frame type."""
        self._frame_handlers[frame_type] = handler

    async def connect(self) -> dict:
        """No handshake is needed in-process; report an approved ack."""
        self._connected = True
        return {"type": "hello_ack", "status": "approved", "runtime": "in_process"}

    async def run(self) -> None:
        """No receive loop in-process. Frames arrive via deliver()."""
        return None

    async def run_with_reconnect(self) -> None:
        """No connection to lose in-process."""
        return None

    async def send(self, frame: dict) -> None:
        """Hand an outbound frame to core."""
        if not self._connected:
            raise RuntimeError("Not connected to bus server")
        await self._frame_sink(self._plugin_id, frame)

    async def request(self, frame: dict, timeout: float = 10.0) -> dict:
        """Send a frame and wait for a correlated response."""
        request_id = frame.get("request_id")
        if not request_id:
            raise ValueError("Frame must include 'request_id' for request/response")

        future: asyncio.Future[dict] = asyncio.get_running_loop().create_future()
        self._pending[request_id] = future

        try:
            await self.send(frame)
            return await asyncio.wait_for(future, timeout=timeout)
        except asyncio.TimeoutError:
            self._pending.pop(request_id, None)
            raise TimeoutError(
                f"No response for request_id={request_id} within {timeout}s"
            )

    async def deliver(self, frame: dict) -> None:
        """Deliver a core→plugin frame. Mirrors BusClient's receive-loop logic."""
        request_id = frame.get("request_id")
        if request_id and request_id in self._pending:
            future = self._pending.pop(request_id)
            if not future.done():
                future.set_result(frame)
            return

        handler = self._frame_handlers.get(frame.get("type", ""))
        if handler is None:
            logger.debug(
                "[SDK:inprocess] No handler for frame type '%s'", frame.get("type")
            )
            return
        try:
            await handler(frame)
        except Exception:
            logger.exception(
                "[SDK:inprocess] Error in handler for '%s'", frame.get("type")
            )

    async def close(self) -> None:
        """Drop pending requests and mark disconnected."""
        self._connected = False
        for future in self._pending.values():
            if not future.done():
                future.cancel()
        self._pending.clear()
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `cd backend && python -m pytest tests/unit/plugin_bus/test_inprocess_client.py -v`
Expected: PASS (6 passed).

- [ ] **Step 5: Commit**

```bash
cd /workspace
git add backend/skrib_plugin_sdk/inprocess.py \
        backend/tests/unit/plugin_bus/test_inprocess_client.py
git commit -m "feat: Add InProcessClient transport to the plugin SDK

SkribPlugin reaches its transport only through the BusClient interface,
and both PluginBus and the SDK CoreAPI wrap that same client. So one
alternate backend gives the whole SDK an in-process mode with no
duplicated bus and no changes to any plugin.

No permission checks on this path: an in-process plugin shares the
interpreter with core, so enforcement would be theater. Only trusted
first-party code is eligible for runtime: in_process.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Route core→plugin frames to in-process plugins

Every core→plugin path in the bridge funnels through `self._server.send_to_plugin`: `dispatch_room_action` (line 283), `_handle_core_api_request` (line 204), the `FrameValidationError` path (line 97), and `send_callback`. One indirection covers all of them.

**Files:**
- Modify: `backend/skrib/plugin_bus/bridge.py`
- Test: `backend/tests/unit/plugin_bus/test_inprocess_host.py` (first two tests only)

**Interfaces:**
- Consumes: `InProcessClient.deliver` from Task 2.
- Produces on `PluginBusBridge`:
  - `register_inprocess(plugin_id: str, deliver: Callable[[dict], Awaitable[None]], room_types: list[str]) -> None`
  - `unregister_inprocess(plugin_id: str) -> None`
  - `_send_to_plugin(plugin_id: str, frame: dict) -> bool` — in-process first, else `server.send_to_plugin`
  - `get_bus_plugin_for_room_type(room_type)` now also resolves in-process room types.

- [ ] **Step 1: Write the failing test**

Create `backend/tests/unit/plugin_bus/test_inprocess_host.py` with the routing tests:

```python
"""In-process plugins must be reachable through the same bridge paths."""
import pytest


@pytest.mark.asyncio
async def test_send_to_plugin_prefers_inprocess(bridge):
    """A registered in-process plugin receives frames without the bus server."""
    delivered = []

    async def deliver(frame):
        delivered.append(frame)

    bridge.register_inprocess("four43.room-type-chat", deliver, ["chat"])

    sent = await bridge._send_to_plugin(
        "four43.room-type-chat", {"type": "room.action", "action": "message"}
    )

    assert sent is True
    assert delivered == [{"type": "room.action", "action": "message"}]


def test_room_type_lookup_resolves_inprocess_plugins(bridge):
    """get_bus_plugin_for_room_type must find in-process room types too,
    so ws/handlers.py needs no runtime-specific branching."""
    async def deliver(frame):
        pass

    bridge.register_inprocess("four43.room-type-chat", deliver, ["chat"])

    assert bridge.get_bus_plugin_for_room_type("chat") == "four43.room-type-chat"


def test_unregister_removes_room_types(bridge):
    """Unregistering drops the plugin's room types from the lookup."""
    async def deliver(frame):
        pass

    bridge.register_inprocess("four43.room-type-chat", deliver, ["chat"])
    bridge.unregister_inprocess("four43.room-type-chat")

    assert bridge.get_bus_plugin_for_room_type("chat") is None
```

Add a `bridge` fixture to `backend/tests/unit/plugin_bus/conftest.py` if one does not already exist. `tests/unit/plugin_bus/` already constructs bridges for existing tests — reuse that construction rather than writing a new one.

- [ ] **Step 2: Run the test and confirm it fails**

Run: `cd backend && python -m pytest tests/unit/plugin_bus/test_inprocess_host.py -v`
Expected: FAIL with `AttributeError: 'PluginBusBridge' object has no attribute 'register_inprocess'`.

- [ ] **Step 3: Add the in-process registry to the bridge**

In `backend/skrib/plugin_bus/bridge.py`, add to `__init__` after `self._pending_callbacks`:

```python
        # In-process plugins: plugin_id -> deliver coroutine, and the room
        # types they own. These bypass the bus server entirely — they are
        # trusted code sharing this interpreter.
        self._inprocess: dict[str, Any] = {}
        self._inprocess_room_types: dict[str, str] = {}
```

Then add these methods next to `get_bus_plugin_for_room_type`:

```python
    def register_inprocess(self, plugin_id: str, deliver, room_types: list[str]) -> None:
        """Register an in-process plugin's inbound frame sink and room types."""
        self._inprocess[plugin_id] = deliver
        for rt in room_types:
            self._inprocess_room_types[rt] = plugin_id

    def unregister_inprocess(self, plugin_id: str) -> None:
        """Remove an in-process plugin and any room types it owned."""
        self._inprocess.pop(plugin_id, None)
        for rt in [
            rt for rt, pid in self._inprocess_room_types.items() if pid == plugin_id
        ]:
            del self._inprocess_room_types[rt]

    async def _send_to_plugin(self, plugin_id: str, frame: dict) -> bool:
        """Send a frame to a plugin, in-process or over the bus."""
        deliver = self._inprocess.get(plugin_id)
        if deliver is not None:
            await deliver(frame)
            return True
        return await self._server.send_to_plugin(plugin_id, frame)
```

- [ ] **Step 4: Make room-type lookup runtime-agnostic**

Replace `get_bus_plugin_for_room_type` (line ~378) so `ws/handlers.py` needs no changes:

```python
    def get_bus_plugin_for_room_type(self, room_type: str) -> str | None:
        """Return the plugin_id handling this room type, either runtime.

        In-process plugins are checked first. ws/handlers.py calls this and
        then dispatch_room_action, both of which are runtime-agnostic, so it
        needs no knowledge of where a plugin runs.
        """
        inproc = self._inprocess_room_types.get(room_type)
        if inproc is not None:
            return inproc
        return self._server.room_type_map.get(room_type)
```

- [ ] **Step 5: Route the four existing send sites through the indirection**

In `backend/skrib/plugin_bus/bridge.py`, replace `await self._server.send_to_plugin(` with `await self._send_to_plugin(` at every call site **except** the definition of `_send_to_plugin` itself. There are four:

- line ~97, the `FrameValidationError` handler in `_handle_plugin_frame`
- line ~204, the end of `_handle_core_api_request`
- line ~283, the `return` in `dispatch_room_action`
- inside `send_callback`

Verify with: `grep -n "_server.send_to_plugin" skrib/plugin_bus/bridge.py` — afterwards the only hit should be the one inside `_send_to_plugin`.

- [ ] **Step 6: Run the tests and confirm they pass**

Run: `cd backend && python -m pytest tests/unit/plugin_bus/ -v`
Expected: PASS, 196 passed. The 191 pre-existing tests must all still pass — they exercise the bus-server path, which `_send_to_plugin` falls through to unchanged.

- [ ] **Step 7: Commit**

```bash
cd /workspace
git add backend/skrib/plugin_bus/bridge.py \
        backend/tests/unit/plugin_bus/test_inprocess_host.py \
        backend/tests/unit/plugin_bus/conftest.py
git commit -m "feat: Route core->plugin frames to in-process plugins

Every core->plugin path in the bridge funnelled through
server.send_to_plugin, so a single _send_to_plugin indirection covers
room actions, core_api responses, callbacks and validation errors.

get_bus_plugin_for_room_type now resolves in-process room types too,
which is why ws/handlers.py needs no runtime-specific branching.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: `InProcessHost` — load and register in-process plugins

**Files:**
- Create: `backend/skrib/plugin_bus/inprocess_host.py`
- Test: `backend/tests/unit/plugin_bus/test_inprocess_host.py` (append)

**Interfaces:**
- Consumes: `InProcessClient` (Task 2); `bridge.register_inprocess` / `unregister_inprocess` (Task 3).
- Produces:
  - `InProcessHost(bridge: PluginBusBridge, plugins_dir: Path)`
  - `async start() -> list[str]` — returns the ids of plugins started
  - `async stop() -> None`
  - `discover_inprocess_plugins(plugins_dir: Path) -> list[tuple[str, Path]]` — module-level; returns `(plugin_id, plugin_dir)` for every manifest with `runtime == "in_process"`

- [ ] **Step 1: Write the failing test**

Append to `backend/tests/unit/plugin_bus/test_inprocess_host.py`:

```python
import json

from skrib.plugin_bus.inprocess_host import discover_inprocess_plugins


def test_discover_only_returns_in_process_plugins(tmp_path):
    """Only manifests declaring runtime: in_process are discovered."""
    for pid, runtime in [
        ("four43.alpha", "in_process"),
        ("four43.beta", "process"),
        ("four43.gamma", None),  # omitted -> defaults to process
    ]:
        d = tmp_path / pid
        d.mkdir()
        manifest = {"id": pid, "version": "1.0.0", "permissions": []}
        if runtime is not None:
            manifest["runtime"] = runtime
        (d / "manifest.json").write_text(json.dumps(manifest))

    found = discover_inprocess_plugins(tmp_path)

    assert [pid for pid, _ in found] == ["four43.alpha"]


def test_discover_ignores_directories_without_manifests(tmp_path):
    """A stray directory must not break discovery."""
    (tmp_path / "four43.orphan").mkdir()

    assert discover_inprocess_plugins(tmp_path) == []
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `cd backend && python -m pytest tests/unit/plugin_bus/test_inprocess_host.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'skrib.plugin_bus.inprocess_host'`.

- [ ] **Step 3: Write the implementation**

Create `backend/skrib/plugin_bus/inprocess_host.py`:

```python
"""Host for plugins declaring ``runtime: "in_process"``.

Discovers, imports and instantiates in-process plugins, wires each to an
``InProcessClient`` pointed at the bridge, and registers its room types so
``ws/handlers.py`` can dispatch to it without knowing where it runs.

An in-process plugin shares this interpreter with core: it is trusted, its
permissions are not enforced, and a crash in it can take down the server.
Only first-party code ships this way. See
docs/spec/2026-08-02-extension-model.md §3.1.
"""
from __future__ import annotations

import importlib.util
import json
import logging
from pathlib import Path
from typing import Any

from skrib_plugin_sdk.database import init_schema
from skrib_plugin_sdk.inprocess import InProcessClient

logger = logging.getLogger(__name__)


def discover_inprocess_plugins(plugins_dir: Path) -> list[tuple[str, Path]]:
    """Return (plugin_id, plugin_dir) for manifests with runtime == in_process.

    ``runtime`` defaults to ``"process"`` when absent, so an unmodified
    manifest keeps its current behaviour.
    """
    found: list[tuple[str, Path]] = []
    if not plugins_dir.is_dir():
        return found
    for entry in sorted(plugins_dir.iterdir()):
        manifest_path = entry / "manifest.json"
        if not manifest_path.is_file():
            continue
        try:
            manifest = json.loads(manifest_path.read_text())
        except (json.JSONDecodeError, OSError):
            logger.warning("[InProcess] Unreadable manifest at %s", manifest_path)
            continue
        if manifest.get("runtime", "process") != "in_process":
            continue
        plugin_id = manifest.get("id") or entry.name
        found.append((plugin_id, entry))
    return found


def _load_plugin_class(plugin_dir: Path) -> Any:
    """Import ``backend/plugin_bus.py`` from a plugin dir and return its
    SkribPlugin subclass."""
    from skrib_plugin_sdk.plugin import SkribPlugin

    module_path = plugin_dir / "backend" / "plugin_bus.py"
    if not module_path.is_file():
        raise FileNotFoundError(f"No backend/plugin_bus.py in {plugin_dir}")

    # Namespaced module name so two plugins cannot collide in sys.modules.
    module_name = f"_skrib_inprocess_{plugin_dir.name.replace('.', '_')}"
    spec = importlib.util.spec_from_file_location(module_name, module_path)
    if spec is None or spec.loader is None:
        raise ImportError(f"Cannot load {module_path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)

    for attr in vars(module).values():
        if (
            isinstance(attr, type)
            and issubclass(attr, SkribPlugin)
            and attr is not SkribPlugin
        ):
            return attr
    raise ImportError(f"No SkribPlugin subclass found in {module_path}")


class InProcessHost:
    """Owns the lifecycle of every in-process plugin."""

    def __init__(self, bridge, plugins_dir: Path):
        self._bridge = bridge
        self._plugins_dir = Path(plugins_dir)
        self._instances: dict[str, Any] = {}

    async def start(self) -> list[str]:
        """Load and register every in-process plugin. Returns started ids.

        A plugin that fails to load is logged and skipped; it must never be
        fatal to core startup.
        """
        started: list[str] = []
        for plugin_id, plugin_dir in discover_inprocess_plugins(self._plugins_dir):
            try:
                await self._start_one(plugin_id, plugin_dir)
                started.append(plugin_id)
                logger.info("[InProcess] %s started", plugin_id)
            except Exception:
                logger.exception("[InProcess] Failed to start %s", plugin_id)
        return started

    async def _start_one(self, plugin_id: str, plugin_dir: Path) -> None:
        from skrib_plugin_sdk.bus import PluginBus
        from skrib_plugin_sdk.core_api import CoreAPI

        cls = _load_plugin_class(plugin_dir)
        plugin = cls()

        if plugin.table_schema:
            init_schema(plugin.id, plugin.table_schema)

        client = InProcessClient(plugin.id, self._bridge._handle_plugin_frame)
        plugin._client = client
        plugin._bus = PluginBus(client, plugin.id)
        plugin._core_api = CoreAPI(client)

        # Same frame registrations run() performs for the bus transport.
        client.on_frame("room.action", plugin._handle_room_action)
        client.on_frame("callback.request", plugin._handle_callback)
        client.on_frame("event", plugin._handle_event)
        for lt in (
            "lifecycle.room_created",
            "lifecycle.room_deleted",
            "lifecycle.user_joined",
            "lifecycle.user_left",
        ):
            client.on_frame(lt, plugin._handle_lifecycle)

        await client.connect()
        self._bridge.register_inprocess(plugin.id, client.deliver, plugin.room_types)
        await plugin.on_connect()
        self._instances[plugin.id] = plugin

    async def stop(self) -> None:
        """Unregister and shut down every in-process plugin."""
        for plugin_id, plugin in list(self._instances.items()):
            self._bridge.unregister_inprocess(plugin_id)
            try:
                await plugin.on_disconnect()
            except Exception:
                logger.exception("[InProcess] Error stopping %s", plugin_id)
            if plugin._client is not None:
                await plugin._client.close()
        self._instances.clear()
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `cd backend && python -m pytest tests/unit/plugin_bus/ -v`
Expected: PASS, 198 passed.

- [ ] **Step 5: Commit**

```bash
cd /workspace
git add backend/skrib/plugin_bus/inprocess_host.py \
        backend/tests/unit/plugin_bus/test_inprocess_host.py
git commit -m "feat: Add InProcessHost to load runtime: in_process plugins

Imports each plugin's backend/plugin_bus.py, instantiates it, wires an
InProcessClient at the bridge, performs the same frame registrations
run() does for the bus transport, and registers its room types.

runtime defaults to \"process\" when the manifest omits it, so nothing
changes behaviour until a manifest opts in. A plugin that fails to load
is logged and skipped, never fatal to core startup.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4A: Load plugins with the existing loader, and fail loudly

Task 4's `_load_plugin_class` uses a bare `importlib.util.spec_from_file_location`, which
raises `ImportError: attempted relative import with no known parent package` for 4 of the
5 plugins targeted later — their `backend/plugin_bus.py` does `from . import services`.
`skrib_plugin_sdk/loader.py:load_plugin_class` already solves exactly this by setting the
plugin's `backend/` up as a real package. Worse, `InProcessHost.start()`'s per-plugin
`except` turns the failure into a **silent** no-op, so a later task would appear to
succeed while loading nothing.

**Files:**
- Modify: `backend/skrib/plugin_bus/inprocess_host.py`
- Test: `backend/tests/unit/plugin_bus/test_inprocess_host.py` (append)

**Interfaces:**
- Consumes: `skrib_plugin_sdk.loader.load_plugin_class(plugin_dir: str, module_name: str = "plugin_bus", allowed_base: str | None = None)` — returns the loaded *module*; find the `SkribPlugin` subclass on it.
- Produces: `_load_plugin_class(plugin_dir: Path)` unchanged in signature, correct in behaviour. `InProcessHost.start()` still returns `list[str]` of started ids, but now also records failures.

- [ ] **Step 1: Write the failing test**

Append to `backend/tests/unit/plugin_bus/test_inprocess_host.py`:

```python
import pytest

from pathlib import Path

from skrib.plugin_bus.inprocess_host import _load_plugin_class

PLUGINS_DIR = Path(__file__).resolve().parents[3] / "plugins"


@pytest.mark.parametrize("plugin_id", [
    "four43.room-type-chat",
    "four43.room-type-todo",
    "four43.message-reactions",
    "four43.emoji-picker",
    "four43.chat-typing",
])
def test_every_in_process_candidate_actually_loads(plugin_id):
    """Each plugin targeted for the in-process runtime must import cleanly.

    These plugins use relative imports (`from . import services`), which a bare
    spec_from_file_location cannot satisfy.
    """
    cls = _load_plugin_class(PLUGINS_DIR / plugin_id)

    assert cls.id == plugin_id
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `cd backend && python -m pytest tests/unit/plugin_bus/test_inprocess_host.py -v -k actually_loads`
Expected: 4 of 5 FAIL with `ImportError: attempted relative import with no known parent package`. `four43.chat-typing` passes (it has no relative imports).

- [ ] **Step 3: Reuse the existing loader**

In `backend/skrib/plugin_bus/inprocess_host.py`, replace the body of `_load_plugin_class`:

```python
def _load_plugin_class(plugin_dir: Path) -> Any:
    """Return the SkribPlugin subclass defined in a plugin's backend/plugin_bus.py.

    Delegates to the SDK loader, which sets the plugin's backend/ up as a real
    package so its relative imports (`from . import services`) resolve. A bare
    spec_from_file_location cannot do that.
    """
    from skrib_plugin_sdk.loader import load_plugin_class
    from skrib_plugin_sdk.plugin import SkribPlugin

    module = load_plugin_class(
        str(plugin_dir),
        allowed_base=str(Path(plugin_dir).parent),
    )

    for attr in vars(module).values():
        if (
            isinstance(attr, type)
            and issubclass(attr, SkribPlugin)
            and attr is not SkribPlugin
        ):
            return attr
    raise ImportError(f"No SkribPlugin subclass found in {plugin_dir}/backend/plugin_bus.py")
```

Delete the now-unused `importlib.util` import if nothing else in the file uses it.

- [ ] **Step 4: Make start() loud**

A plugin that fails to load must not be fatal to core startup, but it must not be silent
either. In `InProcessHost`, add `self._failures: dict[str, str] = {}` to `__init__`, and
change `start()`'s except clause to record and shout:

```python
            except Exception as exc:
                self._failures[plugin_id] = repr(exc)
                logger.error(
                    "[InProcess] FAILED to start %s — it will not handle any traffic: %r",
                    plugin_id, exc, exc_info=True,
                )
                print(f"[Plugins] IN-PROCESS PLUGIN FAILED: {plugin_id}: {exc!r}")
```

Add a `failures` property returning `dict(self._failures)` so callers and tests can see them.

- [ ] **Step 5: Run the tests**

Run: `cd backend && python -m pytest tests/unit/plugin_bus/ -v`
Expected: PASS, 211 passed (206 + 5 parametrized).

- [ ] **Step 6: Commit**

```bash
cd /workspace
git add backend/skrib/plugin_bus/inprocess_host.py \
        backend/tests/unit/plugin_bus/test_inprocess_host.py
git commit -m "fix: Load in-process plugins with the SDK loader, fail loudly

A bare spec_from_file_location cannot satisfy the relative imports these
plugins use, so 4 of the 5 in-process candidates raised ImportError.
skrib_plugin_sdk/loader.py already sets each plugin's backend/ up as a
real package; reuse it.

start() also swallowed load failures, which would have made a later task
look successful while loading nothing. Failures are now logged with a
traceback, printed, and exposed via .failures.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4B: In-process plugins get HTTP servers, settings schemas, and records

Four plugins declare `http_port = 0` and serve CRUD routes through the middleware proxy.
Task 4's host never started those servers, and never registered settings schemas. This
task makes the host provide everything the bus server provides for its connections, so
Task 4C's registry has a uniform record to expose.

**Files:**
- Modify: `backend/skrib/plugin_bus/inprocess_host.py`
- Test: `backend/tests/unit/plugin_bus/test_inprocess_host.py` (append)

**Interfaces:**
- Consumes: `SkribPlugin._start_http_server() -> str | None` and `_stop_http_server()`, already defined in `backend/skrib_plugin_sdk/plugin.py` — they create the plugin's FastAPI app, call its `register_routes`, and run uvicorn on `http_port` (0 = auto-assign). Call them; do not reimplement.
- Consumes: the settings service at `backend/skrib/plugin_bus/settings.py` — read it and use whatever function registers a schema for a plugin id (the bus server calls it when handling a `register.settings` frame; find that call site in `backend/skrib/plugin_bus/server.py` and use the same function).
- Produces: `InProcessHost.plugin_records() -> list[dict]`. Each dict has exactly these keys, because Task 4C merges them with the bus server's equivalents:
  `id`, `version`, `permissions` (list[str]), `room_types` (list[str]），`room_type_meta` (dict), `frontend_scripts` (list[str]), `frontend_styles` (list[str]), `http_base_url` (str | None), `runtime` (always `"in_process"`).

- [ ] **Step 1: Write the failing test**

Append to `backend/tests/unit/plugin_bus/test_inprocess_host.py`:

```python
@pytest.mark.asyncio
async def test_started_plugin_gets_an_http_server_and_a_record(bridge, tmp_path, monkeypatch):
    """A started in-process plugin exposes an http_base_url and a full record."""
    host = InProcessHost(bridge, PLUGINS_DIR)
    await host._start_one("four43.room-type-todo", PLUGINS_DIR / "four43.room-type-todo")
    try:
        records = {r["id"]: r for r in host.plugin_records()}
        rec = records["four43.room-type-todo"]

        assert rec["runtime"] == "in_process"
        assert rec["room_types"] == ["todo"]
        assert rec["http_base_url"].startswith("http://127.0.0.1:")
        assert set(rec) == {
            "id", "version", "permissions", "room_types", "room_type_meta",
            "frontend_scripts", "frontend_styles", "http_base_url", "runtime",
        }
    finally:
        await host.stop()


@pytest.mark.asyncio
async def test_stop_shuts_down_the_http_server(bridge):
    """stop() must not leave a listening socket behind."""
    host = InProcessHost(bridge, PLUGINS_DIR)
    await host._start_one("four43.room-type-todo", PLUGINS_DIR / "four43.room-type-todo")
    url = host.plugin_records()[0]["http_base_url"]
    await host.stop()

    assert host.plugin_records() == []
    import httpx
    with pytest.raises(Exception):
        async with httpx.AsyncClient(timeout=1.0) as c:
            await c.get(f"{url}/")
```

`four43.room-type-todo` is chosen because it declares `http_port = 0` and a single room
type, so the assertions are unambiguous. Use the `bridge` fixture already in this file.

- [ ] **Step 2: Run it and confirm it fails**

Run: `cd backend && python -m pytest tests/unit/plugin_bus/test_inprocess_host.py -v -k "http_server or record"`
Expected: FAIL — `AttributeError: 'InProcessHost' object has no attribute 'plugin_records'`.

- [ ] **Step 3: Start the HTTP server in `_start_one`**

In `_start_one`, after `await client.connect()` and before
`self._bridge.register_inprocess(...)`, add:

```python
        # Bus plugins get their HTTP server started by SkribPlugin.run(); in-process
        # plugins need the host to do it, because their CRUD routes are still served
        # through the middleware proxy at /api/plugins/{id}/...
        http_base_url = None
        if plugin.http_port is not None:
            http_base_url = await plugin._start_http_server()
        self._http_urls[plugin.id] = http_base_url
```

Add `self._http_urls: dict[str, str | None] = {}` to `__init__`.

- [ ] **Step 4: Register the settings schema**

Still in `_start_one`, after `await plugin.on_connect()`:

```python
        # The bus server registers settings schemas when it handles a
        # register.settings frame. In-process plugins never send one, so do it here.
        if plugin.settings:
            register_plugin_settings_schema(plugin.id, plugin.settings)
```

Import `register_plugin_settings_schema` from `backend/skrib/plugin_bus/settings.py` using
whatever the real function name is — find it by locating where
`backend/skrib/plugin_bus/server.py` handles `register.settings` and calling the same
function with the same arguments. If the name differs, use the real one and note it in
your report.

- [ ] **Step 5: Add `plugin_records()`**

```python
    def plugin_records(self) -> list[dict]:
        """Uniform records for every running in-process plugin.

        Key set matches what the bus server exposes per connection, so the plugin
        registry can merge both sources without special-casing either runtime.
        """
        records = []
        for plugin_id, plugin in self._instances.items():
            records.append({
                "id": plugin_id,
                "version": plugin.version,
                "permissions": list(plugin.permissions),
                "room_types": list(plugin.room_types),
                "room_type_meta": dict(plugin.room_type_meta),
                "frontend_scripts": list(plugin.frontend_scripts),
                "frontend_styles": list(plugin.frontend_styles),
                "http_base_url": self._http_urls.get(plugin_id),
                "runtime": "in_process",
            })
        return records
```

- [ ] **Step 6: Stop the HTTP server in `stop()`**

In `stop()`, inside the per-plugin loop and before `plugin._client.close()`:

```python
            try:
                await plugin._stop_http_server()
            except Exception:
                logger.exception("[InProcess] Error stopping HTTP server for %s", plugin_id)
```

Also clear `self._http_urls` at the end of `stop()`, alongside `self._instances.clear()`.

- [ ] **Step 7: Run the tests**

Run: `cd backend && python -m pytest tests/unit/plugin_bus/ -v`
Expected: PASS, 213 passed.

- [ ] **Step 8: Commit**

```bash
cd /workspace
git add backend/skrib/plugin_bus/inprocess_host.py \
        backend/tests/unit/plugin_bus/test_inprocess_host.py
git commit -m "feat: In-process plugins get HTTP servers and settings schemas

Four plugins declare http_port = 0 and serve CRUD routes through the
middleware proxy; the host never started those servers, so their routes
would have 404'd. It also never registered settings schemas, which the
bus server does when handling a register.settings frame.

plugin_records() exposes the same key set the bus server exposes per
connection, so the plugin registry can merge both runtimes uniformly.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4C: One runtime-agnostic plugin registry

Four call sites answer "is this plugin active, and what are its details?" by reaching into
the bus server's connection map. That map is now only half the story, so each one silently
excludes in-process plugins. Rather than teach four places about two runtimes, introduce
one registry they all consult.

**Files:**
- Create: `backend/skrib/plugins/registry.py`
- Modify: `backend/skrib/plugins/routes.py` (`_get_bus_plugins`, `list_plugins`, and the `/{plugin_id}/file/{file_path:path}` handler)
- Modify: `backend/skrib/plugins/middleware.py` (`_get_proxy_url`)
- Modify: `backend/skrib/ws/manager.py:296` (the `_dispatch_plugin_namespace` gate)
- Modify: `backend/skrib/main.py` (construct the registry, put it on `app.state`)
- Test: `backend/tests/unit/plugin_bus/test_plugin_registry.py`

**Interfaces:**
- Consumes: `InProcessHost.plugin_records()` from Task 4B; `PluginBusServer.room_type_map` and its per-connection attributes, read-only.
- Produces: `PluginRegistry(bus_server, inprocess_host=None)` with
  - `get(plugin_id: str) -> dict | None` — a record in the Task 4B key set plus `"runtime": "process" | "in_process"`, or `None` if not active
  - `all() -> list[dict]`
  - `is_active(plugin_id: str) -> bool`
  and `app.state.plugin_registry`.

**Do not modify `backend/skrib/plugin_bus/server.py`.** The registry reads it; it does not
change.

- [ ] **Step 1: Write the failing test**

Create `backend/tests/unit/plugin_bus/test_plugin_registry.py`:

```python
"""The registry must present both runtimes through one interface."""
import pytest

from skrib.plugins.registry import PluginRegistry


class _FakeConn:
    def __init__(self, plugin_id):
        self.plugin_id = plugin_id
        self.version = "1.0.0"
        self.permissions = {"bus.send"}
        self.room_types = ["chat"]
        self.room_type_meta = {}
        self.frontend_scripts = []
        self.frontend_styles = []
        self.http_base_url = "http://127.0.0.1:9111"


class _FakeBusServer:
    def __init__(self, conns):
        self._conns = conns
        self.room_type_map = {"chat": "four43.bus-one"}

    def get_plugin(self, plugin_id):
        return self._conns.get(plugin_id)


class _FakeHost:
    def plugin_records(self):
        return [{
            "id": "four43.inproc-one",
            "version": "2.0.0",
            "permissions": ["bus.send"],
            "room_types": ["todo"],
            "room_type_meta": {},
            "frontend_scripts": ["frontend/dist/plugin.js"],
            "frontend_styles": [],
            "http_base_url": "http://127.0.0.1:9222",
            "runtime": "in_process",
        }]


def test_get_resolves_both_runtimes():
    reg = PluginRegistry(_FakeBusServer({"four43.bus-one": _FakeConn("four43.bus-one")}), _FakeHost())

    assert reg.get("four43.bus-one")["runtime"] == "process"
    assert reg.get("four43.inproc-one")["runtime"] == "in_process"
    assert reg.get("four43.nope") is None


def test_is_active_covers_in_process_plugins():
    """This is the manager.py:296 gate — an in-process plugin must pass it."""
    reg = PluginRegistry(_FakeBusServer({}), _FakeHost())

    assert reg.is_active("four43.inproc-one") is True
    assert reg.is_active("four43.nope") is False


def test_all_returns_both_and_does_not_duplicate():
    reg = PluginRegistry(_FakeBusServer({"four43.bus-one": _FakeConn("four43.bus-one")}), _FakeHost())

    ids = sorted(r["id"] for r in reg.all())
    assert ids == ["four43.bus-one", "four43.inproc-one"]


def test_records_share_one_key_set():
    """routes.py merges both sources, so the shapes must agree exactly."""
    reg = PluginRegistry(_FakeBusServer({"four43.bus-one": _FakeConn("four43.bus-one")}), _FakeHost())
    shapes = {frozenset(r) for r in reg.all()}

    assert len(shapes) == 1


def test_works_with_no_in_process_host():
    """The host is optional — a bus-only server must still resolve."""
    reg = PluginRegistry(_FakeBusServer({"four43.bus-one": _FakeConn("four43.bus-one")}), None)

    assert reg.is_active("four43.bus-one") is True
    assert reg.is_active("four43.inproc-one") is False
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `cd backend && python -m pytest tests/unit/plugin_bus/test_plugin_registry.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'skrib.plugins.registry'`.

- [ ] **Step 3: Write the registry**

Create `backend/skrib/plugins/registry.py`:

```python
"""One runtime-agnostic view of active plugins.

Before this existed, four separate call sites answered "is this plugin active,
and what are its details?" by reaching into the bus server's connection map.
That map only describes plugins running as separate processes, so each call site
silently excluded in-process plugins. They all consult this instead.

Adding a third runtime means changing this file, not four others.
"""
from __future__ import annotations

import logging
from typing import Any, Optional

logger = logging.getLogger(__name__)

RECORD_KEYS = (
    "id", "version", "permissions", "room_types", "room_type_meta",
    "frontend_scripts", "frontend_styles", "http_base_url", "runtime",
)


class PluginRegistry:
    """Presents bus-connected and in-process plugins through one interface."""

    def __init__(self, bus_server: Any, inprocess_host: Optional[Any] = None):
        self._bus = bus_server
        self._host = inprocess_host

    def _record_from_conn(self, conn: Any) -> dict:
        return {
            "id": conn.plugin_id,
            "version": getattr(conn, "version", ""),
            "permissions": list(getattr(conn, "permissions", ()) or ()),
            "room_types": list(getattr(conn, "room_types", ()) or ()),
            "room_type_meta": dict(getattr(conn, "room_type_meta", {}) or {}),
            "frontend_scripts": list(getattr(conn, "frontend_scripts", ()) or ()),
            "frontend_styles": list(getattr(conn, "frontend_styles", ()) or ()),
            "http_base_url": getattr(conn, "http_base_url", None),
            "runtime": "process",
        }

    def get(self, plugin_id: str) -> dict | None:
        """Return the active plugin's record, or None if it is not running."""
        if self._host is not None:
            for rec in self._host.plugin_records():
                if rec["id"] == plugin_id:
                    return rec
        if self._bus is not None:
            try:
                conn = self._bus.get_plugin(plugin_id)
            except Exception:
                conn = None
            if conn is not None:
                return self._record_from_conn(conn)
        return None

    def all(self) -> list[dict]:
        """Every active plugin, in-process first. Ids are unique."""
        records: list[dict] = []
        seen: set[str] = set()
        if self._host is not None:
            for rec in self._host.plugin_records():
                records.append(rec)
                seen.add(rec["id"])
        if self._bus is not None:
            for room_type_owner in self._iter_bus_plugin_ids():
                if room_type_owner in seen:
                    continue
                conn = self._bus.get_plugin(room_type_owner)
                if conn is not None:
                    records.append(self._record_from_conn(conn))
                    seen.add(room_type_owner)
        return records

    def _iter_bus_plugin_ids(self):
        """Bus plugin ids, without reaching into the server's private state."""
        ids = getattr(self._bus, "connected_plugin_ids", None)
        if callable(ids):
            return list(ids())
        # Fall back to whatever the server exposes publicly.
        return list(getattr(self._bus, "plugin_ids", ()) or ())

    def is_active(self, plugin_id: str) -> bool:
        return self.get(plugin_id) is not None
```

**Note on `_iter_bus_plugin_ids`:** `PluginBusServer` may not expose a public way to
enumerate connected plugins. You may NOT add one — `server.py` is off limits. Read
`server.py` and find what IS public (`room_type_map` is, via a property). If nothing
enumerates connections publicly, keep `list_plugins`'s existing `_get_bus_plugins()` logic
for the bus half and have `all()` delegate to it rather than duplicating it; adjust the
test accordingly and explain in your report. Correctness beats the shape of my sketch.

- [ ] **Step 4: Run the registry tests**

Run: `cd backend && python -m pytest tests/unit/plugin_bus/test_plugin_registry.py -v`
Expected: PASS.

- [ ] **Step 5: Construct the registry at startup**

In `backend/skrib/main.py`, after the `InProcessHost` is started (the
`started_inprocess = await inprocess_host.start()` line added by Task 5 — if Task 5 has
not run yet, add the registry construction immediately after `app.state.plugin_bus_bridge = bridge`
and pass `inprocess_host=None` for now, leaving a `# wired in Task 5` comment):

```python
    from .plugins.registry import PluginRegistry
    app.state.plugin_registry = PluginRegistry(plugin_bus, inprocess_host)
```

- [ ] **Step 6: Rewire the `_dispatch_plugin_namespace` gate**

In `backend/skrib/ws/manager.py`, replace the gate at line ~296:

```python
            bridge = getattr(app.state, 'plugin_bus_bridge', None)
            registry = getattr(app.state, 'plugin_registry', None)
            if not bridge or not registry or not registry.is_active(plugin_id):
                return False
```

Everything after this gate is already runtime-agnostic — `bridge.dispatch_room_action`
routes through `_send_to_plugin`, which handles both runtimes — so this is the only change
needed in this file.

- [ ] **Step 7: Rewire the proxy gate**

In `backend/skrib/plugins/middleware.py`, `_get_proxy_url`, replace the
`plugin_bus.get_plugin(plugin_id)` lookup with the registry, keeping every existing
security check:

```python
            from ..main import app as main_app
            registry = getattr(main_app.state, 'plugin_registry', None)
            if not registry:
                return None
            rec = registry.get(plugin_id)
            if not rec or not rec["http_base_url"]:
                return None
            if not self._is_localhost_url(rec["http_base_url"]):
                logger.warning("[Middleware] Rejecting non-localhost http_base_url for plugin '%s': %s",
                               plugin_id, rec["http_base_url"])
                return None
            return f"{rec['http_base_url'].rstrip('/')}{sub_path}"
```

The old code also rejected plugins whose `conn.status != ApprovalStatus.APPROVED`. The
registry only ever returns *active* plugins, so preserve that guarantee: make sure
`PluginRegistry.get` does not return a record for a bus connection that is not approved.
Add a test for it if the registry does not already enforce it.

- [ ] **Step 8: Rewire the plugin listing and file serving**

In `backend/skrib/plugins/routes.py`:
- `list_plugins` builds its active set from `app.state.plugin_registry.all()` instead of
  `_get_bus_plugins()`, so in-process plugins report `enabled=True` and carry their
  registered `room_types` and frontend entries. The filesystem-discovery half stays: any
  plugin on disk that the registry does not list still gets `enabled=False`.
- The `/{plugin_id}/file/{file_path:path}` handler currently looks up `conn.http_base_url`
  via `plugin_bus.get_plugin`. Use `registry.get(plugin_id)["http_base_url"]` instead,
  keeping the `_is_localhost_url` check and the filesystem fallback exactly as they are.

**Why this matters most:** `plugins/routes.py:130` sets `enabled = False` for anything not
bus-connected, and the frontend only injects `<script>` tags for enabled plugins. Without
this step an in-process chat plugin's frontend never loads and the app has no chat UI.

- [ ] **Step 9: Run everything**

Run: `cd backend && python -m pytest tests/unit/plugin_bus/ -v`
Expected: PASS, 218 passed.

Then confirm nothing regressed for bus plugins, which is the path all existing e2e tests
still take:

Run: `cd frontend && ./util/test-e2e tests/e2e/attachments.spec.js tests/e2e/typing-indicators.spec.js`
Expected: same results as before this task — no in-process plugin exists yet, so the
registry must be a pure pass-through to the bus server.

- [ ] **Step 10: Commit**

```bash
cd /workspace
git add backend/skrib/plugins/registry.py backend/skrib/plugins/routes.py \
        backend/skrib/plugins/middleware.py backend/skrib/ws/manager.py \
        backend/skrib/main.py backend/tests/unit/plugin_bus/test_plugin_registry.py
git commit -m "feat: One runtime-agnostic plugin registry

Four call sites answered 'is this plugin active?' by reaching into the bus
server's connection map, which only describes out-of-process plugins. Each
therefore excluded in-process plugins silently:

- plugins/routes.py:130 marked them enabled=False, so the frontend would
  never have injected their scripts — no chat UI at all.
- ws/manager.py:296 dropped their own-namespace WS messages.
- plugins/middleware.py:_get_proxy_url 404'd their HTTP CRUD routes.
- the plugin file handler could not resolve their http_base_url.

All four now consult PluginRegistry. Adding a third runtime means changing
one file instead of four.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Start the host during app startup

**Files:**
- Modify: `backend/skrib/main.py:211-220` (inside `startup_event`, after the bridge is created)
- Test: manual — the e2e suite in Task 6 is the real test.

**Interfaces:**
- Consumes: `InProcessHost` (Task 4).
- Produces: `app.state.inprocess_host: InProcessHost`.

- [ ] **Step 1: Wire the host into startup**

In `backend/skrib/main.py`, immediately after `app.state.plugin_bus_bridge = bridge` (line ~213):

```python
    # Start in-process plugins. These need no external process and no
    # approval — they are trusted first-party code sharing this interpreter.
    from pathlib import Path
    from .plugin_bus.inprocess_host import InProcessHost

    inprocess_host = InProcessHost(bridge, Path(__file__).parent.parent / "plugins")
    app.state.inprocess_host = inprocess_host
    started_inprocess = await inprocess_host.start()
    if started_inprocess:
        print(f"[Plugins] in-process: {', '.join(started_inprocess)}")
    _t("inprocess host started")
```

- [ ] **Step 2: Stop the host on shutdown**

Find `shutdown_event` in `backend/skrib/main.py` (it already calls `close_http_client()`) and add before that call:

```python
    inprocess_host = getattr(app.state, "inprocess_host", None)
    if inprocess_host is not None:
        await inprocess_host.stop()
```

- [ ] **Step 3: Verify the server still boots with no in-process plugins yet**

No manifest declares `runtime: in_process` at this point, so the host should start zero plugins and change nothing.

Run: `cd backend && .venv/bin/python -m uvicorn skrib.main:app --port 8099 &` then `curl -s localhost:8099/api/server | head -c 200` and finally `kill %1`.
Expected: the server boots, prints no `[Plugins] in-process:` line, and `/api/server` responds.

- [ ] **Step 4: Run the full backend suite**

Run: `cd backend && python -m pytest tests/unit/plugin_bus/ -v`
Expected: PASS, 198 passed.

- [ ] **Step 5: Commit**

```bash
cd /workspace
git add backend/skrib/main.py
git commit -m "feat: Start and stop the in-process plugin host with the app

No manifest opts in yet, so this is a no-op until the next commit.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Flip `room-type-chat` to `in_process`

**Deliberately narrowed to one plugin.** The msg-2 bug lives in the chat message
path, so `room-type-chat` is the only flip needed to test the hypothesis. Every
other plugin keeps working exactly as it does today, which means a regression
anywhere else is unambiguously caused by this one manifest key rather than by
five of them at once.

Todo, reactions, emoji-picker and chat-typing are all still *intended* for the
in-process runtime on the same reasoning — they interpret core data, do small
frequent writes, and talk to nothing outside — but flipping them is follow-up
work once the suite is green, tracked in `TODO.md`. Web-push and attachments stay
on the bus permanently at this stage: one does outbound HTTP to FCM/APNs, the
other parses untrusted uploads with Pillow.

**Files:**
- Modify: `backend/plugins/four43.room-type-chat/manifest.json`
- Modify: `backend/plugins/four43.web-push/manifest.json`
- Modify: `backend/plugins/four43.attachments/manifest.json`

**Interfaces:**
- Consumes: everything from Tasks 2, 3, 4, 4A, 4B, 4C and 5.
- Produces: `four43.room-type-chat` served in-process; every other plugin on the bus.

- [ ] **Step 1: Flip chat**

Add `"runtime": "in_process"` as a top-level key to
`backend/plugins/four43.room-type-chat/manifest.json`, keeping every existing key.

- [ ] **Step 2: Add explicit `runtime: "process"` to the two that stay out permanently**

Add `"runtime": "process"` to `four43.web-push/manifest.json` and
`four43.attachments/manifest.json`. It matches the default, but stating it
makes the trust boundary legible in the file rather than implied by absence.

Leave `four43.room-type-todo`, `four43.message-reactions`,
`four43.emoji-picker` and `four43.chat-typing` untouched — they default to
`process` and keep their current behaviour.

- [ ] **Step 3: Verify the host picks up exactly five**

Run:

```bash
cd backend && python -c "
from pathlib import Path
from skrib.plugin_bus.inprocess_host import discover_inprocess_plugins
for pid, _ in discover_inprocess_plugins(Path('plugins')):
    print(pid)
"
```

Expected exactly one line:
```
four43.room-type-chat
```

- [ ] **Step 4: Run the msg-2 reproducer**

Run: `cd frontend && ./util/test-e2e --grep "Headings render"`
Expected: PASS.

- [ ] **Step 5: Run the plugin e2e batch**

Run: `cd frontend && ./util/test-e2e tests/e2e/typing-indicators.spec.js tests/e2e/message-reactions.spec.js tests/e2e/emoji-picker.spec.js tests/e2e/todo-rooms.spec.js tests/e2e/attachments.spec.js`
Expected: PASS. Baseline was 32/34 with one flake. Every plugin in this batch still
runs over the bus while chat runs in-process, so this batch is the proof that both
runtimes coexist without interfering.

- [ ] **Step 6: Commit**

```bash
cd /workspace
git add backend/plugins/*/manifest.json
git commit -m "feat: Run room-type-chat in-process

The msg-2 bug lives in the chat message path, where each message did N
sequential bus round-trips before the handler returned. Batching those
into one call did not fix it (see TODO.md), so the boundary itself is the
cause. Chat now runs in the same interpreter as core.

Narrowed to one plugin on purpose: every other plugin still runs over the
bus, so any regression elsewhere is attributable to this single manifest
key. Todo, reactions, emoji-picker and chat-typing are intended to follow
once the suite is green.

web-push and attachments stay on the bus and now say so explicitly: one
does outbound HTTP to FCM/APNs, the other parses untrusted uploads with
Pillow. Those are the two that actually want isolation.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: Stop the e2e harness spawning in-process plugins

`discoverBundledPlugins` spawns a process for every plugin with a `__main__.py`, and `waitForPluginsReady` polls `/api/plugins` until each appears. In-process plugins have no process to spawn, so both must skip them.

**Files:**
- Modify: `frontend/tests/e2e/fixtures.js:92-104` (`discoverBundledPlugins`)

**Interfaces:**
- Consumes: the `runtime` manifest field from Task 6.
- Produces: `discoverBundledPlugins` returns only `runtime: "process"` plugins, so `startPlugins` and `waitForPluginsReady` both narrow automatically.

- [ ] **Step 1: Filter discovery by runtime**

Replace `discoverBundledPlugins` in `frontend/tests/e2e/fixtures.js`:

```javascript
/**
 * Discover bundled plugin directories that need their own process — anything
 * under backend/plugins/ with a __main__.py, a manifest.json, and a manifest
 * runtime that is not "in_process". Returns [{ id, dir }].
 *
 * runtime: "in_process" plugins are loaded by the backend itself (see
 * skrib/plugin_bus/inprocess_host.py), so there is no process to spawn and
 * nothing for waitForPluginsReady to wait on.
 */
function discoverBundledPlugins(backendDir) {
    const pluginsDir = join(backendDir, 'plugins');
    const out = [];
    for (const name of readdirSync(pluginsDir).filter(d => d.startsWith('four43.'))) {
        const dir = join(pluginsDir, name);
        if (!existsSync(join(dir, '__main__.py'))) continue;
        const manifestPath = join(dir, 'manifest.json');
        if (!existsSync(manifestPath)) continue;
        let manifest;
        try {
            manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
        } catch {
            continue;
        }
        if ((manifest.runtime || 'process') === 'in_process') continue;
        out.push({ id: name, dir });
    }
    return out;
}
```

Add `readFileSync` to the existing `node:fs` import at the top of the file if it is not already there.

- [ ] **Step 2: Verify discovery now yields two plugins**

Run:

```bash
cd frontend && node --input-type=module -e "
import { readdirSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
const dir = '../backend/plugins';
for (const name of readdirSync(dir).filter(d => d.startsWith('four43.'))) {
  const p = join(dir, name, 'manifest.json');
  if (!existsSync(p)) continue;
  if (!existsSync(join(dir, name, '__main__.py'))) continue;
  const mf = JSON.parse(readFileSync(p, 'utf8'));
  if ((mf.runtime || 'process') !== 'in_process') console.log(name);
}
"
```

Expected:
```
four43.attachments
four43.web-push
```

- [ ] **Step 3: Run the single-user fixture path**

Run: `cd frontend && ./util/test-e2e tests/e2e/registration-and-authentication.spec.js`
Expected: PASS, 0 failures. Baseline was 2 failures. This exercises `authenticatedPage`/`registeredUser`, which await `ensurePlugins()` — now waiting on only the two bus plugins.

- [ ] **Step 4: Commit**

```bash
cd /workspace
git add frontend/tests/e2e/fixtures.js
git commit -m "test: Only spawn plugin processes for runtime: process plugins

discoverBundledPlugins spawned a process per plugin with a __main__.py
and waitForPluginsReady polled for each. In-process plugins have no
process, so both now skip them and the harness waits on web-push and
attachments only.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: Teach `start-plugins` about runtimes

**Files:**
- Modify: `backend/util/start-plugins:34-36` (the `for plugin_dir in ...` loop)

**Interfaces:**
- Consumes: the `runtime` manifest field from Task 6.
- Produces: `start-plugins` starts only `runtime: process` plugins and says so.

- [ ] **Step 1: Skip in-process plugins in the loop**

In `backend/util/start-plugins`, inside the `for plugin_dir in "$PLUGINS_DIR"/four43.*/; do` loop, immediately after the existing `[ -f "$plugin_dir/__main__.py" ] || continue`:

```bash
    # Skip plugins the backend loads itself. runtime defaults to "process".
    manifest="$plugin_dir/manifest.json"
    if [ -f "$manifest" ]; then
        runtime=$(python3 -c "import json,sys; print(json.load(open(sys.argv[1])).get('runtime','process'))" "$manifest" 2>/dev/null || echo process)
        if [ "$runtime" = "in_process" ]; then
            echo "[Plugins] Skipping $(basename "$plugin_dir") (runtime: in_process — loaded by the backend)"
            continue
        fi
    fi
```

- [ ] **Step 2: Verify it starts only two**

Run: `cd backend && ./util/start-plugins`
Expected output includes skip lines for the five in-process plugins and starts only `four43.attachments` and `four43.web-push`.

Then: `cd backend && ./util/start-plugins --stop`

- [ ] **Step 3: Commit**

```bash
cd /workspace
git add backend/util/start-plugins
git commit -m "chore: start-plugins skips runtime: in_process plugins

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 9: Full suite green, then merge

**Files:**
- Modify: `TODO.md` (record the msg-2 answer and tick the completed P0-unblock items)
- Modify: `docs/reference/architecture.md`, `docs/reference/websocket-bus.md` (replace the `> **Changing.**` notes for what has now changed)

**Interfaces:**
- Consumes: Tasks 1–8.
- Produces: a green suite and a merged branch.

- [ ] **Step 1: Run the whole backend suite**

Run: `cd backend && python -m pytest tests/unit/plugin_bus/ -v`
Expected: PASS, 198 passed.

- [ ] **Step 2: Run the frontend unit tests**

Run: `cd frontend && ./util/test`
Expected: PASS.

- [ ] **Step 3: Run the entire e2e suite**

Run: `cd frontend && ./util/test-e2e`
Expected: PASS, 330 tests. Baseline was ~20 failures across four batches.

If any remain red, stop and diagnose before merging. Do not tick this box on a partial pass — record the exact remaining failures in `TODO.md` under P0-unblock instead, and treat them as a new task.

- [ ] **Step 4: Record what fixed msg-2**

In `TODO.md` under **P0 — Unblock the repository**, replace the two batching/timebox items with a one-line finding: whether Task 1's batching alone fixed it, or whether the in-process flip was required. This is the answer the whole ordering was designed to produce — write it down where the next session will see it.

Tick the now-complete items: the auth batch re-run, the merge, and the msg-2 timebox.

- [ ] **Step 5: Update the two reference docs**

`docs/reference/architecture.md` currently carries a `> **Changing.**` note saying plugin processes are not optional and that supervision is coming. Replace it with what is now true: basic messaging needs no external process because the hot-path plugins run in-process; `start-plugins` remains for the two bus plugins and still has no supervision. Keep a `> **Changing.**` note for the supervision work, which is still outstanding.

`docs/reference/websocket-bus.md` §Routing step 4 says every room action goes over the bus with no in-process fallback. Replace with: dispatch resolves the room type through `bridge.get_bus_plugin_for_room_type`, which checks in-process plugins first and the bus server second; `ws/handlers.py` is runtime-agnostic.

- [ ] **Step 6: Commit the docs and TODO updates**

```bash
cd /workspace
git add TODO.md docs/reference/architecture.md docs/reference/websocket-bus.md
git commit -m "docs: Record the msg-2 finding and the dual-runtime dispatch path

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

- [ ] **Step 7: Stop. Do not merge.**

The merge to `master` is the developer's call, not this plan's. Report the
final state — suite results, the msg-2 finding, and the commit range — and let
them decide when to merge.

Suggested message if they want it:

```
Merge feat-plugins-new-process: dual-runtime plugins

Plugins now declare runtime: in_process | process and run either way
with no change to plugin code. The four hot-path plugins plus typing
run in-process; web-push and attachments stay sandboxed on the bus.
```

---

## Self-Review

**Spec coverage.** This plan implements the parts of `docs/spec/2026-08-02-extension-model.md` needed for green tests: the `runtime` manifest field (§1), one SDK for both runtimes (§3), the security bifurcation (§3.1), and the in/out placement for six of the seven plugins (§4), plus the `get_notify_levels` batching (§4.1). Deliberately **not** covered, and still open in `TODO.md`: the `kind` and `applies_to` manifest fields, moving `subscriptions` out of Python class attributes, core-owned plugin supervision (§5), splitting link previews out of the chat plugin, folding themes in, and splitting `bus.send`. `four43.chat-typing` is flipped to in-process rather than deleted, because deleting it needs the core signal channel from the P2 spec.

**Placeholder scan.** Every code step carries real code. The two places that intentionally defer to existing repo conventions are the `seeded_room` and `bridge` pytest fixtures — both say to reuse what `tests/unit/plugin_bus/conftest.py` already has rather than inventing a parallel construction, which is the correct instruction rather than a placeholder.

**Type consistency.** `get_notify_levels(room_id) -> dict[str, str]` is spelled identically in the core service, both CoreAPI classes, the bridge dispatch, and the chat plugin call site. `InProcessClient`'s method set matches the `BusClient` surface `SkribPlugin` actually uses (`connected`, `on_frame`, `connect`, `run`, `run_with_reconnect`, `send`, `request`, `close`) plus `deliver`. `register_inprocess(plugin_id, deliver, room_types)` is spelled the same in Task 3's implementation and Task 4's call site.

**One risk this plan carries.** In-process plugins share the interpreter, so a crash in chat now takes the server down where previously it only broke room actions. That is the accepted trade for trusting first-party code, and it is why web-push and attachments — the two that handle outside input — stay out. If in-process chat proves crash-prone in practice, the fix is one manifest line, which is the whole point of making runtime a deployment choice.
