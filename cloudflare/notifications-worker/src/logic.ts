export const NOTIFICATION_TIMEZONE = 'Asia/Hebron';

export interface DailySnapshotProblem {
  contestId: number;
  problemIndex: string;
  verifiedAccepted: boolean;
}

export function getLocalDateTime(date: Date, timeZone = NOTIFICATION_TIMEZONE): {
  date: string;
  time: string;
} {
  const dateParts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const values = Object.fromEntries(dateParts.map(({ type, value }) => [type, value]));
  return {
    date: `${values.year}-${values.month}-${values.day}`,
    time: new Intl.DateTimeFormat('en-GB', {
      timeZone,
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).format(date),
  };
}

export function parseDailySnapshot(value: unknown): DailySnapshotProblem[] | null {
  if (!Array.isArray(value) || value.length > 10) return null;
  const result: DailySnapshotProblem[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') return null;
    const problem = item as Record<string, unknown>;
    if (
      !Number.isSafeInteger(problem.contestId) ||
      Number(problem.contestId) <= 0 ||
      Number(problem.contestId) >= 100000 ||
      typeof problem.problemIndex !== 'string' ||
      !/^[A-Z][A-Z0-9]*$/.test(problem.problemIndex) ||
      typeof problem.verifiedAccepted !== 'boolean'
    ) return null;
    result.push({
      contestId: Number(problem.contestId),
      problemIndex: problem.problemIndex,
      verifiedAccepted: problem.verifiedAccepted,
    });
  }
  return result;
}

export function isDailySnapshotUsable(
  snapshotDate: string | null,
  syncedAt: string | null,
  now: Date,
): boolean {
  if (!snapshotDate || !syncedAt) return false;
  const today = getLocalDateTime(now).date;
  const syncedTimestamp = Date.parse(syncedAt);
  return snapshotDate === today &&
    Number.isFinite(syncedTimestamp) &&
    syncedTimestamp <= now.getTime() + 60_000 &&
    now.getTime() - syncedTimestamp <= 24 * 60 * 60 * 1000;
}

export function applyAcceptedSubmissions(
  problems: DailySnapshotProblem[],
  accepted: ReadonlySet<string>,
): DailySnapshotProblem[] {
  return problems.map((problem) => ({
    ...problem,
    verifiedAccepted: problem.verifiedAccepted ||
      accepted.has(`${problem.contestId}_${problem.problemIndex}`),
  }));
}

export function countUnfinished(problems: DailySnapshotProblem[]): number {
  return problems.filter((problem) => !problem.verifiedAccepted).length;
}

export function isValidHandle(handle: unknown): handle is string {
  return typeof handle === 'string' && /^[A-Za-z0-9_.-]{2,64}$/.test(handle);
}

export function isValidReminderTime(value: unknown): value is string {
  return typeof value === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
}

export function isValidSubscription(value: unknown): value is {
  endpoint: string;
  keys: { p256dh: string; auth: string };
} {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  const keys = candidate.keys as Record<string, unknown> | null;
  if (
    typeof candidate.endpoint !== 'string' ||
    candidate.endpoint.length > 2048 ||
    !keys ||
    typeof keys.p256dh !== 'string' ||
    typeof keys.auth !== 'string' ||
    !/^[A-Za-z0-9_-]+$/.test(keys.p256dh) ||
    !/^[A-Za-z0-9_-]+$/.test(keys.auth)
  ) return false;

  try {
    const endpoint = new URL(candidate.endpoint);
    const hostname = endpoint.hostname.toLowerCase();
    const trustedHost = hostname === 'fcm.googleapis.com' ||
      hostname === 'web.push.apple.com' ||
      hostname === 'push.services.mozilla.com' ||
      hostname.endsWith('.push.services.mozilla.com') ||
      hostname === 'notify.windows.com' ||
      hostname.endsWith('.notify.windows.com');
    const publicKeyBytes = Uint8Array.from(atob(keys.p256dh.replace(/-/g, '+').replace(/_/g, '/')), (char) => char.charCodeAt(0));
    const authBytes = Uint8Array.from(atob(keys.auth.replace(/-/g, '+').replace(/_/g, '/')), (char) => char.charCodeAt(0));
    return endpoint.protocol === 'https:' &&
      !endpoint.username &&
      !endpoint.password &&
      !endpoint.port &&
      trustedHost &&
      publicKeyBytes.length === 65 &&
      authBytes.length >= 16;
  } catch {
    return false;
  }
}
