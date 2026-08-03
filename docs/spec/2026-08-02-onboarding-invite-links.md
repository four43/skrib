# Onboarding: invite links, deferred recovery, and PWA install

**Date:** 2026-08-02
**Status:** Approved design, ready for implementation planning

## Problem

Skrīb was deployed for real users. **They could not get through sign-up.** That is
the only piece of verified user feedback the project has, and it has not been
acted on.

Here is what those users walked into, per `docs/auth.md:9-40`:

1. **Pick a username** — `^[a-zA-Z0-9_]{4,15}$` (`auth.md:257`). "Bob" is rejected
   as too short. "seth.miller" is rejected for the period.
2. **Invent a passphrase.** This is the E2E recovery secret. The user must both
   create it and durably save it, before seeing a single message.
3. Form POST redirects to `enroll-passkey.html` carrying a registration token with
   a **5-minute TTL** (`auth.md:137`).
4. **Click "Enroll Passkey"** → the OS passkey dialog. This is the most confusing
   dialog in modern web auth ("save to iCloud Keychain? this device? a security
   key?"), and it is exactly where users hesitate — against that 5-minute timer.
5. Keypair generated, private key wrapped with the passphrase.
6. **The wall.** `backend/skrib/database.py:282` seeds the default registration
   mode as `approval_required`, so the user lands on "you are pending, here is an
   approval code, wait for an admin."

So: two secrets to invent, one OS dialog, a five-minute timer, and a dead end at
the very end. Only `invite_only` auto-approves (`auth.md:108`).

A secondary documentation defect: `auth.md:102` states the default mode is
`closed`, while the code seeds `approval_required`. Both are wrong for the
intended experience.

## Goals

- Fastest possible time to first message.
- Zero invented secrets. The user never composes a passphrase.
- Recovery is prompted **after** the user has a feel for the app, not before.
- Preserve moderation — the admin still controls who gets in.
- Preserve the E2E pillar without exception.

## Non-goals

- Anonymous or ephemeral chat. Accounts are durable and have history.
- SSO/OIDC. It conflicts with WebAuthn-only auth and is a separate spec.
- Email. Skrīb has no email addresses anywhere, and this spec does not add any.

## Key facts that shape the design

- **`invite_tokens` already exists** (`docs/architecture.md:94`), single-use,
  admin-created, marked with `used_by`/`used_at`.
- **The private key already lives in IndexedDB** as a `CryptoKey`
  (`docs/end-to-end-encryption.md:20`), and a passphrase-wrapped copy is already
  stored server-side as `passphrase_encrypted_private_key`
  (`end-to-end-encryption.md:129`). Both mechanisms this spec needs exist.
- **A background scheduler pattern exists** at
  `backend/skrib/backups/services.py:301`, for the expiry sweep.
- **Server settings are key-value** with a `get_setting`/`set_setting` helper and
  a `backup:schedule` precedent, so `invite:ttl_days` is a few lines.
- **`S5` is an open finding** (`auth.md:291`): "Skip recovery silently replaces
  encryption identity." A user who clicks Skip today silently loses all history.
- **`S6` is an open finding** (`auth.md:297`): the PRF salt is static rather than
  per-user. Must be fixed before PRF is promoted to the primary key path.

### PRF support is materially better than previously assessed

Earlier design assumed most mobile platforms lacked WebAuthn PRF. As of 2026 that
is no longer true:

| Platform | PRF status |
| --- | --- |
| Android + Google Password Manager | **Supported by default**, all passkeys, across Chrome/Edge/Samsung Internet |
| iOS/iPadOS 18.4+ | Supported via iCloud Keychain (18.0–18.3 caused data loss as cross-device source) |
| macOS 15+ | Safari 18+, Chrome 132+, Firefox 139+ |
| Windows 11 25H2 | Requires the Feb 2026 update, plus Chrome/Edge 147+ or Firefox 148+ |
| 1Password, Dashlane | Supported. Bitwarden announced. |

Remaining gaps, which are why PRF cannot be the *only* path:

- **Android Firefox: no PRF at all.**
- **Windows 10: none. Un-updated Windows 11: none.**
- **Chrome Profile as authenticator: explicitly no PRF** — a common desktop
  default when passkeys are not routed to the OS.
- iOS with an external security key: no PRF (irrelevant here).

Vendor guidance is explicitly to treat PRF "as an enhancement rather than a core
dependency." Also note: **if a PRF-wrapped key's passkey is lost, the data is
permanently inaccessible** — so even PRF users need a second wrapper, or `S5`
becomes the happy path.

Sources: [Corbado](https://www.corbado.com/blog/passkeys-prf-webauthn),
[Yubico](https://developers.yubico.com/WebAuthn/Concepts/PRF_Extension/Developers_Guide_to_PRF.html),
[Chromium Intent to Ship](https://groups.google.com/a/chromium.org/g/blink-dev/c/iTNOgLwD2bI),
[Apple Developer Forums](https://developer.apple.com/forums/thread/774112).

## Design

### 1. The invariant that constrains everything

**E2E with recoverable history cannot have zero-ceremony onboarding.** The private
key must be wrapped by something only the user holds, so at least one user-held
secret must exist. Link-and-chat products skip this because they have no durable
cross-device identity and nothing to protect; Skrīb has both.

The secret can be **moved, generated, deferred, or absorbed into the passkey**. It
cannot be deleted. This design does all four and deletes none.

### 2. Registration mode default becomes `invite_only`

`invite_only` is the only mode that both auto-approves *and* moderates. It
front-loads the gate: the admin decides who gets a link, before the user invests
any effort. `approval_required` back-loads it, which is what produced the observed
bounce. `open` removes friction but removes moderation entirely.

- `database.py` seeds `invite_only`.
- `auth.md:102` is corrected.

### 3. The invite link

An admin issues a **unique link per user**. The link carries a high-entropy
generated secret `S` **in the URL fragment**.

#### 3.1 The fragment is load-bearing

`S` goes after `#`, never in the query string. Fragments are never transmitted to
the server and never appear in `Referer` headers. So the server stores a wrapped
private key it genuinely cannot unwrap, and the zero-knowledge property survives
intact. This is the same pattern as Bitwarden Send and 1Password share links.

Note also that **a generated 256-bit link secret is cryptographically far stronger
than a human-invented passphrase.** On entropy alone this is an upgrade over what
ships today, not a compromise.

#### 3.2 First redemption

1. User opens the link, picks a username.
2. Client derives a wrapping key from `S`.
3. Client generates the E2E keypair, stores the private key in IndexedDB.
4. Client wraps the private key under the `S`-derived key and uploads the blob.
5. User is in a room, typing. **No passphrase, no passkey yet.**

#### 3.3 The link stays valid until enrollment completes

The link is **multi-use** until the user creates full credentials, or until the
TTL expires.

This is deliberate and it buys something real: the user opens the same link on
their phone *and* their laptop, both derive the same key from `S`, both unwrap the
same private key. **Multi-device works before enrollment**, which a single-use
link cannot offer.

It also carries a real cost, stated plainly. Under single-use, an intercepted link
produces a **race** — whoever redeems first wins, the legitimate user is locked
out, and they complain. Loud. Under multi-use, an interceptor redeems alongside
the real user, derives the same key, and **retrospectively decrypts everything
that user has received**, with nobody locked out and nobody notified. Silent.

§3.5 is the mitigation that makes this acceptable.

#### 3.4 TTL and expiry

- `invite:ttl_days`, configurable in server settings, **default 30**.
- On expiry the user is **de-credentialed, not deleted.**

De-credentialed means: mark the user `expired`, revoke sessions, delete the
`S`-wrapped key blob server-side. **Touch nothing else** — messages stay,
attribution stays, the username stays reserved, no key rotation is triggered. An
admin re-issues a link that re-attaches to the same username and the user resumes.

Deletion is rejected because it is destructive in ways invisible to whoever
triggered it. A reaped user who chatted for six days in a shared room takes half a
thread with them, destroying *other people's* context. Their `room_keys` rows
raise the membership-change rekey question for no reason. And since `username` is
the primary key on `users` (`architecture.md:86`), releasing it lets a future user
claim a name that already appears in old messages.

Non-destructive expiry is also what makes a long TTL safe: reaping is reversible,
so 30 days costs nothing worse than a "send me another link" message.

The sweep uses the `backups/services.py:301` scheduler pattern.

#### 3.5 Redemption notification restores loud failure

**Every redemption of a live link notifies the account owner** — "your invite link
was just used on a new device" — with a **revoke action**: invalidate the link,
rotate the key, force re-enrollment. Notification without remediation is only
anxiety.

This converts the silent-compromise problem of §3.3 back into something the victim
observes, which is what makes a 30-day window defensible where a 30-day *silent*
window would not be.

**Channel limits, stated honestly:** Skrīb has no email addresses, so there is no
out-of-band channel. Web Push needs permission a brand-new user has almost
certainly not granted, and an in-app banner is equally visible to an attacker's
session. Realistic reach is an in-app banner on the legitimate user's next visit,
plus push where granted. Louder than silent; quieter than a typical
new-device-signin flow.

### 4. Credentials: absorb, then generate. Never invent.

Ordered by preference:

1. **Absorb into the passkey (PRF).** Where PRF is available — which per the table
   above is now most platform passkeys — the passkey unwraps the private key and
   **no separate secret exists at all.** Requires fixing `S6` (static PRF salt)
   first.
2. **Generate a phrase.** Where PRF is unavailable, issue a 6-word phrase with
   copy and download affordances, prefilled so the browser's credential manager
   saves it. The user never composes one.
3. **Never ask the user to invent a passphrase.** This step is deleted from
   registration outright.

`S5` must be fixed alongside this: "Skip" must not silently replace the encryption
identity. It either warns explicitly that all history will be lost, or it is
removed.

### 5. The second-session prompt

Recovery setup is prompted on the user's **second session** — they closed the tab
and came back.

Second session over alternatives because it is a genuine signal of intent to stay,
because it is the moment the link-wrapped key actually gets exercised, and because
it is self-limiting in the right direction: a user who never returns is never
nagged and never needed to be. Volume-based triggers fail the opposite way — a
lurker who reads for a week and posts nothing is the user most likely to lose
history, and would never trip a message counter.

The prompt offers two things, **install first**:

#### 5.1 Install as a PWA — the cheapest recovery measure

Installing is itself a durability measure, because it requires no secret at all:

- IndexedDB in a plain browser tab is destroyed by "clear browsing data," and
  Safari evicts script-writable storage for sites without recent user interaction.
  So an iOS user who chats once and returns three weeks later may already have
  lost their local key — independent of any TTL. *(Verify the current eviction
  window before relying on specifics; the behaviour itself is well established.)*
- Call `navigator.storage.persist()` on install.
  `docs/progressive-web-app.md` does not mention storage durability at all today;
  that gap needs closing.

**And on iOS, Web Push only works for installed PWAs.** That makes installation a
*feature* pitch rather than a warning: install this and notifications will tell
you what was actually said, instead of "New message." See
`2026-08-02-core-log-and-signal.md` §4.3 for the service-worker decryption path
that makes that true.

The prompt therefore leads with "install this app" — one tap, no secret — and
offers recovery setup second.

#### 5.2 Platform-specific install instructions

Install is not a uniform gesture: iOS Safari is Share → Add to Home Screen,
Android Chrome offers a prompt, desktop Chrome uses an omnibox icon. The prompt
detects platform and shows the right instructions.

### 6. Visible countdown

A silent deadline is just a delayed version of the wall that already lost users.
While a user has no full credentials, the app shows an unavoidable, dismissible-
but-recurring indicator: "Finish setup — this account expires in N days." It must
not live only in settings, because these users have never opened settings.

### 7. Username rules relax

`^[a-zA-Z0-9_]{4,15}$` rejects "Bob" and "seth.miller". Widen to allow 2-character
names and periods/hyphens, keeping the reserved-word check (`admin`, `skrib`,
`system`). Usernames remain the primary key, so uniqueness and
normalization-for-comparison still apply.

### 8. Registration token TTL

The 5-minute TTL sits precisely where users hesitate most — mid OS passkey dialog.
Raise it substantially (30 minutes) or make the passkey step resumable. A user who
hesitates at a system dialog should not have to restart registration.

## Verification

- A fresh server defaults to `invite_only`.
- Opening an invite link and picking a username lands the user in a room able to
  send a message, with **no passphrase prompt and no approval screen**.
- Time from link-click to first sent message is under 30 seconds.
- The invite secret never appears in any server log, request line, or
  `Referer` header — verified by inspecting backend logs and DevTools during
  redemption.
- Opening the same live link on a second browser profile yields access to the same
  decrypted history, and fires a redemption notification with a working revoke
  action.
- After enrollment, redeeming the old link fails, and the `S`-wrapped blob is gone
  from the database.
- With `invite:ttl_days` set to 0, the sweep marks the user `expired`, revokes
  sessions, and deletes the wrapped blob — while their messages remain visible to
  other room members with attribution intact, and no room key is rotated.
- An admin-issued replacement link re-attaches to the same username, and the user
  regains access.
- On a PRF-capable platform, enrollment completes with no phrase shown at all. On
  a non-PRF platform, a generated phrase is shown and no field ever asks the user
  to compose one.
- The second session surfaces the install-first prompt with platform-correct
  instructions.
- `navigator.storage.persist()` returns true after install.

## Risks

- **The link is a bearer credential in transit,** riding SMS/WhatsApp/email, all
  of which are logged and backed up. TTL bounds the server-side window; it cannot
  delete the copy from a recipient's message history. Mitigated by §3.5, not
  eliminated.
- **A user who ignores every prompt for 30 days gets de-credentialed.** Reversible
  by design, but it will happen and needs a clear recovery message rather than a
  generic auth error.
- **PRF as primary path depends on fixing `S6` first.** A static salt shared
  across users undermines the derivation.
- **Notification reach is weak** for exactly the users who most need it — new ones
  who have not granted push. Accepted; documented rather than hidden.
- **`docs/auth.md` needs revision throughout**, not patching. The two-page
  registration rationale ("so the browser's credential manager detects the
  passphrase field", `auth.md:38`) is obsoleted entirely by deleting the invented
  passphrase.
