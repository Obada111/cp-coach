import type { DailySnapshotProblem } from './logic';

export interface Env {
  DB: D1Database;
  API_SECRET: string;
  VAPID_PUBLIC_KEY: string;
  VAPID_PRIVATE_KEY: string;
  VAPID_SUBJECT: string;
}

export interface NotificationProfile {
  profile_id: string;
  owner_id: string;
  cf_handle: string;
  contest_reminders: number;
  daily_reminders: number;
  reminder_time: string;
  timezone: string;
  snapshot_date: string | null;
  daily_snapshot: string;
  snapshot_synced_at: string | null;
  submissions_checked_at: string | null;
  verification_retry_after: string | null;
}

export interface PushSubscription {
  endpoint_hash: string;
  profile_id: string;
  owner_id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
}

export interface NotificationTask {
  profile: NotificationProfile;
  subscription: PushSubscription;
  notificationKey: string;
  kind: 'contest' | 'daily';
  contestId?: number;
  contestName?: string;
  startTimeSeconds?: number;
  remaining?: number;
  snapshot?: DailySnapshotProblem[];
}

export interface WorkerStats {
  profilesChecked: number;
  pushesAttempted: number;
  notificationsSent: number;
  durationMs: number;
}
