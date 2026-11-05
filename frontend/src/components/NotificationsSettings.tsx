import React, { useCallback, useEffect, useState } from 'react';
import { AlertCircle, Bell, CheckCircle2, Clock3, Send, XCircle } from 'lucide-react';
import {
  fetchNotificationAvailability,
  fetchNotificationSettings,
  isPushSubscriptionRegistered,
  NotificationAvailability,
  NotificationSettings as NotificationPreferences,
  registerPushSubscription,
  removePushSubscription,
  saveNotificationSettings,
} from '../api';
import { requestPushPermission } from '../notifications';

interface NotificationsSettingsProps {
  profileId: string;
}

type PermissionState = NotificationPermission | 'unsupported';

function isAppleMobileDevice(): boolean {
  return typeof navigator !== 'undefined' && (
    /iPhone|iPad|iPod/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
  );
}

function isStandaloneApp(): boolean {
  return typeof window !== 'undefined' && (
    window.matchMedia('(display-mode: standalone)').matches ||
    Boolean((navigator as Navigator & { standalone?: boolean }).standalone)
  );
}

const DEFAULT_SETTINGS: NotificationPreferences = {
  contestReminders: false,
  contestReminderOffsets: [30],
  dailyReminders: false,
  reminderTime: '20:00',
  timezone: 'Asia/Hebron',
};

function decodeApplicationServerKey(value: string): ArrayBuffer {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, '=');
  const binary = window.atob(padded);
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

function serializedSubscription(subscription: PushSubscription): {
  endpoint: string;
  keys: { p256dh: string; auth: string };
} {
  const json = subscription.toJSON();
  if (!json.endpoint || !json.keys?.p256dh || !json.keys.auth) {
    throw new Error('The browser returned an incomplete push subscription. Try enabling notifications again.');
  }
  return {
    endpoint: json.endpoint,
    keys: { p256dh: json.keys.p256dh, auth: json.keys.auth },
  };
}

export const NotificationsSettings: React.FC<NotificationsSettingsProps> = ({ profileId }) => {
  const [availability, setAvailability] = useState<NotificationAvailability | null>(null);
  const [settings, setSettings] = useState(DEFAULT_SETTINGS);
  const [permission, setPermission] = useState<PermissionState>(() => (
    typeof window !== 'undefined' && 'Notification' in window ? Notification.permission : 'unsupported'
  ));
  const [subscription, setSubscription] = useState<PushSubscription | null>(null);
  const [serverRegistered, setServerRegistered] = useState(false);
  const [hasServiceWorker, setHasServiceWorker] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [testNotificationSent, setTestNotificationSent] = useState(false);

  const loadSettings = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    setSubscription(null);
    setServerRegistered(false);
    try {
      const [serviceConfig, preferences] = await Promise.all([
        fetchNotificationAvailability(),
        fetchNotificationSettings(),
      ]);
      setAvailability(serviceConfig);
      setSettings(preferences.settings);
      if (!('Notification' in window) || !('serviceWorker' in navigator) || !('PushManager' in window)) {
        setPermission('unsupported');
        setSubscription(null);
        setHasServiceWorker(false);
        return;
      }
      setPermission(Notification.permission);
      const currentRegistration = await navigator.serviceWorker.getRegistration('/');
      if (!currentRegistration) {
        setHasServiceWorker(false);
        setSubscription(null);
        return;
      }
      setHasServiceWorker(true);
      const registration = await navigator.serviceWorker.ready;
      const existing = await registration.pushManager.getSubscription();
      setSubscription(existing);
      const registered = existing && serviceConfig.available
        ? await isPushSubscriptionRegistered(existing.endpoint)
        : false;
      setServerRegistered(registered);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Could not load notification settings.');
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadSettings();
  }, [loadSettings, profileId]);

  const updateSettings = async (updates: Partial<NotificationPreferences>) => {
    const next = {
      contestReminders: updates.contestReminders ?? settings.contestReminders,
      contestReminderOffsets: updates.contestReminderOffsets ?? settings.contestReminderOffsets,
      dailyReminders: updates.dailyReminders ?? settings.dailyReminders,
      reminderTime: updates.reminderTime ?? settings.reminderTime,
    };
    setIsSaving(true);
    setError(null);
    try {
      setSettings(await saveNotificationSettings(next));
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'Could not save notification settings.');
    } finally {
      setIsSaving(false);
    }
  };

  const enableNotifications = async () => {
    if (!availability?.available) {
      setError('Push notifications are not configured on the backend yet.');
      return;
    }
    if (!('Notification' in window) || !('serviceWorker' in navigator) || !('PushManager' in window)) {
      setPermission('unsupported');
      setError('This browser does not support background push notifications.');
      return;
    }
    if (!(await navigator.serviceWorker.getRegistration('/'))) {
      setError('The CP Coach service worker is not active. Reopen the installed app while online and try again.');
      return;
    }

    setIsSaving(true);
    setError(null);
    try {
      const result = await requestPushPermission();
      if (result === 'unsupported') {
        setPermission('unsupported');
        setError('This browser does not support notification permissions.');
        return;
      }
      setPermission(result);
      if (result !== 'granted') {
        setError(result === 'denied'
          ? 'Notifications are blocked for this site. Allow them in Android Chrome site settings, then try again.'
          : 'Notification permission was not granted.');
        return;
      }
      if (!availability.vapidPublicKey) throw new Error('The backend did not provide its public VAPID key.');
      const registration = await navigator.serviceWorker.ready;
      const existing = await registration.pushManager.getSubscription();
      if (existing && !serverRegistered && !(await existing.unsubscribe())) {
        throw new Error('The previous browser subscription could not be renewed. Remove it in browser settings and try again.');
      }
      const nextSubscription = (existing && serverRegistered ? existing : null) || await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: decodeApplicationServerKey(availability.vapidPublicKey),
      });
      await registerPushSubscription(serializedSubscription(nextSubscription));
      setSubscription(nextSubscription);
      setServerRegistered(true);
    } catch (enableError) {
      setError(enableError instanceof Error ? enableError.message : 'Could not enable push notifications.');
    } finally {
      setIsSaving(false);
    }
  };

  const disableNotifications = async () => {
    if (!subscription) return;
    setIsSaving(true);
    setError(null);
    try {
      await removePushSubscription(subscription.endpoint);
      const removed = await subscription.unsubscribe();
      if (!removed) throw new Error('The browser could not unsubscribe this device.');
      setSubscription(null);
      setServerRegistered(false);
    } catch (disableError) {
      setError(disableError instanceof Error ? disableError.message : 'Could not disable notifications.');
    } finally {
      setIsSaving(false);
    }
  };

  const toggleNotifications = () => {
    if (subscriptionRegistered) void disableNotifications();
    else void enableNotifications();
  };

  const needsAppleHomeScreenInstall = isAppleMobileDevice() && !isStandaloneApp();
  const pushSupported = permission !== 'unsupported' && hasServiceWorker && !needsAppleHomeScreenInstall;
  const subscriptionRegistered = Boolean(subscription && serverRegistered);
  const pushEnabled = Boolean(
    subscriptionRegistered &&
    permission === 'granted' &&
    hasServiceWorker &&
    !needsAppleHomeScreenInstall &&
    availability?.available
  );
  const readiness = availability?.readiness;
  const StatusLine: React.FC<{ label: string; ready: boolean; detail: string }> = ({ label, ready, detail }) => (
    <div className="flex items-start gap-2 text-[11px]">
      {ready
        ? <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-400" />
        : <XCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-400" />}
      <span>
        <span className="font-medium text-slate-200">{label}: </span>
        <span className="text-slate-400">{detail}</span>
      </span>
    </div>
  );

  return (
    <section className="p-4 rounded-xl bg-slate-900/80 border border-slate-800 space-y-4" aria-labelledby="notifications-title">
      <div>
        <h3 id="notifications-title" className="text-xs font-semibold text-slate-200 flex items-center gap-2">
          <Bell className="w-4 h-4 text-cyan-400" />
          Notifications
        </h3>
        <p className="mt-1 text-xs text-slate-400">
          Contest reminders use background Web Push. Delivery still depends on browser push support and the notification worker.
        </p>
      </div>

      <div className="rounded-lg border border-slate-800 bg-slate-950/70 p-3 space-y-2.5">
        <div className="flex items-center justify-between gap-3">
          <div>
            <p className="text-xs font-medium text-slate-200">Push notifications for this device</p>
            <p className="text-[11px] text-slate-500">
              Browser permission: {permission === 'unsupported' ? 'Not supported' : permission}
            </p>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={pushEnabled}
            aria-label="Enable push notifications on this device"
            onClick={toggleNotifications}
            disabled={isLoading || isSaving || (
              !subscriptionRegistered &&
              (!availability?.available || !pushSupported || permission === 'denied')
            )}
            className={`relative h-6 w-11 shrink-0 rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${pushEnabled ? 'bg-cyan-600' : 'bg-slate-700'}`}
          >
            <span className={`absolute top-1 h-4 w-4 rounded-full bg-white transition-transform ${pushEnabled ? 'translate-x-6' : 'translate-x-1'}`} />
          </button>
        </div>
        {!pushEnabled && pushSupported && permission !== 'denied' && (
          <button
            type="button"
            onClick={enableNotifications}
            disabled={isLoading || isSaving || !availability?.available}
            className="flex items-center gap-2 rounded-lg bg-cyan-600 px-3 py-2 text-xs font-semibold text-white transition-colors hover:bg-cyan-500 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Bell className="h-3.5 w-3.5" />
            Enable Notifications
          </button>
        )}
        {pushEnabled && (
          <div className="space-y-2">
            <p className="flex items-center gap-1.5 text-[11px] text-emerald-300" role="status">
              <Bell className="h-3 w-3" />
              This device is registered for push notifications.
            </p>
            <button
              type="button"
              onClick={async () => {
                try {
                  const reg = await navigator.serviceWorker?.ready;
                  if (reg) {
                    await reg.showNotification('CP Coach Test Notification', {
                      body: 'Push notifications are working! Contest reminders are active.',
                      icon: '/icons/icon-192.png',
                      badge: '/icons/icon-192.png',
                      tag: 'cp-coach-test',
                    });
                    setTestNotificationSent(true);
                    setTimeout(() => setTestNotificationSent(false), 3500);
                  }
                } catch (err) {
                  setError('Test notification failed: ' + (err instanceof Error ? err.message : String(err)));
                }
              }}
              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-700 bg-slate-800/80 px-2.5 py-1.5 text-[11px] font-medium text-slate-200 hover:bg-slate-700 hover:text-white transition-colors"
            >
              <Send className="w-3 h-3 text-cyan-400" />
              {testNotificationSent ? 'Test notification sent!' : 'Send test notification'}
            </button>
          </div>
        )}
        {needsAppleHomeScreenInstall && (
          <div className="rounded-lg border border-amber-900/60 bg-amber-950/30 p-3 text-[11px] text-amber-200" role="status">
            <p className="font-medium">Install CP Coach before enabling notifications on iPhone or iPad.</p>
            <ol className="mt-1 list-inside list-decimal space-y-0.5 text-amber-100/80">
              <li>Open this page in Safari.</li>
              <li>Tap Share, then Add to Home Screen.</li>
              <li>Launch CP Coach from its Home Screen icon.</li>
              <li>Return to Settings → Notifications and enable push.</li>
            </ol>
            <p className="mt-1 text-amber-100/70">Web Push requires a supported iOS/iPadOS version (16.4 or later) and a ready notification service.</p>
          </div>
        )}
        {permission === 'denied' && (
          <p className="text-[11px] text-amber-300">
            Permission is blocked. Allow notifications for CP Coach in this browser or device's notification settings.
          </p>
        )}
        {!pushSupported && !needsAppleHomeScreenInstall && (
          <p className="text-[11px] text-amber-300">
            This browser or app session does not have an active service worker for push notifications.
          </p>
        )}
        {readiness && (
          <div className="space-y-2 border-t border-slate-800 pt-3" aria-label="Notification service readiness">
            <StatusLine
              label="Durable storage"
              ready={readiness.storage.ready}
              detail={readiness.storage.detail}
            />
            <StatusLine
              label="VAPID configuration"
              ready={readiness.vapid.configured && readiness.vapid.matchesWorker === true}
              detail={readiness.vapid.detail}
            />
            <StatusLine
              label="Notification worker"
              ready={
                readiness.worker.reachable &&
                readiness.worker.apiSecretConfigured &&
                readiness.worker.schedulerHealthy === true
              }
              detail={readiness.worker.detail}
            />
            <StatusLine
              label="Browser permission"
              ready={permission === 'granted'}
              detail={permission === 'unsupported'
                ? 'This browser does not support Web Push.'
                : permission === 'granted'
                  ? 'Granted.'
                  : permission === 'denied'
                    ? 'Blocked in browser settings.'
                    : 'Not granted yet.'}
            />
            <StatusLine
              label="Device subscription"
              ready={pushEnabled}
              detail={subscriptionRegistered
                ? pushEnabled
                  ? 'This device is registered and the delivery service is ready.'
                  : 'The subscription is stored, but delivery is not currently ready; notifications are not enabled.'
                : subscription
                  ? 'A browser subscription exists but is not registered with the backend.'
                  : 'This device is not subscribed.'}
            />
            <div className="text-[11px] text-slate-400">
              <span className="font-medium text-slate-200">Last worker delivery run: </span>
              {readiness.worker.lastRun
                ? `${readiness.worker.lastRun.status || 'unknown'}; ${readiness.worker.lastRun.notifications_sent ?? 0} push(es) accepted by push services${readiness.worker.lastRun.error_code ? ` (${readiness.worker.lastRun.error_code})` : ''}.`
                : 'No scheduled run has completed yet.'}
            </div>
            {readiness.worker.schedulerHealthy === false && (
              <p className="text-[11px] text-amber-300">
                The worker has no successful scheduled run in the last 15 minutes. A saved subscription alone does not mean reminders are being processed.
              </p>
            )}
          </div>
        )}
      </div>

      <div className="space-y-3">
        <label className="flex items-center justify-between gap-3 rounded-lg border border-slate-800 bg-slate-950/70 p-3">
          <span>
            <span className="block text-xs font-medium text-slate-200">Contest reminders</span>
            <span className="text-[11px] text-slate-500">Choose when to be reminded before a Codeforces contest.</span>
          </span>
          <input
            type="checkbox"
            checked={settings.contestReminders}
            disabled={isLoading || isSaving}
            onChange={(event) => void updateSettings({ contestReminders: event.target.checked })}
            className="h-4 w-4 accent-cyan-500"
          />
        </label>
        <fieldset
          disabled={isLoading || isSaving}
          className="rounded-lg border border-slate-800 bg-slate-950/70 p-3 space-y-2 disabled:opacity-60"
        >
          <legend className="px-1 text-[11px] font-medium text-slate-400">Reminder times</legend>
          {([
            [1440, '24 hours before'],
            [60, '1 hour before'],
            [30, '30 minutes before'],
            [5, '5 minutes before'],
          ] as const).map(([offset, label]) => (
            <label key={offset} className="flex items-center justify-between gap-3 text-xs text-slate-300">
              <span>{label}</span>
              <input
                type="checkbox"
                checked={settings.contestReminderOffsets.includes(offset)}
                onChange={(event) => {
                  const offsets = event.target.checked
                    ? [...settings.contestReminderOffsets, offset]
                    : settings.contestReminderOffsets.filter((value) => value !== offset);
                  void updateSettings({ contestReminderOffsets: offsets.sort((a, b) => b - a) });
                }}
                className="h-4 w-4 accent-cyan-500"
              />
            </label>
          ))}
          <p className="text-[11px] text-slate-500">The worker checks every minute and processes up to ten deliveries per run. Large bursts or CPU limits can still delay a reminder past its delivery window.</p>
        </fieldset>

        <div className="rounded-lg border border-slate-800 bg-slate-950/70 p-3 space-y-3">
          <label className="flex items-center justify-between gap-3">
            <span>
              <span className="block text-xs font-medium text-slate-200">Daily practice reminder</span>
              <span className="text-[11px] text-slate-500">Only while today's recommendations remain unfinished.</span>
            </span>
            <input
              type="checkbox"
              checked={settings.dailyReminders}
              disabled={isLoading || isSaving}
              onChange={(event) => void updateSettings({ dailyReminders: event.target.checked })}
              className="h-4 w-4 accent-cyan-500"
            />
          </label>
          <label className="flex items-center justify-between gap-3 border-t border-slate-800 pt-3">
            <span className="flex items-center gap-1.5 text-xs text-slate-300">
              <Clock3 className="h-3.5 w-3.5 text-cyan-400" />
              Reminder time
            </span>
            <input
              type="time"
              value={settings.reminderTime}
              disabled={isLoading || isSaving}
              onChange={(event) => void updateSettings({ reminderTime: event.target.value })}
              className="rounded-md border border-slate-700 bg-slate-900 px-2 py-1 text-xs text-white"
            />
          </label>
          <p className="text-[11px] text-slate-500">
            Timezone: <span className="font-medium text-slate-300">{settings.timezone}</span>
          </p>
        </div>
      </div>

      {error && (
        <p className="flex items-start gap-1.5 text-xs text-rose-300" role="alert">
          <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          {error}
        </p>
      )}
      {isLoading && <p className="text-[11px] text-slate-500">Loading notification settings…</p>}
    </section>
  );
};
