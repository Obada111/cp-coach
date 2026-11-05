import fs from 'node:fs';
import path from 'node:path';
import { db, DB_PATH, isEphemeralStoragePath } from './db.js';
import {
  createDatabaseBackup,
  verifyDatabaseIntegrity,
  type DatabaseBackupResult,
} from './databaseBackup.js';
import { isTestEnvironment } from './authMiddleware.js';

export interface DatabaseMaintenanceStatus {
  durableStorage: boolean;
  integrity: 'ok' | 'failed' | 'unknown';
  foreignKeysOk: boolean;
  backupDir: string;
  backupRetention: number;
  backupIntervalHours: number;
  backupCount: number;
  latestBackupAt: string | null;
  latestBackupPath: string | null;
  latestBackupSha256: string | null;
  lastBackupAt: string | null;
  lastBackupSha256: string | null;
  lastError: string | null;
  checkedAt: string | null;
}

const BACKUP_FILE_PATTERN = /^cp_coach-backup-.*\.sqlite$/;
const BACKUP_MANIFEST_SUFFIX = '.json';
const DEFAULT_RETENTION = 14;
const DEFAULT_INTERVAL_HOURS = 24;

let scheduler: ReturnType<typeof setInterval> | null = null;
let maintenanceInFlight: Promise<DatabaseMaintenanceStatus> | null = null;
function hasDurableStorage(): boolean {
  return !isEphemeralStoragePath(path.dirname(DB_PATH)) &&
    !isEphemeralStoragePath(backupDirectory());
}

let status: DatabaseMaintenanceStatus = {
  durableStorage: hasDurableStorage(),
  integrity: 'unknown',
  foreignKeysOk: false,
  backupDir: backupDirectory(),
  backupRetention: configuredRetention(),
  backupIntervalHours: configuredIntervalHours(),
  backupCount: 0,
  latestBackupAt: null,
  latestBackupPath: null,
  latestBackupSha256: null,
  lastBackupAt: null,
  lastBackupSha256: null,
  lastError: null,
  checkedAt: null,
};

function backupDirectory(): string {
  const configured = process.env.DB_BACKUP_DIR?.trim();
  return configured
    ? path.resolve(configured)
    : path.join(path.dirname(DB_PATH), 'backups');
}

function configuredRetention(): number {
  const parsed = Number(process.env.DB_BACKUP_RETENTION || DEFAULT_RETENTION);
  if (!Number.isFinite(parsed)) return DEFAULT_RETENTION;
  return Math.max(2, Math.min(90, Math.floor(parsed)));
}

function configuredIntervalHours(): number {
  const parsed = Number(process.env.DB_BACKUP_INTERVAL_HOURS || DEFAULT_INTERVAL_HOURS);
  if (!Number.isFinite(parsed)) return DEFAULT_INTERVAL_HOURS;
  return Math.max(1, Math.min(24 * 30, parsed));
}

function maintenanceDisabled(): boolean {
  return process.env.DATABASE_MAINTENANCE_DISABLED === 'true' ||
    (isTestEnvironment() && process.env.RUN_DB_MAINTENANCE_IN_TESTS !== 'true');
}

function listBackupFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((name) => BACKUP_FILE_PATTERN.test(name))
    .sort((a, b) => b.localeCompare(a));
}

function latestBackup(): { path: string; manifest: Record<string, unknown> | null } | null {
  const dir = backupDirectory();
  const files = listBackupFiles(dir);
  if (files.length === 0) return null;
  const filePath = path.join(dir, files[0]);
  let manifest: Record<string, unknown> | null = null;
  try {
    const raw = fs.readFileSync(`${filePath}${BACKUP_MANIFEST_SUFFIX}`, 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      manifest = parsed as Record<string, unknown>;
    }
  } catch {
    manifest = null;
  }
  return { path: filePath, manifest };
}

function refreshStatus(): DatabaseMaintenanceStatus {
  const dir = backupDirectory();
  const files = listBackupFiles(dir);
  const latest = latestBackup();
  return {
    ...status,
    durableStorage: hasDurableStorage(),
    backupDir: dir,
    backupRetention: configuredRetention(),
    backupIntervalHours: configuredIntervalHours(),
    backupCount: files.length,
    latestBackupAt: latest
      ? (typeof latest.manifest?.createdAt === 'string'
        ? latest.manifest.createdAt
        : fs.statSync(latest.path).mtime.toISOString())
      : null,
    latestBackupPath: latest?.path || null,
    latestBackupSha256: typeof latest?.manifest?.sha256 === 'string'
      ? latest.manifest.sha256
      : null,
  };
}

function checkLiveDatabaseIntegrity(): { integrity: 'ok' | 'failed'; foreignKeysOk: boolean } {
  const integrityRow = db.prepare('PRAGMA integrity_check;').get() as
    | { integrity_check?: string }
    | undefined;
  const integrity = integrityRow?.integrity_check === 'ok' ? 'ok' : 'failed';
  const foreignKeyViolations = db.prepare('PRAGMA foreign_key_check;').all();
  return { integrity, foreignKeysOk: foreignKeyViolations.length === 0 };
}

function pruneBackups(): void {
  const dir = backupDirectory();
  const files = listBackupFiles(dir);
  const retention = configuredRetention();
  for (const fileName of files.slice(retention)) {
    const backupPath = path.join(dir, fileName);
    try {
      fs.unlinkSync(backupPath);
      try { fs.unlinkSync(`${backupPath}${BACKUP_MANIFEST_SUFFIX}`); } catch {}
      console.log(`[Database] Removed old backup ${fileName} (retention ${retention}).`);
    } catch (error) {
      console.warn(`[Database] Could not remove old backup ${fileName}:`, error);
    }
  }
}

function backupIsDue(): boolean {
  if (process.env.DB_BACKUP_ON_STARTUP === 'true') return true;
  const latest = latestBackup();
  if (!latest) return true;
  const lastBackupMs = Date.parse(
    typeof latest.manifest?.createdAt === 'string'
      ? latest.manifest.createdAt
      : fs.statSync(latest.path).mtime.toISOString()
  );
  if (!Number.isFinite(lastBackupMs)) return true;
  return Date.now() - lastBackupMs >= configuredIntervalHours() * 60 * 60 * 1_000;
}

function writeBackupManifest(result: DatabaseBackupResult): void {
  const manifest = {
    format: 'cp-coach-sqlite-backup',
    version: 1,
    createdAt: result.createdAt,
    backupPath: path.basename(result.backupPath),
    source: path.basename(DB_PATH),
    bytes: result.bytes,
    sha256: result.sha256,
    integrity: result.integrity,
    foreignKeysOk: result.foreignKeysOk,
    tableCounts: result.tableCounts,
    databaseInstance: process.env.RENDER_INSTANCE_ID || null,
  };
  const manifestPath = `${result.backupPath}${BACKUP_MANIFEST_SUFFIX}`;
  const tempPath = `${manifestPath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(manifest, null, 2), { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tempPath, manifestPath);
}

export async function runDatabaseMaintenance(options: { force?: boolean } = {}): Promise<DatabaseMaintenanceStatus> {
  if (maintenanceDisabled()) {
    return refreshStatus();
  }
  if (maintenanceInFlight) return maintenanceInFlight;

  maintenanceInFlight = (async () => {
    const checkedAt = new Date().toISOString();
    const liveCheck = checkLiveDatabaseIntegrity();
    status = {
      ...refreshStatus(),
      integrity: liveCheck.integrity,
      foreignKeysOk: liveCheck.foreignKeysOk,
      checkedAt,
    };

    if (liveCheck.integrity !== 'ok') {
      status.lastError = 'SQLite integrity_check failed';
      throw new Error(
        `Database integrity check failed. Refusing to continue with a corrupt database. Restore a verified backup before starting the service.`
      );
    }

    if (!liveCheck.foreignKeysOk) {
      console.warn('[Database] foreign_key_check reported violations; the database is still readable but should be inspected.');
    }

    if (options.force || backupIsDue()) {
      try {
        const dir = backupDirectory();
        if (isEphemeralStoragePath(dir)) {
          throw new Error('Configured backup directory is ephemeral. Configure DB_BACKUP_DIR on the persistent disk.');
        }
        const result = await createDatabaseBackup(DB_PATH, dir);
        writeBackupManifest(result);
        pruneBackups();
        status = {
          ...refreshStatus(),
          lastBackupAt: result.createdAt,
          lastBackupSha256: result.sha256,
          lastError: null,
        };
        console.log(`[Database] Verified backup created: ${path.basename(result.backupPath)} (${result.bytes} bytes, sha256 ${result.sha256.slice(0, 12)}...).`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        status = { ...refreshStatus(), lastError: message };
        console.error('[Database] Backup failed:', message);
      }
    }

    return status;
  })().finally(() => {
    maintenanceInFlight = null;
  });

  return maintenanceInFlight;
}

export function getDatabaseMaintenanceStatus(): DatabaseMaintenanceStatus {
  return refreshStatus();
}

export function getDatabaseHealthSummary(): {
  durableStorage: boolean;
  integrity: string;
  foreignKeysOk: boolean;
  backupCount: number;
  latestBackupAt: string | null;
  lastBackupAt: string | null;
  lastError: string | null;
} {
  const current = refreshStatus();
  return {
    durableStorage: current.durableStorage,
    integrity: current.integrity,
    foreignKeysOk: current.foreignKeysOk,
    backupCount: current.backupCount,
    latestBackupAt: current.latestBackupAt,
    lastBackupAt: current.lastBackupAt,
    lastError: current.lastError,
  };
}

export function startDatabaseMaintenanceScheduler(): void {
  if (maintenanceDisabled() || scheduler) return;
  const everyMs = Math.max(
    60 * 60 * 1_000,
    Math.floor((configuredIntervalHours() * 60 * 60 * 1_000) / 4),
  );
  scheduler = setInterval(() => {
    void runDatabaseMaintenance().catch((error: unknown) => {
      console.error('[Database] Scheduled maintenance failed:', error);
    });
  }, everyMs);
  scheduler.unref?.();
}

export function stopDatabaseMaintenanceScheduler(): void {
  if (scheduler) {
    clearInterval(scheduler);
    scheduler = null;
  }
}

export function verifyBackupFile(backupPath: string): { integrity: string; foreignKeysOk: boolean } {
  return verifyDatabaseIntegrity(backupPath);
}
