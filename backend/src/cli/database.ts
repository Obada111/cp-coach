import path from 'node:path';
import fs from 'node:fs';
import dotenv from 'dotenv';

dotenv.config();

interface ParsedArgs {
  command: string;
  positionals: string[];
  flags: Map<string, string | true>;
}

function parseArgs(argv: string[]): ParsedArgs {
  const [command = 'help', ...rest] = argv;
  const flags = new Map<string, string | true>();
  const positionals: string[] = [];
  for (let index = 0; index < rest.length; index += 1) {
    const value = rest[index];
    if (value.startsWith('--')) {
      const withoutPrefix = value.slice(2);
      const equalsIndex = withoutPrefix.indexOf('=');
      if (equalsIndex >= 0) {
        flags.set(withoutPrefix.slice(0, equalsIndex), withoutPrefix.slice(equalsIndex + 1));
      } else {
        const next = rest[index + 1];
        if (next && !next.startsWith('--')) {
          flags.set(withoutPrefix, next);
          index += 1;
        } else {
          flags.set(withoutPrefix, true);
        }
      }
    } else {
      positionals.push(value);
    }
  }
  return { command, positionals, flags };
}

function requiredFlag(args: ParsedArgs, name: string): string {
  const value = args.flags.get(name);
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`Missing required --${name} value.`);
  }
  return value.trim();
}

function optionalFlag(args: ParsedArgs, name: string): string | null {
  const value = args.flags.get(name);
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function requireConfirmation(args: ParsedArgs, action: string): void {
  if (args.flags.get('confirm') !== true) {
    throw new Error(`${action} changes production data. Re-run with --confirm after reviewing a --dry-run.`);
  }
}

function usage(): void {
  console.log(`CP Coach SQLite database tools

Usage:
  npm --prefix backend run db:verify
  npm --prefix backend run db:backup -- [--out <directory>]
  npm --prefix backend run db:restore -- <backup.sqlite> [--target <database.sqlite>] --confirm
  npm --prefix backend run db:migrate
  npm --prefix backend run db:claim -- --user <supabase-user-uuid> --profile <profile-id-or-handle> [--legacy-owner <id>] [--reason <text>] [--dry-run] [--confirm]
  npm --prefix backend run db:rollback -- --migration <pom_id> [--dry-run] --confirm
  npm --prefix backend run db:migrations -- [--profile <profile-id>]

Environment:
  DB_DIR             Directory containing cp_coach.db (default: backend/data)
  DB_BACKUP_DIR      Backup output directory (default: <DB_DIR>/backups)
  DB_BACKUP_RETENTION Number of verified backups to keep (default: 14)

Run restore only while the backend is stopped. The restore command verifies the
backup and creates a pre-restore safety copy before replacing the database.`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (args.command === 'help' || args.flags.has('help')) {
    usage();
    return;
  }

  if (args.command === 'verify') {
    const { verifyDatabaseIntegrity, defaultDatabasePath } = await import('../databaseBackup.js');
    const target = optionalFlag(args, 'target') || defaultDatabasePath();
    if (!fs.existsSync(target)) throw new Error(`Database does not exist: ${target}`);
    const result = verifyDatabaseIntegrity(target);
    console.log(JSON.stringify({ target, ...result }, null, 2));
    if (result.integrity !== 'ok') process.exitCode = 1;
    return;
  }

  if (args.command === 'backup') {
    const { createDatabaseBackup, defaultDatabasePath } = await import('../databaseBackup.js');
    const source = optionalFlag(args, 'target') || defaultDatabasePath();
    const output = optionalFlag(args, 'out') ||
      process.env.DB_BACKUP_DIR?.trim() ||
      path.join(path.dirname(source), 'backups');
    const result = await createDatabaseBackup(source, output);
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (args.command === 'restore') {
    const backupPath = args.positionals[0] || requiredFlag(args, 'backup');
    const { restoreDatabaseBackup, defaultDatabasePath } = await import('../databaseBackup.js');
    const target = optionalFlag(args, 'target') || defaultDatabasePath();
    requireConfirmation(args, 'Restoring a database');
    const result = await restoreDatabaseBackup(backupPath, target);
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (args.command === 'migrate') {
    const { initDatabase, getAppliedSchemaMigrations } = await import('../db.js');
    initDatabase();
    console.log(JSON.stringify({ success: true, migrations: getAppliedSchemaMigrations() }, null, 2));
    return;
  }

  if (args.command === 'claim') {
    const user = requiredFlag(args, 'user');
    const profile = requiredFlag(args, 'profile');
    const legacyOwner = optionalFlag(args, 'legacy-owner');
    const dryRun = args.flags.get('dry-run') === true || args.flags.get('dryRun') === true;
    if (!dryRun) requireConfirmation(args, 'Claiming a legacy profile');
    const {
      initDatabase,
      claimLegacyProfile,
      listProfileOwnershipMigrations,
    } = await import('../db.js');
    initDatabase();
    const result = claimLegacyProfile(user, profile, {
      legacyOwnerId: legacyOwner,
      dryRun,
      allowReassign: true,
      performedBy: optionalFlag(args, 'performed-by') || 'database-cli',
      reason: optionalFlag(args, 'reason') || 'administrator-cli',
    });
    console.log(JSON.stringify({
      ...result,
      audit: result.profile ? listProfileOwnershipMigrations(result.profile.id) : [],
    }, null, 2));
    return;
  }

  if (args.command === 'rollback') {
    const migration = requiredFlag(args, 'migration');
    const dryRun = args.flags.get('dry-run') === true || args.flags.get('dryRun') === true;
    const { initDatabase, listProfileOwnershipMigrations, revertProfileOwnershipMigration } = await import('../db.js');
    initDatabase();
    if (dryRun) {
      const record = listProfileOwnershipMigrations().find((item) => item.id === migration);
      if (!record) throw new Error(`Ownership migration '${migration}' was not found.`);
      console.log(JSON.stringify({ dryRun: true, migration: record }, null, 2));
      return;
    }
    requireConfirmation(args, 'Rolling back ownership');
    const result = revertProfileOwnershipMigration(migration, optionalFlag(args, 'performed-by') || 'database-cli');
    console.log(JSON.stringify({ ...result, audit: listProfileOwnershipMigrations(result.profile.id) }, null, 2));
    return;
  }

  if (args.command === 'migrations') {
    const { initDatabase, listProfileOwnershipMigrations } = await import('../db.js');
    initDatabase();
    console.log(JSON.stringify(listProfileOwnershipMigrations(optionalFlag(args, 'profile') || undefined), null, 2));
    return;
  }

  if (args.command === 'export-legacy' || args.command === 'migrate-legacy') {
    const backupPath = optionalFlag(args, 'source') || 'data/backups/cp_coach-20261103T193419Z-76c51c3b.sqlite';
    const resolvedPath = path.isAbsolute(backupPath) ? backupPath : path.resolve(process.cwd(), backupPath);
    const handle = optionalFlag(args, 'handle') || 'Obadajo';
    const outDir = optionalFlag(args, 'out') || path.resolve(process.cwd(), 'data/legacy-exports');
    const user = optionalFlag(args, 'user');
    const upload = args.flags.get('upload') === true;
    const confirm = args.flags.get('confirm') === true;
    const { exportLegacyDataFromBackup, uploadLegacySnapshotToSupabase } = await import('./migrateLegacyData.js');
    const { snapshot, report } = exportLegacyDataFromBackup(resolvedPath, handle, {
      outDir,
      upload,
      confirm,
      user: user || undefined,
    });
    if (upload && confirm && user) {
      const uploadRes = await uploadLegacySnapshotToSupabase(snapshot, user);
      report.uploadedToSupabase = uploadRes.success;
      report.verifiedInDatabase = uploadRes.verified;
      report.targetUserId = user;
      report.message = uploadRes.message;
    }
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  if (args.command === 'cloud-backup') {
    const { createCloudBackup } = await import('./cloudBackup.js');
    const outDir = optionalFlag(args, 'out') || path.resolve(process.cwd(), '../backups/supabase');
    const passphrase = optionalFlag(args, 'passphrase') || undefined;
    const manifest = await createCloudBackup({ outDir, passphrase });
    console.log(JSON.stringify({ success: true, manifest }, null, 2));
    return;
  }

  if (args.command === 'cloud-verify') {
    const backupFile = args.positionals[0] || requiredFlag(args, 'file');
    const { verifyAndTestRestoreBackup } = await import('./cloudBackup.js');
    const passphrase = optionalFlag(args, 'passphrase') || undefined;
    const result = verifyAndTestRestoreBackup(path.resolve(process.cwd(), backupFile), passphrase);
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  throw new Error(`Unknown command '${args.command}'. Run with --help for usage.`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
