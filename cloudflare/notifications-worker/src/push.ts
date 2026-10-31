const textEncoder = new TextEncoder();

export class PushDeliveryError extends Error {
  constructor(readonly statusCode: number) {
    super(`Push service returned HTTP ${statusCode}`);
  }
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const length = parts.reduce((total, part) => total + part.length, 0);
  const result = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

function base64UrlDecode(value: string): Uint8Array {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '=');
  const binary = atob(base64);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function base64UrlEncode(value: Uint8Array): string {
  let binary = '';
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

async function hmacSha256(keyBytes: Uint8Array, value: Uint8Array): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    'raw',
    toArrayBuffer(keyBytes),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, toArrayBuffer(value)));
}

async function hkdfExpand(prk: Uint8Array, info: Uint8Array, length: number): Promise<Uint8Array> {
  const blocks: Uint8Array[] = [];
  let previous: Uint8Array = new Uint8Array();
  for (let counter = 1; blocks.reduce((total, block) => total + block.length, 0) < length; counter += 1) {
    previous = await hmacSha256(prk, concatBytes(previous, info, new Uint8Array([counter])));
    blocks.push(previous);
  }
  return concatBytes(...blocks).slice(0, length);
}

async function createVapidToken(
  audience: string,
  publicKey: Uint8Array,
  privateKey: Uint8Array,
  subject: string,
  now: Date,
): Promise<string> {
  if (publicKey.length !== 65 || privateKey.length !== 32) {
    throw new Error('Invalid VAPID key length');
  }
  const key = await crypto.subtle.importKey(
    'jwk',
    {
      kty: 'EC',
      crv: 'P-256',
      x: base64UrlEncode(publicKey.slice(1, 33)),
      y: base64UrlEncode(publicKey.slice(33)),
      d: base64UrlEncode(privateKey),
      ext: true,
      key_ops: ['sign'],
    },
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign'],
  );
  const header = base64UrlEncode(textEncoder.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = base64UrlEncode(textEncoder.encode(JSON.stringify({
    aud: audience,
    exp: Math.floor(now.getTime() / 1000) + 12 * 60 * 60,
    sub: subject,
  })));
  const signingInput = `${header}.${claims}`;
  const signature = new Uint8Array(await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    key,
    toArrayBuffer(textEncoder.encode(signingInput)),
  ));
  return `${signingInput}.${base64UrlEncode(signature)}`;
}

export async function encryptWebPushPayload(
  payload: string,
  p256dh: string,
  auth: string,
): Promise<Uint8Array> {
  const userPublicKey = base64UrlDecode(p256dh);
  const authSecret = base64UrlDecode(auth);
  if (userPublicKey.length !== 65 || authSecret.length < 16) {
    throw new Error('Invalid push subscription encryption keys');
  }
  const userKey = await crypto.subtle.importKey(
    'raw',
    toArrayBuffer(userPublicKey),
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    [],
  );
  const serverKeyPair = await crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' },
    true,
    ['deriveBits'],
  );
  const serverPublicKey = new Uint8Array(await crypto.subtle.exportKey('raw', serverKeyPair.publicKey));
  const sharedSecret = new Uint8Array(await crypto.subtle.deriveBits(
    { name: 'ECDH', public: userKey },
    serverKeyPair.privateKey,
    256,
  ));
  const authPrk = await hmacSha256(authSecret, sharedSecret);
  const keyInfo = concatBytes(textEncoder.encode('WebPush: info\0'), userPublicKey, serverPublicKey);
  const inputKeyMaterial = await hkdfExpand(authPrk, keyInfo, 32);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const prk = await hmacSha256(salt, inputKeyMaterial);
  const contentKey = await hkdfExpand(prk, textEncoder.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdfExpand(prk, textEncoder.encode('Content-Encoding: nonce\0'), 12);
  const aesKey = await crypto.subtle.importKey(
    'raw',
    toArrayBuffer(contentKey),
    { name: 'AES-GCM' },
    false,
    ['encrypt'],
  );
  const plaintext = concatBytes(textEncoder.encode(payload), new Uint8Array([2]));
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: toArrayBuffer(nonce), tagLength: 128 },
    aesKey,
    toArrayBuffer(plaintext),
  ));
  return concatBytes(
    salt,
    new Uint8Array([0, 0, 16, 0]),
    new Uint8Array([serverPublicKey.length]),
    serverPublicKey,
    ciphertext,
  );
}

function isSupportedPushEndpoint(endpoint: URL): boolean {
  const hostname = endpoint.hostname.toLowerCase();
  return endpoint.protocol === 'https:' &&
    !endpoint.username &&
    !endpoint.password &&
    !endpoint.port &&
    (
      hostname === 'fcm.googleapis.com' ||
      hostname === 'web.push.apple.com' ||
      hostname === 'push.services.mozilla.com' ||
      hostname.endsWith('.push.services.mozilla.com') ||
      hostname === 'notify.windows.com' ||
      hostname.endsWith('.notify.windows.com')
    );
}

export async function sendWebPush(
  endpointValue: string,
  p256dh: string,
  auth: string,
  payload: Record<string, unknown>,
  vapid: { publicKey: string; privateKey: string; subject: string },
  request: typeof fetch = (...args) => globalThis.fetch(...args),
  now = new Date(),
): Promise<void> {
  let endpoint: URL;
  try {
    endpoint = new URL(endpointValue);
  } catch {
    throw new Error('Invalid push endpoint');
  }
  if (!isSupportedPushEndpoint(endpoint)) throw new Error('Unsupported push endpoint');

  const publicKey = base64UrlDecode(vapid.publicKey);
  const privateKey = base64UrlDecode(vapid.privateKey);
  const jwt = await createVapidToken(endpoint.origin, publicKey, privateKey, vapid.subject, now);
  const encrypted = await encryptWebPushPayload(JSON.stringify(payload), p256dh, auth);
  const response = await request(endpoint.href, {
    method: 'POST',
    headers: {
      Authorization: `vapid t=${jwt}, k=${vapid.publicKey}`,
      'Content-Encoding': 'aes128gcm',
      'Content-Type': 'application/octet-stream',
      TTL: '3600',
    },
    body: toArrayBuffer(encrypted),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new PushDeliveryError(response.status);
}
