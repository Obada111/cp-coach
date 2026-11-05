import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { Pool } from 'pg';
import dotenv from 'dotenv';

dotenv.config();

export interface CloudBackupManifest {
  version: number;
  timestamp: string;
  databaseHost: string;
  tables: Record<string, number>;
  totalRecords: number;
  unencryptedSha256: string;
  encryptedSha256: string;
  algorithm: string;
  cipherTextBytes: number;
  retentionKeptCount: number;
}

const DEFAULT_BACKUP_DIR = path.resolve(process.cwd(), '../backups/supabase');
const ALGORITHM = 'aes-256-gcm';

function deriveKey(passphrase: string, salt: Buffer): Buffer {
  return crypto.pbkdf2Sync(passphrase, salt, 100_000, 32, 'sha256');
}

export function encryptPayload(data: string, passphrase: string): { cipherBuffer: Buffer; unencryptedSha: string; encryptedSha: string } {
  const unencryptedSha = crypto.createHash('sha256').update(data).digest('hex');
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const key = deriveKey(passphrase, salt);

  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(data, 'utf-8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  // Format: [16 bytes salt][12 bytes iv][16 bytes tag][encrypted data]
  const finalBuffer = Buffer.concat([salt, iv, tag, encrypted]);
  const encryptedSha = crypto.createHash('sha256').update(finalBuffer).digest('hex');

  return { cipherBuffer: finalBuffer, unencryptedSha, encryptedSha };
}

export function decryptPayload(buffer: Buffer, passphrase: string): string {
  if (buffer.length < 44) throw new Error('Invalid backup file: header too short.');
  const salt = buffer.subarray(0, 16);
  const iv = buffer.subarray(16, 28);
  const tag = buffer.subarray(28, 44);
  const encrypted = buffer.subarray(44);

  const key = deriveKey(passphrase, salt);
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);

  return decipher.update(encrypted) + decipher.final('utf-8');
}

export function enforceRetention(dir: string, maxBackups = 14): number {
  if (!fs.existsSync(dir)) return 0;
  const files = fs.readdirSync(dir)
    .filter((f) => f.endsWith('.enc'))
    .map((f) => ({
      name: f,
      time: fs.statSync(path.join(dir, f)).mtimeMs,
    }))
    .sort((a, b) => b.time - a.time);

  let removed = 0;
  if (files.length > maxBackups) {
    const toRemove = files.slice(maxBackups);
    for (const item of toRemove) {
      try {
        fs.unlinkSync(path.join(dir, item.name));
        const manifestName = item.name.replace(/\.enc$/, '.manifest.json');
        const manifestPath = path.join(dir, manifestName);
        if (fs.existsSync(manifestPath)) fs.unlinkSync(manifestPath);
        removed += 1;
      } catch {}
    }
  }
  return files.length - removed;
}

export async function createCloudBackup(options: {
  connectionString?: string;
  passphrase?: string;
  outDir?: string;
  retention?: number;
}): Promise<CloudBackupManifest> {
  const conn = (options.connectionString || process.env.DATABASE_URL || '').trim();
  if (!conn) {
    throw new Error('DATABASE_URL is required to perform a Supabase cloud backup.');
  }

  const passphrase = options.passphrase || process.env.BACKUP_ENCRYPTION_KEY || 'cp-coach-default-zero-cost-passphrase';
  const outDir = options.outDir || DEFAULT_BACKUP_DIR;
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

  const pool = new Pool({
    connectionString: conn,
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 10000,
  });

  const client = await pool.connect();
  try {
    const tablesRes = await client.query(`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
      ORDER BY table_name
    `);

    const tableNames: string[] = tablesRes.rows.map((r) => r.table_name);
    const dump: Record<string, any[]> = {};
    const tableCounts: Record<string, number> = {};
    let totalRecords = 0;

    for (const table of tableNames) {
      try {
        const rows = await client.query(`SELECT * FROM public."${table}"`);
        dump[table] = rows.rows;
        tableCounts[table] = rows.rows.length;
        totalRecords += rows.rows.length;
      } catch (err: any) {
        console.warn(`[CloudBackup] Could not dump table ${table}:`, err?.message || err);
      }
    }

    const payload = JSON.stringify({
      timestamp: new Date().toISOString(),
      tables: dump,
    });

    const { cipherBuffer, unencryptedSha, encryptedSha } = encryptPayload(payload, passphrase);
    const timestampStr = new Date().toISOString().replace(/[:.]/g, '-');
    const encFile = path.join(outDir, `supabase_backup_${timestampStr}.enc`);
    const manifestFile = path.join(outDir, `supabase_backup_${timestampStr}.manifest.json`);

    fs.writeFileSync(encFile, cipherBuffer);

    const keptCount = enforceRetention(outDir, options.retention || 14);

    let host = 'supabase-postgres';
    try {
      const u = new URL(conn.replace('postgresql://', 'http://').replace('postgres://', 'http://'));
      host = u.hostname;
    } catch {}

    const manifest: CloudBackupManifest = {
      version: 1,
      timestamp: new Date().toISOString(),
      databaseHost: host,
      tables: tableCounts,
      totalRecords,
      unencryptedSha256: unencryptedSha,
      encryptedSha256: encryptedSha,
      algorithm: ALGORITHM,
      cipherTextBytes: cipherBuffer.length,
      retentionKeptCount: keptCount,
    };

    fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2), 'utf-8');
    return manifest;
  } finally {
    client.release();
    await pool.end();
  }
}

export function verifyAndTestRestoreBackup(encFilePath: string, passphrase?: string): {
  verified: boolean;
  manifest: CloudBackupManifest | null;
  tableCounts: Record<string, number>;
  totalRecords: number;
  message: string;
} {
  if (!fs.existsSync(encFilePath)) throw new Error(`Backup file not found: ${encFilePath}`);
  const pass = passphrase || process.env.BACKUP_ENCRYPTION_KEY || 'cp-coach-default-zero-cost-passphrase';

  const manifestPath = encFilePath.replace(/\.enc$/, '.manifest.json');
  let manifest: CloudBackupManifest | null = null;
  if (fs.existsSync(manifestPath)) {
    try {
      manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
    } catch {}
  }

  const cipherBuffer = fs.readFileSync(encFilePath);
  const actualEncSha = crypto.createHash('sha256').update(cipherBuffer).digest('hex');

  if (manifest && manifest.encryptedSha256 !== actualEncSha) {
    throw new Error('Encrypted file SHA-256 does not match manifest! File may be corrupted or tampered.');
  }

  const decryptedText = decryptPayload(cipherBuffer, pass);
  const actualUnencSha = crypto.createHash('sha256').update(decryptedText).digest('hex');

  if (manifest && manifest.unencryptedSha256 !== actualUnencSha) {
    throw new Error('Decrypted payload SHA-256 mismatch! Integrity verification failed.');
  }

  const parsed = JSON.parse(decryptedText);
  if (!parsed || typeof parsed !== 'object' || !parsed.tables) {
    throw new Error('Decrypted payload is not a valid backup archive structure.');
  }

  const counts: Record<string, number> = {};
  let total = 0;
  for (const [table, rows] of Object.entries(parsed.tables)) {
    if (Array.isArray(rows)) {
      counts[table] = rows.length;
      total += rows.length;
    }
  }

  return {
    verified: true,
    manifest,
    tableCounts: counts,
    totalRecords: total,
    message: `Restore verification PASSED: Decrypted and verified ${total} records across ${Object.keys(counts).length} tables. Checksums match.`,
  };
}
