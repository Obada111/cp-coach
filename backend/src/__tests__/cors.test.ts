import express from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { createCorsMiddleware } from '../cors.js';

describe('CORS response headers', () => {
  let server: Server | undefined;

  afterEach(async () => {
    if (!server) return;
    await new Promise<void>((resolve, reject) => {
      server!.close((error) => (error ? reject(error) : resolve()));
    });
    server = undefined;
  });

  it('exposes Server-Timing only through the configured allowed origins', async () => {
    const previousOrigins = process.env.CORS_ORIGINS;
    const previousPreviewSetting = process.env.ALLOW_VERCEL_PREVIEWS;
    process.env.CORS_ORIGINS = 'https://cp-coach-six.vercel.app';
    process.env.ALLOW_VERCEL_PREVIEWS = 'true';

    try {
      const app = express();
      app.use(createCorsMiddleware());
      app.get('/dashboard', (_req, res) => {
        res.setHeader('Server-Timing', 'dashboard;dur=12.3');
        res.json({ ok: true });
      });
      await new Promise<void>((resolve) => {
        server = app.listen(0, '127.0.0.1', () => resolve());
      });
      const address = server.address() as AddressInfo;
      const url = `http://127.0.0.1:${address.port}/dashboard`;

      const allowedResponse = await fetch(url, {
        headers: { Origin: 'https://cp-coach-six.vercel.app' },
      });
      expect(allowedResponse.headers.get('access-control-allow-origin')).toBe('https://cp-coach-six.vercel.app');
      expect(allowedResponse.headers.get('access-control-expose-headers')).toBe('Server-Timing');
      expect(allowedResponse.headers.get('server-timing')).toBe('dashboard;dur=12.3');

      const previewResponse = await fetch(url, {
        headers: { Origin: 'https://preview-123.vercel.app' },
      });
      expect(previewResponse.headers.get('access-control-allow-origin')).toBe('https://preview-123.vercel.app');
      expect(previewResponse.headers.get('access-control-expose-headers')).toBe('Server-Timing');

      const disallowedResponse = await fetch(url, {
        headers: { Origin: 'https://not-allowed.example' },
      });
      expect(disallowedResponse.headers.get('access-control-allow-origin')).toBeNull();
    } finally {
      if (previousOrigins === undefined) delete process.env.CORS_ORIGINS;
      else process.env.CORS_ORIGINS = previousOrigins;
      if (previousPreviewSetting === undefined) delete process.env.ALLOW_VERCEL_PREVIEWS;
      else process.env.ALLOW_VERCEL_PREVIEWS = previousPreviewSetting;
    }
  });
});
