import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CodeforcesApiError,
  createCodeforcesRequestQueue,
  createCodeforcesSignature,
  isCodeforcesCredentialRejection,
  requestCodeforcesApi,
} from '../codeforcesApi.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Codeforces API client', () => {
  it('creates a deterministic signature using sorted parameters', () => {
    const parameters = { time: '1700000000', apiKey: 'public-key', handles: 'tourist;Petr' };
    const signature = createCodeforcesSignature('user.info', parameters, 'private-secret', 'a1b2c3');
    const input = 'a1b2c3/user.info?apiKey=public-key&handles=tourist;Petr&time=1700000000#private-secret';
    const expected = `a1b2c3${createHash('sha512').update(input).digest('hex')}`;

    expect(signature).toBe(expected);
    expect(() => createCodeforcesSignature('user.info', parameters, 'secret', 'invalid')).toThrow();
  });

  it('signs authenticated requests without transmitting the API secret', async () => {
    const fetchMock = vi.fn(async () => Response.json({ status: 'OK', result: ['Petr'] }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(requestCodeforcesApi<string[]>(
      'user.friends',
      { onlyOnline: true },
      { key: 'public-key', secret: 'private-secret' },
    )).resolves.toEqual(['Petr']);

    const requestUrl = new URL(fetchMock.mock.calls[0][0] as string);
    expect(requestUrl.searchParams.get('apiKey')).toBe('public-key');
    expect(requestUrl.searchParams.get('onlyOnline')).toBe('true');
    expect(requestUrl.searchParams.get('apiSig')).toMatch(/^[a-f0-9]{6}[a-f0-9]{128}$/);
    expect(requestUrl.href).not.toContain('private-secret');
  });

  it('surfaces Codeforces API failures as typed errors', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({
      status: 'FAILED',
      comment: 'Invalid API key',
    })));

    await expect(requestCodeforcesApi('user.friends', { onlyOnline: true }, undefined))
      .rejects.toBeInstanceOf(CodeforcesApiError);
  });

  it('deduplicates concurrent identical requests', async () => {
    let finishRequest: ((response: Response) => void) | null = null;
    const fetchMock = vi.fn(() => new Promise<Response>((resolve) => {
      finishRequest = resolve;
    }));
    vi.stubGlobal('fetch', fetchMock);

    const first = requestCodeforcesApi<string[]>('user.friends', { onlyOnline: true });
    const second = requestCodeforcesApi<string[]>('user.friends', { onlyOnline: true });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    finishRequest?.(Response.json({ status: 'OK', result: ['Petr'] }));

    await expect(Promise.all([first, second])).resolves.toEqual([['Petr'], ['Petr']]);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('distinguishes rejected credentials from transient API failures', () => {
    expect(isCodeforcesCredentialRejection(
      new CodeforcesApiError('Call failed: invalid apiKey or apiSig'),
    )).toBe(true);
    expect(isCodeforcesCredentialRejection(
      new CodeforcesApiError('Could not reach the Codeforces API', undefined, 'transport'),
    )).toBe(false);
    expect(isCodeforcesCredentialRejection(
      new CodeforcesApiError('Codeforces API returned HTTP 429', 429, 'http'),
    )).toBe(false);
  });

  it('prioritizes interactive requests while preserving request spacing', async () => {
    const nextSlot = createCodeforcesRequestQueue(25);
    const started: string[] = [];
    const startedAt: number[] = [];
    const first = nextSlot('background').then(() => {
      started.push('first');
      startedAt.push(Date.now());
    });
    await first;

    const background = nextSlot('background').then(() => {
      started.push('background');
      startedAt.push(Date.now());
    });
    const interactive = nextSlot('interactive').then(() => {
      started.push('interactive');
      startedAt.push(Date.now());
    });
    await Promise.all([background, interactive]);

    expect(started).toEqual(['first', 'interactive', 'background']);
    expect(startedAt[1] - startedAt[0]).toBeGreaterThanOrEqual(20);
    expect(startedAt[2] - startedAt[1]).toBeGreaterThanOrEqual(20);
  });
});
