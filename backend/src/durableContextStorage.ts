import { isSocialDatabaseConfigured, withSystemTransaction } from './socialDatabase.js';

let tableInitialized = false;
let initPromise: Promise<void> | null = null;
const inFlightSaves = new Map<string, Promise<boolean>>();

/**
 * Initializes the durable cloud storage table in Supabase PostgreSQL if not present.
 * Uses a safe IF NOT EXISTS statement.
 */
export async function initDurableContextTable(): Promise<void> {
  if (tableInitialized || !isSocialDatabaseConfigured()) return;
  if (initPromise) return initPromise;

  initPromise = (async () => {
    try {
      await withSystemTransaction(async (client) => {
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
      });
      tableInitialized = true;
    } catch (err: any) {
      console.warn('[DurableStorage] Could not initialize cloud table in Supabase PostgreSQL:', err?.message || err);
    } finally {
      initPromise = null;
    }
  })();

  return initPromise;
}

/**
 * Persists a user's full training context snapshot into Supabase PostgreSQL.
 * Deduplicated per user_id to prevent redundant parallel writes.
 */
export async function saveDurableCloudContext(
  userId: string,
  handle: string,
  contextData: unknown,
): Promise<boolean> {
  if (!isSocialDatabaseConfigured() || !userId) return false;
  await initDurableContextTable();

  if (inFlightSaves.has(userId)) {
    try {
      await inFlightSaves.get(userId);
    } catch {}
  }

  let savePromise: Promise<boolean>;
  const runSave = async (): Promise<boolean> => {
    try {
      await withSystemTransaction(async (client) => {
        await client.query(
          `INSERT INTO public.user_training_contexts (user_id, handle, context_data, updated_at, version)
           VALUES ($1, $2, $3, now(), 1)
           ON CONFLICT (user_id) DO UPDATE SET
             handle = EXCLUDED.handle,
             context_data = EXCLUDED.context_data,
             updated_at = now(),
             version = public.user_training_contexts.version + 1`,
          [userId, handle, JSON.stringify(contextData)],
        );
      });
      return true;
    } catch (err: any) {
      console.warn(`[DurableStorage] Failed to save cloud context for user ${userId}:`, err?.message || err);
      return false;
    } finally {
      if (inFlightSaves.get(userId) === savePromise) {
        inFlightSaves.delete(userId);
      }
    }
  };

  savePromise = runSave();
  inFlightSaves.set(userId, savePromise);
  return savePromise;
}

/**
 * Retrieves a user's full training context snapshot from Supabase PostgreSQL.
 */
export async function loadDurableCloudContext(userId: string): Promise<any | null> {
  if (!isSocialDatabaseConfigured() || !userId) return null;
  await initDurableContextTable();

  try {
    return await withSystemTransaction(async (client) => {
      const res = await client.query(
        'SELECT context_data FROM public.user_training_contexts WHERE user_id = $1 LIMIT 1',
        [userId],
      );
      if (res.rows.length === 0) return null;
      const data = res.rows[0].context_data;
      return typeof data === 'string' ? JSON.parse(data) : data;
    });
  } catch (err: any) {
    console.warn(`[DurableStorage] Failed to load cloud context for user ${userId}:`, err?.message || err);
    return null;
  }
}
