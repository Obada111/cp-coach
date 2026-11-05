import { scopedStorageKey } from './storageScope';

const LEGACY_PREFIXES = [
  'cp-coach:handles:v1',
  'cp-coach:active-handle:v1',
  'cp-coach:context:v1:',
  'cp-coach:offline-dashboard:v1',
  'cp-coach:knowledge-journal:v1:',
  'cp-coach:virtual-contest:v1:',
  'cp-coach:context-captured-at:v1:',
];

const MIGRATION_MARKER = 'cp-coach:legacy-browser-data-migrated:v1';

function isLegacyBrowserKey(key: string): boolean {
  if (key.includes(':user:')) return false;
  return LEGACY_PREFIXES.some((prefix) => (
    key === prefix || key.startsWith(prefix.endsWith(':') ? prefix : `${prefix}:`)
  ));
}

export function findLegacyBrowserKeys(): string[] {
  try {
    const keys: string[] = [];
    for (let index = 0; index < window.localStorage.length; index += 1) {
      const key = window.localStorage.key(index);
      if (key && isLegacyBrowserKey(key)) keys.push(key);
    }
    return keys;
  } catch {
    return [];
  }
}

export function hasLegacyBrowserData(): boolean {
  try {
    return window.localStorage.getItem(scopedStorageKey(MIGRATION_MARKER)) !== 'true' &&
      findLegacyBrowserKeys().length > 0;
  } catch {
    return false;
  }
}

export function migrateLegacyBrowserDataToActiveAccount(): {
  moved: number;
  skipped: number;
  failed: number;
} {
  const keys = findLegacyBrowserKeys();
  const written: Array<{ legacyKey: string; accountKey: string; value: string }> = [];
  let skipped = 0;
  let failed = 0;

  for (const legacyKey of keys) {
    const accountKey = scopedStorageKey(legacyKey);
    if (accountKey === legacyKey) {
      skipped += 1;
      continue;
    }
    try {
      if (window.localStorage.getItem(accountKey) !== null) {
        skipped += 1;
        continue;
      }
      const value = window.localStorage.getItem(legacyKey);
      if (value === null) {
        skipped += 1;
        continue;
      }
      window.localStorage.setItem(accountKey, value);
      written.push({ legacyKey, accountKey, value });
    } catch {
      failed += 1;
    }
  }

  if (failed === 0) {
    for (const { legacyKey, accountKey, value } of written) {
      try {
        if (window.localStorage.getItem(accountKey) === value) {
          window.localStorage.removeItem(legacyKey);
        }
      } catch {
        failed += 1;
      }
    }
    if (failed === 0) {
      try {
        window.localStorage.setItem(scopedStorageKey(MIGRATION_MARKER), 'true');
      } catch {
        failed += 1;
      }
    }
  }

  return { moved: written.length, skipped, failed };
}

export function dismissLegacyBrowserDataMigration(): void {
  try {
    window.localStorage.setItem(scopedStorageKey(MIGRATION_MARKER), 'dismissed');
  } catch {
    // The prompt will reappear next session if storage is unavailable.
  }
}
