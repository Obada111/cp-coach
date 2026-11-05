import { describe, expect, it } from 'vitest';
import { selectRecentFollowedEntries } from '../socialSyncService.js';

describe('social background synchronization', () => {
  it('filters entries to followed bloggers and deduplicates blog actions', () => {
    const followedAt = new Date('2026-11-02T12:00:00.000Z');
    const result = selectRecentFollowedEntries([
      {
        timeSeconds: 100,
        blogEntry: {
          id: 1,
          authorHandle: 'Followed',
          title: 'Before follow',
          creationTimeSeconds: Math.floor(followedAt.getTime() / 1_000) - 1,
        },
      },
      {
        timeSeconds: 101,
        blogEntry: {
          id: 2,
          authorHandle: 'FOLLOWED',
          title: 'New post',
          creationTimeSeconds: Math.floor(followedAt.getTime() / 1_000),
        },
      },
      {
        timeSeconds: 102,
        blogEntry: {
          id: 2,
          authorHandle: 'followed',
          title: 'New post updated',
          creationTimeSeconds: Math.floor(followedAt.getTime() / 1_000) + 1,
        },
      },
      {
        timeSeconds: 103,
        blogEntry: {
          id: 3,
          authorHandle: 'NotFollowed',
          title: 'Unfollowed author',
          creationTimeSeconds: Math.floor(followedAt.getTime() / 1_000) + 1,
        },
      },
    ], [{ handle: 'Followed', created_at: followedAt }]);

    expect(result).toHaveLength(1);
    expect(result[0].id).toBe(2);
    expect(result[0].title).toBe('New post updated');
  });
});
