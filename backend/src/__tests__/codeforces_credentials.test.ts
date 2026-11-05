import { afterEach, describe, expect, it } from 'vitest';
import {
  decryptCodeforcesCredentials,
  encryptCodeforcesCredentials,
} from '../codeforcesCredentials.js';

describe('Codeforces credential encryption', () => {
  const originalKey = process.env.CODEFORCES_CREDENTIAL_ENCRYPTION_KEY;

  afterEach(() => {
    if (originalKey === undefined) delete process.env.CODEFORCES_CREDENTIAL_ENCRYPTION_KEY;
    else process.env.CODEFORCES_CREDENTIAL_ENCRYPTION_KEY = originalKey;
  });

  it('encrypts credentials and binds decryption to the owning user', () => {
    process.env.CODEFORCES_CREDENTIAL_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
    const credentials = { key: 'test-api-key', secret: 'test-api-secret' };
    const envelope = encryptCodeforcesCredentials('user-a', credentials);

    expect(envelope.ciphertext.toString('utf8')).not.toContain(credentials.secret);
    expect(decryptCodeforcesCredentials('user-a', envelope)).toEqual(credentials);
    expect(() => decryptCodeforcesCredentials('user-b', envelope)).toThrow();
  });

  it('rejects missing and malformed encryption keys', () => {
    delete process.env.CODEFORCES_CREDENTIAL_ENCRYPTION_KEY;
    expect(() => encryptCodeforcesCredentials('user-a', { key: 'key', secret: 'secret' })).toThrow(/not configured/);

    process.env.CODEFORCES_CREDENTIAL_ENCRYPTION_KEY = Buffer.alloc(16, 1).toString('base64');
    expect(() => encryptCodeforcesCredentials('user-a', { key: 'key', secret: 'secret' })).toThrow(/exactly 32 bytes/);
  });
});
