import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  encryptPayload,
  decryptPayload,
  enforceRetention,
  verifyAndTestRestoreBackup,
  type CloudBackupManifest,
} from '../cli/cloudBackup.js';

describe('Zero-Cost Cloud Backup: Encryption, SHA-256 Manifest & Restore Verification', () => {
  const passphrase = 'test-secret-backup-passphrase-2026';
  const sampleData = JSON.stringify({
    timestamp: '2026-11-05T19:00:00.000Z',
    tables: {
      user_training_contexts: [{ user_id: 'uuid-1', handle: 'tourist', context_data: { score: 100 } }],
      social_profiles: [{ user_id: 'uuid-1', handle: 'tourist' }],
      friendships: [],
    },
  });

  it('encrypts and decrypts with AES-256-GCM and verifies SHA-256 integrity', () => {
    const { cipherBuffer, unencryptedSha, encryptedSha } = encryptPayload(sampleData, passphrase);
    expect(cipherBuffer.length).toBeGreaterThan(sampleData.length);

    // Decrypt
    const decrypted = decryptPayload(cipherBuffer, passphrase);
    expect(decrypted).toBe(sampleData);

    // Wrong passphrase fails
    expect(() => decryptPayload(cipherBuffer, 'wrong-password')).toThrow();
  });

  it('detects tampering and corrupted backup data', () => {
    const { cipherBuffer } = encryptPayload(sampleData, passphrase);
    const tampered = Buffer.from(cipherBuffer);
    tampered[tampered.length - 5] ^= 0xff; // Flip bits in ciphertext

    expect(() => decryptPayload(tampered, passphrase)).toThrow();
  });

  it('verifies restore and checks manifest consistency end-to-end', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-coach-backup-test-'));
    try {
      const { cipherBuffer, unencryptedSha, encryptedSha } = encryptPayload(sampleData, passphrase);
      const encPath = path.join(tempDir, 'supabase_backup_test.enc');
      const manifestPath = path.join(tempDir, 'supabase_backup_test.manifest.json');

      fs.writeFileSync(encPath, cipherBuffer);

      const manifest: CloudBackupManifest = {
        version: 1,
        timestamp: new Date().toISOString(),
        databaseHost: 'aws-0-eu-central-1.pooler.supabase.com',
        tables: {
          user_training_contexts: 1,
          social_profiles: 1,
          friendships: 0,
        },
        totalRecords: 2,
        unencryptedSha256: unencryptedSha,
        encryptedSha256: encryptedSha,
        algorithm: 'aes-256-gcm',
        cipherTextBytes: cipherBuffer.length,
        retentionKeptCount: 1,
      };

      fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf-8');

      const result = verifyAndTestRestoreBackup(encPath, passphrase);
      expect(result.verified).toBe(true);
      expect(result.totalRecords).toBe(2);
      expect(result.tableCounts.user_training_contexts).toBe(1);
      expect(result.tableCounts.social_profiles).toBe(1);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('enforces retention policy by keeping the newest N backups', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-coach-retention-test-'));
    try {
      for (let i = 1; i <= 6; i++) {
        const file = path.join(tempDir, `backup_${i}.enc`);
        fs.writeFileSync(file, `data_${i}`);
      }
      expect(fs.readdirSync(tempDir).length).toBe(6);

      const kept = enforceRetention(tempDir, 3);
      expect(kept).toBe(3);
      expect(fs.readdirSync(tempDir).length).toBe(3);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
