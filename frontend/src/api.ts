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
} from './types';

const API_ORIGIN = ((import.meta.env.VITE_API_BASE_URL as string | undefined) || '').trim().replace(/\/+$/, '');
export const isPublicMode = import.meta.env.VITE_PUBLIC_MODE === 'true' || Boolean(API_ORIGIN);
const API_BASE = `${API_ORIGIN}${isPublicMode ? '/api/public' : '/api'}`;

const CLIENT_ID_KEY = 'cp-coach:client-id:v1';
const HANDLES_KEY = 'cp-coach:handles:v1';
const ACTIVE_HANDLE_KEY = 'cp-coach:active-handle:v1';
const CONTEXT_PREFIX = 'cp-coach:context:v1:';
const SERVER_INSTANCE_KEY = 'cp-coach:server-instance:v1';
const HANDLE_PATTERN = /^[A-Za-z0-9_.-]{2,64}$/;

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

function trimContext(snapshot: any): any {
  if (!snapshot || typeof snapshot !== 'object') return snapshot;
  const trim = (value: unknown, max: number) => Array.isArray(value) ? value.slice(0, max) : value;
  return {
    ...snapshot,
    dailySets: trim(snapshot.dailySets, 60),
    dailyProblems: trim(snapshot.dailyProblems, 240),
    reviewQueue: trim(snapshot.reviewQueue, 250),
    solveSessions: trim(snapshot.solveSessions, 200),
    contestReviews: trim(snapshot.contestReviews, 200),
    userContests: trim(snapshot.userContests, 200),
    weeklyGoals: trim(snapshot.weeklyGoals, 52),
    learningEvents: trim(snapshot.learningEvents, 500),
    problems: trim(snapshot.problems, 1000),
    contestProblemsMeta: trim(snapshot.contestProblemsMeta, 1000),
  };
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

  let value = JSON.stringify(trimContext(snapshot));
  if (writeStorage(key, value)) return;

  const minimal = {
    ...snapshot,
    learningEvents: Array.isArray(snapshot.learningEvents) ? snapshot.learningEvents.slice(0, 150) : [],
    solveSessions: Array.isArray(snapshot.solveSessions) ? snapshot.solveSessions.slice(0, 75) : [],
    problems: Array.isArray(snapshot.problems) ? snapshot.problems.slice(0, 400) : [],
  };
  value = JSON.stringify(minimal);
  if (!writeStorage(key, value)) {
    removeStorage(key);
  }
}

export async function capturePublicContext(handle: string | null = currentHandle): Promise<void> {
  if (!isPublicMode || !handle) return;
  if (captureInFlight) return captureInFlight;

  const task = (async () => {
    try {
      const res = await globalThis.fetch(`${API_BASE}/context`, { headers: publicHeaders(handle) });
      if (!res.ok) return;
      const snapshot = await res.json();
      writeContext(handle, snapshot);
    } catch {
      // Context capture is best-effort; the next successful refresh retries.
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
  handle: string
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
      body: JSON.stringify({ context }),
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

function scheduleContextCapture(): void {
  if (!isPublicMode || !currentHandle) return;
  if (captureTimer) clearTimeout(captureTimer);
  captureTimer = setTimeout(() => {
    captureTimer = null;
    void capturePublicContext(currentHandle);
  }, 400);
}

/**
 * One transport boundary for both modes. Public requests carry a random
 * browser ID and the selected handle; no server token is ever shipped to the
 * browser. Profile IDs are rewritten server-side, so old component code can
 * keep passing them without leaking another browser's data.
 */
const apiFetch: typeof globalThis.fetch = (input, init) => {
  if (!isPublicMode) return globalThis.fetch(input, init);

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

  const promise = globalThis.fetch(nextInput, nextInit);
  if (method !== 'GET' && method !== 'HEAD') {
    promise.then((response) => {
      if (response.ok) scheduleContextCapture();
    }).catch(() => {});
  }
  return promise;
};

const fetch = apiFetch;

export async function fetchProfiles(): Promise<{ profiles: UserProfile[]; activeProfileId: string }> {
  if (isPublicMode) {
    const handles = getSavedHandles();
    const query = handles.length > 0 ? `?handles=${encodeURIComponent(handles.join(','))}` : '';
    const res = await globalThis.fetch(`${API_BASE}/profiles${query}`, { headers: publicHeaders() });
    if (!res.ok) throw new Error('Failed to fetch browser profiles');
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
