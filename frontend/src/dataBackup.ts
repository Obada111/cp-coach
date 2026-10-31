import { KnowledgeNote, validateKnowledgeNotes } from './knowledgeJournal';
import { isVirtualContestSession, VirtualContestSession } from './virtualContest';
import { isValidDateString, isValidTimestamp } from './timestamps';

export const BROWSER_BACKUP_FORMAT = 'cp-coach-browser-backup';
export const BROWSER_BACKUP_VERSION = 1;
export const PUBLIC_CONTEXT_VERSION = 1;

const HANDLE_PATTERN = /^[A-Za-z0-9_.-]{2,64}$/;
export const MAX_BROWSER_BACKUP_BYTES = 10 * 1024 * 1024;
const CONTEXT_ARRAY_LIMITS: Record<string, number> = {
  dailySets: 10000,
  dailyProblems: 30000,
  reviewQueue: 20000,
  solveSessions: 20000,
  contestReviews: 10000,
  userContests: 5000,
  weeklyGoals: 5000,
  learningEvents: 50000,
  problems: 50000,
  contestProblemsMeta: 50000,
};
const REQUIRED_ROW_KEYS: Record<string, string[]> = {
  dailySets: ['id'],
  dailyProblems: ['id'],
  reviewQueue: ['profile_id', 'problem_id'],
  solveSessions: ['id'],
  contestReviews: ['profile_id', 'contest_id', 'problem_index'],
  userContests: ['profile_id', 'contest_id'],
  weeklyGoals: ['profile_id', 'week_start_date'],
  learningEvents: ['id'],
  problems: ['id'],
  contestProblemsMeta: ['contest_id', 'problem_index'],
};
const TIMESTAMP_FIELDS: Record<string, string[]> = {
  dailySets: ['generated_at'],
  dailyProblems: ['updated_at', 'opened_at'],
  reviewQueue: ['added_at', 'last_reviewed_at'],
  solveSessions: ['started_at', 'ended_at', 'created_at', 'updated_at'],
  contestReviews: ['updated_at'],
  userContests: ['created_at', 'updated_at'],
  weeklyGoals: ['updated_at'],
  learningEvents: ['occurred_at'],
  problems: ['updated_at'],
};
const DATE_FIELDS: Record<string, string[]> = {
  dailySets: ['date'],
  dailyProblems: ['daily_set_date'],
  reviewQueue: ['due_date'],
  weeklyGoals: ['week_start_date'],
};

export type BackupMode = 'merge' | 'replace';

export function serverContextImportSequence(
  incomingContext: Record<string, unknown>,
  existingContext: Record<string, unknown> | null,
  mode: BackupMode
): Record<string, unknown>[] {
  return mode === 'merge' && existingContext
    ? [existingContext, incomingContext]
    : [incomingContext];
}

export interface BrowserStorageAdapter {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export class BrowserStorageTransactionError extends Error {
  constructor(
    message: string,
    readonly previousValues: Map<string, string | null>,
    readonly rollbackFailures: string[]
  ) {
    super(message);
    this.name = 'BrowserStorageTransactionError';
  }
}

function writeAndVerify(
  storage: BrowserStorageAdapter,
  key: string,
  value: string | null
): void {
  if (value === null) storage.removeItem(key);
  else storage.setItem(key, value);
  if (storage.getItem(key) !== value) {
    throw new Error(`Browser storage did not persist '${key}'.`);
  }
}

export function snapshotBrowserStorage(
  storage: BrowserStorageAdapter,
  keys: Iterable<string>
): Map<string, string | null> {
  try {
    return new Map(Array.from(keys, (key) => [key, storage.getItem(key)] as [string, string | null]));
  } catch {
    throw new Error('Could not snapshot browser storage; no data was changed.');
  }
}

export function restoreBrowserStorageValues(
  storage: BrowserStorageAdapter,
  previousValues: Map<string, string | null>
): string[] {
  const failures: string[] = [];
  for (const [key, value] of Array.from(previousValues.entries()).reverse()) {
    try {
      writeAndVerify(storage, key, value);
    } catch {
      failures.push(key);
    }
  }
  return failures;
}

export function applyBrowserStorageChanges(
  storage: BrowserStorageAdapter,
  changes: Map<string, string | null>,
  savedPreviousValues?: Map<string, string | null>
): void {
  const previousValues = savedPreviousValues
    ? new Map(Array.from(changes.keys(), (key) => {
      if (!savedPreviousValues.has(key)) {
        throw new Error(`Browser storage key '${key}' was not included in the pre-import snapshot.`);
      }
      return [key, savedPreviousValues.get(key) ?? null] as [string, string | null];
    }))
    : snapshotBrowserStorage(storage, changes.keys());

  try {
    for (const [key, value] of changes) writeAndVerify(storage, key, value);
  } catch (error) {
    const rollbackFailures = restoreBrowserStorageValues(storage, previousValues);
    const reason = error instanceof Error ? error.message : 'Unknown browser storage error';
    throw new BrowserStorageTransactionError(
      rollbackFailures.length > 0
        ? `Import failed (${reason}) and browser-storage rollback could not be verified for ${rollbackFailures.join(', ')}.`
        : `Import failed (${reason}); all previous browser-storage values were restored and verified.`,
      previousValues,
      rollbackFailures
    );
  }
}

export interface BrowserBackupProfile {
  handle: string;
  context: Record<string, unknown>;
  knowledgeNotes: KnowledgeNote[];
  virtualContests: VirtualContestSession[];
}

export interface BrowserBackup {
  format: typeof BROWSER_BACKUP_FORMAT;
  version: typeof BROWSER_BACKUP_VERSION;
  exportedAt: string;
  profiles: BrowserBackupProfile[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function validateBrowserBackup(value: unknown): BrowserBackup {
  if (!isRecord(value) || value.format !== BROWSER_BACKUP_FORMAT || value.version !== BROWSER_BACKUP_VERSION) {
    throw new Error('Unsupported backup format or schema version.');
  }
  if (!isValidTimestamp(value.exportedAt)) {
    throw new Error('Backup export timestamp is missing or invalid.');
  }
  if (!Array.isArray(value.profiles) || value.profiles.length < 1 || value.profiles.length > 10) {
    throw new Error('Backup must contain between 1 and 10 profiles.');
  }

  const seenHandles = new Set<string>();
  const profiles = value.profiles.map((entry) => {
    if (!isRecord(entry) || typeof entry.handle !== 'string' || !HANDLE_PATTERN.test(entry.handle)) {
      throw new Error('Backup contains an invalid Codeforces handle.');
    }
    const handle = entry.handle.trim();
    const canonicalHandle = handle.toLowerCase();
    if (seenHandles.has(canonicalHandle)) throw new Error(`Backup contains duplicate profile '${handle}'.`);
    seenHandles.add(canonicalHandle);

    if (!isRecord(entry.context) || entry.context.version !== PUBLIC_CONTEXT_VERSION) {
      throw new Error(`Backup context for '${handle}' has an unsupported schema version.`);
    }
    if (typeof entry.context.handle !== 'string' || entry.context.handle.toLowerCase() !== canonicalHandle) {
      throw new Error(`Backup context does not match profile '${handle}'.`);
    }
    if (entry.context.exportedAt !== undefined && !isValidTimestamp(entry.context.exportedAt)) {
      throw new Error(`Backup context for '${handle}' has an invalid export timestamp.`);
    }
    if (entry.context.profileId !== undefined && (
      typeof entry.context.profileId !== 'string' || entry.context.profileId.trim().length === 0
    )) {
      throw new Error(`Backup context for '${handle}' has an invalid source profile ID.`);
    }
    for (const [field, limit] of Object.entries(CONTEXT_ARRAY_LIMITS)) {
      const rows = entry.context[field];
      if (!Array.isArray(rows) || rows.length > limit || rows.some((row) =>
        !isRecord(row) || REQUIRED_ROW_KEYS[field].some((key) => {
          const item = row[key];
          return typeof item === 'string'
            ? item.trim().length === 0
            : typeof item !== 'number' || !Number.isFinite(item);
        }) ||
        (TIMESTAMP_FIELDS[field] || []).some((key) => row[key] !== null && row[key] !== undefined && !isValidTimestamp(row[key])) ||
        (DATE_FIELDS[field] || []).some((key) => row[key] !== null && row[key] !== undefined && !isValidDateString(row[key]))
      )) {
        throw new Error(`Backup context for '${handle}' has invalid '${field}' data.`);
      }
    }
    if (
      isRecord(entry.context.learnerState) &&
      entry.context.learnerState.updated_at !== undefined &&
      !isValidTimestamp(entry.context.learnerState.updated_at)
    ) {
      throw new Error(`Backup context for '${handle}' has an invalid learner-state timestamp.`);
    }

    const knowledgeNotes = entry.knowledgeNotes === undefined
      ? []
      : validateKnowledgeNotes(entry.knowledgeNotes);
    const virtualContests = entry.virtualContests === undefined ? [] : entry.virtualContests;
    if (
      !Array.isArray(virtualContests) ||
      virtualContests.length > 1000 ||
      !virtualContests.every((session) => isVirtualContestSession(session, handle))
    ) {
      throw new Error(`Backup contains invalid virtual contest sessions for '${handle}'.`);
    }
    return { handle, context: entry.context, knowledgeNotes, virtualContests };
  });

  const backup: BrowserBackup = {
    format: BROWSER_BACKUP_FORMAT,
    version: BROWSER_BACKUP_VERSION,
    exportedAt: value.exportedAt,
    profiles,
  };
  if (new TextEncoder().encode(JSON.stringify(backup)).byteLength > MAX_BROWSER_BACKUP_BYTES) {
    throw new Error('Backup exceeds the 10 MB safety limit.');
  }
  return backup;
}

const NATURAL_KEYS: Record<string, string[]> = {
  dailySets: ['id'],
  dailyProblems: ['id'],
  reviewQueue: ['profile_id', 'problem_id'],
  solveSessions: ['id'],
  contestReviews: ['profile_id', 'contest_id', 'problem_index'],
  userContests: ['profile_id', 'contest_id'],
  weeklyGoals: ['profile_id', 'week_start_date'],
  learningEvents: ['id'],
  problems: ['id'],
  contestProblemsMeta: ['contest_id', 'problem_index'],
};

function rowKey(row: Record<string, unknown>, fields: string[]): string {
  const key = fields.map((field) => String(row[field] ?? '')).join('\u0000');
  return key.replace(/\u0000/g, '') ? key : JSON.stringify(row);
}

export function mergeBrowserContexts(
  existing: Record<string, unknown>,
  incoming: Record<string, unknown>
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...existing, ...incoming };
  for (const [field, keys] of Object.entries(NATURAL_KEYS)) {
    const rows = new Map<string, Record<string, unknown>>();
    const oldRows = Array.isArray(existing[field]) ? existing[field] as Record<string, unknown>[] : [];
    const newRows = Array.isArray(incoming[field]) ? incoming[field] as Record<string, unknown>[] : [];
    for (const row of oldRows) rows.set(rowKey(row, keys), row);
    for (const row of newRows) rows.set(rowKey(row, keys), row);
    merged[field] = Array.from(rows.values());
  }
  return merged;
}
