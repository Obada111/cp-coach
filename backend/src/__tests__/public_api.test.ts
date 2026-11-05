import express from 'express';
import { createHash } from 'node:crypto';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createProfile, db, getOrCreatePublicProfile, getPublicProfileId, initDatabase } from '../db.js';
import { codeforcesService } from '../codeforcesService.js';
import { cloudflareNotificationRepository } from '../cloudflareNotificationRepository.js';
import { exportPublicContext, importPublicContext } from '../publicContextService.js';
import { publicRouter } from '../publicRoutes.js';

const USER_A = '11111111-1111-4111-8111-111111111111';
const USER_B = '22222222-2222-4222-8222-222222222222';
const USER_C = '33333333-3333-4333-8333-333333333333';
const HANDLE = 'PublicTestUser';

let server: Server;
let baseUrl: string;
const appFetch = globalThis.fetch.bind(globalThis);
let profileA: ReturnType<typeof getOrCreatePublicProfile>;
let profileB: ReturnType<typeof getOrCreatePublicProfile>;

async function request(path: string, init: RequestInit = {}) {
  const response = await appFetch(`${baseUrl}${path}`, init);
  const text = await response.text();
  let body: any = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  return { status: response.status, body, headers: response.headers };
}

function makeToken(userId: string, expiresInSeconds = 3600): string {
  const encode = (value: Record<string, unknown>) =>
    Buffer.from(JSON.stringify(value)).toString('base64url');
  return [
    encode({ alg: 'none', typ: 'JWT' }),
    encode({
      sub: userId,
      role: 'authenticated',
      aud: 'authenticated',
      exp: Math.floor(Date.now() / 1000) + expiresInSeconds,
    }),
    'test-signature',
  ].join('.');
}

function headers(userId: string, handle = HANDLE): Record<string, string> {
  return {
    Authorization: `Bearer ${makeToken(userId)}`,
    'X-Coach-Handle': handle,
    'Content-Type': 'application/json',
  };
}

function makeContext(profile: ReturnType<typeof getOrCreatePublicProfile>, note: string) {
  const setId = `${profile.id}_2026-01-01`;
  const problemId = '1_A';
  const dailyProblemId = `${profile.id}_2026-01-01_weakness`;
  return {
    version: 1,
    exportedAt: new Date().toISOString(),
    handle: profile.handle,
    profile: {
      handle: profile.handle,
      displayName: profile.handle,
      avatar: null,
      rating: 1200,
      maxRating: 1300,
      rank: 'pupil',
      maxRank: 'specialist',
    },
    dailySets: [
      {
        id: setId,
        profile_id: profile.id,
        date: '2026-01-01',
        generated_at: '2026-01-01T00:00:00.000Z',
      },
    ],
    dailyProblems: [
      {
        id: dailyProblemId,
        daily_set_id: setId,
        profile_id: profile.id,
        daily_set_date: '2026-01-01',
        problem_id: problemId,
        category: 'WEAKNESS_DRILL',
        reason: 'Test recommendation',
        target_rating: 1200,
        completed: 0,
        notes: note,
        updated_at: '2026-01-01T00:00:00.000Z',
      },
    ],
    reviewQueue: [],
    solveSessions: [],
    contestReviews: [],
    userContests: [],
    weeklyGoals: [],
    learningEvents: [],
    learnerState: null,
    problems: [
      {
        id: problemId,
        contest_id: 1,
        problem_index: 'A',
        name: 'Theatre Square',
        type: 'PROGRAMMING',
        rating: 1200,
        tags: '["math"]',
        solved_count: 1000,
        updated_at: '2026-01-01T00:00:00.000Z',
      },
    ],
    contestProblemsMeta: [],
  };
}

beforeAll(async () => {
  initDatabase();
  const app = express();
  app.use(express.json({ limit: '11mb' }));
  app.use('/api/public', publicRouter);
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => resolve());
  });
  server.keepAliveTimeout = 60000;
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  profileA = getOrCreatePublicProfile(USER_A, HANDLE);
  profileB = getOrCreatePublicProfile(USER_B, HANDLE);
});

afterAll(async () => {
  if (server) {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
});

describe('public API tenant isolation', () => {
  it('only reports push as ready after the scheduled Worker has succeeded recently', async () => {
    const original = {
      publicMode: process.env.PUBLIC_MODE,
      workerUrl: process.env.CLOUDFLARE_NOTIFICATIONS_URL,
      workerSecret: process.env.CLOUDFLARE_NOTIFICATIONS_API_SECRET,
      vapidPublicKey: process.env.VAPID_PUBLIC_KEY,
    };
    process.env.PUBLIC_MODE = 'true';
    process.env.CLOUDFLARE_NOTIFICATIONS_URL = 'http://127.0.0.1:8787';
    process.env.CLOUDFLARE_NOTIFICATIONS_API_SECRET = 'test-secret';
    process.env.VAPID_PUBLIC_KEY = 'test-public-key';
    const isConfigured = vi.spyOn(cloudflareNotificationRepository, 'isConfigured').mockReturnValue(true);
    const getHealth = vi.spyOn(cloudflareNotificationRepository, 'getHealth');
    const healthyWorker = {
      status: 'ok',
      storageReady: true,
      apiSecretConfigured: true,
      vapidConfigured: true,
      vapidPublicKey: 'test-public-key',
      state: { last_status: 'FAILED', last_success_at: null },
      latestRun: { status: 'FAILED', pushes_attempted: 1, notifications_sent: 0 },
      schedulerHealthy: false,
    };
    try {
      getHealth.mockResolvedValueOnce(healthyWorker).mockResolvedValueOnce({
        ...healthyWorker,
        state: { last_status: 'SUCCEEDED', last_success_at: new Date().toISOString() },
        latestRun: { status: 'SUCCEEDED', pushes_attempted: 1, notifications_sent: 1 },
        schedulerHealthy: true,
      });

      const stale = await request('/api/public/notifications/config', {
        headers: headers(USER_A),
      });
      expect(stale.status).toBe(200);
      expect(stale.body.available).toBe(false);
      expect(stale.body.readiness.worker.schedulerHealthy).toBe(false);
      expect(stale.body.readiness.worker.lastRun.notifications_sent).toBe(0);

      const ready = await request('/api/public/notifications/config', {
        headers: headers(USER_A),
      });
      expect(ready.status).toBe(200);
      expect(ready.body.available).toBe(true);
      expect(ready.body.readiness.worker.schedulerHealthy).toBe(true);
      expect(ready.body.readiness.worker.lastRun.notifications_sent).toBe(1);
    } finally {
      isConfigured.mockRestore();
      getHealth.mockRestore();
      for (const [key, value] of Object.entries({
        PUBLIC_MODE: original.publicMode,
        CLOUDFLARE_NOTIFICATIONS_URL: original.workerUrl,
        CLOUDFLARE_NOTIFICATIONS_API_SECRET: original.workerSecret,
        VAPID_PUBLIC_KEY: original.vapidPublicKey,
      })) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it('gives the same handle different deterministic profiles per browser', () => {
    expect(profileA.id).not.toBe(profileB.id);
    expect(profileA.id).toBe(getPublicProfileId(USER_A, HANDLE));
    expect(profileB.id).toBe(getPublicProfileId(USER_B, HANDLE));
  });

  it('lists only the requesting browser profiles', async () => {
    const a = await request('/api/public/profiles', { headers: headers(USER_A) });
    expect(a.status).toBe(200);
    expect(a.body.profiles.map((profile: any) => profile.id)).toEqual([profileA.id]);

    const b = await request('/api/public/profiles', { headers: headers(USER_B) });
    expect(b.status).toBe(200);
    expect(b.body.profiles.map((profile: any) => profile.id)).toEqual([profileB.id]);
  });

  it('distinguishes an unknown Codeforces handle from a temporary Codeforces outage', async () => {
    const validate = vi.spyOn(codeforcesService, 'validateHandle');
    validate
      .mockResolvedValueOnce({ valid: false, error: "Codeforces handle 'MissingUser' does not exist. Please check the spelling." })
      .mockResolvedValueOnce({ valid: false, error: 'Codeforces check failed: temporary timeout' });
    try {
      const missing = await request('/api/public/profiles', {
        method: 'POST',
        headers: headers(USER_C),
        body: JSON.stringify({ handle: 'MissingUser' }),
      });
      expect(missing.status).toBe(400);
      expect(missing.body.error).toContain('does not exist');

      const unavailable = await request('/api/public/profiles', {
        method: 'POST',
        headers: headers(USER_C),
        body: JSON.stringify({ handle: 'ValidShape' }),
      });
      expect(unavailable.status).toBe(503);
      expect(unavailable.body.error).toContain('try again');
    } finally {
      validate.mockRestore();
    }
  });

  it('round-trips browser context without exposing it to another browser', async () => {
    const snapshot = makeContext(profileA, 'private note A');
    const imported = await request('/api/public/context', {
      method: 'POST',
      headers: headers(USER_A),
      body: JSON.stringify({ context: snapshot }),
    });
    expect(imported.status).toBe(200);
    expect(imported.body.imported).toBe(true);
    expect(imported.body.counts.dailySets).toBe(1);
    expect(imported.body.counts.dailyProblems).toBe(1);

    const aContext = await request('/api/public/context', { headers: headers(USER_A) });
    expect(aContext.status).toBe(200);
    expect(aContext.body.dailyProblems[0].notes).toBe('private note A');

    const bContext = await request('/api/public/context', { headers: headers(USER_B) });
    expect(bContext.status).toBe(200);
    expect(bContext.body.dailyProblems).toHaveLength(0);
  });

  it('starts Cloudflare daily snapshot synchronization without blocking the response', async () => {
    vi.stubEnv('CLOUDFLARE_NOTIFICATIONS_URL', 'https://notifications.example');
    vi.stubEnv('CLOUDFLARE_NOTIFICATIONS_API_SECRET', 'worker-test-secret');
    const calls: string[] = [];
    let releaseSync!: () => void;
    const syncGate = new Promise<void>((resolve) => {
      releaseSync = resolve;
    });
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push(url);
      expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer worker-test-secret');
      if (url.endsWith('/internal/v1/snapshots/sync')) {
        await syncGate;
      }
      return Response.json({ success: true });
    }));

    try {
      const imported = await Promise.race([
        request('/api/public/context', {
          method: 'POST',
          headers: headers(USER_A),
          body: JSON.stringify({ context: makeContext(profileA, 'sync after response') }),
        }),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 1000)),
      ]);
      expect(imported).not.toBeNull();
      expect(imported!.status).toBe(200);
      expect(imported!.headers.get('x-notification-snapshot-sync')).toBeNull();
      await vi.waitFor(() => {
        expect(calls.some((url) => url.endsWith('/internal/v1/snapshots/sync'))).toBe(true);
      }, { timeout: 1000, interval: 10 });
    } finally {
      releaseSync();
      await new Promise((resolve) => setTimeout(resolve, 10));
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
    }
  });

  it('rejects malformed replacement snapshots without deleting existing learning data', async () => {
    importPublicContext(profileA.id, makeContext(profileA, 'keep this note'));

    const malformed = makeContext(profileA, 'this must not be imported') as any;
    malformed.dailySets = 'not-an-array';
    expect(() => importPublicContext(profileA.id, malformed, { mode: 'replace' }))
      .toThrow('Invalid browser context field: dailySets');
    expect(exportPublicContext(profileA.id).dailyProblems[0].notes).toBe('keep this note');
  });

  it('rejects malformed backup timestamps without changing saved data', () => {
    importPublicContext(profileA.id, makeContext(profileA, 'timestamp-protected note'));
    const malformed = makeContext(profileA, 'must not replace saved data') as any;
    malformed.learningEvents = [{
      id: 'invalid-event-time',
      profile_id: profileA.id,
      problem_id: '1_A',
      source: 'DAILY_FEEDBACK',
      occurred_at: '2026-02-30T10:00:00.000Z',
    }];

    expect(() => importPublicContext(profileA.id, malformed, { mode: 'replace' }))
      .toThrow('Invalid browser context field: learningEvents');
    expect(exportPublicContext(profileA.id).dailyProblems[0].notes).toBe('timestamp-protected note');
  });

  it('restores feedback onto an already-existing daily set', async () => {
    const updated = makeContext(profileA, 'updated note A');
    updated.dailyProblems[0].updated_at = '2026-01-02T00:00:00.000Z';
    const imported = await request('/api/public/context', {
      method: 'POST',
      headers: headers(USER_A),
      body: JSON.stringify({ context: updated }),
    });
    expect(imported.status).toBe(200);
    expect(imported.body.counts.dailyProblems).toBe(1);

    const aContext = await request('/api/public/context', { headers: headers(USER_A) });
    expect(aContext.body.dailyProblems[0].notes).toBe('updated note A');
  });

  it('does not let another browser take over a row by reusing its id', async () => {
    db.prepare(`
      INSERT INTO review_queue (
        id, profile_id, problem_id, source, problem_name, trigger_reason, due_date
      ) VALUES (?, ?, ?, 'DAILY_STRUGGLE', 'Theatre Square', 'test', '2026-01-03')
    `).run('shared-review-id', profileA.id, '1_A');

    const snapshot = makeContext(profileB, 'B note');
    snapshot.reviewQueue = [
      {
        id: 'shared-review-id',
        profile_id: profileB.id,
        problem_id: '1_A',
        source: 'DAILY_STRUGGLE',
        problem_name: 'Theatre Square',
        trigger_reason: 'test',
        due_date: '2026-01-04',
      },
    ] as any;

    const imported = await request('/api/public/context', {
      method: 'POST',
      headers: headers(USER_B),
      body: JSON.stringify({ context: snapshot }),
    });
    expect(imported.status).toBe(200);
    expect(imported.body.counts.reviewQueue).toBe(1);

    const owner = db.prepare('SELECT profile_id FROM review_queue WHERE id = ?').get('shared-review-id') as any;
    expect(owner.profile_id).toBe(profileA.id);
    const browserBReview = db.prepare(
      'SELECT id, profile_id FROM review_queue WHERE profile_id = ? AND problem_id = ?'
    ).get(profileB.id, '1_A') as any;
    expect(browserBReview.profile_id).toBe(profileB.id);
    expect(browserBReview.id).not.toBe('shared-review-id');
  });

  it('handles natural-key conflicts when a snapshot id changes', async () => {
    const first = makeContext(profileA, 'week one');
    first.weeklyGoals = [
      {
        id: 'goal-original',
        profile_id: profileA.id,
        week_start_date: '2026-01-05',
        target_solves: 10,
        target_contests: 1,
        target_upsolves: 2,
        focus_topics: '["dp"]',
        updated_at: '2026-01-05T00:00:00.000Z',
      },
    ] as any;
    const firstImport = await request('/api/public/context', {
      method: 'POST',
      headers: headers(USER_A),
      body: JSON.stringify({ context: first }),
    });
    expect(firstImport.status).toBe(200);

    const second = makeContext(profileA, 'week two');
    second.weeklyGoals = [
      {
        id: 'goal-new-id',
        profile_id: profileA.id,
        week_start_date: '2026-01-05',
        target_solves: 12,
        target_contests: 2,
        target_upsolves: 3,
        focus_topics: '["graphs"]',
        updated_at: '2026-01-06T00:00:00.000Z',
      },
    ] as any;
    const secondImport = await request('/api/public/context', {
      method: 'POST',
      headers: headers(USER_A),
      body: JSON.stringify({ context: second }),
    });
    expect(secondImport.status).toBe(200);

    const goals = db.prepare(
      'SELECT id, target_solves FROM weekly_goals WHERE profile_id = ? AND week_start_date = ?'
    ).all(profileA.id, '2026-01-05') as any[];
    expect(goals).toHaveLength(1);
    expect(goals[0].id).not.toBe('goal-original');
    expect(goals[0].target_solves).toBe(12);
  });

  it('rejects invalid feedback and review values before they can corrupt analytics', async () => {
    const dailyProblemId = (db.prepare(
      'SELECT id FROM daily_problems WHERE profile_id = ? AND daily_set_date = ?'
    ).get(profileA.id, '2026-01-01') as { id: string }).id;
    const badFeedback = await request(`/api/public/problems/${encodeURIComponent(dailyProblemId)}/feedback`, {
      method: 'POST',
      headers: headers(USER_A),
      body: JSON.stringify({ solvedStatus: 'MADE_UP_STATUS' }),
    });
    expect(badFeedback.status).toBe(400);
    expect(badFeedback.body.error).toBe('Invalid solvedStatus');

    const badReview = await request('/api/public/reviews/1_A/action', {
      method: 'POST',
      headers: headers(USER_A),
      body: JSON.stringify({ outcome: 'MADE_UP_OUTCOME' }),
    });
    expect(badReview.status).toBe(400);
    expect(badReview.body.error).toBe('Invalid review outcome');
  });

  it('rejects a backup from a different Codeforces handle', async () => {
    const foreign = makeContext(profileA, 'foreign note');
    foreign.handle = 'SomeOtherHandle';
    const imported = await request('/api/public/context', {
      method: 'POST',
      headers: headers(USER_A),
      body: JSON.stringify({ context: foreign, mode: 'merge' }),
    });
    expect(imported.status).toBe(400);
    expect(imported.body.error).toContain('different Codeforces handle');
  });

  it('supports explicit replace mode without touching another browser profile', async () => {
    db.prepare(`
      INSERT INTO review_queue (
        id, profile_id, problem_id, source, problem_name, trigger_reason, due_date
      ) VALUES (?, ?, ?, 'DAILY_STRUGGLE', 'Theatre Square', 'keep me', '2026-01-03')
    `).run('browser-b-review', profileB.id, 'browser-b-only-problem');

    const replacement = makeContext(profileA, 'replacement note');
    replacement.dailySets[0].id = `${profileA.id}_2026-02-01`;
    replacement.dailySets[0].date = '2026-02-01';
    replacement.dailyProblems[0].id = `${profileA.id}_2026-02-01_weakness`;
    replacement.dailyProblems[0].daily_set_id = replacement.dailySets[0].id;
    replacement.dailyProblems[0].daily_set_date = '2026-02-01';

    const imported = await request('/api/public/context', {
      method: 'POST',
      headers: headers(USER_A),
      body: JSON.stringify({ context: replacement, mode: 'replace' }),
    });
    expect(imported.status).toBe(200);
    expect(imported.body.mode).toBe('replace');

    const aContext = await request('/api/public/context', { headers: headers(USER_A) });
    expect(aContext.body.dailySets).toHaveLength(1);
    expect(aContext.body.dailySets[0].date).toBe('2026-02-01');
    expect(aContext.body.dailyProblems[0].notes).toBe('replacement note');

    const bReview = db.prepare('SELECT profile_id FROM review_queue WHERE id = ?').get('browser-b-review') as any;
    expect(bReview.profile_id).toBe(profileB.id);
  });

  it('restores a complete backup across browser profiles and remains idempotent', () => {
    const source = getOrCreatePublicProfile('restoreSourceBrowser123', 'RestoreTester');
    const destination = getOrCreatePublicProfile('restoreDestination123', 'RestoreTester');
    const problemId = '9000_A';
    const sourceSetId = `${source.id}_2026-03-01`;
    const sourceDailyProblemId = `${sourceSetId}_RESTORE`;
    const sourceSessionId = 'source-session-id';
    const sourceContestReviewId = 'source-contest-review-id';
    const occurredAt = '2026-03-01T10:00:00.000Z';

    db.prepare(`
      INSERT INTO problems (id, contest_id, problem_index, name, rating, tags)
      VALUES (?, 9000, 'A', 'Restore problem', 1200, '["dp"]')
    `).run(problemId);
    db.prepare(`
      INSERT INTO daily_sets (id, profile_id, date, generated_at)
      VALUES (?, ?, '2026-03-01', ?)
    `).run(sourceSetId, source.id, occurredAt);
    db.prepare(`
      INSERT INTO daily_problems (
        id, daily_set_id, profile_id, daily_set_date, problem_id, category,
        reason, target_rating, solved_status, solution_method, struggle_reason,
        time_spent_minutes, notes, updated_at
      ) VALUES (?, ?, ?, '2026-03-01', ?, 'RESTORE', 'Cross-browser test', 1200,
        'SOLVED_WITH_HINTS', 'HINTS', 'IMPLEMENTATION', 37, 'keep this note', ?)
    `).run(sourceDailyProblemId, sourceSetId, source.id, problemId, occurredAt);
    db.prepare(`
      INSERT INTO review_queue (
        id, profile_id, problem_id, source, problem_name, trigger_reason, due_date, review_notes
      ) VALUES ('source-review-id', ?, ?, 'DAILY_STRUGGLE', 'Restore problem', 'test', '2026-03-02', 'review note')
    `).run(source.id, problemId);
    db.prepare(`
      INSERT INTO solve_sessions (
        id, profile_id, problem_id, started_at, ended_at, outcome, key_takeaway, updated_at
      ) VALUES (?, ?, ?, ?, ?, 'SOLVED', 'session lesson', ?)
    `).run(sourceSessionId, source.id, problemId, occurredAt, occurredAt, occurredAt);
    db.prepare(`
      INSERT INTO contest_problem_reviews (
        id, profile_id, contest_id, problem_index, self_review_notes, updated_at
      ) VALUES (?, ?, 9000, 'A', 'contest lesson', ?)
    `).run(sourceContestReviewId, source.id, occurredAt);
    db.prepare(`
      INSERT INTO user_contests (
        id, profile_id, contest_id, name, start_time_seconds, duration_seconds, is_official
      ) VALUES ('source-contest-id', ?, 9000, 'Restore contest', 1772360000, 7200, 1)
    `).run(source.id);
    db.prepare(`
      INSERT INTO weekly_goals (id, profile_id, week_start_date, notes, updated_at)
      VALUES ('source-week-goal', ?, '2026-03-02', 'weekly note', ?)
    `).run(source.id, occurredAt);

    const eventRows = [
      ['event-daily-open', `daily_open_${sourceDailyProblemId}`],
      ['event-legacy-daily', `legacy_daily_${sourceDailyProblemId}`],
      ['event-session-link', `legacy_session_${sourceSessionId}`],
      ['event-contest-link', `legacy_contest_${sourceContestReviewId}`],
      ...Array.from({ length: 501 }, (_, index) => [`bulk-event-${index}`, `bulk-source-${index}`]),
    ];
    const insertEvent = db.prepare(`
      INSERT INTO problem_learning_events (
        id, profile_id, problem_id, source, tags, solved_status, notes, source_key, occurred_at
      ) VALUES (?, ?, ?, 'DAILY_FEEDBACK', '["dp"]', 'SOLVED_INDEPENDENTLY', 'learning note', ?, ?)
    `);
    for (const [id, sourceKey] of eventRows) {
      insertEvent.run(id, source.id, problemId, sourceKey, occurredAt);
    }
    db.prepare(`
      INSERT INTO learner_profile_state (profile_id, handle, data_json, updated_at)
      VALUES (?, ?, ?, ?)
    `).run(source.id, source.handle, JSON.stringify({
      profileId: source.id,
      nested: { profile_id: source.id, lesson: 'preserve learner state' },
    }), occurredAt);

    const backup = exportPublicContext(source.id);
    expect(backup.learningEvents).toHaveLength(505);
    expect(backup.profileId).toBe(source.id);

    const restoreResult = importPublicContext(destination.id, backup);
    expect(restoreResult.skipped).toBe(0);
    expect(restoreResult.counts.learningEvents).toBe(505);

    const dailySet = db.prepare('SELECT * FROM daily_sets WHERE profile_id = ?').get(destination.id) as any;
    const dailyProblem = db.prepare('SELECT * FROM daily_problems WHERE profile_id = ?').get(destination.id) as any;
    expect(dailySet.id).not.toBe(sourceSetId);
    expect(dailySet.id).toBe(`${destination.id}_2026-03-01`);
    expect(dailyProblem.id).not.toBe(sourceDailyProblemId);
    expect(dailyProblem.daily_set_id).toBe(dailySet.id);
    expect(dailyProblem.profile_id).toBe(destination.id);
    expect(dailyProblem.problem_id).toBe(problemId);
    expect(dailyProblem.notes).toBe('keep this note');
    expect(dailyProblem.solved_status).toBe('SOLVED_WITH_HINTS');
    expect(dailyProblem.solution_method).toBe('HINTS');
    expect(dailyProblem.struggle_reason).toBe('IMPLEMENTATION');
    expect(dailyProblem.time_spent_minutes).toBe(37);
    expect(dailyProblem.updated_at).toBe(occurredAt);
    const remappedSourceKey = (logicalKey: string) => {
      const digest = createHash('sha256')
        .update([destination.id, source.id, logicalKey].join('\0'))
        .digest('hex')
        .slice(0, 32);
      return `restore_source_${digest}`;
    };
    expect(db.prepare('SELECT id FROM review_queue WHERE profile_id = ?').get(destination.id)?.id).not.toBe('source-review-id');
    expect(db.prepare('SELECT id FROM solve_sessions WHERE profile_id = ?').get(destination.id)?.id).not.toBe(sourceSessionId);
    expect(db.prepare('SELECT id FROM contest_problem_reviews WHERE profile_id = ?').get(destination.id)?.id).not.toBe(sourceContestReviewId);
    expect(db.prepare('SELECT id FROM user_contests WHERE profile_id = ?').get(destination.id)?.id).not.toBe('source-contest-id');
    expect(db.prepare('SELECT id FROM weekly_goals WHERE profile_id = ?').get(destination.id)?.id).not.toBe('source-week-goal');
    expect(db.prepare(
      'SELECT id FROM problem_learning_events WHERE profile_id = ? AND source_key = ?'
    ).get(destination.id, remappedSourceKey(`daily_open_${dailyProblem.id}`))?.id).not.toBe('event-daily-open');

    for (const table of [
      'review_queue',
      'solve_sessions',
      'contest_problem_reviews',
      'user_contests',
      'weekly_goals',
      'problem_learning_events',
    ]) {
      const wrongOwner = db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE profile_id = ?`).get(source.id) as any;
      const restored = db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE profile_id = ?`).get(destination.id) as any;
      expect(wrongOwner.count).toBeGreaterThan(0);
      expect(restored.count).toBe(table === 'problem_learning_events' ? 505 : 1);
    }

    const sourceKeys = db.prepare(`
      SELECT id, source_key FROM problem_learning_events
      WHERE profile_id = ? AND id IN (
        SELECT id FROM problem_learning_events WHERE profile_id = ?
      )
    `).all(destination.id, destination.id) as Array<{ id: string; source_key: string | null }>;
    const restoredBySourceKey = new Set(sourceKeys.map((row) => row.source_key));
    expect(restoredBySourceKey.has(remappedSourceKey(`daily_open_${dailyProblem.id}`))).toBe(true);
    expect(restoredBySourceKey.has(remappedSourceKey(`legacy_daily_${dailyProblem.id}`))).toBe(true);
    expect(restoredBySourceKey.has(remappedSourceKey(`legacy_session_${db.prepare(
      'SELECT id FROM solve_sessions WHERE profile_id = ?'
    ).get(destination.id)?.id}`))).toBe(true);
    expect(restoredBySourceKey.has(remappedSourceKey(`legacy_contest_${db.prepare(
      'SELECT id FROM contest_problem_reviews WHERE profile_id = ?'
    ).get(destination.id)?.id}`))).toBe(true);

    const learnerState = db.prepare(
      'SELECT profile_id, data_json FROM learner_profile_state WHERE profile_id = ?'
    ).get(destination.id) as any;
    expect(learnerState.profile_id).toBe(destination.id);
    expect(JSON.parse(learnerState.data_json)).toEqual({
      profileId: destination.id,
      nested: { profile_id: destination.id, lesson: 'preserve learner state' },
    });

    importPublicContext(destination.id, backup);
    expect(db.prepare('SELECT COUNT(*) AS count FROM daily_sets WHERE profile_id = ?').get(destination.id)).toMatchObject({ count: 1 });
    expect(db.prepare('SELECT COUNT(*) AS count FROM daily_problems WHERE profile_id = ?').get(destination.id)).toMatchObject({ count: 1 });
    expect(db.prepare('SELECT COUNT(*) AS count FROM problem_learning_events WHERE profile_id = ?').get(destination.id)).toMatchObject({ count: 505 });

    importPublicContext(destination.id, exportPublicContext(destination.id));
    expect(db.prepare('SELECT COUNT(*) AS count FROM solve_sessions WHERE profile_id = ?').get(destination.id)).toMatchObject({ count: 1 });
    expect(db.prepare('SELECT COUNT(*) AS count FROM problem_learning_events WHERE profile_id = ?').get(destination.id)).toMatchObject({ count: 505 });
  }, 60000);

  it('rejects unauthenticated, expired, and cross-account profile access', async () => {
    const missingAuth = await request('/api/public/context', {
      headers: { 'X-Coach-Handle': HANDLE },
    });
    expect(missingAuth.status).toBe(401);

    const spoofedClientId = await request('/api/public/context', {
      headers: { 'X-Coach-Client-Id': USER_A, 'X-Coach-Handle': HANDLE },
    });
    expect(spoofedClientId.status).toBe(401);

    const expired = await request('/api/public/context', {
      headers: { Authorization: `Bearer ${makeToken(USER_A, -60)}` },
    });
    expect(expired.status).toBe(401);

    const crossAccount = await request(`/api/public/context?profileId=${encodeURIComponent(profileA.id)}`, {
      headers: headers(USER_B),
    });
    expect(crossAccount.status).toBe(403);
  });

  it('claims a legacy profile only for the authenticated user, with a safe dry-run', async () => {
    const legacy = createProfile('PublicLegacyClaim');
    db.prepare(`
      INSERT INTO daily_sets (id, profile_id, date, generated_at)
      VALUES (?, ?, '2026-04-03', '2026-04-03T00:00:00.000Z')
    `).run(`${legacy.id}_2026-04-03`, legacy.id);

    const denied = await request('/api/public/profiles/claim-legacy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ handle: 'PublicLegacyClaim', dryRun: true }),
    });
    expect(denied.status).toBe(401);

    const unverified = await request('/api/public/profiles/claim-legacy', {
      method: 'POST',
      headers: headers(USER_C, 'PublicLegacyClaim'),
      body: JSON.stringify({ profileId: legacy.id, dryRun: true }),
    });
    expect(unverified.status).toBe(403);

    const preview = await request('/api/public/profiles/claim-legacy', {
      method: 'POST',
      headers: headers(USER_C, 'PublicLegacyClaim'),
      body: JSON.stringify({
        profileId: legacy.id,
        dryRun: true,
        claimSecret: 'test-migration-secret',
      }),
    });
    expect(preview.status).toBe(200);
    expect(preview.body.dryRun).toBe(true);
    expect(preview.body.profile.ownerId).toBeNull();
    expect(preview.body.migratedCounts.daily_sets).toBe(1);

    const claimed = await request('/api/public/profiles/claim-legacy', {
      method: 'POST',
      headers: headers(USER_C, 'PublicLegacyClaim'),
      body: JSON.stringify({ profileId: legacy.id, claimSecret: 'test-migration-secret' }),
    });
    expect(claimed.status).toBe(200);
    expect(claimed.body.profile.ownerId).toBe(USER_C);
    expect(claimed.body.migrationId).toMatch(/^pom_/);
  });

  it('reports a stable instance id for restart detection', async () => {
    const first = await request('/api/public/health');
    const second = await request('/api/public/health');
    expect(first.status).toBe(200);
    expect(first.body.mode).toBe('public');
    expect(first.body.instanceId).toBe(second.body.instanceId);
  });
});
