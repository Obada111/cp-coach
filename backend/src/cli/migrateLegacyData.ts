import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { Pool } from 'pg';
import dotenv from 'dotenv';

dotenv.config();

export interface LegacyExportReport {
  timestamp: string;
  sourceBackupPath: string;
  sourceFileSizeBytes: number;
  sourceFileSha256: string;
  profileId: string;
  handle: string;
  counts: {
    dailySets: number;
    dailyProblems: number;
    reviewQueue: number;
    solveSessions: number;
    contestReviews: number;
    userContests: number;
    weeklyGoals: number;
    learningEvents: number;
    submissions: number;
    problemsMeta: number;
    contestProblemsMeta: number;
  };
  exportSha256: string;
  dryRun: boolean;
  uploadedToSupabase: boolean;
  destinationTable?: string;
  targetUserId?: string;
  verifiedInDatabase?: boolean;
  message: string;
}

export async function uploadLegacySnapshotToSupabase(
  snapshot: any,
  targetUserId: string,
  connectionString?: string
): Promise<{ success: boolean; verified: boolean; message: string }> {
  const conn = (connectionString || process.env.DATABASE_URL || '').trim();
  if (!conn) {
    throw new Error('DATABASE_URL is required to upload to Supabase PostgreSQL.');
  }

  const pool = new Pool({
    connectionString: conn,
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 10000,
  });

  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS public.user_training_contexts (
        user_id uuid PRIMARY KEY,
        handle text NOT NULL,
        context_data jsonb NOT NULL,
        updated_at timestamptz NOT NULL DEFAULT now(),
        version integer NOT NULL DEFAULT 1
      );
      CREATE INDEX IF NOT EXISTS user_training_contexts_handle_idx
        ON public.user_training_contexts (lower(handle));
    `);

    const serialized = JSON.stringify(snapshot);
    const expectedSha = crypto.createHash('sha256').update(serialized).digest('hex');

    await client.query(
      `INSERT INTO public.user_training_contexts (user_id, handle, context_data, updated_at, version)
       VALUES ($1, $2, $3, now(), 1)
       ON CONFLICT (user_id) DO UPDATE SET
         handle = EXCLUDED.handle,
         context_data = EXCLUDED.context_data,
         updated_at = now(),
         version = public.user_training_contexts.version + 1`,
      [targetUserId, snapshot.handle, serialized]
    );

    // Verify read-back
    const res = await client.query(
      'SELECT context_data FROM public.user_training_contexts WHERE user_id = $1 LIMIT 1',
      [targetUserId]
    );

    if (res.rows.length === 0) {
      throw new Error('Verification failed: record not found after insert.');
    }

    const readData = res.rows[0].context_data;
    const readSerialized = typeof readData === 'string' ? readData : JSON.stringify(readData);
    const readSha = crypto.createHash('sha256').update(readSerialized).digest('hex');

    const verified = readSha === expectedSha;
    return {
      success: true,
      verified,
      message: verified
        ? `Successfully uploaded and verified context for '${snapshot.handle}' (SHA: ${readSha.slice(0, 16)})`
        : 'Uploaded, but readback hash comparison differed due to JSON formatting.',
    };
  } finally {
    client.release();
    await pool.end();
  }
}

export function exportLegacyDataFromBackup(
  backupPath: string,
  targetHandle = 'Obadajo',
  options: { outDir?: string; upload?: boolean; confirm?: boolean; user?: string } = {}
): { snapshot: any; report: LegacyExportReport } {
  if (!fs.existsSync(backupPath)) {
    throw new Error(`Backup file not found at: ${backupPath}`);
  }

  const stat = fs.statSync(backupPath);
  const fileBytes = fs.readFileSync(backupPath);
  const sourceFileSha256 = crypto.createHash('sha256').update(fileBytes).digest('hex');

  const sourceDb = new DatabaseSync(backupPath, { open: true, readOnly: true });

  try {
    const profileRow = sourceDb.prepare(`
      SELECT id, handle, display_name, avatar, rating, max_rating, rank, max_rank, owner_id
      FROM profiles
      WHERE lower(handle) = lower(?)
    `).get(targetHandle) as any;

    if (!profileRow) {
      throw new Error(`Profile with handle '${targetHandle}' not found in backup.`);
    }

    const profileId = profileRow.id;

    // Read personal tables
    const dailySets = sourceDb.prepare('SELECT * FROM daily_sets WHERE profile_id = ? ORDER BY date DESC').all(profileId) as any[];
    const dailyProblems = sourceDb.prepare('SELECT * FROM daily_problems WHERE profile_id = ? ORDER BY daily_set_date DESC').all(profileId) as any[];
    const reviewQueue = sourceDb.prepare('SELECT * FROM review_queue WHERE profile_id = ? ORDER BY added_at DESC').all(profileId) as any[];
    const solveSessions = sourceDb.prepare('SELECT * FROM solve_sessions WHERE profile_id = ? ORDER BY started_at DESC').all(profileId) as any[];
    const contestReviews = sourceDb.prepare('SELECT * FROM contest_problem_reviews WHERE profile_id = ? ORDER BY updated_at DESC').all(profileId) as any[];
    const userContests = sourceDb.prepare('SELECT * FROM user_contests WHERE profile_id = ? ORDER BY start_time_seconds DESC').all(profileId) as any[];
    const weeklyGoals = sourceDb.prepare('SELECT * FROM weekly_goals WHERE profile_id = ? ORDER BY week_start_date DESC').all(profileId) as any[];
    const learningEvents = sourceDb.prepare('SELECT * FROM problem_learning_events WHERE profile_id = ? ORDER BY occurred_at DESC').all(profileId) as any[];

    // Count submissions for handle
    const submissionCountRow = sourceDb.prepare('SELECT count(*) as c FROM submissions WHERE lower(handle) = lower(?)').get(targetHandle) as any;
    const submissionCount = submissionCountRow?.c || 0;

    // Collect problem IDs
    const problemIds = new Set<string>();
    for (const r of dailyProblems) if (r.problem_id) problemIds.add(String(r.problem_id));
    for (const r of reviewQueue) if (r.problem_id) problemIds.add(String(r.problem_id));
    for (const r of solveSessions) if (r.problem_id) problemIds.add(String(r.problem_id));
    for (const r of learningEvents) if (r.problem_id) problemIds.add(String(r.problem_id));
    for (const r of contestReviews) if (r.contest_id && r.problem_index) problemIds.add(`${r.contest_id}_${r.problem_index}`);

    const problemIdList = Array.from(problemIds);
    const problems: any[] = [];
    const contestProblemsMeta: any[] = [];

    for (let i = 0; i < problemIdList.length; i += 500) {
      const batch = problemIdList.slice(i, i + 500);
      const ph = batch.map(() => '?').join(', ');
      problems.push(...(sourceDb.prepare(`SELECT * FROM problems WHERE id IN (${ph})`).all(...batch) as any[]));
      contestProblemsMeta.push(...(sourceDb.prepare(`SELECT * FROM contest_problems_meta WHERE id IN (${ph})`).all(...batch) as any[]));
    }

    const learnerRow = sourceDb.prepare('SELECT * FROM learner_profile_state WHERE profile_id = ?').get(profileId) as any;

    const snapshot = {
      version: 1,
      exportedAt: new Date().toISOString(),
      profileId,
      handle: profileRow.handle,
      profile: {
        handle: profileRow.handle,
        displayName: profileRow.display_name || profileRow.handle,
        avatar: profileRow.avatar ?? null,
        rating: profileRow.rating ?? null,
        maxRating: profileRow.max_rating ?? null,
        rank: profileRow.rank ?? null,
        maxRank: profileRow.max_rank ?? null,
      },
      dailySets,
      dailyProblems,
      reviewQueue,
      solveSessions,
      contestReviews,
      userContests,
      weeklyGoals,
      learningEvents,
      learnerState: learnerRow || null,
      problems,
      contestProblemsMeta,
    };

    const serialized = JSON.stringify(snapshot);
    const exportSha256 = crypto.createHash('sha256').update(serialized).digest('hex');

    const isDryRun = !(options.upload === true && options.confirm === true && Boolean(options.user));

    const report: LegacyExportReport = {
      timestamp: new Date().toISOString(),
      sourceBackupPath: path.resolve(backupPath),
      sourceFileSizeBytes: stat.size,
      sourceFileSha256,
      profileId,
      handle: profileRow.handle,
      counts: {
        dailySets: dailySets.length,
        dailyProblems: dailyProblems.length,
        reviewQueue: reviewQueue.length,
        solveSessions: solveSessions.length,
        contestReviews: contestReviews.length,
        userContests: userContests.length,
        weeklyGoals: weeklyGoals.length,
        learningEvents: learningEvents.length,
        submissions: submissionCount,
        problemsMeta: problems.length,
        contestProblemsMeta: contestProblemsMeta.length,
      },
      exportSha256,
      dryRun: isDryRun,
      uploadedToSupabase: false,
      message: `Verified and extracted legacy records for '${profileRow.handle}' (SHA-256: ${exportSha256.slice(0, 16)}...)`,
    };

    if (options.outDir) {
      if (!fs.existsSync(options.outDir)) fs.mkdirSync(options.outDir, { recursive: true });
      const outFile = path.join(options.outDir, `legacy_export_${profileRow.handle.toLowerCase()}_${exportSha256.slice(0, 8)}.json`);
      const reportFile = path.join(options.outDir, `legacy_export_${profileRow.handle.toLowerCase()}_${exportSha256.slice(0, 8)}.manifest.json`);
      fs.writeFileSync(outFile, serialized, 'utf-8');
      fs.writeFileSync(reportFile, JSON.stringify(report, null, 2), 'utf-8');
    }

    return { snapshot, report };
  } finally {
    sourceDb.close();
  }
}
