"""Backup creation, retention, scheduling, and system log queries."""
import asyncio
import json
import logging
import os
import sqlite3
import threading
import time
import zipfile
from datetime import datetime, timedelta
from pathlib import Path

from ..config import DB_DIR
from ..database import add_system_log, get_db, get_setting, set_setting

logger = logging.getLogger(__name__)

# Global lock to prevent concurrent backups
_backup_lock = threading.Lock()

# Scheduler task reference
_scheduler_task: asyncio.Task | None = None

DEFAULT_RETENTION_POLICY = {
    "tiers": [
        {"name": "daily", "keep": 7},
        {"name": "weekly", "keep": 4},
        {"name": "monthly", "keep": 3},
    ]
}


# ── Config helpers ──────────────────────────────────────────────────────

def get_backup_config() -> dict:
    """Read backup configuration from settings."""
    return {
        "enabled": get_setting("backup:enabled", "true") == "true",
        "directory": get_setting("backup:directory", str(DB_DIR / "backups")),
        "schedule": get_setting("backup:schedule", "03:00"),
        "retention_policy": json.loads(
            get_setting("backup:retention_policy", json.dumps(DEFAULT_RETENTION_POLICY))
        ),
    }


def update_backup_config(updates: dict) -> dict:
    """Update backup configuration and return new config."""
    if "enabled" in updates and updates["enabled"] is not None:
        set_setting("backup:enabled", "true" if updates["enabled"] else "false")
    if "directory" in updates and updates["directory"] is not None:
        set_setting("backup:directory", updates["directory"])
    if "schedule" in updates and updates["schedule"] is not None:
        set_setting("backup:schedule", updates["schedule"])
    if "retention_policy" in updates and updates["retention_policy"] is not None:
        set_setting("backup:retention_policy", json.dumps(updates["retention_policy"]))
    return get_backup_config()


# ── Backup creation ────────────────────────────────────────────────────

def _checkpoint_all_databases():
    """Flush WAL data into main .db files by checkpointing each database."""
    for db_file in DB_DIR.rglob("*.db"):
        # Skip files inside the backups directory
        try:
            db_file.relative_to(DB_DIR / "backups")
            continue
        except ValueError:
            pass
        try:
            conn = sqlite3.connect(str(db_file), timeout=10)
            conn.execute("PRAGMA wal_checkpoint(TRUNCATE)")
            conn.close()
        except Exception as e:
            logger.warning("Failed to checkpoint %s: %s", db_file, e)


def create_backup(username: str = None) -> dict:
    """Create a backup zip of the data directory.

    Returns dict with filename, size, duration_seconds.
    """
    if not _backup_lock.acquire(blocking=False):
        raise RuntimeError("A backup is already in progress")

    try:
        start = time.monotonic()
        config = get_backup_config()
        backup_dir = Path(config["directory"])
        backup_dir.mkdir(parents=True, exist_ok=True)

        timestamp = datetime.now().strftime("%Y-%m-%d-%H%M%S")
        filename = f"skrib-backup-{timestamp}.zip"
        zip_path = backup_dir / filename

        add_system_log("backup", "Backup started", username=username)

        # Checkpoint all databases to flush WAL
        _checkpoint_all_databases()

        # Create zip archive
        with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as zf:
            for path in DB_DIR.rglob("*"):
                if path.is_dir():
                    continue
                # Skip the backups directory itself
                try:
                    path.relative_to(backup_dir)
                    continue
                except ValueError:
                    pass
                # Skip WAL/SHM files (data is flushed via checkpoint)
                if path.suffix in (".db-wal", ".db-shm"):
                    continue
                arcname = path.relative_to(DB_DIR)
                zf.write(path, arcname)

        duration = time.monotonic() - start
        size = zip_path.stat().st_size

        add_system_log(
            "backup",
            f"Backup completed: {filename} ({size} bytes, {duration:.1f}s)",
            username=username,
        )

        # Run retention cleanup
        _apply_retention_policy(backup_dir, config["retention_policy"])

        return {
            "status": "completed",
            "filename": filename,
            "size": size,
            "duration_seconds": round(duration, 2),
        }
    except Exception as e:
        add_system_log("backup", f"Backup failed: {e}", level="error", username=username)
        raise
    finally:
        _backup_lock.release()


# ── List / delete ──────────────────────────────────────────────────────

def list_backups() -> list[dict]:
    """List all backup files with metadata."""
    config = get_backup_config()
    backup_dir = Path(config["directory"])
    if not backup_dir.exists():
        return []

    backups = []
    for f in sorted(backup_dir.glob("skrib-backup-*.zip"), reverse=True):
        stat = f.stat()
        backups.append({
            "filename": f.name,
            "size": stat.st_size,
            "created_at": datetime.fromtimestamp(stat.st_mtime).isoformat() + "Z",
        })
    return backups


def delete_backup(filename: str) -> bool:
    """Delete a specific backup file. Returns True if deleted."""
    # Path traversal protection
    if os.path.basename(filename) != filename or ".." in filename:
        return False

    config = get_backup_config()
    backup_dir = Path(config["directory"])
    path = backup_dir / filename

    if not path.exists() or not path.is_file():
        return False

    path.unlink()
    add_system_log("backup", f"Backup deleted: {filename}")
    return True


# ── Retention policy ───────────────────────────────────────────────────

def _parse_backup_timestamp(filename: str) -> datetime | None:
    """Extract timestamp from backup filename."""
    # Format: skrib-backup-YYYY-MM-DD-HHmmss.zip
    try:
        ts_str = filename.replace("skrib-backup-", "").replace(".zip", "")
        return datetime.strptime(ts_str, "%Y-%m-%d-%H%M%S")
    except ValueError:
        return None


def _apply_retention_policy(backup_dir: Path, policy: dict):
    """Delete backups that exceed the retention policy."""
    files = sorted(backup_dir.glob("skrib-backup-*.zip"))
    if not files:
        return

    now = datetime.now()
    tiers = policy.get("tiers", DEFAULT_RETENTION_POLICY["tiers"])

    # Parse all backup timestamps
    backups = []
    for f in files:
        ts = _parse_backup_timestamp(f.name)
        if ts:
            backups.append((f, ts))
    backups.sort(key=lambda x: x[1], reverse=True)

    keep = set()

    for tier in tiers:
        name = tier["name"]
        max_keep = tier["keep"]
        kept = 0

        if name == "daily":
            # Keep the most recent backup per day
            seen_days = set()
            for f, ts in backups:
                day = ts.date()
                if day not in seen_days and (now - ts) < timedelta(days=max_keep + 1):
                    keep.add(f)
                    seen_days.add(day)
                    kept += 1
                    if kept >= max_keep:
                        break

        elif name == "weekly":
            # Keep the most recent backup per ISO week
            seen_weeks = set()
            for f, ts in backups:
                week = ts.isocalendar()[:2]  # (year, week)
                if week not in seen_weeks and (now - ts) < timedelta(weeks=max_keep + 1):
                    keep.add(f)
                    seen_weeks.add(week)
                    kept += 1
                    if kept >= max_keep:
                        break

        elif name == "monthly":
            # Keep the most recent backup per month
            seen_months = set()
            for f, ts in backups:
                month = (ts.year, ts.month)
                if month not in seen_months and (now - ts) < timedelta(days=max_keep * 31 + 31):
                    keep.add(f)
                    seen_months.add(month)
                    kept += 1
                    if kept >= max_keep:
                        break

    # Delete backups not in any keep set
    for f, ts in backups:
        if f not in keep:
            f.unlink()
            add_system_log("backup", f"Retention: deleted {f.name}")


# ── System log queries ─────────────────────────────────────────────────

def get_system_logs(category: str = None, level: str = None,
                    page: int = 1, page_size: int = 50) -> dict:
    """Query system log entries with optional filters."""
    with get_db() as conn:
        conditions = []
        params = []

        if category:
            conditions.append("category = ?")
            params.append(category)
        if level:
            conditions.append("level = ?")
            params.append(level)

        where = f"WHERE {' AND '.join(conditions)}" if conditions else ""

        # Count total
        cursor = conn.execute(f"SELECT COUNT(*) as cnt FROM system_log {where}", params)
        total = cursor.fetchone()["cnt"]

        # Fetch page
        offset = (page - 1) * page_size
        cursor = conn.execute(
            f"SELECT * FROM system_log {where} ORDER BY id DESC LIMIT ? OFFSET ?",
            params + [page_size, offset],
        )
        entries = [dict(row) for row in cursor.fetchall()]

        return {
            "entries": entries,
            "total": total,
            "page": page,
            "page_size": page_size,
        }


# ── Scheduler ──────────────────────────────────────────────────────────

async def start_backup_scheduler():
    """Start the background backup scheduler."""
    global _scheduler_task
    config = get_backup_config()
    if not config["enabled"]:
        return
    _scheduler_task = asyncio.create_task(_scheduler_loop())


def stop_backup_scheduler():
    """Cancel the backup scheduler."""
    global _scheduler_task
    if _scheduler_task:
        _scheduler_task.cancel()
        _scheduler_task = None


async def _scheduler_loop():
    """Run backups on schedule."""
    while True:
        try:
            config = get_backup_config()
            if not config["enabled"]:
                await asyncio.sleep(60)
                continue

            # Parse schedule time (HH:MM)
            try:
                hour, minute = map(int, config["schedule"].split(":"))
            except ValueError:
                hour, minute = 3, 0

            now = datetime.now()
            target = now.replace(hour=hour, minute=minute, second=0, microsecond=0)
            if target <= now:
                target += timedelta(days=1)

            wait_seconds = (target - now).total_seconds()
            await asyncio.sleep(wait_seconds)

            # Run backup in thread pool to avoid blocking the event loop
            loop = asyncio.get_event_loop()
            await loop.run_in_executor(None, create_backup, "scheduler")
        except asyncio.CancelledError:
            break
        except Exception as e:
            logger.error("Backup scheduler error: %s", e)
            # Wait a bit before retrying
            await asyncio.sleep(300)
