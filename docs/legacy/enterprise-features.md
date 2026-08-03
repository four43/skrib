# Enterprise Features

> **Superseded — retained for history.** Written 2026-04-02.
>
> Superseded and retired by `docs/spec/2026-08-02-roadmap-phases.md` §2.
>
> Four features listed here are **permanently cut**, because they require the server
> to read message plaintext and E2E encryption is an inviolable pillar: DLP content
> scanning (Tier 1), eDiscovery *production* of message content (Tier 1),
> compliance archiving / journaling (Tier 3), and information barriers as enforced
> at search (Tier 3). Only legal hold acknowledged that tension when this was
> written.
>
> Its priority table is also inverted for Skrīb's actual users: it scheduled SSO and
> audit logging at Phase 1 and threads and search at Phase 3, which is procurement
> order rather than user order.

---

What enterprises expect from a team messaging platform, and where Skrib stands today.

## Already Covered

These enterprise needs are addressed by current functionality:

| Need | Skrib Today |
|---|---|
| Strong auth (no passwords) | WebAuthn/Passkeys with biometric verification |
| E2E encryption | Zero-knowledge AES-GCM + RSA-OAEP, per-room key rotation |
| Role-based access | Admin, Moderator, User roles with scoped permissions |
| User provisioning control | Registration modes: open, approval, invite-only, closed |
| Private/public rooms | Visibility controls with request-to-join flow |
| Extensibility | Plugin system for room types (chat, todo) and features |
| Real-time collaboration | Unified WebSocket bus, typing indicators, reactions |
| Push notifications | Web Push plugin |

---

## Tier 1 -- Table Stakes

Features enterprises consider mandatory. Without these, Skrib won't pass procurement.

### SSO / SAML / OIDC Integration

Enterprises require single sign-on through their identity provider (Okta, Entra ID, Google Workspace). WebAuthn is great as a second factor, but IT needs centralized identity lifecycle management -- when an employee is deprovisioned in the IdP, their Skrib access must terminate immediately.

- SAML 2.0 SP implementation
- OIDC relying party with PKCE
- Just-in-time (JIT) user provisioning from IdP attributes
- Forced logout / session revocation on IdP-side deprovisioning (SCIM or webhook)

### SCIM User & Group Provisioning

Manually managing users doesn't scale. Enterprises expect automated provisioning:

- SCIM 2.0 endpoint for user create/update/deactivate
- Group sync to Skrib roles or room memberships
- Directory-driven room auto-join (e.g., "Engineering" group -> #engineering room)

### Audit Logging

Compliance teams and security operations need a tamper-evident record of all sensitive actions:

- Authentication events (login, logout, failed attempts, credential changes)
- Room lifecycle (create, delete, membership changes, visibility changes)
- Admin actions (role changes, user approval/rejection, settings changes)
- Message lifecycle (send, edit, delete -- metadata only if E2E encrypted)
- Export to SIEM (structured JSON, syslog, or webhook-based forwarding)
- Configurable retention period

### Data Retention & Legal Hold

Regulated industries (finance, healthcare, government) must retain and produce messages:

- Configurable retention policies per room or org-wide (e.g., 90 days, 1 year, indefinite)
- Automatic purge after retention period expires
- Legal hold: freeze specific rooms/users so messages are preserved regardless of retention policy
- eDiscovery export (structured archive with metadata, timestamps, user attribution)
- Tension with E2E encryption -- requires a compliance key escrow or organizational key recovery mechanism

### Data Loss Prevention (DLP)

Prevent sensitive information from leaving the organization:

- Content scanning rules (regex, keyword, ML-based classification)
- Block or flag messages containing PII, credentials, financial data
- File upload scanning before delivery
- Admin-configurable policies per room or globally

---

## Tier 2 -- Competitive Expectations

Features that enterprises compare across vendors. Missing these loses deals.

### File Sharing & Management

- File attachments with preview (images, PDFs, code)
- File size limits configurable by admin
- Virus/malware scanning on upload
- Storage quotas per user or org
- File search across rooms

### Message Threading

- Reply threads that don't clutter the main timeline
- Thread-level notifications (follow/unfollow)
- Thread summary in main channel

### Search

- Full-text search across all rooms the user has access to
- Filters: sender, date range, room, file type
- Search within E2E encrypted rooms (client-side index or searchable encryption)

### Guest Access

- Invite external users (vendors, clients) with limited scope
- Guest users restricted to specific rooms
- Automatic expiration of guest accounts
- Separate guest branding / notice

### User Presence & Status

- Online / away / DND / offline indicators
- Custom status messages with optional expiry
- Timezone display
- Calendar integration for automatic status (in a meeting, OOO)

### Admin Analytics & Reporting

- Active users (DAU/MAU), messages sent, rooms created
- Adoption metrics per team/department
- Storage usage breakdown
- Export to CSV or dashboard integration

---

## Tier 3 -- Differentiation

Features that create competitive advantage and drive stickiness.

### Federation / Multi-Server

Skrib's architecture (server name, server icon) hints at this already:

- Server-to-server messaging protocol
- Shared rooms across Skrib instances
- Cross-org identity verification
- Admin controls for which servers can federate

### Compliance Archiving Integrations

- Direct integrations with compliance archivers (Global Relay, Smarsh, Veritas)
- Real-time message journaling
- Archive search from within Skrib

### Workflow Automation / Bots

- Bot accounts with API tokens (no WebAuthn needed)
- Incoming/outgoing webhooks
- Slash commands that trigger external services
- Plugin marketplace or registry for enterprise integrations (Jira, PagerDuty, GitHub)

### Mobile & Desktop Apps

- Native iOS / Android apps with push notifications
- Desktop app (Electron or Tauri) with OS-level notifications
- Consistent E2E encryption key sync across devices

### Advanced Room Management

- Room templates (pre-configured settings, default members, pinned messages)
- Archival (read-only, searchable, but no new messages)
- Room categories / namespaces beyond folders
- Cross-room announcements (broadcast to multiple rooms)

### High Availability & Scalability

- Horizontal scaling of WebSocket connections (sticky sessions or shared state)
- Database migration path from SQLite to PostgreSQL/CockroachDB
- Redis or equivalent for pub/sub across instances
- Health checks, graceful shutdown, zero-downtime deploys
- SLA guarantees (99.9%+ uptime)

### Information Barriers

Required in financial services:

- Ethical walls between teams (e.g., trading desk cannot message advisory)
- Admin-defined barrier policies
- Enforced at room join, DM creation, and search

---

## Suggested Priority Order

| Phase | Focus | Key Items |
|---|---|---|
| **1** | Security & compliance | SSO/OIDC, audit logging, data retention |
| **2** | Scale & administration | SCIM provisioning, admin analytics, DLP |
| **3** | User experience | Threads, search, file management, guest access |
| **4** | Platform growth | Federation, bots/webhooks, mobile apps, HA |
