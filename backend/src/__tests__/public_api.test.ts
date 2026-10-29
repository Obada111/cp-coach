import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db, getOrCreatePublicProfile, getPublicProfileId, initDatabase } from '../db.js';
import { publicRouter } from '../publicRoutes.js';

const CLIENT_A = 'clientA1234567890';
const CLIENT_B = 'clientB1234567890';
const HANDLE = 'PublicTestUser';

let server: Server;
let baseUrl: string;
let profileA: ReturnType<typeof getOrCreatePublicProfile>;
let profileB: ReturnType<typeof getOrCreatePublicProfile>;

async function request(path: string, init: RequestInit = {}) {
  const response = await fetch(`${baseUrl}${path}`, init);
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

function headers(clientId: string, handle = HANDLE): Record<string, string> {
  return {
    'X-Coach-Client-Id': clientId,
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
  app.use(express.json({ limit: '1mb' }));
  app.use('/api/public', publicRouter);
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => resolve());
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  profileA = getOrCreatePublicProfile(CLIENT_A, HANDLE);
  profileB = getOrCreatePublicProfile(CLIENT_B, HANDLE);
});

afterAll(async () => {
  if (server) {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
});

describe('public API tenant isolation', () => {
  it('gives the same handle different deterministic profiles per browser', () => {
    expect(profileA.id).not.toBe(profileB.id);
    expect(profileA.id).toBe(getPublicProfileId(CLIENT_A, HANDLE));
    expect(profileB.id).toBe(getPublicProfileId(CLIENT_B, HANDLE));
  });

  it('lists only the requesting browser profiles', async () => {
    const a = await request('/api/public/profiles', { headers: headers(CLIENT_A) });
    expect(a.status).toBe(200);
    expect(a.body.profiles.map((profile: any) => profile.id)).toEqual([profileA.id]);

    const b = await request('/api/public/profiles', { headers: headers(CLIENT_B) });
    expect(b.status).toBe(200);
    expect(b.body.profiles.map((profile: any) => profile.id)).toEqual([profileB.id]);
  });

  it('round-trips browser context without exposing it to another browser', async () => {
    const snapshot = makeContext(profileA, 'private note A');
    const imported = await request('/api/public/context', {
      method: 'POST',
      headers: headers(CLIENT_A),
      body: JSON.stringify({ context: snapshot }),
    });
    expect(imported.status).toBe(200);
    expect(imported.body.imported).toBe(true);
    expect(imported.body.counts.dailySets).toBe(1);
    expect(imported.body.counts.dailyProblems).toBe(1);

    const aContext = await request('/api/public/context', { headers: headers(CLIENT_A) });
    expect(aContext.status).toBe(200);
    expect(aContext.body.dailyProblems[0].notes).toBe('private note A');

    const bContext = await request('/api/public/context', { headers: headers(CLIENT_B) });
    expect(bContext.status).toBe(200);
    expect(bContext.body.dailyProblems).toHaveLength(0);
  });

  it('restores feedback onto an already-existing daily set', async () => {
    const updated = makeContext(profileA, 'updated note A');
    updated.dailyProblems[0].updated_at = '2026-01-02T00:00:00.000Z';
    const imported = await request('/api/public/context', {
      method: 'POST',
      headers: headers(CLIENT_A),
      body: JSON.stringify({ context: updated }),
    });
    expect(imported.status).toBe(200);
    expect(imported.body.counts.dailyProblems).toBe(1);

    const aContext = await request('/api/public/context', { headers: headers(CLIENT_A) });
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
      headers: headers(CLIENT_B),
      body: JSON.stringify({ context: snapshot }),
    });
    expect(imported.status).toBe(200);
    expect(imported.body.counts.reviewQueue || 0).toBe(0);

    const owner = db.prepare('SELECT profile_id FROM review_queue WHERE id = ?').get('shared-review-id') as any;
    expect(owner.profile_id).toBe(profileA.id);
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
      headers: headers(CLIENT_A),
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
      headers: headers(CLIENT_A),
      body: JSON.stringify({ context: second }),
    });
    expect(secondImport.status).toBe(200);

    const goals = db.prepare(
      'SELECT id, target_solves FROM weekly_goals WHERE profile_id = ? AND week_start_date = ?'
    ).all(profileA.id, '2026-01-05') as any[];
    expect(goals).toHaveLength(1);
    expect(goals[0].id).toBe('goal-original');
    expect(goals[0].target_solves).toBe(12);
  });

  it('requires both a client id and a handle for personal routes', async () => {
    const missingClient = await request('/api/public/context', {
      headers: { 'X-Coach-Handle': HANDLE },
    });
    expect(missingClient.status).toBe(400);

    const missingHandle = await request('/api/public/context', {
      headers: { 'X-Coach-Client-Id': CLIENT_A },
    });
    expect(missingHandle.status).toBe(400);
  });

  it('reports a stable instance id for restart detection', async () => {
    const first = await request('/api/public/health');
    const second = await request('/api/public/health');
    expect(first.status).toBe(200);
    expect(first.body.mode).toBe('public');
    expect(first.body.instanceId).toBe(second.body.instanceId);
  });
});
