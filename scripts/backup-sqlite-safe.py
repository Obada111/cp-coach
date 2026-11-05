#!/usr/bin/env python3
"""Create a verified SQLite snapshot using the online backup API."""

from __future__ import annotations

import argparse
from contextlib import closing
import hashlib
import json
import os
import sqlite3
import sys
import tempfile
import uuid
from datetime import datetime, timezone
from pathlib import Path


def application_schema(connection: sqlite3.Connection) -> list[tuple[str, str, str]]:
    return connection.execute(
        """
        SELECT type, name, COALESCE(sql, '')
        FROM sqlite_master
        WHERE name NOT LIKE 'sqlite_%'
        ORDER BY type, name
        """
    ).fetchall()


def table_counts(connection: sqlite3.Connection) -> dict[str, int]:
    tables = connection.execute(
        """
        SELECT name
        FROM sqlite_master
        WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
        ORDER BY name
        """
    ).fetchall()
    result: dict[str, int] = {}
    for (name,) in tables:
        quoted_name = '"' + name.replace('"', '""') + '"'
        result[name] = connection.execute(
            f"SELECT COUNT(*) FROM {quoted_name}"
        ).fetchone()[0]
    return result


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as file:
        for chunk in iter(lambda: file.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def create_backup(source_path: Path, backup_dir: Path) -> Path:
    source_path = source_path.expanduser().resolve(strict=True)
    if not source_path.is_file():
        raise ValueError(f"Source is not a regular file: {source_path}")

    backup_dir = backup_dir.expanduser().resolve()
    backup_dir.mkdir(parents=True, exist_ok=True)
    if not backup_dir.is_dir():
        raise ValueError(f"Backup destination is not a directory: {backup_dir}")

    timestamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    destination = backup_dir / f"{source_path.stem}-{timestamp}-{uuid.uuid4().hex[:8]}.sqlite"
    temporary_path: Path | None = None

    try:
        with tempfile.NamedTemporaryFile(
            prefix=".sqlite-backup-", suffix=".tmp", dir=backup_dir, delete=False
        ) as temporary:
            temporary_path = Path(temporary.name)

        source_uri = source_path.as_uri() + "?mode=ro"
        with closing(sqlite3.connect(source_uri, uri=True, timeout=30)) as source:
            source.execute("PRAGMA query_only = ON")
            with closing(sqlite3.connect(temporary_path, timeout=30)) as target:
                source.backup(target, pages=256, sleep=0.05)

        with closing(sqlite3.connect(temporary_path)) as verified:
            integrity = verified.execute("PRAGMA integrity_check").fetchone()[0]
            if integrity != "ok":
                raise RuntimeError(f"Backup integrity check failed: {integrity}")
            if verified.execute("PRAGMA foreign_key_check").fetchone() is not None:
                raise RuntimeError("Backup contains foreign-key violations")

        if temporary_path.stat().st_size == 0:
            raise RuntimeError("Backup file is empty")
        if destination.exists():
            raise FileExistsError(f"Refusing to overwrite existing backup: {destination}")

        # A hard link is an atomic create-if-absent operation on the same
        # filesystem, so a concurrent process cannot make this replace a file.
        os.link(temporary_path, destination)
        temporary_path.unlink()
        temporary_path = None
        return destination
    finally:
        if temporary_path is not None:
            try:
                temporary_path.unlink()
            except FileNotFoundError:
                pass


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", required=True, type=Path, help="SQLite database file")
    parser.add_argument("--backup-dir", required=True, type=Path, help="Destination directory")
    args = parser.parse_args()

    try:
        backup_path = create_backup(args.source, args.backup_dir)
        with closing(sqlite3.connect(backup_path)) as backup:
            schema = application_schema(backup)
            report = {
                "backup": str(backup_path),
                "bytes": backup_path.stat().st_size,
                "sha256": sha256_file(backup_path),
                "integrity": backup.execute("PRAGMA integrity_check").fetchone()[0],
                "schema_sha256": hashlib.sha256(
                    json.dumps(schema, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
                ).hexdigest(),
                "schema_objects": len(schema),
                "tables": table_counts(backup),
            }
        print(json.dumps(report, indent=2, sort_keys=True))
        return 0
    except (OSError, sqlite3.Error, RuntimeError, ValueError) as error:
        print(f"SQLite backup failed: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
