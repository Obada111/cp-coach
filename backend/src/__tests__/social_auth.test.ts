import type { Request, Response } from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { requireSupabaseUser } from '../socialAuth.js';

const userId = '00000000-0000-4000-8000-000000000001';

function makeRequest(
  claims: Record<string, unknown> | null,
  body?: Record<string, unknown>,
): Request {
  const token = claims
    ? `header.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.signature`
    : '';
  return {
    header: (name: string) => name === 'authorization' && token ? `Bearer ${token}` : undefined,
    body,
  } as unknown as Request;
}

function makeResponse() {
  const response = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn(),
  };
  return response as unknown as Response & typeof response;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Supabase social authentication', () => {
  const originalUrl = process.env.SUPABASE_URL;
  const originalAnonKey = process.env.SUPABASE_ANON_KEY;

  afterEach(() => {
    if (originalUrl === undefined) delete process.env.SUPABASE_URL;
    else process.env.SUPABASE_URL = originalUrl;
    if (originalAnonKey === undefined) delete process.env.SUPABASE_ANON_KEY;
    else process.env.SUPABASE_ANON_KEY = originalAnonKey;
  });

  it('derives the social identity from a verified Supabase session', async () => {
    process.env.SUPABASE_URL = 'https://auth.example.test';
    process.env.SUPABASE_ANON_KEY = 'test-anon-key';
    const claims = {
      sub: userId,
      role: 'authenticated',
      exp: Math.floor(Date.now() / 1_000) + 60,
    };
    const request = makeRequest(claims, { userId: '00000000-0000-4000-8000-000000000002' });
    const response = makeResponse();
    const next = vi.fn();
    const fetchMock = vi.fn(async () => Response.json({ id: userId }));
    vi.stubGlobal('fetch', fetchMock);

    await requireSupabaseUser(request, response, next);

    expect(next).toHaveBeenCalledOnce();
    expect((request as Request & { socialUser?: { userId: string } }).socialUser?.userId).toBe(userId);
    expect((request as Request & { socialUser?: { userId: string } }).socialUser?.userId)
      .not.toBe(request.body.userId);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(String(fetchMock.mock.calls[0][0])).toBe('https://auth.example.test/auth/v1/user');
  });

  it('rejects mismatched identity claims and revoked sessions', async () => {
    process.env.SUPABASE_URL = 'https://auth.example.test';
    process.env.SUPABASE_ANON_KEY = 'test-anon-key';
    const response = makeResponse();
    const next = vi.fn();
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ id: userId })));

    await requireSupabaseUser(makeRequest({
      sub: '00000000-0000-4000-8000-000000000002',
      role: 'authenticated',
      exp: Math.floor(Date.now() / 1_000) + 60,
    }), response, next);

    expect(response.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();

    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 401 })));
    const revokedResponse = makeResponse();
    await requireSupabaseUser(makeRequest({
      sub: userId,
      role: 'authenticated',
      exp: Math.floor(Date.now() / 1_000) + 60,
    }), revokedResponse, next);

    expect(revokedResponse.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });
});
