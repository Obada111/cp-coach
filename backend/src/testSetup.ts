import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';

// Never let automated tests open the user's configured database. The test
// suite intentionally clears tables between cases, so it must always use an
// isolated per-process SQLite directory.
const testDbDir = path.join(os.tmpdir(), `cp-coach-vitest-${process.pid}`);
fs.mkdirSync(testDbDir, { recursive: true });
process.env.DB_DIR = testDbDir;

for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy']) {
  delete process.env[key];
}
process.env.NO_PROXY = 'localhost,127.0.0.1,[::1],::1,*';
process.env.no_proxy = process.env.NO_PROXY;

function isLocalLoopback(url: URL): boolean {
  const hostname = url.hostname.toLowerCase();
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' || hostname === '[::1]';
}

async function fetchLocalHttp(url: URL, init?: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const signal = init?.signal;
  const abortListener = () => controller.abort();
  if (signal) {
    if (signal.aborted) {
      throw new DOMException('The operation was aborted', 'AbortError');
    }
    signal.addEventListener('abort', abortListener, { once: true });
  }

  const body = init?.body === undefined ? undefined : (() => {
    if (typeof init.body === 'string') return init.body;
    if (init.body instanceof Uint8Array) return Buffer.from(init.body);
    if (ArrayBuffer.isView(init.body)) return Buffer.from(init.body.buffer, init.body.byteOffset, init.body.byteLength);
    if (init.body instanceof ArrayBuffer) return Buffer.from(init.body);
    if (init.body instanceof URLSearchParams) return init.body.toString();
    return String(init.body);
  })();

  const client = url.protocol === 'https:' ? https : http;

  return await new Promise<Response>((resolve, reject) => {
    const request = client.request(
      {
        hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: `${url.pathname}${url.search}`,
        method: (init?.method || 'GET').toUpperCase(),
        headers: Object.fromEntries(new Headers(init?.headers || {}).entries()),
        agent: false,
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
        response.on('end', () => {
          const headers = new Headers();
          for (const [key, value] of Object.entries(response.headers)) {
            if (Array.isArray(value)) {
              for (const item of value) headers.append(key, item);
            } else if (value !== undefined) {
              headers.set(key, Array.isArray(value) ? value.join(', ') : value);
            }
          }
          const bodyText = Buffer.concat(chunks);
          resolve(new Response(bodyText, {
            status: response.statusCode ?? 200,
            statusText: response.statusMessage || '',
            headers,
          }));
        });
      }
    );

    request.on('error', (error) => {
      reject(error);
    });
    if (body !== undefined) request.write(body);
    request.end();
  }).finally(() => {
    if (signal) signal.removeEventListener('abort', abortListener);
  });
}

const originalFetch = globalThis.fetch.bind(globalThis);
globalThis.fetch = ((input: any, init?: RequestInit): Promise<Response> => {
  const url = typeof input === 'string' ? new URL(input) : input instanceof URL ? input : new URL(String(input));
  if ((url.protocol === 'http:' || url.protocol === 'https:') && isLocalLoopback(url)) {
    return fetchLocalHttp(url, init);
  }
  return originalFetch(input, init);
}) as typeof fetch;

process.once('exit', () => {
  try {
    fs.rmSync(testDbDir, { recursive: true, force: true });
  } catch {
    // The test process is already exiting; cleanup failure must not mask a
    // test result.
  }
});
