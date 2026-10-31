export type PushPermissionResult = NotificationPermission | 'unsupported';

export async function requestPushPermission(): Promise<PushPermissionResult> {
  if (typeof Notification === 'undefined') return 'unsupported';
  return Notification.requestPermission();
}
