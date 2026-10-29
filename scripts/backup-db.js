#!/usr/bin/env node
/**
 * Database backup script for Codeforces Coach.
 * Creates a timestamped copy of the production SQLite database.
 * Usage: node scripts/backup-db.js [--dir <backup_dir>] [--keep <count>]
 */

import { copyFileSync, readdirSync, statSync, unlinkSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Parse CLI args
const args = process.argv.slice(2);
let backupDir = join(__dirname, '..', 'backups');
let keepCount = 10;

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--dir' && args[i + 1]) {
    backupDir = args[++i];
  } else if (args[i] === '--keep' && args[i + 1]) {
    keepCount = parseInt(args[++i], 10);
  }
}

// Resolve database path
const dbDir = process.env.DB_DIR || join(__dirname, '..', 'backend', 'data');
const dbPath = join(dbDir, 'cp_coach.db');

if (!existsSync(dbPath)) {
  console.error(`Database not found at: ${dbPath}`);
  process.exit(1);
}

// Ensure backup directory exists
if (!existsSync(backupDir)) {
  mkdirSync(backupDir, { recursive: true });
}

// Create timestamped backup
const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const backupFile = join(backupDir, `cp_coach_backup_${timestamp}.db`);

try {
  copyFileSync(dbPath, backupFile);
  const stats = statSync(backupFile);
  console.log(`Backup created: ${backupFile}`);
  console.log(`  Size: ${(stats.size / 1024 / 1024).toFixed(2)} MB`);
  console.log(`  Source: ${dbPath}`);
} catch (err) {
  console.error(`Backup failed: ${err.message}`);
  process.exit(1);
}

// Prune old backups beyond keepCount
try {
  const files = readdirSync(backupDir)
    .filter(f => f.startsWith('cp_coach_backup_') && f.endsWith('.db'))
    .map(f => ({ name: f, time: statSync(join(backupDir, f)).mtime }))
    .sort((a, b) => b.time.getTime() - a.time.getTime());

  if (files.length > keepCount) {
    const toDelete = files.slice(keepCount);
    for (const f of toDelete) {
      unlinkSync(join(backupDir, f.name));
      console.log(`Pruned old backup: ${f.name}`);
    }
  }
} catch (err) {
  console.warn(`Backup pruning failed: ${err.message}`);
}