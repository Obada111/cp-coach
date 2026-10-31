import { 
  DashboardOverview, 
  DailySet, 
  FeedbackPayload, 
  DailyProblem, 
  SyncStatus, 
  UserProfile,
  TrainingPlan,
  SkillTrack,
  ReviewQueueItem,
  ReviewQueueSummary,
  SolveSession,
  SessionAnalytics,
  WeeklyGoal
  ,ProblemLearningEvent
  ,WeeklyCoachReport
} from './types';
import {
  BackupMode,
  BrowserBackup,
  BROWSER_BACKUP_FORMAT,
  BROWSER_BACKUP_VERSION,
  BrowserStorageTransactionError,
  MAX_BROWSER_BACKUP_BYTES,
  applyBrowserStorageChanges,
  restoreBrowserStorageValues,
  serverContextImportSequence,
  snapshotBrowserStorage,
  validateBrowserBackup,
} from './dataBackup';
import {
  knowledgeNotesStorageKey,
  mergeKnowledgeNotes,
  readKnowledgeNotes,
} from './knowledgeJournal';
import {
  listVirtualContestSessions,
  virtualContestStorageKey,
} from './virtualContest';
import { recordRequest } from './perf';

const FALLBACK_PUBLIC_API_ORIGIN = 'https://cp-coach-api-9wk2.onrender.com';
const configuredApiOrigin = ((import.meta.env.VITE_API_BASE_URL as string | undefined) || '').trim().replace(/\/+$/, '');
const isVercelHost = typeof window !== 'undefined' && /(^|\.)vercel\.app$/i.test(window.location.hostname);
const API_ORIGIN = configuredApiOrigin || (isVercelHost ? FALLBACK_PUBLIC_API_ORIGIN : '');
export const isPublicMode = import.meta.env.VITE_PUBLIC_MODE === 'true' || Boolean(API_ORIGIN);
const API_BASE = `${API_ORIGIN}${isPublicMode ? '/api/public' : '/api'}`;

const CLIENT_ID_KEY = 'cp-coach:client-id:v1';
const HANDLES_KEY = 'cp-coach:handles:v1';
const ACTIVE_HANDLE_KEY = 'cp-coach:active-handle:v1';
const CONTEXT_PREFIX = 'cp-coach:context:v1:';
const SERVER_INSTANCE_KEY = 'cp-coach:server-instance:v1';
const OFFLINE_SNAPSHOT_KEY = 'cp-coach:offline-dashboard:v1';
const HANDLE_PATTERN = /^[A-Za-z0-9_.-]{2,64}$/;
const inFlightPublicRequests = new Map<string, Promise<Response>>();

function readStorage(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStorage(key: string, value: string): boolean {
  try {
    window.localStorage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

function removeStorage(key: string): void {
  try {
    window.localStorage.removeItem(key);
  } catch {
    // Storage may be unavailable in private modes.
  }
}

function randomClientId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  const bytes = new Uint8Array(16);
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  }
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function getOrCreateClientId(): string {
  let clientId = readStorage(CLIENT_ID_KEY);
  if (!clientId || !/^[A-Za-z0-9_-]{16,128}$/.test(clientId)) {
    clientId = randomClientId();
    writeStorage(CLIENT_ID_KEY, clientId);
  }
  return clientId;
}

export function getSavedHandles(): string[] {
  const raw = readStorage(HANDLES_KEY);
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return Array.from(new Set(
      parsed
        .filter((handle): handle is string => typeof handle === 'string' && HANDLE_PATTERN.test(handle.trim()))
        .map((handle) => handle.trim())
    )).slice(0, 10);
  } catch {
    return [];
  }
}

function saveHandle(handle: string): void {
  const clean = handle.trim();
  if (!HANDLE_PATTERN.test(clean)) return;
  const handles = getSavedHandles();
  if (!handles.some((item) => item.toLowerCase() === clean.toLowerCase())) {
    handles.push(clean);
    writeStorage(HANDLES_KEY, JSON.stringify(handles.slice(0, 10)));
  }
}

export function getPublicHandle(): string | null {
  const active = readStorage(ACTIVE_HANDLE_KEY);
  if (active && HANDLE_PATTERN.test(active)) return active;
  return getSavedHandles()[0] || null;
}

export function setPublicHandle(handle: string): void {
  const clean = handle.trim();
  if (!HANDLE_PATTERN.test(clean)) return;
  saveHandle(clean);
  writeStorage(ACTIVE_HANDLE_KEY, clean);
  currentHandle = clean;
}

export function removeSavedHandle(handle: string): void {
  const clean = handle.trim().toLowerCase();
  const remaining = getSavedHandles().filter((item) => item.toLowerCase() !== clean);
  writeStorage(HANDLES_KEY, JSON.stringify(remaining));
  if (getPublicHandle()?.toLowerCase() === clean) {
    if (remaining[0]) writeStorage(ACTIVE_HANDLE_KEY, remaining[0]);
    else removeStorage(ACTIVE_HANDLE_KEY);
  }
  removeStorage(`${CONTEXT_PREFIX}${clean}`);
}

export function clearPublicLocalData(): void {
  for (const handle of getSavedHandles()) {
    removeStorage(`${CONTEXT_PREFIX}${handle.toLowerCase()}`);
  }
  removeStorage(HANDLES_KEY);
  removeStorage(ACTIVE_HANDLE_KEY);
  currentHandle = null;
}

function publicHeaders(handle: string | null = currentHandle): Record<string, string> {
  const headers: Record<string, string> = {
    'X-Coach-Client-Id': getOrCreateClientId(),
  };
  if (handle) headers['X-Coach-Handle'] = handle;
  return headers;
}

let currentHandle: string | null = getPublicHandle();
let lastProfiles: UserProfile[] = [];
const profileHandleById = new Map<string, string>();
let captureTimer: ReturnType<typeof setTimeout> | null = null;
let captureInFlight: Promise<void> | null = null;

function rememberProfiles(profiles: UserProfile[]): void {
  lastProfiles = profiles;
  for (const profile of profiles) {
    profileHandleById.set(profile.id, profile.handle);
    saveHandle(profile.handle);
  }
}

function countPersonalRows(snapshot: any): number {
  if (!snapshot || typeof snapshot !== 'object') return 0;
  return [
    'dailySets', 'dailyProblems', 'reviewQueue', 'solveSessions',
    'contestReviews', 'userContests', 'weeklyGoals', 'learningEvents',
  ].reduce((total, key) => total + (Array.isArray(snapshot[key]) ? snapshot[key].length : 0), 0);
}

function writeContext(handle: string, snapshot: any): void {
  const key = `${CONTEXT_PREFIX}${handle.trim().toLowerCase()}`;

  // Never replace a richer local snapshot with an empty server snapshot. This
  // can happen if a health check misses a restart and the first dashboard
  // request lands on a fresh ephemeral database. Keeping the local snapshot
  // lets the next refresh restore it.
  const existingRaw = readStorage(key);
  if (existingRaw && countPersonalRows(snapshot) === 0) {
    try {
      if (countPersonalRows(JSON.parse(existingRaw)) > 0) return;
    } catch {
      // Corrupt local data can be replaced by the server snapshot.
    }
  }

  const value = JSON.stringify(snapshot);
  if (!writeStorage(key, value) || readStorage(key) !== value) {
    console.warn(`Could not persist the complete training snapshot for '${handle}'; the previous snapshot was kept.`);
  }
}

const CONTEXT_CAPTURE_INTERVAL_MS = 5 * 60 * 1000;
const CONTEXT_CAPTURE_AT_PREFIX = 'cp-coach:context-captured-at:v1:';
const lastContextCaptureAt = new Map<string, number>();

function readLastContextCaptureAt(captureKey: string): number {
  const cached = lastContextCaptureAt.get(captureKey);
  if (cached !== undefined) return cached;
  const stored = Number(readStorage(`${CONTEXT_CAPTURE_AT_PREFIX}${captureKey}`) || 0);
  const timestamp = Number.isFinite(stored) ? stored : 0;
  lastContextCaptureAt.set(captureKey, timestamp);
  return timestamp;
}

function rememberContextCapture(captureKey: string): void {
  const timestamp = Date.now();
  lastContextCaptureAt.set(captureKey, timestamp);
  writeStorage(`${CONTEXT_CAPTURE_AT_PREFIX}${captureKey}`, String(timestamp));
}

export async function capturePublicContext(
  handle: string | null = currentHandle,
  options: { force?: boolean } = {}
): Promise<void> {
  if (!isPublicMode || !handle) return;
  if (captureInFlight) return captureInFlight;

  const captureKey = handle.trim().toLowerCase();
  const lastCaptureAt = readLastContextCaptureAt(captureKey);
  if (!options.force && Date.now() - lastCaptureAt < CONTEXT_CAPTURE_INTERVAL_MS) return;

  const task = (async () => {
    try {
      const res = await globalThis.fetch(`${API_BASE}/context`, { headers: publicHeaders(handle) });
      if (!res.ok) {
        console.warn(`Could not capture the complete training snapshot for '${handle}': server returned ${res.status}.`);
        return;
      }
      const snapshot = await res.json();
      writeContext(handle, snapshot);
      rememberContextCapture(captureKey);
    } catch (error) {
      console.warn(`Could not capture the complete training snapshot for '${handle}'; a later refresh will retry.`, error);
    }
  })();

  captureInFlight = task.finally(() => {
    captureInFlight = null;
  });
  return captureInFlight;
}

let instanceCheck: Promise<boolean> | null = null;
let lastInstanceCheckAt = 0;
let pendingServerInstanceId: string | null = null;

function acknowledgeServerInstance(): void {
  if (pendingServerInstanceId) {
    writeStorage(SERVER_INSTANCE_KEY, pendingServerInstanceId);
    pendingServerInstanceId = null;
  }
  lastInstanceCheckAt = Date.now();
}

export async function restorePublicContext(
  handle: string,
  mode: BackupMode = 'merge'
): Promise<{ restored: boolean; failed?: boolean; counts?: Record<string, number> }> {
  if (!isPublicMode) return { restored: false };
  const key = `${CONTEXT_PREFIX}${handle.trim().toLowerCase()}`;
  const raw = readStorage(key);
  if (!raw) {
    acknowledgeServerInstance();
    return { restored: false };
  }

  let context: unknown;
  try {
    context = JSON.parse(raw);
  } catch {
    acknowledgeServerInstance();
    return { restored: false };
  }

  try {
    const res = await globalThis.fetch(`${API_BASE}/context`, {
      method: 'POST',
      headers: {
        ...publicHeaders(handle),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ context, mode }),
    });
    if (!res.ok) return { restored: false, failed: true };
    const data = await res.json().catch(() => ({}));
    acknowledgeServerInstance();
    return { restored: true, counts: data.counts };
  } catch {
    return { restored: false, failed: true };
  }
}

/**
 * Detect a backend restart (Render free instances lose their ephemeral DB).
 * When the instance changes, the caller re-uploads this browser's snapshot
 * before loading the dashboard. The new instance ID is only acknowledged after
 * a successful restore, so a transient failure is retried instead of silently
 * replacing the local snapshot with an empty dashboard.
 */
export async function serverRestarted(): Promise<boolean> {
  if (!isPublicMode) return false;
  if (instanceCheck) return instanceCheck;
  if (Date.now() - lastInstanceCheckAt < 15_000) return false;

  instanceCheck = (async () => {
    try {
      const res = await globalThis.fetch(`${API_BASE}/health`, { cache: 'no-store' });
      if (!res.ok) return false;
      const data = await res.json();
      const instanceId = typeof data.instanceId === 'string' ? data.instanceId : '';
      if (!instanceId) return false;
      const previous = readStorage(SERVER_INSTANCE_KEY);
      if (!previous) {
        writeStorage(SERVER_INSTANCE_KEY, instanceId);
        lastInstanceCheckAt = Date.now();
        return false;
      }
      if (previous === instanceId) {
        lastInstanceCheckAt = Date.now();
        return false;
      }
      pendingServerInstanceId = instanceId;
      return true;
    } catch {
      return false;
    } finally {
      instanceCheck = null;
    }
  })();

  return instanceCheck;
}

export function getContextSavedAt(handle: string): string | null {
  const raw = readStorage(`${CONTEXT_PREFIX}${handle.trim().toLowerCase()}`);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed.exportedAt === 'string' ? parsed.exportedAt : null;
  } catch {
    return null;
  }
}

export interface OfflineDashboardSnapshot {
    savedAt: string;
    data: DashboardOverview;
    history: DailySet[];
    journal: ProblemLearningEvent[];
    dueReviews: ReviewQueueItem[];
    reviewSummary: ReviewQueueSummary | null;
    weeklyGoal: WeeklyGoal | null;
  }

  export function saveOfflineDashboard(snapshot: OfflineDashboardSnapshot): void {
      const handle = snapshot.data.activeProfile?.handle?.trim().toLowerCase();
      const key = handle ? `${OFFLINE_SNAPSHOT_KEY}:${handle}` : OFFLINE_SNAPSHOT_KEY;
      writeStorage(key, JSON.stringify(snapshot));
    }

    export function readOfflineDashboard(handle = isPublicMode ? getPublicHandle() : null): OfflineDashboardSnapshot | null {
      if (isPublicMode && !handle) return null;
      const scopedKey = handle
        ? `${OFFLINE_SNAPSHOT_KEY}:${handle.trim().toLowerCase()}`
        : OFFLINE_SNAPSHOT_KEY;
      const raw = readStorage(scopedKey) || (handle ? readStorage(OFFLINE_SNAPSHOT_KEY) : null);
      if (!raw) return null;
      try {
        const snapshot: unknown = JSON.parse(raw);
      if (
        !snapshot ||
        typeof snapshot !== 'object' ||
        typeof (snapshot as OfflineDashboardSnapshot).savedAt !== 'string' ||
        !(snapshot as OfflineDashboardSnapshot).data?.activeProfile ||
        !Array.isArray((snapshot as OfflineDashboardSnapshot).history)
      ) {
        return null;
      }
      if (
        handle &&
        (snapshot as OfflineDashboardSnapshot).data.activeProfile.handle.toLowerCase() !== handle.trim().toLowerCase()
      ) {
        return null;
      }
      return snapshot as OfflineDashboardSnapshot;
    } catch {
      return null;
    }
  }

  export async function exportBrowserData(): Promise<BrowserBackup> {
    if (!isPublicMode) {
      throw new Error('Browser data export is available in public browser-local mode only.');
    }

    const handles = Array.from(new Set(
      [...getSavedHandles(), ...(currentHandle ? [currentHandle] : [])]
        .map((handle) => handle.trim())
        .filter((handle) => HANDLE_PATTERN.test(handle))
    )).slice(0, 10);
    if (handles.length === 0) throw new Error('There is no browser-local profile data to export yet.');

    const profiles = [];
    for (const handle of handles) {
      const response = await globalThis.fetch(`${API_BASE}/context`, {
        headers: publicHeaders(handle),
        cache: 'no-store',
      });
      if (!response.ok) {
        throw new Error(`Could not retrieve the complete server backup for '${handle}' (HTTP ${response.status}). Connect and retry; no partial backup was exported.`);
      }
      const context: unknown = await response.json();
      if (
        !context ||
        typeof context !== 'object' ||
        (context as Record<string, unknown>).version !== 1 ||
        typeof (context as Record<string, unknown>).handle !== 'string' ||
        String((context as Record<string, unknown>).handle).toLowerCase() !== handle.toLowerCase()
      ) {
        throw new Error(`The server returned an incomplete or invalid backup for '${handle}'.`);
      }
      profiles.push({
        handle,
        context: context as Record<string, unknown>,
        knowledgeNotes: readKnowledgeNotes(handle),
        virtualContests: listVirtualContestSessions(handle),
      });
    }

    if (profiles.length === 0) {
      throw new Error('No saved learning data was found. Connect to the service and try again.');
    }
    const backup = {
      format: BROWSER_BACKUP_FORMAT,
      version: BROWSER_BACKUP_VERSION,
      exportedAt: new Date().toISOString(),
      profiles,
    };
    const validated = validateBrowserBackup(backup);
    if (new TextEncoder().encode(JSON.stringify(validated)).byteLength > MAX_BROWSER_BACKUP_BYTES) {
      throw new Error('Complete backup exceeds the 10 MB safety limit. No partial export was created.');
    }
    return validated;
  }

  export async function importBrowserData(rawBackup: unknown, mode: BackupMode): Promise<void> {
    if (!isPublicMode) {
      throw new Error('Browser data restore is available in public browser-local mode only.');
    }
    if (mode !== 'merge' && mode !== 'replace') throw new Error('Import mode must be merge or replace.');
    const backup = validateBrowserBackup(rawBackup);
    const savedHandlesRaw = window.localStorage.getItem(HANDLES_KEY);
    if (savedHandlesRaw) {
      let existingHandles: unknown;
      try {
        existingHandles = JSON.parse(savedHandlesRaw);
      } catch {
        throw new Error('The saved browser profile list is malformed. Existing data was not changed.');
      }
      if (
        !Array.isArray(existingHandles) ||
        existingHandles.length > 10 ||
        existingHandles.some((handle) => typeof handle !== 'string' || !HANDLE_PATTERN.test(handle.trim()))
      ) {
        throw new Error('The saved browser profile list is invalid. Existing data was not changed.');
      }
    }

    const currentVirtualByHandle = new Map(
      backup.profiles.map(({ handle }) => [handle.toLowerCase(), listVirtualContestSessions(handle)])
    );
    const affectedKeys = [
      HANDLES_KEY,
      ACTIVE_HANDLE_KEY,
      ...backup.profiles.flatMap(({ handle, virtualContests }) => [
        `${CONTEXT_PREFIX}${handle.toLowerCase()}`,
        knowledgeNotesStorageKey(handle),
        ...(currentVirtualByHandle.get(handle.toLowerCase()) || [])
          .map((session) => virtualContestStorageKey(handle, session.contestId)),
        ...virtualContests.map((session) => virtualContestStorageKey(handle, session.contestId)),
      ]),
    ];
    const previousValues = snapshotBrowserStorage(window.localStorage, affectedKeys);

    const handleMap = new Map<string, string>();
    for (const handle of [...getSavedHandles(), ...backup.profiles.map(({ handle }) => handle)]) {
      const canonicalHandle = handle.trim().toLowerCase();
      if (HANDLE_PATTERN.test(handle.trim()) && !handleMap.has(canonicalHandle)) {
        handleMap.set(canonicalHandle, handle.trim());
      }
    }
    const newHandles = Array.from(handleMap.values());
    if (newHandles.length > 10) {
      throw new Error('This browser already has 10 profiles. Remove a saved profile before importing this backup.');
    }

    const prepared = backup.profiles.map((entry) => {
      const { handle, context } = entry;
      const key = `${CONTEXT_PREFIX}${handle.toLowerCase()}`;
      const existingRaw = window.localStorage.getItem(key);
      let existingContext: Record<string, unknown> | null = null;
      let knowledgeNotes = entry.knowledgeNotes;
      if (mode === 'merge' && existingRaw) {
        let existing: unknown;
        try {
          existing = JSON.parse(existingRaw);
        } catch {
          throw new Error(`Saved browser data for '${handle}' is malformed. Existing data was not changed.`);
        }
        if (
          !existing ||
          typeof existing !== 'object' ||
          (existing as Record<string, unknown>).version !== 1 ||
          typeof (existing as Record<string, unknown>).handle !== 'string' ||
          String((existing as Record<string, unknown>).handle).toLowerCase() !== handle.toLowerCase()
        ) {
          throw new Error(`Saved browser data for '${handle}' is invalid. Existing data was not changed.`);
        }
        validateBrowserBackup({
          ...backup,
          profiles: [{
            handle,
            context: existing as Record<string, unknown>,
            knowledgeNotes: [],
            virtualContests: [],
          }],
        });
        existingContext = existing as Record<string, unknown>;
      }
      if (mode === 'merge') {
        knowledgeNotes = mergeKnowledgeNotes(readKnowledgeNotes(handle), entry.knowledgeNotes);
      }
      const currentVirtual = currentVirtualByHandle.get(handle.toLowerCase()) || [];
      const virtualContests = mode === 'merge'
        ? Array.from(new Map([...currentVirtual, ...entry.virtualContests].map((session) => [session.contestId, session])).values())
        : entry.virtualContests;
      if (knowledgeNotes.length > 1000 || virtualContests.length > 1000) {
        throw new Error(`Merged browser data for '${handle}' exceeds the supported backup limits.`);
      }
      return {
        handle,
        context,
        serverContexts: serverContextImportSequence(context, existingContext, mode),
        knowledgeNotes,
        virtualContests,
        currentVirtual,
      };
    });

    validateBrowserBackup({
      ...backup,
      profiles: prepared.map(({ handle, context, knowledgeNotes, virtualContests }) => ({
        handle,
        context,
        knowledgeNotes,
        virtualContests,
      })),
    });

    const requestBackup = {
      ...backup,
      profiles: prepared.map(({ handle, context, knowledgeNotes, virtualContests }) => ({
        handle,
        context,
        knowledgeNotes,
        virtualContests,
      })),
    };
    if (new TextEncoder().encode(JSON.stringify(requestBackup)).byteLength > MAX_BROWSER_BACKUP_BYTES) {
      throw new Error('Merged backup exceeds the 10 MB safety limit. No data was changed.');
    }

    const serverSnapshots = new Map<string, unknown>();
    for (const { handle } of prepared) {
      const response = await globalThis.fetch(`${API_BASE}/context`, {
        headers: publicHeaders(handle),
        cache: 'no-store',
      });
      if (!response.ok) {
        throw new Error(`Could not verify existing server data for '${handle}'. No data was changed.`);
      }
      const snapshot: unknown = await response.json();
      if (
        !snapshot ||
        typeof snapshot !== 'object' ||
        (snapshot as Record<string, unknown>).version !== 1 ||
        typeof (snapshot as Record<string, unknown>).handle !== 'string' ||
        String((snapshot as Record<string, unknown>).handle).toLowerCase() !== handle.toLowerCase()
      ) {
        throw new Error(`Could not validate the current server data for '${handle}'. No data was changed.`);
      }
      serverSnapshots.set(handle, snapshot);
    }

    let localChangesApplied = false;
    let storageRollbackFailures: string[] = [];
    try {
      for (const { handle, serverContexts } of prepared) {
        for (const context of serverContexts) {
          const response = await globalThis.fetch(`${API_BASE}/context`, {
            method: 'POST',
            headers: {
              ...publicHeaders(handle),
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              context,
              mode: mode === 'replace' ? 'replace' : 'merge',
            }),
          });
          if (!response.ok) {
            const errorData = await response.json().catch(() => ({}));
            throw new Error(errorData.error || `Could not restore data for '${handle}' (HTTP ${response.status}).`);
          }
        }
      }

      const canonicalContexts = new Map<string, Record<string, unknown>>();
      for (const { handle } of prepared) {
        const response = await globalThis.fetch(`${API_BASE}/context`, {
          headers: publicHeaders(handle),
          cache: 'no-store',
        });
        if (!response.ok) {
          throw new Error(`Could not verify restored server data for '${handle}' (HTTP ${response.status}).`);
        }
        const context: unknown = await response.json();
        if (
          !context ||
          typeof context !== 'object' ||
          (context as Record<string, unknown>).version !== 1 ||
          typeof (context as Record<string, unknown>).profileId !== 'string' ||
          typeof (context as Record<string, unknown>).handle !== 'string' ||
          String((context as Record<string, unknown>).handle).toLowerCase() !== handle.toLowerCase()
        ) {
          throw new Error(`Restored server data for '${handle}' has invalid profile identities.`);
        }
        canonicalContexts.set(handle, context as Record<string, unknown>);
      }

      validateBrowserBackup({
        ...backup,
        profiles: prepared.map(({ handle, knowledgeNotes, virtualContests }) => ({
          handle,
          context: canonicalContexts.get(handle) || {},
          knowledgeNotes,
          virtualContests,
        })),
      });

      const localChanges = new Map<string, string | null>();
      localChanges.set(HANDLES_KEY, JSON.stringify(newHandles));
      for (const { handle, knowledgeNotes, virtualContests, currentVirtual } of prepared) {
        localChanges.set(
          `${CONTEXT_PREFIX}${handle.toLowerCase()}`,
          JSON.stringify(canonicalContexts.get(handle))
        );
        localChanges.set(knowledgeNotesStorageKey(handle), JSON.stringify(knowledgeNotes));
        if (mode === 'replace') {
          for (const session of currentVirtual) {
            if (!virtualContests.some((item) => item.contestId === session.contestId)) {
              localChanges.set(virtualContestStorageKey(handle, session.contestId), null);
            }
          }
        }
        for (const session of virtualContests) {
          localChanges.set(
            virtualContestStorageKey(handle, session.contestId),
            JSON.stringify(session)
          );
        }
      }
      applyBrowserStorageChanges(window.localStorage, localChanges, previousValues);
      localChangesApplied = true;
    } catch (error) {
      if (error instanceof BrowserStorageTransactionError) {
        storageRollbackFailures = error.rollbackFailures;
      } else if (localChangesApplied) {
        storageRollbackFailures = restoreBrowserStorageValues(window.localStorage, previousValues);
      }

      const rollbackFailures: string[] = [];
      for (const { handle } of [...prepared].reverse()) {
        try {
          const response = await globalThis.fetch(`${API_BASE}/context`, {
            method: 'POST',
            headers: {
              ...publicHeaders(handle),
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({ context: serverSnapshots.get(handle), mode: 'replace' }),
          });
          if (!response.ok) rollbackFailures.push(handle);
        } catch {
          rollbackFailures.push(handle);
        }
      }

      if (rollbackFailures.length > 0 || storageRollbackFailures.length > 0) {
        const recoveryDownloaded = downloadImportRecoveryCopy(previousValues, serverSnapshots);
        const details = [
          storageRollbackFailures.length > 0
            ? `browser storage rollback failed for ${storageRollbackFailures.join(', ')}`
            : '',
          rollbackFailures.length > 0
            ? `server rollback could not be confirmed for ${rollbackFailures.join(', ')}`
            : '',
          recoveryDownloaded
            ? 'an emergency recovery copy was downloaded'
            : 'an emergency recovery copy could not be downloaded',
        ].filter(Boolean).join('; ');
        throw new Error(`Restore failed: ${error instanceof Error ? error.message : 'unknown error'}. ${details}.`);
      }
      throw new Error(
        `Restore failed: ${error instanceof Error ? error.message : 'unknown error'}. Previous browser and server data were restored and verified.`
      );
    }
  }

  function downloadImportRecoveryCopy(
    browserStorage: Map<string, string | null>,
    serverProfiles: Map<string, unknown>
  ): boolean {
    try {
      const payload = {
        format: 'cp-coach-import-recovery',
        version: 1,
        exportedAt: new Date().toISOString(),
        browserStorage: Array.from(browserStorage.entries(), ([key, value]) => ({ key, value })),
        serverProfiles: Array.from(serverProfiles.entries(), ([handle, context]) => ({ handle, context })),
      };
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `cp-coach-recovery-${new Date().toISOString().slice(0, 10)}.json`;
      link.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      return true;
    } catch (error) {
      console.error('Could not create emergency browser recovery download.', error);
      return false;
    }
  }

function scheduleContextCapture(): void {
  if (!isPublicMode || !currentHandle) return;
  if (captureTimer) clearTimeout(captureTimer);
  captureTimer = setTimeout(() => {
    captureTimer = null;
    void capturePublicContext(currentHandle, { force: true });
  }, 400);
}

/**
 * One transport boundary for both modes. Public requests carry a random
 * browser ID and the selected handle; no server token is ever shipped to the
 * browser. Profile IDs are rewritten server-side, so old component code can
 * keep passing them without leaking another browser's data.
 */
const apiFetch: typeof globalThis.fetch = (input, init) => {
  if (!isPublicMode) {
    const startedAt = performance.now();
    const method = (init?.method || 'GET').toUpperCase();
    const url = typeof input === 'string'
      ? input
      : input instanceof Request
        ? input.url
        : input.toString();
    return globalThis.fetch(input, init).then((response) => {
      recordRequest({
        method,
        url,
        startedAt,
        durationMs: performance.now() - startedAt,
        status: response.status,
        serverTiming: response.headers.get('server-timing'),
      });
      return response;
    }).catch((error: unknown) => {
      recordRequest({
        method,
        url,
        startedAt,
        durationMs: performance.now() - startedAt,
        status: 0,
        serverTiming: null,
        failed: true,
      });
      throw error;
    });
  }

  const headers = new Headers(init?.headers);
  headers.set('X-Coach-Client-Id', getOrCreateClientId());
  if (currentHandle) headers.set('X-Coach-Handle', currentHandle);

  const method = (init?.method || 'GET').toUpperCase();
  let nextInput: RequestInfo | URL = input;
  const nextInit: RequestInit = { ...init, headers };

  if (typeof input === 'string') {
    try {
      const url = new URL(input, window.location.origin);
      if (method === 'GET' || method === 'HEAD') {
        url.searchParams.delete('profileId');
        if (currentHandle && !url.searchParams.has('handle')) {
          url.searchParams.set('handle', currentHandle);
        }
      }
      nextInput = url.origin === window.location.origin ? `${url.pathname}${url.search}` : url.toString();
    } catch {
      nextInput = input;
    }
  }

  if (init?.body && typeof init.body === 'string') {
    try {
      const parsed = JSON.parse(init.body);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        delete parsed.profileId;
        if (currentHandle && !parsed.handle) parsed.handle = currentHandle;
        nextInit.body = JSON.stringify(parsed);
      }
    } catch {
      // Leave non-JSON bodies untouched.
    }
  }

  const url = typeof nextInput === 'string'
    ? nextInput
    : nextInput instanceof Request
      ? nextInput.url
      : nextInput.toString();
  const isRead = method === 'GET' || method === 'HEAD';
  const profilePath = new URL(`${API_BASE}/profiles`, window.location.origin).pathname;
  const isProfileCreation = method === 'POST' && new URL(url, window.location.origin).pathname === profilePath;
  const canRetryNetwork = isRead || isProfileCreation;
  const requestKey = [
    method,
    url,
    Array.from(headers.entries()).sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => `${key}:${value}`).join('|'),
    typeof nextInit.body === 'string' ? nextInit.body : '',
  ].join('\n');

  const existingRequest = inFlightPublicRequests.get(requestKey);
  if (existingRequest) return existingRequest.then((response) => response.clone());

  const promise = (async () => {
    for (let attempt = 0; ; attempt += 1) {
      const attemptStartedAt = performance.now();
      try {
        const response = await globalThis.fetch(nextInput, nextInit);
        recordRequest({
          method,
          url,
          startedAt: attemptStartedAt,
          durationMs: performance.now() - attemptStartedAt,
          status: response.status,
          serverTiming: response.headers.get('server-timing'),
        });
        if (isRead && [502, 503, 504].includes(response.status) && attempt < 2) {
          await new Promise((resolve) => window.setTimeout(resolve, 700 * (attempt + 1)));
          continue;
        }
        return response;
      } catch (error) {
        recordRequest({
          method,
          url,
          startedAt: attemptStartedAt,
          durationMs: performance.now() - attemptStartedAt,
          status: 0,
          serverTiming: null,
          failed: true,
        });
        if (!canRetryNetwork || attempt >= 2) {
          if (canRetryNetwork && error instanceof TypeError) {
            throw new Error('The Coach service could not be reached. Check your connection and try again; your saved browser data has not been changed.');
          }
          throw error;
        }
        await new Promise((resolve) => window.setTimeout(resolve, 700 * (attempt + 1)));
      }
    }
  })();

  if (isRead || isProfileCreation) {
    inFlightPublicRequests.set(requestKey, promise);
    void promise.finally(() => {
      if (inFlightPublicRequests.get(requestKey) === promise) inFlightPublicRequests.delete(requestKey);
    }).catch(() => {});
  }

  if (method !== 'GET' && method !== 'HEAD') {
    promise.then((response) => {
      if (response.ok) scheduleContextCapture();
    }).catch(() => {});
  }
  return promise.then((response) => response.clone());
};

const fetch = apiFetch;

export async function fetchProfiles(): Promise<{ profiles: UserProfile[]; activeProfileId: string }> {
  if (isPublicMode) {
    const handles = getSavedHandles();
    const query = handles.length > 0 ? `?handles=${encodeURIComponent(handles.join(','))}` : '';
    const res = await fetch(`${API_BASE}/profiles${query}`, { headers: publicHeaders() });
    if (!res.ok) {
      throw new Error('Could not load saved browser profiles. The Coach service may be waking up; please retry in a moment.');
    }
    const data = await res.json() as { profiles: UserProfile[]; activeProfileId: string };
    rememberProfiles(data.profiles || []);
    if (!getPublicHandle() && data.profiles?.[0]) {
      setPublicHandle(data.profiles[0].handle);
    }
    return data;
  }

  const res = await fetch(`${API_BASE}/profiles`);
  if (!res.ok) throw new Error('Failed to fetch user profiles');
  return res.json();
}

export async function createProfile(handle: string, displayName?: string): Promise<{ success: boolean; profile: UserProfile; message?: string }> {
  const res = await fetch(`${API_BASE}/profiles`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ handle, displayName }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error || 'Failed to create profile');
  }
  if (isPublicMode && data.profile) {
    rememberProfiles([data.profile]);
    setPublicHandle(data.profile.handle);
  }
  return data;
}

export async function selectProfile(profileId: string): Promise<{ success: boolean; profile: UserProfile }> {
  if (isPublicMode) {
    let profiles = lastProfiles;
    if (!profiles.some((profile) => profile.id === profileId)) {
      profiles = (await fetchProfiles()).profiles;
    }
    const profile = profiles.find((item) => item.id === profileId);
    if (!profile) throw new Error('Profile not found');
    setPublicHandle(profile.handle);
    return { success: true, profile };
  }

  const res = await fetch(`${API_BASE}/profiles/${encodeURIComponent(profileId)}/select`, {
    method: 'POST',
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || 'Failed to switch profile');
  }
  return res.json();
}

export async function deleteProfile(profileId: string): Promise<{ success: boolean; message: string }> {
  const res = await fetch(`${API_BASE}/profiles/${encodeURIComponent(profileId)}`, {
    method: 'DELETE',
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || 'Failed to delete profile');
  }

  if (isPublicMode) {
    const profile = lastProfiles.find((item) => item.id === profileId);
    if (profile) {
      removeSavedHandle(profile.handle);
      if (currentHandle?.toLowerCase() === profile.handle.toLowerCase()) {
        const next = getPublicHandle();
        currentHandle = next;
      }
    }
  }

  return res.json();
}

export async function fetchDashboard(profileId?: string): Promise<DashboardOverview> {
  const url = profileId ? `${API_BASE}/dashboard?profileId=${encodeURIComponent(profileId)}` : `${API_BASE}/dashboard`;
  const res = await fetch(url);
  if (!res.ok) {
    const errorData = await res.json().catch(() => ({}));
    throw new Error(errorData.message || 'Failed to load dashboard data');
  }
  return res.json();
}

export async function triggerSync(profileId?: string): Promise<{ success: boolean; message: string; syncStatus: SyncStatus }> {
  const res = await fetch(`${API_BASE}/sync`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ profileId }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.message || 'Failed to trigger synchronization');
  }
  return res.json();
}

export async function fetchDailySet(profileId?: string, date?: string): Promise<DailySet> {
  const params = new URLSearchParams();
  if (profileId) params.append('profileId', profileId);
  if (date) params.append('date', date);
  const qs = params.toString();
  const url = qs ? `${API_BASE}/daily?${qs}` : `${API_BASE}/daily`;

  const res = await fetch(url);
  if (!res.ok) throw new Error('Failed to fetch daily problem set');
  return res.json();
}

export async function openProblem(problemId: string): Promise<{ success: boolean; problem: DailyProblem }> {
  const res = await fetch(`${API_BASE}/problems/${encodeURIComponent(problemId)}/open`, {
    method: 'POST',
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.message || 'Failed to record problem open');
  }
  return res.json();
}

export async function fetchNetworkInfo(): Promise<{
  localUrl: string;
  lanUrls: string[];
  lanIps: string[];
  frontendPort: number;
  backendPort: number;
  recommendation: string;
}> {
  if (isPublicMode) {
    return {
      localUrl: '',
      lanUrls: [],
      lanIps: [],
      frontendPort: 0,
      backendPort: 0,
      recommendation: 'This is the public deployment. Personal data stays in this browser.',
    };
  }
  const res = await fetch(`${API_BASE}/network-info`);
  if (!res.ok) throw new Error('Failed to fetch network info');
  return res.json();
}

export async function submitProblemFeedback(
  problemId: string,
  payload: FeedbackPayload
): Promise<{ success: boolean; problem: DailyProblem }> {
  const res = await fetch(`${API_BASE}/problems/${encodeURIComponent(problemId)}/feedback`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.message || 'Failed to submit problem feedback');
  }
  return res.json();
}

export async function fetchHistory(profileId?: string, limit = 30): Promise<DailySet[]> {
  const url = profileId 
    ? `${API_BASE}/history?profileId=${encodeURIComponent(profileId)}&limit=${limit}` 
    : `${API_BASE}/history?limit=${limit}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error('Failed to fetch training history');
  return res.json();
}

export async function fetchProblemJournal(profileId?: string, limit = 100): Promise<ProblemLearningEvent[]> {
  const url = profileId
    ? `${API_BASE}/journal?profileId=${encodeURIComponent(profileId)}&limit=${limit}`
    : `${API_BASE}/journal?limit=${limit}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error('Failed to fetch problem learning journal');
  return res.json();
}

// ──────────────────────────────────────────
// Contests API
// ──────────────────────────────────────────

export async function fetchContests(profileId?: string): Promise<any[]> {
  const url = profileId ? `${API_BASE}/contests?profileId=${encodeURIComponent(profileId)}` : `${API_BASE}/contests`;
  const res = await fetch(url);
  if (!res.ok) throw new Error('Failed to fetch contests');
  return res.json();
}

export async function fetchUpcomingContests(): Promise<Array<{
  id: number;
  name: string;
  startTimeSeconds: number;
  durationSeconds: number;
  phase: string;
  url: string;
}>> {
  const res = await fetch(`${API_BASE}/contests/upcoming`);
  if (!res.ok) throw new Error('Failed to fetch upcoming contests');
  return res.json();
}

export async function syncContests(profileId?: string): Promise<{ success: boolean; count: number; contests: any[] }> {
  const res = await fetch(`${API_BASE}/contests/sync`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ profileId }),
  });
  if (!res.ok) throw new Error('Failed to synchronize contests');
  return res.json();
}

export async function importContest(input: string, profileId?: string): Promise<{ success: boolean; report: any }> {
  const res = await fetch(`${API_BASE}/contests/import`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ input, profileId }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Failed to import contest');
  return data;
}

export async function fetchContestPostMortem(contestId: number, profileId?: string): Promise<any> {
  const url = profileId 
    ? `${API_BASE}/contests/${contestId}?profileId=${encodeURIComponent(profileId)}` 
    : `${API_BASE}/contests/${contestId}`;
  const res = await fetch(url);
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.message || 'Failed to load contest post-mortem report');
  }
  return res.json();
}

export async function submitContestProblemReview(
  contestId: number,
  problemIndex: string,
  payload: { selfReviewTag?: string | null; selfReviewNotes?: string | null; upsolveStatus?: string },
  profileId?: string
): Promise<{ success: boolean; report: any }> {
  const res = await fetch(`${API_BASE}/contests/${contestId}/review`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...payload, problemIndex, profileId }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.message || 'Failed to save review');
  }
  return res.json();
}

export async function fetchProblemTutorial(problemId: string): Promise<any> {
  const res = await fetch(`${API_BASE}/tutorial/${encodeURIComponent(problemId)}`);
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.message || 'Failed to load tutorial');
  }
  return res.json();
}

export async function fetchContestProblemTutorial(contestId: number, problemIndex: string): Promise<any> {
  const res = await fetch(`${API_BASE}/contests/${contestId}/problems/${encodeURIComponent(problemIndex)}/tutorial`);
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.message || 'Failed to load contest problem tutorial');
  }
  return res.json();
}

// ──────────────────────────────────────────
// Training Plan & Skill Tracks
// ──────────────────────────────────────────

export async function fetchTrainingPlan(profileId?: string, date?: string): Promise<TrainingPlan> {
  const params = new URLSearchParams();
  if (profileId) params.append('profileId', profileId);
  if (date) params.append('date', date);
  const qs = params.toString();
  const url = qs ? `${API_BASE}/training-plan?${qs}` : `${API_BASE}/training-plan`;

  const res = await fetch(url);
  if (!res.ok) throw new Error('Failed to fetch training plan');
  return res.json();
}

export async function fetchSkillTracks(profileId?: string, date?: string): Promise<{ skillTracks: SkillTrack[]; profileId: string; handle: string }> {
  const params = new URLSearchParams();
  if (profileId) params.append('profileId', profileId);
  if (date) params.append('date', date);
  const qs = params.toString();
  const url = qs ? `${API_BASE}/skill-tracks?${qs}` : `${API_BASE}/skill-tracks`;

  const res = await fetch(url);
  if (!res.ok) throw new Error('Failed to fetch skill tracks');
  return res.json();
}

export async function fetchWeeklyReport(profileId?: string): Promise<WeeklyCoachReport> {
  const url = profileId
    ? `${API_BASE}/weekly-report?profileId=${encodeURIComponent(profileId)}`
    : `${API_BASE}/weekly-report`;
  const res = await fetch(url);
  if (!res.ok) {
    const error = await res.json().catch(() => ({}));
    throw new Error(error.message || error.error || 'Failed to load weekly coach report');
  }
  return res.json();
}

export async function replaceDailyProblem(
  dailyProblemId: string,
  profileId?: string,
  date?: string
): Promise<{ success: boolean; problem: DailyProblem }> {
  const res = await fetch(`${API_BASE}/daily/replace`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ dailyProblemId, profileId, date }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.message || 'Failed to replace problem');
  }
  return res.json();
}

// ──────────────────────────────────────────
// Spaced Repetition (Reviews)
// ──────────────────────────────────────────

export async function fetchReviewQueue(profileId?: string): Promise<{ dueReviews: ReviewQueueItem[]; summary: ReviewQueueSummary }> {
  const url = profileId ? `${API_BASE}/reviews?profileId=${encodeURIComponent(profileId)}` : `${API_BASE}/reviews`;
  const res = await fetch(url);
  if (!res.ok) throw new Error('Failed to fetch review queue');
  return res.json();
}

export async function enqueueReview(
  problemId: string,
  triggerReason?: string,
  source?: string,
  profileId?: string
): Promise<{ success: boolean; reviewItem: ReviewQueueItem }> {
  const res = await fetch(`${API_BASE}/reviews/enqueue`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ problemId, triggerReason, source, profileId }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.message || 'Failed to enqueue problem for review');
  }
  return res.json();
}

export async function actionReview(
  problemId: string,
  outcome: 'MASTERED' | 'EASY' | 'DIFFICULT' | 'DEFERRED',
  notes?: string,
  profileId?: string
): Promise<{ success: boolean; reviewItem: ReviewQueueItem }> {
  const res = await fetch(`${API_BASE}/reviews/${encodeURIComponent(problemId)}/action`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ outcome, notes, profileId }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.message || 'Failed to record review action');
  }
  return res.json();
}

export async function sendContestProblemToReview(
  contestId: number,
  problemIndex: string,
  triggerReason?: string,
  profileId?: string
): Promise<{ success: boolean; reviewItem: ReviewQueueItem }> {
  const res = await fetch(`${API_BASE}/contests/${contestId}/problems/${encodeURIComponent(problemIndex)}/send-to-review`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ triggerReason, profileId }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.message || 'Failed to send contest problem to review');
  }
  return res.json();
}

// ──────────────────────────────────────────
// Solve Sessions Tracker & Reflections
// ──────────────────────────────────────────

export async function startSolveSession(
  problemId: string,
  profileId?: string
): Promise<{ success: boolean; session: SolveSession }> {
  const res = await fetch(`${API_BASE}/sessions/start`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ problemId, profileId }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.message || 'Failed to start solve session');
  }
  return res.json();
}

export async function recordSessionHint(sessionId: string): Promise<{ success: boolean; session: SolveSession }> {
  const res = await fetch(`${API_BASE}/sessions/${encodeURIComponent(sessionId)}/hint`, {
    method: 'POST',
  });
  if (!res.ok) throw new Error('Failed to record hint');
  return res.json();
}

export async function recordSessionEditorial(sessionId: string): Promise<{ success: boolean; session: SolveSession }> {
  const res = await fetch(`${API_BASE}/sessions/${encodeURIComponent(sessionId)}/editorial`, {
    method: 'POST',
  });
  if (!res.ok) throw new Error('Failed to record editorial view');
  return res.json();
}

export async function finishSolveSession(
  sessionId: string,
  payload: {
    outcome?: string;
    activeDurationSeconds?: number;
    perceivedDifficulty?: string;
    struggleType?: string;
    keyTakeaway?: string;
    reflectionNotes?: string;
  }
): Promise<{ success: boolean; session: SolveSession }> {
  const res = await fetch(`${API_BASE}/sessions/${encodeURIComponent(sessionId)}/finish`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.message || 'Failed to finish solve session');
  }
  return res.json();
}

export async function fetchSessionAnalytics(profileId?: string): Promise<SessionAnalytics> {
  const url = profileId ? `${API_BASE}/sessions/analytics?profileId=${encodeURIComponent(profileId)}` : `${API_BASE}/sessions/analytics`;
  const res = await fetch(url);
  if (!res.ok) throw new Error('Failed to fetch session analytics');
  return res.json();
}

// ──────────────────────────────────────────
// Weekly Goals
// ──────────────────────────────────────────

export async function fetchWeeklyGoals(profileId?: string, weekStart?: string): Promise<WeeklyGoal> {
  const params = new URLSearchParams();
  if (profileId) params.append('profileId', profileId);
  if (weekStart) params.append('weekStart', weekStart);
  const qs = params.toString();
  const url = qs ? `${API_BASE}/weekly-goals?${qs}` : `${API_BASE}/weekly-goals`;

  const res = await fetch(url);
  if (!res.ok) throw new Error('Failed to fetch weekly goals');
  return res.json();
}

export async function updateWeeklyGoals(
  payload: { targetSolvesCount?: number; targetContestsCount?: number; focusTopic?: string; weekStartDate?: string },
  profileId?: string
): Promise<{ success: boolean; weeklyGoal: WeeklyGoal }> {
  const res = await fetch(`${API_BASE}/weekly-goals`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...payload, profileId }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.message || 'Failed to update weekly goals');
  }
  return res.json();
}

// ──────────────────────────────────────────
// System Health
// ──────────────────────────────────────────

export async function fetchHealth(): Promise<{ status: string; timestamp: string; uptimeSeconds: number; memoryUsageMb: number }> {
  const res = await fetch(`${API_BASE}/health`);
  if (!res.ok) throw new Error('Health check failed');
  return res.json();
}

export interface NotificationSettings {
  contestReminders: boolean;
  dailyReminders: boolean;
  reminderTime: string;
  timezone: string;
}

export interface NotificationAvailability {
  available: boolean;
  vapidPublicKey: string | null;
  timezone: string;
}

export async function fetchNotificationAvailability(): Promise<NotificationAvailability> {
  const res = await fetch(`${API_BASE}/notifications/config`);
  if (!res.ok) throw new Error('Could not load push notification configuration');
  return res.json();
}

export async function fetchNotificationSettings(): Promise<{
  available: boolean;
  settings: NotificationSettings;
}> {
  const res = await fetch(`${API_BASE}/notifications/settings`);
  if (!res.ok) throw new Error('Could not load notification settings');
  return res.json();
}

export async function isPushSubscriptionRegistered(endpoint: string): Promise<boolean> {
  const params = new URLSearchParams({ endpoint });
  const res = await fetch(`${API_BASE}/notifications/subscriptions/status?${params}`);
  if (!res.ok) throw new Error('Could not verify this device subscription');
  const result = await res.json();
  return result.registered === true;
}

export async function saveNotificationSettings(
  settings: Pick<NotificationSettings, 'contestReminders' | 'dailyReminders' | 'reminderTime'>
): Promise<NotificationSettings> {
  const res = await fetch(`${API_BASE}/notifications/settings`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(settings),
  });
  if (!res.ok) {
    const error = await res.json().catch(() => ({}));
    throw new Error(error.error || error.message || 'Could not save notification settings');
  }
  const result = await res.json();
  return result.settings;
}

export async function registerPushSubscription(subscription: {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}): Promise<void> {
  const res = await fetch(`${API_BASE}/notifications/subscriptions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ subscription }),
  });
  if (!res.ok) {
    const error = await res.json().catch(() => ({}));
    throw new Error(error.error || 'Could not register this device for notifications');
  }
}

export async function removePushSubscription(endpoint: string): Promise<void> {
  const res = await fetch(`${API_BASE}/notifications/subscriptions`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ endpoint }),
  });
  if (!res.ok) {
    const error = await res.json().catch(() => ({}));
    throw new Error(error.error || 'Could not remove this device subscription');
  }
}
