import { createHash, randomBytes } from 'node:crypto';

const API_ORIGIN = 'https://codeforces.com';
const API_BASE = `${API_ORIGIN}/api`;
const MIN_REQUEST_INTERVAL_MS = process.env.VITEST ? 0 : 2_000;
const REQUEST_TIMEOUT_MS = Number.parseInt(process.env.CODEFORCES_REQUEST_TIMEOUT_MS || '10000', 10);
const USER_AGENT = 'CP-Coach/1.0 (Codeforces API client)';
const inFlightRequests = new Map<string, Promise<unknown>>();
export type RequestPriority = 'interactive' | 'normal' | 'background';
const PRIORITY_WEIGHT: Record<RequestPriority, number> = {
  interactive: 0,
  normal: 1,
  background: 2,
};
interface QueuedRequest {
  priority: RequestPriority;
  sequence: number;
  resolve: () => void;
}

export interface CodeforcesApiCredentials {
  key: string;
  secret: string;
}

export class CodeforcesApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly kind: 'api' | 'http' | 'transport' = 'api',
  ) {
    super(message);
    this.name = 'CodeforcesApiError';
  }
}

export function isCodeforcesCredentialRejection(error: unknown): boolean {
  if (!(error instanceof CodeforcesApiError)) return false;
  if (error.status === 401 || error.status === 403) return true;
  if (error.kind !== 'api') return false;
  return /(?:invalid|unknown|missing).{0,40}(?:api.?key|api.?sig|signature)|(?:api.?key|api.?sig|signature).{0,40}(?:invalid|unknown|missing)/i
    .test(error.message);
}

export function createCodeforcesRequestQueue(minIntervalMs: number): (priority?: RequestPriority) => Promise<void> {
  let lastRequestStartedAt = 0;
  let queuedRequests: QueuedRequest[] = [];
  let requestSequence = 0;
  let dispatching = false;
  let pendingWait: { priority: RequestPriority; resume: () => void } | null = null;

  async function drainRequestQueue(): Promise<void> {
    if (dispatching) return;
    dispatching = true;
    try {
      while (queuedRequests.length > 0) {
        queuedRequests.sort((a, b) => PRIORITY_WEIGHT[a.priority] - PRIORITY_WEIGHT[b.priority] || a.sequence - b.sequence);
        const request = queuedRequests[0];
        const waitMs = Math.max(0, lastRequestStartedAt + minIntervalMs - Date.now());
        if (waitMs > 0) {
          await new Promise<void>((resolve) => {
            const pending = {
              priority: request.priority,
              resume: () => {
                clearTimeout(timer);
                if (pendingWait === pending) pendingWait = null;
                resolve();
              },
            };
            const timer = setTimeout(() => {
              if (pendingWait === pending) pendingWait = null;
              resolve();
            }, waitMs);
            pendingWait = pending;
          });
          continue;
        }
        queuedRequests.shift();
        lastRequestStartedAt = Date.now();
        request.resolve();
      }
    } finally {
      dispatching = false;
      if (queuedRequests.length > 0) void drainRequestQueue();
    }
  }

  return (priority = 'interactive') => new Promise<void>((resolve) => {
    queuedRequests.push({ priority, sequence: requestSequence++, resolve });
    if (pendingWait && PRIORITY_WEIGHT[priority] < PRIORITY_WEIGHT[pendingWait.priority]) {
      pendingWait.resume();
    }
    void drainRequestQueue();
  });
}

const requestSlot = createCodeforcesRequestQueue(MIN_REQUEST_INTERVAL_MS);

function encodeQuery(parameters: Record<string, string>): URLSearchParams {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(parameters)) query.set(key, value);
  return query;
}

function deduplicateRequest<T>(key: string, start: () => Promise<T>): Promise<T> {
  const existing = inFlightRequests.get(key);
  if (existing) return existing as Promise<T>;
  const request = start();
  inFlightRequests.set(key, request);
  const clear = () => {
    if (inFlightRequests.get(key) === request) inFlightRequests.delete(key);
  };
  void request.then(clear, clear);
  return request;
}

export function createCodeforcesSignature(
  method: string,
  parameters: Record<string, string>,
  secret: string,
  rand = randomBytes(3).toString('hex'),
): string {
  if (!/^[a-fA-F0-9]{6}$/.test(rand)) throw new Error('Codeforces signature prefix must be six hexadecimal characters');
  const serialized = Object.entries(parameters)
    .sort(([keyA], [keyB]) => keyA < keyB ? -1 : keyA > keyB ? 1 : 0)
    .map(([key, value]) => `${key}=${value}`)
    .join('&');
  const signatureInput = `${rand}/${method}?${serialized}#${secret}`;
  return `${rand}${createHash('sha512').update(signatureInput).digest('hex')}`;
}

async function fetchResult<T>(
  method: string,
  parameters: Record<string, string>,
  retries: number,
  priority: RequestPriority,
): Promise<T> {
  await requestSlot(priority);
  const url = `${API_BASE}/${method}?${encodeQuery(parameters).toString()}`;
  try {
    const response = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) {
      if (response.status === 429 && retries > 0) {
        await new Promise((resolve) => setTimeout(resolve, 3_000));
        return fetchResult<T>(method, parameters, retries - 1, priority);
      }
      throw new CodeforcesApiError(`Codeforces API returned HTTP ${response.status}`, response.status, 'http');
    }

    const payload = await response.json() as { status?: string; comment?: string; result?: T };
    if (payload.status !== 'OK') {
      if (payload.comment?.toLowerCase().includes('call limit exceeded') && retries > 0) {
        await new Promise((resolve) => setTimeout(resolve, 3_000));
        return fetchResult<T>(method, parameters, retries - 1, priority);
      }
      throw new CodeforcesApiError(payload.comment || 'Codeforces API request was unsuccessful');
    }
    return payload.result as T;
  } catch (error) {
    if (error instanceof CodeforcesApiError) throw error;
    const reason = error instanceof Error ? error.name : '';
    if (retries > 0 && ['TypeError', 'AbortError', 'TimeoutError'].includes(reason)) {
      await new Promise((resolve) => setTimeout(resolve, 2_000));
      return fetchResult<T>(method, parameters, retries - 1, priority);
    }
    throw new CodeforcesApiError('Could not reach the Codeforces API', undefined, 'transport');
  }
}

export function requestCodeforcesApi<T>(
  method: string,
  parameters: Record<string, string | number | boolean> = {},
  credentials?: CodeforcesApiCredentials,
  priority: RequestPriority = 'interactive',
): Promise<T> {
  const normalized: Record<string, string> = Object.fromEntries(
    Object.entries(parameters)
      .map(([key, value]) => [key, String(value)] as const)
      .sort(([keyA], [keyB]) => keyA < keyB ? -1 : keyA > keyB ? 1 : 0),
  );
  const key = createHash('sha256').update(JSON.stringify([
    method,
    normalized,
    credentials ? [credentials.key, credentials.secret] : null,
    priority,
  ])).digest('hex');
  return deduplicateRequest(key, () => {
    if (credentials) {
      const signedParameters: Record<string, string> = {
        ...normalized,
        apiKey: credentials.key,
        time: String(Math.floor(Date.now() / 1_000)),
      };
      const rand = randomBytes(3).toString('hex');
      signedParameters.apiSig = createCodeforcesSignature(method, signedParameters, credentials.secret, rand);
      return fetchResult<T>(method, signedParameters, 2, priority);
    }
    return fetchResult<T>(method, normalized, 2, priority);
  });
}

export async function requestCodeforcesUrl<T>(
  url: string,
  timeoutMs = REQUEST_TIMEOUT_MS,
  priority: RequestPriority = 'normal',
): Promise<T | null> {
  if (process.env.VITEST) return null;
  const parsed = new URL(url);
  if (parsed.origin !== API_ORIGIN) throw new Error('Only official Codeforces API URLs are accepted');
  const method = parsed.pathname.slice('/api/'.length);
  if (!method || method.includes('/')) throw new Error('Invalid Codeforces API method');
  const key = createHash('sha256').update(JSON.stringify([
    parsed.toString(),
    timeoutMs,
    priority,
  ])).digest('hex');
  return deduplicateRequest(key, async () => {
    await requestSlot(priority);
    try {
      const response = await fetch(parsed, {
        headers: { 'User-Agent': USER_AGENT },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) return null;
      const payload = await response.json() as { status?: string; result?: T };
      return payload.status === 'OK' ? payload.result ?? null : null;
    } catch {
      return null;
    }
  });
}
