let activeUserScope: string | null = null;

export function setStorageScope(userId: string | null): void {
  const clean = userId?.trim().toLowerCase() || '';
  activeUserScope = /^[0-9a-f-]{36}$/i.test(clean) ? clean : null;
}

export function getStorageScope(): string | null {
  return activeUserScope;
}

export function scopedStorageKey(key: string): string {
  return activeUserScope ? `cp-coach:user:${activeUserScope}:${key}` : key;
}
