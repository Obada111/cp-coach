import { describe, expect, it } from 'vitest';
import { verifySupabaseAccessToken } from '../authMiddleware.js';

const USER_ID = '44444444-4444-4444-8444-444444444444';

function token(claims: Record<string, unknown>): string {
  const encode = (value: Record<string, unknown>) =>
    Buffer.from(JSON.stringify(value)).toString('base64url');
  return [
    encode({ alg: 'none', typ: 'JWT' }),
    encode({
      sub: USER_ID,
      role: 'authenticated',
      aud: 'authenticated',
      exp: Math.floor(Date.now() / 1000) + 3600,
      ...claims,
    }),
    'test-signature',
  ].join('.');
}

async function verify(claims: Record<string, unknown>) {
  return verifySupabaseAccessToken(token(claims), { allowTestFallback: true });
}

describe('Supabase token verification', () => {
  it('accepts a well-formed test token only through the explicit test fallback', async () => {
    const result = await verify({});
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.user.userId).toBe(USER_ID);
  });

  it('rejects missing, expired, malformed, anonymous, wrong-role, wrong-audience, and wrong-subject claims', async () => {
    for (const claims of [
      { exp: undefined },
      { exp: Math.floor(Date.now() / 1000) - 5 },
      { nbf: Math.floor(Date.now() / 1000) + 3_600 },
      { sub: 'not-a-uuid' },
      { role: 'anon' },
      { aud: 'service_role' },
      { aud: [] },
      { exp: 'tomorrow' },
    ]) {
      const result = await verify(claims as Record<string, unknown>);
      expect(result.ok, JSON.stringify(claims)).toBe(false);
      if (!result.ok) expect(result.status).toBe(401);
    }

    expect((await verifySupabaseAccessToken('not-a-jwt', { allowTestFallback: true })).ok).toBe(false);
  });

  it('does not allow the test fallback when Supabase configuration is required', async () => {
    const originalUrl = process.env.SUPABASE_URL;
    const originalKey = process.env.SUPABASE_ANON_KEY;
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_ANON_KEY;
    try {
      const result = await verifySupabaseAccessToken(token({}), {
        requireSupabaseConfig: true,
        allowTestFallback: true,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.status).toBe(503);
    } finally {
      if (originalUrl === undefined) delete process.env.SUPABASE_URL;
      else process.env.SUPABASE_URL = originalUrl;
      if (originalKey === undefined) delete process.env.SUPABASE_ANON_KEY;
      else process.env.SUPABASE_ANON_KEY = originalKey;
    }
  });
});