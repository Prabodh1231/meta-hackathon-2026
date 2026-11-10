"""Rolling copies of the library, so a damaged or wrongly changed library.db can be put back.

At most one copy a day is made when the app starts, into `<data dir>/backups/`, and the newest
KEEP are kept. SQLite's own backup copies a consistent snapshot while the app goes on using the
library. To restore: close the app and put a copy in place of library.db (deleting
library.db-wal and library.db-shm beside it).
"""

import logging
import sqlite3
import threading
import time
from datetime import datetime
from pathlib import Path

log = logging.getLogger(__name__)

KEEP = 3
MIN_AGE = 20 * 3600  # seconds between copies: one a day, however often the app is started
FOLDER = "backups"


def backup_library(db_path: Path, keep: int = KEEP, min_age: float = MIN_AGE) -> Path | None:
    """Copy the library if the newest copy is older than `min_age`. Returns the new copy, or
    None when none was due or there is no library yet."""
    if not db_path.is_file():
        return None
    folder = db_path.parent / FOLDER
    folder.mkdir(parents=True, exist_ok=True)
    for stale in folder.glob("*.partial"):  # a copy the app was closed in the middle of
        stale.unlink(missing_ok=True)
    copies = sorted(folder.glob("library-*.db"))
    if copies and time.time() - copies[-1].stat().st_mtime < min_age:
        return None
    target = folder / f"library-{datetime.now():%Y%m%d-%H%M%S}.db"
    partial = target.with_suffix(".partial")
    source = sqlite3.connect(f"file:{db_path.as_posix()}?mode=ro", uri=True)
    try:
        dest = sqlite3.connect(partial)
        try:
            source.backup(dest)
        finally:
            dest.close()
    finally:
        source.close()
    partial.replace(target)  # only a finished copy gets the name that counts
    for old in sorted(folder.glob("library-*.db"))[:-keep]:
        old.unlink(missing_ok=True)
    return target


def backup_in_background(db_path: Path) -> threading.Thread:
    """Start the copy without holding up the app's start. A failure is logged, never raised."""

    def run() -> None:
        try:
            made = backup_library(db_path)
            if made:
                log.info("Library backed up to %s", made)
        except Exception:
            log.exception("Could not back up the library")

    thread = threading.Thread(target=run, name="library-backup", daemon=True)
    thread.start()
    return thread
