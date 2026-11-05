import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

export function defaultDatabasePath(): string {
  const dbDir = process.env.DB_DIR?.trim() ||
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../data');
  return path.join(path.resolve(dbDir), 'cp_coach.db');
}

export interface DatabaseBackupResult {
  backupPath: string;
  bytes: number;
  sha256: string;
  integrity: string;
  foreignKeysOk: boolean;
  tableCounts: Record<string, number>;
  createdAt: string;
}

export interface DatabaseRestoreResult {
  restoredPath: string;
  bytes: number;
  integrity: string;
  foreignKeysOk: boolean;
}

export function computeFileSha256(filePath: string): string {
  const hash = createHash('sha256');
  const buffer = fs.readFileSync(filePath);
  hash.update(buffer);
  return hash.digest('hex');
}

export function verifyDatabaseIntegrity(dbPath: string): { integrity: string; foreignKeysOk: boolean } {
  const tempDb = new DatabaseSync(dbPath, { open: true });
  try {
    const integrityRow = tempDb.prepare('PRAGMA integrity_check;').get() as { integrity_check?: string } | undefined;
    const integrity = integrityRow?.integrity_check ?? 'unknown';

    const fkRows = tempDb.prepare('PRAGMA foreign_key_check;').all();
    const foreignKeysOk = fkRows.length === 0;

    return { integrity, foreignKeysOk };
  } finally {
    tempDb.close();
  }
}

export function getTableCounts(tempDb: DatabaseSync): Record<string, number> {
  const tables = tempDb.prepare(`
    SELECT name FROM sqlite_master
    WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
    ORDER BY name
  `).all() as Array<{ name: string }>;

  const counts: Record<string, number> = {};
  for (const { name } of tables) {
    const quoted = `"${name.replace(/"/g, '""')}"`;
    const countRow = tempDb.prepare(`SELECT COUNT(*) AS count FROM ${quoted}`).get() as { count: number } | undefined;
    counts[name] = countRow?.count ?? 0;
  }
  return counts;
}

/**
 * Creates an atomic, point-in-time, verified backup of the database
 * using SQLite's VACUUM INTO statement.
 */
export async function createDatabaseBackup(
  sourceDbPath: string = defaultDatabasePath(),
  backupDir?: string
): Promise<DatabaseBackupResult> {
  if (!fs.existsSync(sourceDbPath)) {
    throw new Error(`Source database does not exist: ${sourceDbPath}`);
  }

  const targetDir = backupDir || path.join(path.dirname(sourceDbPath), 'backups');
  if (!fs.existsSync(targetDir)) {
    fs.mkdirSync(targetDir, { recursive: true });
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupFileName = `cp_coach-backup-${timestamp}.sqlite`;
  const backupPath = path.join(targetDir, backupFileName);

  // Use a temporary file during backup so partial files are never treated as valid backups
  const tempBackupPath = path.join(targetDir, `.tmp-${backupFileName}`);
  if (fs.existsSync(tempBackupPath)) {
    fs.unlinkSync(tempBackupPath);
  }

  const sourceDb = new DatabaseSync(sourceDbPath, { open: true });
  try {
    // Checkpoint WAL first to flush pending transactions into main file
    try {
      sourceDb.exec('PRAGMA wal_checkpoint(TRUNCATE);');
    } catch {}

    // VACUUM INTO creates an exact, atomic, self-contained copy
    const escapedTempPath = tempBackupPath.replace(/'/g, "''");
    sourceDb.exec(`VACUUM INTO '${escapedTempPath}';`);
  } finally {
    sourceDb.close();
  }

  // Rename temp backup to final destination atomically
  fs.renameSync(tempBackupPath, backupPath);

  // Verify backup integrity
  const { integrity, foreignKeysOk } = verifyDatabaseIntegrity(backupPath);
  if (integrity !== 'ok') {
    throw new Error(`Backup integrity check failed: ${integrity}`);
  }

  const backupDb = new DatabaseSync(backupPath, { open: true });
  let tableCounts: Record<string, number> = {};
  try {
    tableCounts = getTableCounts(backupDb);
  } finally {
    backupDb.close();
  }

  const stats = fs.statSync(backupPath);
  const sha256 = computeFileSha256(backupPath);

  return {
    backupPath,
    bytes: stats.size,
    sha256,
    integrity,
    foreignKeysOk,
    tableCounts,
    createdAt: new Date().toISOString(),
  };
}

/**
 * Safely restores a verified backup to a target database file.
 * Creates a pre-restore safety copy of the current target file if it exists.
 */
export async function restoreDatabaseBackup(
  backupPath: string,
  targetDbPath: string = defaultDatabasePath()
): Promise<DatabaseRestoreResult> {
  if (!fs.existsSync(backupPath)) {
    throw new Error(`Backup file does not exist: ${backupPath}`);
  }

  // Verify backup before doing anything
  const { integrity, foreignKeysOk } = verifyDatabaseIntegrity(backupPath);
  if (integrity !== 'ok') {
    throw new Error(`Cannot restore corrupt backup (integrity: ${integrity})`);
  }

  const targetDir = path.dirname(targetDbPath);
  if (!fs.existsSync(targetDir)) {
    fs.mkdirSync(targetDir, { recursive: true });
  }

  // If a target database exists, make a safety backup first
  if (fs.existsSync(targetDbPath)) {
    const safetyCopyPath = path.join(targetDir, `pre-restore-safety-${Date.now()}.sqlite`);
    fs.copyFileSync(targetDbPath, safetyCopyPath);
  }

  // Remove existing WAL and SHM files if any
  const walPath = `${targetDbPath}-wal`;
  const shmPath = `${targetDbPath}-shm`;
  if (fs.existsSync(walPath)) fs.unlinkSync(walPath);
  if (fs.existsSync(shmPath)) fs.unlinkSync(shmPath);

  // Copy backup to target
  fs.copyFileSync(backupPath, targetDbPath);

  // Verify restored database
  const postRestoreCheck = verifyDatabaseIntegrity(targetDbPath);
  const stats = fs.statSync(targetDbPath);

  return {
    restoredPath: targetDbPath,
    bytes: stats.size,
    integrity: postRestoreCheck.integrity,
    foreignKeysOk: postRestoreCheck.foreignKeysOk,
  };
}

