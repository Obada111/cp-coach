import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { isPresenceOnline, isSocialCacheStale } from '../socialState.js';

describe('social cache and presence state', () => {
  const now = Date.parse('2026-11-02T12:00:00.000Z');

  it('expires stale and invalid cache timestamps', () => {
    expect(isSocialCacheStale(new Date(now - 89_000), 90_000, now)).toBe(false);
    expect(isSocialCacheStale(new Date(now - 91_000), 90_000, now)).toBe(true);
    expect(isSocialCacheStale(null, 90_000, now)).toBe(true);
    expect(isSocialCacheStale('not-a-date', 90_000, now)).toBe(true);
    expect(isSocialCacheStale(new Date(now + 1_000), 90_000, now)).toBe(true);
  });

  it('treats expired presence as offline', () => {
    expect(isPresenceOnline(new Date(now + 1), now)).toBe(true);
    expect(isPresenceOnline(new Date(now), now)).toBe(false);
    expect(isPresenceOnline(null, now)).toBe(false);
    expect(isPresenceOnline('invalid', now)).toBe(false);
  });

  it('enables RLS for every sensitive social data table', async () => {
    const migration = await readFile(
      new URL('../../../supabase/migrations/202611020001_phase1_social.sql', import.meta.url),
      'utf8',
    );
    const syncService = await readFile(new URL('../socialSyncService.ts', import.meta.url), 'utf8');
    const protectedTables = [
      'social_profiles',
      'codeforces_link_challenges',
      'codeforces_credentials',
      'codeforces_friends_cache',
      'friend_requests',
      'friendships',
      'friend_presence',
      'friend_activity_preferences',
      'blog_watchlist',
      'blog_entries',
      'blog_entry_comments',
      'blog_entry_state',
      'social_sync_state',
      'social_notifications',
    ];

    for (const table of protectedTables) {
      expect(migration).toContain(`ALTER TABLE public.${table} ENABLE ROW LEVEL SECURITY;`);
    }
    expect(migration).toContain('UNIQUE (user_id, event_key)');
    expect(migration).toContain('LEAST(sender_id, recipient_id)');
    expect(migration).toContain('GREATEST(sender_id, recipient_id)');
    expect(migration).toContain('CREATE POLICY friend_requests_read_participant');
    expect(migration).toContain('CREATE POLICY friend_requests_create_sender');
    expect(migration).toContain('CREATE POLICY friend_requests_update_recipient');
    expect(migration).toContain('CREATE POLICY friendships_accept_request');
    expect(migration).toContain('CREATE POLICY friend_presence_read_visible_friends');
    expect(syncService).toContain('ON CONFLICT (user_id, event_key) DO NOTHING');
  });
});
