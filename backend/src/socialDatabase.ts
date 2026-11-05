import { Pool, type PoolClient } from 'pg';
import type { AuthenticatedSocialUser } from './socialAuth.js';

export type SocialQuery = PoolClient;

let pool: Pool | null = null;

export class SocialDatabaseConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SocialDatabaseConfigurationError';
  }
}

function getPool(): Pool {
  const connectionString = process.env.DATABASE_URL?.trim();
  if (!connectionString) {
    throw new SocialDatabaseConfigurationError('Social PostgreSQL is not configured.');
  }
  if (!pool) {
    pool = new Pool({
      connectionString,
      max: 5,
      idleTimeoutMillis: 10_000,
      connectionTimeoutMillis: 5_000,
      keepAlive: true,
      ssl: { rejectUnauthorized: true },
    });
    pool.on('error', () => {
      console.error('[SocialDB] An idle PostgreSQL connection failed.');
    });
  }
  return pool;
}

export async function withUserTransaction<T>(
  user: AuthenticatedSocialUser,
  operation: (client: SocialQuery) => Promise<T>,
): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL ROLE authenticated');
    const claims = { ...user.claims, sub: user.userId, role: 'authenticated' };
    await client.query(
      `SELECT
        set_config('request.jwt.claims', $1, true),
        set_config('request.jwt.claim.sub', $2, true),
        set_config('request.jwt.claim.role', 'authenticated', true),
        set_config('app.cp_coach_backend', 'true', true)`,
      [JSON.stringify(claims), user.userId],
    );
    const result = await operation(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      console.error('[SocialDB] Could not roll back a failed social transaction.');
    }
    throw error;
  } finally {
    client.release();
  }
}

export async function withSystemTransaction<T>(
  operation: (client: SocialQuery) => Promise<T>,
): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const result = await operation(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      console.error('[SocialDB] Could not roll back a background social transaction.');
    }
    throw error;
  } finally {
    client.release();
  }
}

export async function closeSocialDatabase(): Promise<void> {
  if (!pool) return;
  const activePool = pool;
  pool = null;
  await activePool.end();
}

export function isSocialDatabaseConfigured(): boolean {
  return Boolean(process.env.DATABASE_URL?.trim());
}
