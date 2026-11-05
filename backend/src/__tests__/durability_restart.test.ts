import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, describe, expect, it } from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BACKEND_ROOT = path.resolve(__dirname, '../..');
const TSX_CLI = path.resolve(BACKEND_ROOT, 'node_modules/tsx/dist/cli.mjs');
const USER_ID = 'edededed-eded-4ded-8ded-edededededed';
const HANDLE = 'RestartPersistence';
const tempDir = path.join(BACKEND_ROOT, `.tmp-restart-test-${process.pid}`);

function makeToken(userId: string): string {
  const encode = (value: Record<string, unknown>) =>
    Buffer.from(JSON.stringify(value)).toString('base64url');
  return [
    encode({ alg: 'none', typ: 'JWT' }),
    encode({
      sub: userId,
      role: 'authenticated',
      aud: 'authenticated',
      exp: Math.floor(Date.now() / 1000) + 600,
    }),
    'test-signature',
  ].join('.');
}

async function findFreePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as net.AddressInfo).port;
      server.close(() => resolve(port));
    });
  });
}

async function waitForHealth(baseUrl: string): Promise<void> {
  const deadline = Date.now() + 30_000;
  let lastError: unknown = null;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/api/public/health`, { cache: 'no-store' });
      if (response.ok) return;
      lastError = new Error(`Health returned ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`Backend did not become healthy: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  if (process.platform === 'win32' && child.pid) {
    spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  } else {
    child.kill('SIGTERM');
  }
  if (child.exitCode !== null) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, 5_000);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

async function startBackend(port: number): Promise<{ child: ChildProcess; baseUrl: string; logs: string[] }> {
  const logs: string[] = [];
  const child = spawn(process.execPath, [TSX_CLI, 'src/index.ts'], {
    cwd: BACKEND_ROOT,
    env: {
      ...process.env,
      DB_DIR: tempDir,
      DB_BACKUP_DIR: path.join(tempDir, 'backups'),
      PORT: String(port),
      HOST: '127.0.0.1',
      NODE_ENV: 'test',
      PUBLIC_MODE: 'true',
      DATABASE_MAINTENANCE_DISABLED: 'true',
      SUPABASE_URL: '',
      SUPABASE_ANON_KEY: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  child.stdout?.on('data', (chunk: Buffer) => logs.push(chunk.toString('utf8')));
  child.stderr?.on('data', (chunk: Buffer) => logs.push(chunk.toString('utf8')));
  const baseUrl = `http://127.0.0.1:${port}`;
  try {
    await waitForHealth(baseUrl);
  } catch (error) {
    await stopChild(child);
    throw new Error(`${error instanceof Error ? error.message : String(error)}\n${logs.join('')}`);
  }
  return { child, baseUrl, logs };
}

afterAll(() => {
  try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
});

describe('durable SQLite persistence across real backend restarts', () => {
  it('serves the same private context after the backend process is stopped and started again', async () => {
    fs.rmSync(tempDir, { recursive: true, force: true });
    fs.mkdirSync(tempDir, { recursive: true });
    const port = await findFreePort();

    const first = await startBackend(port);
    await stopChild(first.child);

    const dbPath = path.join(tempDir, 'cp_coach.db');
    expect(fs.existsSync(dbPath)).toBe(true);
    const seedDb = new DatabaseSync(dbPath);
    try {
      seedDb.exec('BEGIN IMMEDIATE;');
      seedDb.prepare(`
        INSERT INTO profiles (id, handle, owner_id, display_name, is_default)
        VALUES (?, ?, ?, ?, 0)
      `).run('prof_restart_persistence', HANDLE, USER_ID, HANDLE);
      seedDb.prepare(`
        INSERT INTO problems (id, contest_id, problem_index, name, type, rating, tags, solved_count)
        VALUES ('9001_A', 9001, 'A', 'Persistence Problem', 'PROGRAMMING', 1200, '["dp"]', 10)
      `).run();
      seedDb.prepare(`
        INSERT INTO daily_sets (id, profile_id, date, generated_at)
        VALUES ('persist-set-1', 'prof_restart_persistence', '2026-05-01', '2026-05-01T00:00:00.000Z')
      `).run();
      seedDb.prepare(`
        INSERT INTO daily_problems (
          id, daily_set_id, profile_id, daily_set_date, problem_id, category,
          reason, target_rating, completed, notes, updated_at
        ) VALUES (
          'persist-problem-1', 'persist-set-1', 'prof_restart_persistence', '2026-05-01',
          '9001_A', 'WEAKNESS_DRILL', 'Persistence test', 1200, 0,
          'persisted after restart', '2026-05-01T00:00:00.000Z'
        )
      `).run();
      seedDb.exec('COMMIT;');
    } finally {
      seedDb.close();
    }

    const second = await startBackend(port);
    try {
      const response = await fetch(
        `${second.baseUrl}/api/public/context`,
        {
          headers: {
            Authorization: `Bearer ${makeToken(USER_ID)}`,
            'X-Coach-Handle': HANDLE,
          },
          cache: 'no-store',
        },
      );
      expect(response.status).toBe(200);
      const body = await response.json() as any;
      expect(body.dailySets.some((set: any) => set.id === 'persist-set-1')).toBe(true);
      expect(body.dailyProblems.find((problem: any) => problem.id === 'persist-problem-1')?.notes)
        .toBe('persisted after restart');

      const health = await fetch(`${second.baseUrl}/api/public/health`).then((item) => item.json()) as any;
      expect(health.database.durableStorage).toBe(true);
    } finally {
      await stopChild(second.child);
    }
  }, 90_000);
});
