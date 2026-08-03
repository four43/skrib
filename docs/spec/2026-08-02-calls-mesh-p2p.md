# Video and voice calls: P2P mesh, capped at four

**Date:** 2026-08-02
**Status:** Approved design, ready for implementation planning
**Depends on:** `2026-08-02-core-log-and-signal.md`, `2026-08-02-extension-model.md`

## Problem

A WebRTC prototype exists (`research/index.html`, `research/server.py`, commit
`8555852`) but it lives outside the application: its own aiohttp server on port
8080, pairing clients into rooms of exactly two, Google public STUN, no TURN, no
integration with rooms, membership, or the E2E model.

The open design question was whether a call is a **room type** or a **feature of a
room**. Answering it required deciding what part of a call, if any, belongs in the
durable record.

## Goals

- Calls inside existing rooms, using existing membership and existing room keys.
- Retire the standalone signalling server and port 8080.
- Preserve the E2E pillar with no exceptions.
- A call that is in progress is discoverable by someone opening the room.

## Non-goals

- Group calls beyond four participants. Deliberately deferred (§4).
- An SFU, and therefore SFrame / insertable streams. Deferred with it.
- Recording. Under E2E a server-side recording is impossible, and a client-side
  one is a separate design.
- Screen sharing. Mechanically an extra track; deferred to keep this small.

## Key facts that shape the design

- The prototype uses `stun.l.google.com` with **no TURN fallback**
  (`research/index.html:69`).
- `RTCPeerConnection` media is already DTLS-SRTP encrypted peer-to-peer, so in a
  mesh topology **the server is never in the media path.**
- The core signal channel (`2026-08-02-core-log-and-signal.md` §2) provides
  directed member-to-member delivery, which pairwise negotiation requires.

## Design

### 1. A call decomposes into three planes

| Plane | Content | Where it lives |
| --- | --- | --- |
| **Lifecycle** | `call.started`, `call.joined`, `call.left`, `call.ended` | **Core log items.** Durable, ordered, attributed — rendered inline in the transcript. |
| **Signalling** | SDP offers/answers, ICE candidates | **Directed signals.** Never persisted. |
| **Media** | SRTP audio/video | **Never touches the server.** Peer-to-peer. |

So a call *produces* durable records without *being* one.

### 2. A call is a feature, not a room type

Per the extension model, **a room type owns the primary surface and the default
interpretation of the log; a feature adds items or behaviour to someone else's
surface.** A call inside a chat room is an activity within that room — the room is
still a chat. So: `kind: feature`, `applies_to: ["chat"]`.

A future *meeting room* whose primary surface **is** the call (a persistent video
room you walk into) would be a genuine room type, embedding this same feature as
its surface. That the same plugin can serve both cases is evidence the
room-type/feature split is doing real work rather than being arbitrary.

### 3. Liveness is a projection, not state

"A call is happening now" is derived from the log: **the most recent
`call.started` in a room with no matching `call.ended`.**

This was initially modelled as join-visible ephemeral state, which would have
required a last-write-wins flavour of the signal channel. It does not: the
lifecycle items are durable anyway because they belong in the transcript. The
projection survives a server restart, cannot race, and needs no new primitive —
and removing this case is what let the signal channel collapse to fire-and-forget
events only.

#### 3.1 The stale-call reaper

If every participant's browser dies, no `call.ended` is ever written and the
projection reports a phantom live call indefinitely.

A periodic sweep appends a synthetic `call.ended` for any call with no participant
activity for a threshold interval, using the
`backend/skrib/backups/services.py:301` scheduler pattern. Participant liveness
comes from WebSocket connection state, which core already tracks.

### 4. Mesh only, capped at four

Every participant uploads their stream to every other participant, so bandwidth
grows as N². Quality degrades around four or five participants. The cap is **four,
enforced server-side** when appending `call.joined`.

This is a deliberate product cap, chosen because it is where the E2E pillar and
the "me and a few people" scale genuinely align:

- **Mesh is the E2E-correct topology by default.** DTLS-SRTP means media is
  already encrypted peer-to-peer with the server nowhere in the path. No
  additional crypto work is required for calls to satisfy the pillar.
- Going beyond four requires an SFU. An SFU that cannot decrypt requires
  insertable streams / SFrame — the approach Signal and Element Call use. That is
  possible but a large step up in complexity, with browser support that must be
  verified before committing.

Raising the cap is a later phase. The cap is designed in on purpose rather than
discovered as a limitation.

### 5. Signalling over directed signals

Pairwise negotiation: a four-person mesh is **six independent negotiations**, each
exchanging SDP with exactly one peer. `research/server.py` sidesteps this by
pairing clients into rooms of two; the real implementation cannot.

Signal types:

| Type | Delivery | Notes |
| --- | --- | --- |
| `call.offer` / `call.answer` | `to: member` | SDP |
| `call.ice` | `to: member` | ICE candidates, high frequency |
| `call.ringing` | `to: room` | Invite the room |
| `call.speaking` | `to: room` | Active speaker / audio level, 10–30/s |
| `call.mute` | `to: member` on join, `to: room` on change | Current state arrives in-band via renegotiation |

**Directed signals are encrypted with the room key**, because SDP and ICE
candidates contain participants' IP addresses. The server already learns every IP
from the WebSocket connection, so nothing leaks today — but the room key is
already in hand and it preserves the option of running behind a relay where that
stops being true.

Per-type rate limits are required: `call.ice` and `call.speaking` run orders of
magnitude hotter than `call.ringing`.

### 6. Runtime placement

`runtime: in_process`. The call feature does no outside-world I/O — signalling
rides the core signal channel and media never touches the server. There is
nothing to isolate.

### 7. TURN: the admin cost

**STUN alone fails behind symmetric NAT**, commonly cited around 10–15% of
connections. The prototype has no TURN fallback, so a meaningful fraction of real
calls between real users will simply fail to connect.

Fixing that means the admin runs coturn: another process, another port, bandwidth
costs, and credentials to rotate. So **"self-host Skrīb" quietly becomes
"self-host Skrīb and a TURN server"** for anyone who wants calls to work
reliably.

A TURN relay only ever sees encrypted SRTP, so the E2E pillar survives a relay
intact.

Design consequence: TURN is **optional and configured in server settings**
(`calls:turn_url`, `calls:turn_secret`). With no TURN configured, calls are
attempted with STUN only and the UI reports connection failure honestly rather
than hanging. Calls are a feature plugin, so an admin who does not want this
operational burden can leave it uninstalled.

## Verification

- A four-participant call completes six pairwise negotiations; a fifth participant
  is refused server-side.
- Opening a room with a call in progress shows it as live, without the client
  having been connected when it started.
- Killing every participant's browser results in a synthetic `call.ended` within
  the reaper interval, and the room stops reporting a live call.
- `call.offer` payloads are ciphertext when inspected at the bus.
- The transcript shows call start, participants, and duration as ordinary log
  items after the call ends.
- With no TURN configured, a call across a symmetric NAT reports a clear
  connection failure rather than hanging indefinitely.
- Port 8080 and `research/server.py` are no longer required to run calls.
- `call.ice` exceeding its rate limit does not throttle `call.ringing`.

## Risks

- **The four-participant cap will feel arbitrary to users** who expect Zoom-like
  behaviour. It is a real product limitation and should be surfaced in the UI as a
  stated limit, not as a failure.
- **TURN is an operational burden** that turns a single-container deployment into
  two moving parts. Some admins will skip it and their users will experience
  unexplained call failures. Mitigation: the UI must attribute failures to missing
  TURN rather than reporting a generic error.
- **Mobile browser WebRTC behaviour varies**, particularly around backgrounding
  and audio session handling in an installed PWA. Untested here.
- **Raising the cap later is not incremental.** Moving to an SFU with SFrame is a
  substantial project, not a parameter change. The phase boundary is real.
