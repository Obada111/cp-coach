import React, { useCallback, useEffect, useState } from 'react';
import { AlertCircle, Bell, Clock3 } from 'lucide-react';
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

const DEFAULT_SETTINGS: NotificationPreferences = {
  contestReminders: false,
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
    if (subscription && serverRegistered) void disableNotifications();
    else void enableNotifications();
  };

  const pushSupported = permission !== 'unsupported' && hasServiceWorker;
  const pushEnabled = Boolean(subscription && serverRegistered);

  return (
    <section className="p-4 rounded-xl bg-slate-900/80 border border-slate-800 space-y-4" aria-labelledby="notifications-title">
      <div>
        <h3 id="notifications-title" className="text-xs font-semibold text-slate-200 flex items-center gap-2">
          <Bell className="w-4 h-4 text-cyan-400" />
          Notifications
        </h3>
        <p className="mt-1 text-xs text-slate-400">
          Reminders are delivered by the CP Coach backend, including when this app is closed.
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
            disabled={isLoading || isSaving || (pushEnabled ? false : !availability?.available || !pushSupported || permission === 'denied')}
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
          <p className="flex items-center gap-1.5 text-[11px] text-emerald-300" role="status">
            <Bell className="h-3 w-3" />
            This device is registered for push notifications.
          </p>
        )}
        {!availability?.available && !isLoading && (
          <p className="text-[11px] text-amber-300">
            Backend setup is incomplete. Durable storage and VAPID keys are required before notifications can be enabled.
          </p>
        )}
        {permission === 'denied' && (
          <p className="text-[11px] text-amber-300">
            Permission is blocked. Change this site's notification permission in Android Chrome settings.
          </p>
        )}
        {!pushSupported && (
          <p className="text-[11px] text-amber-300">
            This browser or app session does not have an active service worker for push notifications.
          </p>
        )}
      </div>

      <div className="space-y-3">
        <label className="flex items-center justify-between gap-3 rounded-lg border border-slate-800 bg-slate-950/70 p-3">
          <span>
            <span className="block text-xs font-medium text-slate-200">Contest reminders</span>
            <span className="text-[11px] text-slate-500">About 30 minutes before a Codeforces contest.</span>
          </span>
          <input
            type="checkbox"
            checked={settings.contestReminders}
            disabled={isLoading || isSaving}
            onChange={(event) => void updateSettings({ contestReminders: event.target.checked })}
            className="h-4 w-4 accent-cyan-500"
          />
        </label>

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
