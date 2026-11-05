import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  db,
  getOrCreatePublicProfile,
  initDatabase,
} from '../db.js';
import { publicRouter } from '../publicRoutes.js';

const USER_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const USER_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const HANDLE_A = 'UserA_Handle';
const HANDLE_B = 'UserB_Handle';

let server: Server;
let baseUrl: string;
const appFetch = globalThis.fetch.bind(globalThis);
let profileA: ReturnType<typeof getOrCreatePublicProfile>;
let profileB: ReturnType<typeof getOrCreatePublicProfile>;

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

function userHeaders(userId: string, handle?: string, extraHeaders: Record<string, string> = {}): Record<string, string> {
  const h: Record<string, string> = {
    Authorization: `Bearer ${makeToken(userId)}`,
    'Content-Type': 'application/json',
    ...extraHeaders,
  };
  if (handle) {
    h['X-Coach-Handle'] = handle;
  }
  return h;
}

async function apiRequest(path: string, init: RequestInit = {}) {
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

beforeAll(async () => {
  initDatabase();
  const app = express();
  app.use(express.json({ limit: '10mb' }));
  app.use('/api/public', publicRouter);

  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => resolve());
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  profileA = getOrCreatePublicProfile(USER_A, HANDLE_A);
  profileB = getOrCreatePublicProfile(USER_B, HANDLE_B);

  // Seed sample training data for User B
  const date = '2026-06-01';
  const setIdB = `${profileB.id}_${date}`;
  const problemId = '100_B';
  const dailyProblemIdB = `${profileB.id}_${date}_drill`;

  db.prepare(`
    INSERT OR IGNORE INTO problems (id, contest_id, problem_index, name, rating, tags)
    VALUES (?, 100, 'B', 'Test Multiuser Problem', 1300, '["implementation"]')
  `).run(problemId);

  db.prepare(`
    INSERT OR REPLACE INTO daily_sets (id, profile_id, date, generated_at)
    VALUES (?, ?, ?, '2026-06-01T08:00:00.000Z')
  `).run(setIdB, profileB.id, date);

  db.prepare(`
    INSERT OR REPLACE INTO daily_problems (
      id, daily_set_id, profile_id, daily_set_date, problem_id, category,
      reason, target_rating, completed, notes, updated_at
    ) VALUES (
      ?, ?, ?, ?, ?, 'WEAKNESS_DRILL',
      'User B training reason', 1300, 1, 'Secret User B Notes', '2026-06-01T09:00:00.000Z'
    )
  `).run(dailyProblemIdB, setIdB, profileB.id, date, problemId);

  db.prepare(`
    INSERT OR REPLACE INTO weekly_goals (id, profile_id, week_start_date, target_solves, notes, updated_at)
    VALUES (?, ?, '2026-06-01', 7, 'User B secret weekly goal', '2026-06-01T08:00:00.000Z')
  `).run(`goal_${profileB.id}_2026-06-01`, profileB.id);
});

afterAll(async () => {
  if (server) {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  }
});

describe('Blocker 3: Full Multi-User Security & Data Isolation', () => {
  it('User A cannot retrieve User B\'s training records (403 Forbidden)', async () => {
    const res = await apiRequest(`/api/public/context?profileId=${encodeURIComponent(profileB.id)}`, {
      headers: userHeaders(USER_A, HANDLE_A),
    });
    expect(res.status).toBe(403);
    expect(res.body.error).toContain('Forbidden');
  });

  it('User A cannot change User B\'s training history or problem feedback', async () => {
    const dailyProblemIdB = `${profileB.id}_2026-06-01_drill`;
    const res = await apiRequest(`/api/public/problems/${encodeURIComponent(dailyProblemIdB)}/feedback`, {
      method: 'POST',
      headers: userHeaders(USER_A, HANDLE_A),
      body: JSON.stringify({
        solvedStatus: 'SOLVED_INDEPENDENTLY',
        notes: 'Malicious modification by User A',
      }),
    });
    // Must be rejected (either 404 daily problem not found in user A scope, or 403 forbidden)
    expect([403, 404]).toContain(res.status);

    // Verify User B's data remains uncorrupted
    const bProblem = db.prepare('SELECT notes FROM daily_problems WHERE id = ?').get(dailyProblemIdB) as any;
    expect(bProblem.notes).toBe('Secret User B Notes');
  });

  it('User A cannot access User B\'s recommendations', async () => {
    const res = await apiRequest(`/api/public/daily?profileId=${encodeURIComponent(profileB.id)}`, {
      headers: userHeaders(USER_A, HANDLE_A),
    });
    expect(res.status).toBe(403);
  });

  it('User A cannot modify User B\'s weekly goals', async () => {
    const res = await apiRequest('/api/public/goals', {
      method: 'POST',
      headers: userHeaders(USER_A, HANDLE_A),
      body: JSON.stringify({
        profileId: profileB.id,
        weekStartDate: '2026-06-01',
        targetSolves: 999,
        notes: 'Tampered goal',
      }),
    });
    expect(res.status).toBe(403);

    // Verify User B's goal target is still 7
    const bGoal = db.prepare('SELECT target_solves FROM weekly_goals WHERE profile_id = ?').get(profileB.id) as any;
    expect(bGoal.target_solves).toBe(7);
  });

  it('User A cannot access User B\'s notification settings', async () => {
    const res = await apiRequest(`/api/public/notifications/settings?profileId=${encodeURIComponent(profileB.id)}`, {
      headers: userHeaders(USER_A, HANDLE_A),
    });
    expect(res.status).toBe(403);
  });

  it('User A cannot register subscriptions for User B', async () => {
    const res = await apiRequest('/api/public/notifications/subscriptions', {
      method: 'POST',
      headers: userHeaders(USER_A, HANDLE_A),
      body: JSON.stringify({
        profileId: profileB.id,
        subscription: {
          endpoint: 'https://push.example.com/malicious-sub',
          keys: { p256dh: 'dummy-p256dh', auth: 'dummy-auth' },
        },
      }),
    });
    expect(res.status).toBe(403);
  });

  it('Changing client IDs or spoofing X-Coach-Client-Id cannot bypass authorization', async () => {
    // User A passes User B's ID in X-Coach-Client-Id header, but has User A's token
    const res = await apiRequest(`/api/public/context?profileId=${encodeURIComponent(profileB.id)}`, {
      headers: userHeaders(USER_A, HANDLE_A, {
        'X-Coach-Client-Id': USER_B,
      }),
    });
    // The server must derive identity from verified JWT sub, NOT client header
    expect(res.status).toBe(403);
  });

  it('Expired sessions are rejected with 401', async () => {
    const res = await apiRequest('/api/public/profiles', {
      headers: {
        Authorization: `Bearer ${makeToken(USER_A, -120)}`,
        'Content-Type': 'application/json',
      },
    });
    expect(res.status).toBe(401);
  });

  it('Missing authentication is rejected on protected routes with 401', async () => {
    const res = await apiRequest('/api/public/profiles', {
      headers: {
        'X-Coach-Handle': HANDLE_A,
      },
    });
    expect(res.status).toBe(401);
  });

  it('Account switching cannot leak previously cached data between users', async () => {
    // Request User A's context
    const resA = await apiRequest('/api/public/context', {
      headers: userHeaders(USER_A, HANDLE_A),
    });
    expect(resA.status).toBe(200);
    expect(resA.body.profile.handle).toBe(HANDLE_A);

    // Request User B's context
    const resB = await apiRequest('/api/public/context', {
      headers: userHeaders(USER_B, HANDLE_B),
    });
    expect(resB.status).toBe(200);
    expect(resB.body.profile.handle).toBe(HANDLE_B);
    expect(resB.body.dailyProblems.some((p: any) => p.notes === 'Secret User B Notes')).toBe(true);

    // Verify User A context never includes User B's notes or sets
    expect(resA.body.dailyProblems.some((p: any) => p.notes === 'Secret User B Notes')).toBe(false);
  });
});

