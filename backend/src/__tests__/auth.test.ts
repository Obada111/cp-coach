import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { requireApiToken, requireConfiguredToken } from '../auth.js';

describe('API authentication boundary', () => {
  const originalToken = process.env.COACH_API_TOKEN;

  beforeEach(() => {
    process.env.COACH_API_TOKEN = 'test-token';
  });

  afterEach(() => {
    if (originalToken === undefined) delete process.env.COACH_API_TOKEN;
    else process.env.COACH_API_TOKEN = originalToken;
  });

  it('rejects missing and invalid bearer tokens', () => {
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn() };
    const next = vi.fn();

    requireApiToken({ header: () => undefined }, res, next);
    requireApiToken({ header: () => 'Bearer wrong' }, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('accepts the configured bearer token', () => {
    const req = { header: (name: string) => name === 'authorization' ? 'Bearer test-token' : undefined };
    const next = vi.fn();

    requireApiToken(req, { status: vi.fn(), json: vi.fn() }, next);

    expect(next).toHaveBeenCalledOnce();
  });

  it('closes admin routes when no admin token is configured', () => {
    const originalAdminToken = process.env.COACH_ADMIN_TOKEN;
    delete process.env.COACH_API_TOKEN;
    delete process.env.COACH_ADMIN_TOKEN;

    const res = { status: vi.fn().mockReturnThis(), json: vi.fn() };
    const next = vi.fn();
    requireConfiguredToken({ header: () => undefined }, res, next);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(next).not.toHaveBeenCalled();

    if (originalAdminToken === undefined) delete process.env.COACH_ADMIN_TOKEN;
    else process.env.COACH_ADMIN_TOKEN = originalAdminToken;
  });
});
