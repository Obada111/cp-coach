import {
  applyAcceptedSubmissions,
  countUnfinished,
  getLocalDateTime,
  isDailySnapshotUsable,
  parseDailySnapshot,
} from './logic';
import { PushDeliveryError, sendWebPush } from './push';
import { NotificationStore } from './store';
import type { Env, NotificationTask, WorkerStats } from './types';

const CONTEST_REFRESH_MS = 5 * 60_000;
const CODEFORCES_STATUS_COUNT = 3000;
const RETRY_DELAY_MS = 15 * 60_000;
const MAX_PUSHES_PER_CRON = 1;

interface CodeforcesContest {
  id?: number;
  name?: string;
  startTimeSeconds?: number;
  durationSeconds?: number;
  phase?: string;
}

async function fetchContests(now: Date): Promise<Array<{
  contest_id: number;
  name: string;
  start_time_seconds: number;
  duration_seconds: number | null;
  phase: string;
  updated_at: string;
}>> {
  const response = await fetch('https://codeforces.com/api/contest.list?gym=false', {
    headers: { 'User-Agent': 'CP-Coach-Notification-Worker/1.0' },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`Codeforces contest API returned HTTP ${response.status}`);
  const data = await response.json() as { status?: string; result?: CodeforcesContest[] };
  if (data.status !== 'OK' || !Array.isArray(data.result)) {
    throw new Error('Codeforces contest response was invalid');
  }
  return data.result
    .filter((contest) =>
      Number.isSafeInteger(contest.id) &&
      Number(contest.id) > 0 &&
      typeof contest.name === 'string' &&
      Number.isSafeInteger(contest.startTimeSeconds) &&
      contest.phase === 'BEFORE'
    )
    .map((contest) => ({
      contest_id: Number(contest.id),
      name: String(contest.name).slice(0, 500),
      start_time_seconds: Number(contest.startTimeSeconds),
      duration_seconds: Number.isSafeInteger(contest.durationSeconds) ? Number(contest.durationSeconds) : null,
      phase: 'BEFORE',
      updated_at: now.toISOString(),
    }));
}

async function refreshContestsIfNeeded(store: NotificationStore, now: Date): Promise<boolean> {
  if (!await store.hasContestSubscribers()) return true;
  const lastRefreshAt = await store.getLastContestRefreshAt();
  const lastRefresh = lastRefreshAt ? Date.parse(lastRefreshAt) : 0;
  if (Number.isFinite(lastRefresh) && now.getTime() - lastRefresh < CONTEST_REFRESH_MS) return true;
  try {
    await store.refreshContests(await fetchContests(now), now);
    return true;
  } catch {
    console.warn('[NotificationWorker] Contest list refresh failed.');
    return false;
  }
}

async function fetchAcceptedProblems(handle: string): Promise<Set<string>> {
  const url = new URL('https://codeforces.com/api/user.status');
  url.searchParams.set('handle', handle);
  url.searchParams.set('from', '1');
  url.searchParams.set('count', String(CODEFORCES_STATUS_COUNT));
  const response = await fetch(url, {
    headers: { 'User-Agent': 'CP-Coach-Notification-Worker/1.0' },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`Codeforces status API returned HTTP ${response.status}`);
  const data = await response.json() as {
    status?: string;
    result?: Array<{ verdict?: string; problem?: { contestId?: number; index?: string } }>;
  };
  if (data.status !== 'OK' || !Array.isArray(data.result)) {
    throw new Error('Codeforces submission response was invalid');
  }
  return new Set(data.result
    .filter((item) =>
      item.verdict === 'OK' &&
      Number.isSafeInteger(item.problem?.contestId) &&
      typeof item.problem?.index === 'string'
    )
    .map((item) => `${item.problem!.contestId}_${item.problem!.index}`));
}

function contestPayload(task: NotificationTask): Record<string, unknown> {
  const start = new Date(Number(task.startTimeSeconds) * 1000);
  const time = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Hebron',
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(start);
  return {
    title: 'Upcoming Codeforces contest',
    body: `${task.contestName} (Codeforces) starts at ${time} (Asia/Hebron).`,
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
    tag: `contest-${task.contestId}`,
    data: { url: `https://codeforces.com/contest/${task.contestId}` },
    actions: [{ action: 'open', title: 'Open contest' }],
  };
}

function dailyPayload(task: NotificationTask, remaining: number, date: string): Record<string, unknown> {
  return {
    title: 'Your Daily CP Practice',
    body: `You still have ${remaining} daily problem${remaining === 1 ? '' : 's'} to solve. Keep your Codeforces progress going!`,
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
    tag: `daily-${date}`,
    data: { url: '/#daily-recommendations' },
    actions: [{ action: 'open', title: 'Open daily practice' }],
  };
}

async function prepareDailyTask(
  store: NotificationStore,
  task: NotificationTask,
  now: Date,
): Promise<{ remaining: number; snapshot: NonNullable<NotificationTask['snapshot']> } | null> {
  const profile = task.profile;
  if (!isDailySnapshotUsable(profile.snapshot_date, profile.snapshot_synced_at, now)) return null;
  let problems = task.snapshot || parseDailySnapshot(JSON.parse(profile.daily_snapshot));
  if (!problems) return null;

  try {
    const accepted = await fetchAcceptedProblems(profile.cf_handle);
    problems = applyAcceptedSubmissions(problems, accepted);
    await store.updateVerifiedSnapshot(profile.profile_id, problems, now, null);
  } catch {
    console.warn('[NotificationWorker] Daily submission verification failed; reminder deferred.');
    await store.updateVerifiedSnapshot(
      profile.profile_id,
      problems,
      now,
      new Date(now.getTime() + RETRY_DELAY_MS),
    );
    return null;
  }
  const remaining = countUnfinished(problems);
  return remaining > 0 ? { remaining, snapshot: problems } : null;
}

async function sendTask(
  store: NotificationStore,
  task: NotificationTask,
  env: Env,
  now: Date,
): Promise<'SENT' | 'SKIPPED' | 'FAILED'> {
  let payload: Record<string, unknown>;
  if (task.kind === 'contest') {
    payload = contestPayload(task);
  } else {
    const localDate = getLocalDateTime(now).date;
    const daily = await prepareDailyTask(store, task, now);
    if (!daily) return 'SKIPPED';
    payload = dailyPayload(task, daily.remaining, localDate);
  }

  const deliveryId = await store.claimDelivery(task, now);
  if (!deliveryId) return 'SKIPPED';
  try {
    await sendWebPush(
      task.subscription.endpoint,
      task.subscription.p256dh,
      task.subscription.auth,
      payload,
      {
        publicKey: env.VAPID_PUBLIC_KEY,
        privateKey: env.VAPID_PRIVATE_KEY,
        subject: env.VAPID_SUBJECT,
      },
    );
    await store.updateDelivery(deliveryId, {
      status: 'SENT',
      sentAt: now.toISOString(),
    });
    return 'SENT';
  } catch (error) {
    if (error instanceof PushDeliveryError && (error.statusCode === 404 || error.statusCode === 410)) {
      await store.deleteSubscriptionByHash(task.subscription.endpoint_hash);
      await store.updateDelivery(deliveryId, {
        status: 'EXPIRED',
        errorCode: `HTTP_${error.statusCode}`,
      });
      return 'FAILED';
    }
    const errorCode = error instanceof PushDeliveryError ? `HTTP_${error.statusCode}` : 'DELIVERY_FAILED';
    await store.updateDelivery(deliveryId, {
      status: 'FAILED',
      retryAfter: new Date(now.getTime() + RETRY_DELAY_MS).toISOString(),
      errorCode,
    });
    return 'FAILED';
  }
}

export async function runScheduledWorker(
  env: Env,
  now = new Date(),
): Promise<WorkerStats & { status: 'SUCCEEDED' | 'SKIPPED' }> {
  const started = performance.now();
  const store = new NotificationStore(env.DB);
  const runId = crypto.randomUUID();
  const startedAt = now.toISOString();
  let profilesChecked = 0;
  let pushesAttempted = 0;
  let notificationsSent = 0;

  if (!await store.acquireWorker(runId, now)) {
    await store.recordRun(runId, { startedAt, completedAt: now.toISOString(), status: 'SKIPPED' });
    return { status: 'SKIPPED', profilesChecked, pushesAttempted, notificationsSent, durationMs: performance.now() - started };
  }

  await store.recordRun(runId, { startedAt, status: 'RUNNING' });
  try {
    const contestRefreshSucceeded = await refreshContestsIfNeeded(store, now);
    let task: NotificationTask | null = contestRefreshSucceeded
      ? await store.findContestTask(now)
      : null;
    const localTime = getLocalDateTime(now);
    if (!task) task = await store.findDailyTask(now, localTime.date, localTime.time);

    if (task) {
      profilesChecked = 1;
      const delivery = await sendTask(store, task, env, now);
      if (delivery !== 'SKIPPED') pushesAttempted = MAX_PUSHES_PER_CRON;
      if (delivery === 'SENT') notificationsSent = 1;
    }

    const completedAt = new Date().toISOString();
    const durationMs = performance.now() - started;
    await store.recordRun(runId, {
      startedAt,
      completedAt,
      status: 'SUCCEEDED',
      profilesChecked,
      pushesAttempted,
      notificationsSent,
      durationMs,
    });
    await store.updateWorkerState({
      lockOwner: runId,
      lastCompletedAt: completedAt,
      lastSuccessAt: completedAt,
      lastStatus: 'SUCCEEDED',
    });
    if (now.getUTCHours() === 3 && now.getUTCMinutes() < 5) await store.cleanup(now);
    return { status: 'SUCCEEDED', profilesChecked, pushesAttempted, notificationsSent, durationMs };
  } catch (error) {
    const completedAt = new Date().toISOString();
    const durationMs = performance.now() - started;
    await store.recordRun(runId, {
      startedAt,
      completedAt,
      status: 'FAILED',
      profilesChecked,
      pushesAttempted,
      notificationsSent,
      durationMs,
      errorCode: safeErrorCode(error),
    });
    await store.updateWorkerState({
      lockOwner: runId,
      lastCompletedAt: completedAt,
      lastStatus: 'FAILED',
    });
    console.error(`[NotificationWorker] Scheduled run failed (${safeErrorCode(error)}).`);
    throw error;
  } finally {
    await store.releaseWorker(runId);
  }
}

function safeErrorCode(error: unknown): string {
  if (error instanceof PushDeliveryError) return `HTTP_${error.statusCode}`;
  if (error instanceof Error && error.message.startsWith('Codeforces')) return 'CODEFORCES_FAILED';
  return 'WORKER_FAILED';
}
