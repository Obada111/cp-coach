export function isSocialCacheStale(
  refreshedAt: Date | string | number | null | undefined,
  maxAgeMs: number,
  now = Date.now(),
): boolean {
  if (!refreshedAt) return true;
  const timestamp = new Date(refreshedAt).getTime();
  return !Number.isFinite(timestamp) || timestamp > now || now - timestamp > maxAgeMs;
}

export function isPresenceOnline(expiresAt: Date | string | null | undefined, now = Date.now()): boolean {
  if (!expiresAt) return false;
  const expiration = new Date(expiresAt).getTime();
  return Number.isFinite(expiration) && expiration > now;
}
