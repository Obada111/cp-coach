import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Never let automated tests open the user's configured database. The test
// suite intentionally clears tables between cases, so it must always use an
// isolated per-process SQLite directory.
const testDbDir = path.join(os.tmpdir(), `cp-coach-vitest-${process.pid}`);
fs.mkdirSync(testDbDir, { recursive: true });
process.env.DB_DIR = testDbDir;

process.once('exit', () => {
  try {
    fs.rmSync(testDbDir, { recursive: true, force: true });
  } catch {
    // The test process is already exiting; cleanup failure must not mask a
    // test result.
  }
});
