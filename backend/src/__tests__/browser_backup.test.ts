import { describe, expect, it } from 'vitest';
import {
  applyBrowserStorageChanges,
  BROWSER_BACKUP_FORMAT,
  BrowserStorageTransactionError,
  mergeBrowserContexts,
  serverContextImportSequence,
  validateBrowserBackup,
} from '../../../frontend/src/dataBackup.js';
import { mergeKnowledgeNotes, validateKnowledgeNotes } from '../../../frontend/src/knowledgeJournal.js';
import { isVirtualContestSession } from '../../../frontend/src/virtualContest.js';

function context(note: string) {
  return {
    version: 1,
    handle: 'BackupTester',
    dailySets: [],
    dailyProblems: [{ id: 'daily-1', notes: note }],
    reviewQueue: [{ profile_id: 'p1', problem_id: '1_A', review_notes: note }],
    solveSessions: [],
    contestReviews: [],
    userContests: [],
    weeklyGoals: [],
    learningEvents: [],
    problems: [],
    contestProblemsMeta: [],
  };
}

describe('browser backup schema and merge', () => {
  it('accepts a versioned backup with bounded, structured profile snapshots', () => {
    const backup = validateBrowserBackup({
      format: BROWSER_BACKUP_FORMAT,
      version: 1,
      exportedAt: '2026-10-30T12:00:00.000Z',
      profiles: [{ handle: 'BackupTester', context: context('private note') }],
    });
    expect(backup.profiles).toHaveLength(1);
  });

  it('rejects unsupported versions, mismatched handles, and malformed row arrays', () => {
    const base = {
      format: BROWSER_BACKUP_FORMAT,
      version: 1,
      exportedAt: '2026-10-30T12:00:00.000Z',
      profiles: [{ handle: 'BackupTester', context: context('private note') }],
    };
    expect(() => validateBrowserBackup({ ...base, version: 2 })).toThrow('Unsupported backup format');
    expect(() => validateBrowserBackup({
      ...base,
      profiles: [{ handle: 'BackupTester', context: { ...context('note'), handle: 'DifferentUser' } }],
    })).toThrow('does not match profile');
    expect(() => validateBrowserBackup({
      ...base,
      profiles: [{ handle: 'BackupTester', context: { ...context('note'), reviewQueue: 'invalid' } }],
    })).toThrow("invalid 'reviewQueue' data");
  });

  it('merges by natural keys without duplicating matching learning records', () => {
    const merged = mergeBrowserContexts(context('existing'), context('restored'));
    expect(merged.dailyProblems).toEqual([{ id: 'daily-1', notes: 'restored' }]);
    expect(merged.reviewQueue).toEqual([
      { profile_id: 'p1', problem_id: '1_A', review_notes: 'restored' },
    ]);
  });

  it('imports different browser snapshots separately so profile IDs are never mixed', () => {
    const browserA = { ...context('from A'), profileId: 'profile-a' };
    const browserB = { ...context('from B'), profileId: 'profile-b' };
    expect(serverContextImportSequence(browserA, browserB, 'merge')).toEqual([browserB, browserA]);
    expect(serverContextImportSequence(browserA, browserB, 'replace')).toEqual([browserA]);
  });

  it('validates and merges browser-private knowledge notes by entry ID', () => {
    const note = {
      id: 'note-1',
      title: 'Two pointers',
      lesson: 'Maintain the leftmost valid boundary.',
      problemRef: '100_A',
      contestId: 100,
      topics: ['two pointers'],
      createdAt: '2026-10-01T10:00:00.000Z',
      updatedAt: '2026-10-01T10:00:00.000Z',
    };
    expect(validateKnowledgeNotes([note])).toEqual([note]);
    expect(mergeKnowledgeNotes([note], [{ ...note, lesson: 'Updated invariant.' }])).toEqual([
      { ...note, lesson: 'Updated invariant.' },
    ]);
    expect(() => validateKnowledgeNotes([{ ...note, topics: ['dp', 42] }])).toThrow('invalid knowledge journal');
  });

  it('validates browser-local virtual contest reports and rejects cross-profile data', () => {
    const session = {
      contestId: 1900,
      profileHandle: 'BackupTester',
      name: 'Codeforces Round',
      durationSeconds: 7200,
      startedAt: '2026-10-30T10:00:00.000Z',
      finishedAt: null,
      problems: { A: { firstStartedAt: null, solvedAt: null } },
    };
    const backup = validateBrowserBackup({
      format: BROWSER_BACKUP_FORMAT,
      version: 1,
      exportedAt: '2026-10-30T12:00:00.000Z',
      profiles: [{ handle: 'BackupTester', context: context('note'), virtualContests: [session] }],
    });
    expect(backup.profiles[0].virtualContests).toEqual([session]);
    expect(() => validateBrowserBackup({
      format: BROWSER_BACKUP_FORMAT,
      version: 1,
      exportedAt: '2026-10-30T12:00:00.000Z',
      profiles: [{ handle: 'BackupTester', context: context('note'), virtualContests: [{ ...session, profileHandle: 'OtherUser' }] }],
    })).toThrow('invalid virtual contest sessions');
  });

  it('rejects invalid journal and virtual-contest timestamps and impossible ordering', () => {
    const note = {
      id: 'note-date',
      title: 'Date validation',
      lesson: 'Use only valid timestamps.',
      problemRef: null,
      contestId: null,
      topics: [],
      createdAt: '2026-10-30T10:00:00.000Z',
      updatedAt: '2026-10-30T10:00:00.000Z',
    };
    expect(() => validateKnowledgeNotes([{ ...note, createdAt: '' }])).toThrow('invalid createdAt timestamp');
    expect(() => validateKnowledgeNotes([{ ...note, updatedAt: '2026-02-30T10:00:00Z' }])).toThrow('invalid updatedAt timestamp');
    expect(() => validateKnowledgeNotes([{ ...note, updatedAt: 'not-a-date' }])).toThrow('invalid updatedAt timestamp');
    expect(() => validateKnowledgeNotes([{ ...note, updatedAt: '2026-10-29T10:00:00Z' }])).toThrow('updatedAt earlier than createdAt');

    const session = {
      contestId: 1900,
      profileHandle: 'BackupTester',
      name: 'Codeforces Round',
      durationSeconds: 7200,
      startedAt: '2026-10-30T10:00:00.000Z',
      finishedAt: null,
      problems: { A: { firstStartedAt: '2026-10-30T10:10:00.000Z', solvedAt: '2026-10-30T10:20:00.000Z' } },
    };
    expect(isVirtualContestSession({ ...session, startedAt: '' }, 'BackupTester')).toBe(false);
    expect(isVirtualContestSession({ ...session, startedAt: '2026-13-30T10:00:00Z' }, 'BackupTester')).toBe(false);
    expect(isVirtualContestSession({
      ...session,
      finishedAt: '2026-10-30T09:00:00.000Z',
    }, 'BackupTester')).toBe(false);
    expect(isVirtualContestSession({
      ...session,
      problems: { A: { firstStartedAt: '2026-10-30T10:10:00.000Z', solvedAt: '2026-10-30T10:05:00.000Z' } },
    }, 'BackupTester')).toBe(false);
  });

  it('rejects malformed backup timestamps before touching data', () => {
    const backup = {
      format: BROWSER_BACKUP_FORMAT,
      version: 1,
      exportedAt: '2026-02-30T10:00:00Z',
      profiles: [{ handle: 'BackupTester', context: context('note') }],
    };
    expect(() => validateBrowserBackup(backup)).toThrow('timestamp');
  });

  it('restores every previous local-storage value and verifies rollback after an import write fails', () => {
    const values = new Map([['first', 'old-first'], ['second', 'old-second']]);
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        if (key === 'second' && value === 'new-second') throw new Error('simulated import failure');
        values.set(key, value);
      },
      removeItem: (key: string) => { values.delete(key); },
    };

    expect(() => applyBrowserStorageChanges(storage, new Map([
      ['first', 'new-first'],
      ['second', 'new-second'],
    ]))).toThrow('all previous browser-storage values were restored and verified');
    expect(values.get('first')).toBe('old-first');
    expect(values.get('second')).toBe('old-second');
  });

  it('reports rollback failure instead of claiming the old values were restored', () => {
    const values = new Map([['first', 'old-first'], ['second', 'old-second']]);
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        if (key === 'second') throw new Error('simulated storage failure');
        values.set(key, value);
      },
      removeItem: (key: string) => { values.delete(key); },
    };

    try {
      applyBrowserStorageChanges(storage, new Map([
        ['first', 'new-first'],
        ['second', 'new-second'],
      ]));
      throw new Error('Expected storage transaction to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(BrowserStorageTransactionError);
      expect((error as BrowserStorageTransactionError).rollbackFailures).toEqual(['second']);
      expect((error as Error).message).toContain('rollback could not be verified');
    }
    expect(values.get('first')).toBe('old-first');
  });
});
