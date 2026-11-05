import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

export interface CodeforcesCredentialPair {
  key: string;
  secret: string;
}

export interface EncryptedCredentialEnvelope {
  ciphertext: Buffer;
  nonce: Buffer;
  authTag: Buffer;
}

function getMasterKey(): Buffer {
  const configured = process.env.CODEFORCES_CREDENTIAL_ENCRYPTION_KEY?.trim();
  if (!configured) throw new Error('Codeforces credential encryption is not configured.');
  const key = Buffer.from(configured, 'base64');
  if (
    key.length !== 32 ||
    key.toString('base64').replace(/=+$/, '') !== configured.replace(/=+$/, '')
  ) {
    throw new Error('Codeforces credential encryption key must be base64 for exactly 32 bytes.');
  }
  return key;
}

export function encryptCodeforcesCredentials(
  userId: string,
  credentials: CodeforcesCredentialPair,
): EncryptedCredentialEnvelope {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', getMasterKey(), nonce);
  cipher.setAAD(Buffer.from(userId, 'utf8'));
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(credentials), 'utf8'),
    cipher.final(),
  ]);
  return { ciphertext, nonce, authTag: cipher.getAuthTag() };
}

export function decryptCodeforcesCredentials(
  userId: string,
  envelope: EncryptedCredentialEnvelope,
): CodeforcesCredentialPair {
  const decipher = createDecipheriv('aes-256-gcm', getMasterKey(), envelope.nonce);
  decipher.setAAD(Buffer.from(userId, 'utf8'));
  decipher.setAuthTag(envelope.authTag);
  const plaintext = Buffer.concat([
    decipher.update(envelope.ciphertext),
    decipher.final(),
  ]).toString('utf8');
  const credentials = JSON.parse(plaintext) as Partial<CodeforcesCredentialPair>;
  if (
    typeof credentials.key !== 'string' ||
    typeof credentials.secret !== 'string' ||
    !credentials.key ||
    !credentials.secret
  ) {
    throw new Error('Stored Codeforces credential data is invalid.');
  }
  return { key: credentials.key, secret: credentials.secret };
}
