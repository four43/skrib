# Backups

Periodic backup system that creates compressed archives of all Skrib data (core DB, plugin DBs, and plugin files) to a local directory.

## Overview

Backups are a **core feature** (not a plugin). The system closes all DB file handles, snapshots the entire `data/` directory (minus the backups dir itself) into a timestamped `.zip`, then reopens connections. A configurable retention policy automatically prunes old backups.

## Backup Contents

Each backup zip contains:

- `chat.db` — core database (users, rooms, memberships, keys, settings, etc.)
- `plugins/*.db` — all plugin databases (chat messages, todos, reactions, attachments metadata, web-push subscriptions, etc.)
- `plugins/four43.attachments/` — attachment file blobs
- Any other files in the data directory

WAL/SHM files are excluded — the DB handles are closed cleanly before the snapshot so all data is flushed to the main `.db` files.

## Backup Process

1. Acquire a global backup lock (prevent concurrent backups)
2. Close all database connections (core DB + all plugin DBs)
3. Create a zip archive of the data directory, excluding `backups/`
4. Reopen all database connections
5. Move the completed zip to the backup directory
6. Run retention policy cleanup
7. Log result to system log

The window where DB connections are closed should be brief (seconds). During this window, API requests that need the DB will receive a `503 Service Unavailable`. WebSocket connections stay alive but messages are queued/deferred until connections reopen.

## Storage

- **Default directory**: `data/backups/`
- **Configurable** via admin settings (absolute path or relative to data dir)
- **Filename format**: `skrib-backup-{YYYY-MM-DD-HHmmss}.zip`

## Retention Policy

Backups are retained on a tiered schedule. The default policy:

| Tier    | Frequency | Retention | Example                        |
|---------|-----------|-----------|--------------------------------|
| Daily   | Every day | 7 days    | Keep last 7 daily backups      |
| Weekly  | Weekly    | 4 weeks   | Keep last 4 weekly backups     |
| Monthly | Monthly   | 3 months  | Keep last 3 monthly backups    |

A daily backup is promoted to "weekly" if it's the most recent backup on its Monday (or configurable day-of-week). Similarly, a weekly backup is promoted to "monthly" if it's the most recent in its calendar month.

After each backup, the retention policy runs and deletes backups that don't fit any tier. This means:
- Days 1-7: up to 7 backups
- Weeks 1-4: up to 4 additional backups (the weekly snapshots)
- Months 1-3: up to 3 additional backups (the monthly snapshots)
- Max ~14 backups on disk at any time

The retention tiers are admin-configurable. Admins can define any number of tiers with custom frequency/retention values.

## Schedule

- **Default**: daily at 03:00 server local time
- **Configurable** via admin settings: cron-like expression or simple interval
- Uses `register_interval` / asyncio background task within the FastAPI app lifecycle (no external cron dependency)

## Admin UI

### Server Settings > Backups Tab

- **Backup list**: table of existing backups with filename, size, date, and tier (daily/weekly/monthly)
- **Manual backup button**: triggers an immediate backup outside the schedule
- **Configuration**:
  - Backup directory path
  - Schedule (time of day / interval)
  - Retention policy tiers
- **Download**: ability to download a backup zip from the UI

### System Log

A new system log feature (visible in Server Settings) that records:

- Backup started / completed / failed events with timestamps
- Retention policy cleanup actions (which backups were pruned)
- Manual backup triggers (who initiated)
- Errors with details

The system log is stored in the core database (`system_log` table) and is viewable/filterable in the admin UI. This log infrastructure can be reused by other features in the future.

## Backend Implementation

### New module: `backend/skrib/backups/`

```
backups/
  routes.py      # Admin API endpoints
  schemas.py     # Pydantic models
  services.py    # Backup creation, retention, scheduling logic
```

### API Endpoints

```
GET    /api/admin/backups              # List backups (with size, date, tier)
POST   /api/admin/backups              # Trigger manual backup
GET    /api/admin/backups/{filename}   # Download a backup zip
DELETE /api/admin/backups/{filename}   # Delete a specific backup
GET    /api/admin/backups/config       # Get backup configuration
PATCH  /api/admin/backups/config       # Update backup configuration
```

All endpoints require admin role.

### System Log Endpoints

```
GET    /api/admin/logs                 # List log entries (paginated, filterable)
```

### Settings (stored in `settings` table)

| Key                       | Default              | Description                          |
|---------------------------|----------------------|--------------------------------------|
| `backup:enabled`          | `true`               | Enable/disable automatic backups     |
| `backup:directory`        | `data/backups`       | Backup storage path                  |
| `backup:schedule`         | `03:00`              | Time of day for daily backup         |
| `backup:retention_policy` | (JSON, see default)  | Tiered retention configuration       |

### Database Schema

```sql
CREATE TABLE IF NOT EXISTS system_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    level TEXT NOT NULL DEFAULT 'info',   -- info, warning, error
    category TEXT NOT NULL,               -- 'backup', 'admin', etc.
    message TEXT NOT NULL,
    details TEXT,                          -- JSON blob for structured data
    username TEXT                          -- who triggered it, if applicable
);
```

## Frontend Implementation

- New admin tab component for the backups page
- Backup list with download/delete actions
- Manual backup button with loading state
- Configuration form for schedule and retention
- System log viewer (filterable by category, level, date range)
- URL hash navigation (`#backups`, `#logs`, etc.) — active tab is persisted in the URL hash so refreshing the page returns to the same tab. This applies to both the admin panel and user settings pages.

## Open Questions

- Should we support backup encryption (password-protected zip)? — Deferred for now.
- Should we support remote backup destinations (S3, etc.)? — Out of scope, future feature.
- Should backup/restore be available via CLI as well as the web UI? — Nice to have, defer.
