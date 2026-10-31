import { isValidTimestamp, timestampMilliseconds } from './timestamps';

export interface VirtualProblemEvent {
  firstStartedAt: string | null;
  solvedAt: string | null;
}

export interface VirtualContestSession {
  contestId: number;
  profileHandle: string;
  name: string;
  durationSeconds: number;
  startedAt: string;
  finishedAt: string | null;
  problems: Record<string, VirtualProblemEvent>;
}

const STORAGE_PREFIX = 'cp-coach:virtual-contest:v1:';

export function virtualContestStorageKey(handle: string, contestId: number): string {
  return `${STORAGE_PREFIX}${handle.toLowerCase()}:${contestId}`;
}

export function listVirtualContestSessions(handle: string): VirtualContestSession[] {
  const prefix = `${STORAGE_PREFIX}${handle.toLowerCase()}:`;
  try {
    const sessions: VirtualContestSession[] = [];
    for (let index = 0; index < window.localStorage.length; index += 1) {
      const key = window.localStorage.key(index);
      if (!key?.startsWith(prefix)) continue;
      const raw = window.localStorage.getItem(key);
      if (!raw) throw new Error('Saved virtual contest data is empty.');
      const parsed: unknown = JSON.parse(raw);
      if (!isVirtualContestSession(parsed, handle)) {
        throw new Error('Saved virtual contest data has invalid timestamps or identities.');
      }
      sessions.push(parsed);
    }
    return sessions;
  } catch (error) {
    if (error instanceof Error && error.message.includes('Saved virtual contest data')) throw error;
    throw new Error('Could not read saved virtual contest sessions from browser storage.');
  }
}

export function isVirtualContestSession(value: unknown, handle?: string): value is VirtualContestSession {
  if (!value || typeof value !== 'object') return false;
  const session = value as Partial<VirtualContestSession>;
  if (
    !Number.isInteger(session.contestId) ||
    (session.contestId || 0) <= 0 ||
    typeof session.profileHandle !== 'string' ||
    (handle && session.profileHandle.toLowerCase() !== handle.toLowerCase()) ||
    typeof session.name !== 'string' ||
    typeof session.durationSeconds !== 'number' ||
    !Number.isFinite(session.durationSeconds) ||
    session.durationSeconds <= 0 ||
    !isValidTimestamp(session.startedAt) ||
    (session.finishedAt !== null && !isValidTimestamp(session.finishedAt)) ||
    !session.problems ||
    typeof session.problems !== 'object' ||
    Array.isArray(session.problems)
  ) return false;

  const startedAt = timestampMilliseconds(session.startedAt);
  const finishedAt = session.finishedAt === null ? null : timestampMilliseconds(session.finishedAt);
  if (finishedAt !== null && finishedAt < startedAt) return false;
  return Object.values(session.problems).every((event) => {
    if (
      !event ||
      typeof event !== 'object' ||
      (event.firstStartedAt !== null && !isValidTimestamp(event.firstStartedAt)) ||
      (event.solvedAt !== null && !isValidTimestamp(event.solvedAt))
    ) return false;
    if (event.firstStartedAt === null) return event.solvedAt === null;
    const firstStartedAt = timestampMilliseconds(event.firstStartedAt);
    if (firstStartedAt < startedAt || (finishedAt !== null && firstStartedAt > finishedAt)) return false;
    if (event.solvedAt === null) return true;
    const solvedAt = timestampMilliseconds(event.solvedAt);
    return solvedAt >= firstStartedAt && (finishedAt === null || solvedAt <= finishedAt);
  });
}

export function saveVirtualContestSession(session: VirtualContestSession): void {
  if (!isVirtualContestSession(session, session.profileHandle)) {
    throw new Error('Could not save this virtual contest because its timestamps or identities are invalid.');
  }
  try {
    window.localStorage.setItem(
      virtualContestStorageKey(session.profileHandle, session.contestId),
      JSON.stringify(session)
    );
  } catch {
    throw new Error('Could not save this virtual contest. Browser storage may be full or unavailable.');
  }
}
