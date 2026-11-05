import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DB_PATH, db, initDatabase } from '../db.js';
import {
  computeFileSha256,
  createDatabaseBackup,
  restoreDatabaseBackup,
  verifyDatabaseIntegrity,
} from '../databaseBackup.js';
import { runDatabaseMaintenance } from '../databaseMaintenance.js';

const backendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const tempDir = fs.mkdtempSync(path.join(backendRoot, '.tmp-backup-test-'));

beforeAll(() => {
  initDatabase();
  db.prepare(`
    INSERT INTO settings (key, value) VALUES ('backup-test-marker', 'present')
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run();
});

afterAll(() => {
  try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
});

describe('verified SQLite backups', () => {
  it('creates a verified point-in-time backup with a sha256 manifest source', async () => {
    const result = await createDatabaseBackup(DB_PATH, tempDir);
    expect(fs.existsSync(result.backupPath)).toBe(true);
    expect(result.integrity).toBe('ok');
    expect(result.foreignKeysOk).toBe(true);
    expect(result.bytes).toBeGreaterThan(0);
    expect(result.sha256).toBe(computeFileSha256(result.backupPath));
    expect(result.tableCounts.settings).toBeGreaterThan(0);
    expect(verifyDatabaseIntegrity(result.backupPath).integrity).toBe('ok');

    const restoredPath = path.join(tempDir, 'restored.sqlite');
    const restored = await restoreDatabaseBackup(result.backupPath, restoredPath);
    expect(restored.integrity).toBe('ok');
    const restoredDb = new (await import('node:sqlite')).DatabaseSync(restoredPath);
    try {
      const marker = restoredDb.prepare(
        "SELECT value FROM settings WHERE key = 'backup-test-marker'"
      ).get() as { value: string } | undefined;
      expect(marker?.value).toBe('present');
    } finally {
      restoredDb.close();
    }
  });

  it('writes a manifest and enforces backup retention during startup maintenance', async () => {
    const backupDir = path.join(tempDir, 'startup-backups');
    const original = {
      backupDir: process.env.DB_BACKUP_DIR,
      disabled: process.env.DATABASE_MAINTENANCE_DISABLED,
      runInTests: process.env.RUN_DB_MAINTENANCE_IN_TESTS,
      retention: process.env.DB_BACKUP_RETENTION,
      force: process.env.DB_BACKUP_ON_STARTUP,
    };
    process.env.DB_BACKUP_DIR = backupDir;
    process.env.DATABASE_MAINTENANCE_DISABLED = 'false';
    process.env.RUN_DB_MAINTENANCE_IN_TESTS = 'true';
    process.env.DB_BACKUP_RETENTION = '2';
    process.env.DB_BACKUP_ON_STARTUP = 'true';
    try {
      const first = await runDatabaseMaintenance({ force: true });
      expect(first.integrity).toBe('ok');
      expect(first.lastBackupAt).not.toBeNull();
      expect(first.latestBackupSha256).toMatch(/^[0-9a-f]{64}$/);
      const files = fs.readdirSync(backupDir).filter((name) => name.endsWith('.sqlite'));
      expect(files).toHaveLength(1);
      const manifest = JSON.parse(fs.readFileSync(path.join(backupDir, `${files[0]}.json`), 'utf8'));
      expect(manifest.sha256).toBe(first.latestBackupSha256);
      expect(manifest.integrity).toBe('ok');

      await runDatabaseMaintenance({ force: true });
      await runDatabaseMaintenance({ force: true });
      const retained = fs.readdirSync(backupDir).filter((name) => name.endsWith('.sqlite'));
      expect(retained.length).toBeLessThanOrEqual(2);
    } finally {
      for (const [key, value] of Object.entries({
        DB_BACKUP_DIR: original.backupDir,
        DATABASE_MAINTENANCE_DISABLED: original.disabled,
        RUN_DB_MAINTENANCE_IN_TESTS: original.runInTests,
        DB_BACKUP_RETENTION: original.retention,
        DB_BACKUP_ON_STARTUP: original.force,
      })) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
});
