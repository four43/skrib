# Plan 01: Consolidate User Tables (4 → 1)

## Goal

Merge `users`, `pending_users`, `user_preferences`, and `user_encryption_keys` into a single `users` table with a `status` field. Eliminates the copy-between-tables approval dance and removes 3 redundant tables.

## New Schema

```sql
CREATE TABLE IF NOT EXISTS users (
    username TEXT PRIMARY KEY,
    credential_id TEXT NOT NULL,
    public_key TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',      -- 'pending', 'active', 'suspended'
    role TEXT NOT NULL DEFAULT 'user',
    approval_code TEXT,
    encryption_public_key TEXT,
    color TEXT NOT NULL DEFAULT '#1976d2',
    nickname TEXT,
    theme_color TEXT,
    created_at TEXT NOT NULL,
    approved_at TEXT,
    approved_by TEXT
);
```

**Dropped tables:** `pending_users`, `user_preferences`, `user_encryption_keys`

## Migration Strategy

Since this is SQLite and the app is pre-production, we'll do an in-place migration in `init_db()`:

1. Check if old tables exist (`pending_users`, `user_preferences`, `user_encryption_keys`)
2. If they do, create the new `users` table schema (add missing columns via `ALTER TABLE`)
3. Migrate data from old tables into the new columns
4. Drop old tables
5. If they don't exist, just create the new schema directly

Concrete steps in `database.py`:

- Add columns to `users`: `status`, `approval_code`, `encryption_public_key`, `color`, `nickname`, `theme_color`, `created_at`
- Backfill `status='active'` for all existing `users` rows
- Backfill `created_at` from `approved_at` for existing users (or use current timestamp)
- Copy `pending_users` rows into `users` with `status='pending'`
- Copy `user_preferences` columns into `users` (JOIN on username)
- Copy `user_encryption_keys.public_key` → `users.encryption_public_key`
- Drop `pending_users`, `user_preferences`, `user_encryption_keys`

## Files to Change

### `backend/mini_chat/database.py`

- Rewrite `init_db()` to use new single-table schema
- Add migration logic for existing databases
- Remove old table CREATE statements

### `backend/mini_chat/auth/services.py`

- `create_pending_user()`: INSERT into `users` with `status='pending'` instead of `pending_users`
  - Auto-approve cases: INSERT with `status='active'`
  - Pending cases: INSERT with `status='pending'`, set `approval_code`
- `get_user_by_credential()`: Add `AND status = 'active'` (replaces `AND approved = 1`)
- `get_user_from_session()`: Same — filter on `status = 'active'`
- `get_user_credentials()`: Same — filter on `status = 'active'`

### `backend/mini_chat/auth/routes.py`

- `store_encryption_key()`: UPDATE `users SET encryption_public_key = ?` instead of INSERT into `user_encryption_keys`
- `get_encryption_key()`: SELECT from `users` instead of `user_encryption_keys`

### `backend/mini_chat/auth/schemas.py`

- No changes needed (schemas don't reference table names)

### `backend/mini_chat/users/services.py`

- `get_pending_users()`: Query `users WHERE status = 'pending'` instead of `pending_users`
- `approve_user()`: UPDATE `users SET status = 'active'` instead of copy between tables
- `reject_user()`: DELETE from `users WHERE status = 'pending' AND approval_code = ?`
- `get_all_users()`: Filter on `status = 'active'` instead of the implicit "in users table"
- `get_user_preferences()`: SELECT from `users` (columns are now inline)
- `create_default_preferences()`: Remove entirely — defaults come from column defaults
- `update_user_preferences()`: UPDATE `users SET color=?, nickname=?, theme_color=?`
- `get_all_user_preferences()`: SELECT from `users` directly
- `revoke_user_access()`: DELETE from `users` (unchanged behavior) or UPDATE `status='suspended'`

### `backend/mini_chat/users/routes.py`

- Remove import of `create_default_preferences`
- `get_user_preferences_endpoint()`: Simplify (no more create-if-missing dance)
- `get_all_user_colors()`: Query `users` directly

### `backend/mini_chat/users/schemas.py`

- `UserInfo`: Replace `approved: bool` with `status: str`
- Remove `approved` field, add `status` field

### `backend/mini_chat/dependencies.py`

- Any queries filtering on `approved = 1` change to `status = 'active'`

### Frontend: `frontend/src/chat.js`

- No changes — frontend doesn't know about table structure, only API responses
- The `/users/preferences/colors` endpoint response shape stays the same

## Testing Checklist

- [ ] Fresh database: tables created correctly with new schema
- [ ] Existing database: migration runs, data preserved
- [ ] Registration flow: pending user created in `users` with `status='pending'`
- [ ] First user auto-approved: `status='active'`, `role='admin'`
- [ ] Open/invite registration: `status='active'` immediately
- [ ] Approval flow: `status` changes from `pending` to `active`
- [ ] Rejection flow: row deleted from `users`
- [ ] Login: only `status='active'` users can log in
- [ ] Preferences: color/nickname/theme_color read/write from `users` table
- [ ] Encryption keys: stored/retrieved from `users.encryption_public_key`
- [ ] User list: only shows `status='active'` users
- [ ] Admin delete: works, still prevents deleting last admin
