import { beforeAll, describe, expect, it } from 'vitest';
import {
  claimLegacyProfile,
  createProfile,
  db,
  deletePublicProfile,
  getOrCreatePublicProfile,
  getProfileById,
  initDatabase,
  listProfileOwnershipMigrations,
  revertProfileOwnershipMigration,
} from '../db.js';

const USER_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const USER_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

beforeAll(() => {
  initDatabase();
});

describe('legacy profile ownership migration', () => {
  it('claims an unowned legacy profile, previews safely, and rolls back with an audit trail', () => {
    const profile = createProfile('LegacyClaimSubject');
    db.prepare(`
      INSERT INTO daily_sets (id, profile_id, date, generated_at)
      VALUES (?, ?, '2026-04-01', '2026-04-01T00:00:00.000Z')
    `).run(`${profile.id}_2026-04-01`, profile.id);

    const preview = claimLegacyProfile(USER_A, profile.id, { dryRun: true });
    expect(preview.dryRun).toBe(true);
    expect(preview.profile.ownerId).toBeNull();
    expect(preview.migratedCounts.daily_sets).toBe(1);

    const claimed = claimLegacyProfile(USER_A, profile.id, { performedBy: 'test' });
    expect(claimed.alreadyOwned).toBe(false);
    expect(claimed.migrationId).toMatch(/^pom_/);
    expect(getProfileById(profile.id)?.ownerId).toBe(USER_A);
    expect(claimed.migratedCounts.daily_sets).toBe(1);

    const audits = listProfileOwnershipMigrations(profile.id);
    expect(audits).toHaveLength(1);
    expect(audits[0].previousOwnerId).toBeNull();
    expect(audits[0].newOwnerId).toBe(USER_A);
    expect(audits[0].rolledBackAt).toBeNull();

    const rollback = revertProfileOwnershipMigration(claimed.migrationId!, 'test');
    expect(rollback.previousOwnerId).toBeNull();
    expect(getProfileById(profile.id)?.ownerId).toBeNull();
    expect(listProfileOwnershipMigrations(profile.id)[0].rolledBackAt).not.toBeNull();
  });

  it('refuses silent reassignment of client-id owned data', () => {
    const legacyClient = 'legacyclient1234567890';
    const profile = getOrCreatePublicProfile(legacyClient, 'OwnedLegacySubject');

    expect(() => claimLegacyProfile(USER_A, profile.id))
      .toThrow(/cannot be reassigned without explicit migration approval/i);
    expect(getProfileById(profile.id)?.ownerId).toBe(legacyClient);

    const claim = claimLegacyProfile(USER_A, profile.id, {
      legacyOwnerId: legacyClient,
      allowReassign: true,
      performedBy: 'test',
    });
    expect(claim.success).toBe(true);
    expect(getProfileById(profile.id)?.ownerId).toBe(USER_A);

    const rollback = revertProfileOwnershipMigration(claim.migrationId!, 'test');
    expect(rollback.profile.ownerId).toBe(legacyClient);

    expect(() => claimLegacyProfile(USER_B, profile.id, {
      legacyOwnerId: 'wrong-legacy-owner',
      allowReassign: true,
    })).toThrow(/does not match/i);
  });

  it('rejects a takeover when another account already has non-empty data for the handle', () => {
    const legacy = createProfile('ConflictHandleSubject');
    const existing = getOrCreatePublicProfile(USER_B, 'ConflictHandleSubject');
    db.prepare(`
      INSERT INTO daily_sets (id, profile_id, date, generated_at)
      VALUES (?, ?, '2026-04-02', '2026-04-02T00:00:00.000Z')
    `).run(`${existing.id}_2026-04-02`, existing.id);

    expect(() => claimLegacyProfile(USER_B, legacy.id))
      .toThrow(/already has non-empty profile data/i);
    expect(getProfileById(legacy.id)?.ownerId).toBeNull();
  });

  it('deletes profiles only for the verified, case-tolerant owner', () => {
    const profile = getOrCreatePublicProfile(USER_A, 'DeleteSubject');
    expect(deletePublicProfile(USER_B, profile.id)).toBe(false);
    expect(deletePublicProfile(USER_A.toUpperCase(), profile.id)).toBe(true);
    expect(getProfileById(profile.id)).toBeNull();
  });
});
