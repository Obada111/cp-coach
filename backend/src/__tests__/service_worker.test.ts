import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';

const serviceWorkerPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../frontend/public/sw.js'
);
const serviceWorkerSource = fs.readFileSync(serviceWorkerPath, 'utf8');

function loadServiceWorker() {
  const listeners = new Map<string, (event: any) => void>();
  const showNotification = vi.fn().mockResolvedValue(undefined);
  const openWindow = vi.fn().mockResolvedValue(undefined);
  const focus = vi.fn().mockResolvedValue(undefined);
  const navigate = vi.fn().mockResolvedValue(undefined);
  const self = {
    addEventListener: (name: string, handler: (event: any) => void) => listeners.set(name, handler),
    skipWaiting: vi.fn().mockResolvedValue(undefined),
    registration: { showNotification },
    location: { origin: 'https://cp-coach.example' },
    clients: {
      matchAll: vi.fn().mockResolvedValue([]),
      openWindow,
    },
  };
  vm.runInNewContext(serviceWorkerSource, { self, URL, console, Promise });
  return { listeners, self, showNotification, openWindow, focus, navigate };
}

describe('service worker push interactions', () => {
  it('displays the backend push payload through showNotification', async () => {
    const worker = loadServiceWorker();
    let task: Promise<void> | undefined;
    worker.listeners.get('push')?.({
      data: { json: () => ({
        title: 'Your Daily CP Practice',
        body: 'Two problems remain.',
        tag: 'daily-2026-01-15',
        data: { url: '/#daily-recommendations' },
      }) },
      waitUntil: (promise: Promise<void>) => { task = promise; },
    });

    await task;
    expect(worker.showNotification).toHaveBeenCalledWith(
      'Your Daily CP Practice',
      expect.objectContaining({
        body: 'Two problems remain.',
        tag: 'daily-2026-01-15',
        renotify: false,
        data: { url: '/#daily-recommendations' },
      })
    );
  });

  it('opens the Daily Recommendations destination on notification click', async () => {
    const worker = loadServiceWorker();
    let task: Promise<void> | undefined;
    worker.listeners.get('notificationclick')?.({
      notification: { data: { url: '/#daily-recommendations' }, close: vi.fn() },
      waitUntil: (promise: Promise<void>) => { task = promise; },
    });

    await task;
    expect(worker.openWindow).toHaveBeenCalledWith('https://cp-coach.example/#daily-recommendations');
  });

  it('opens the official Codeforces contest URL from contest notifications', async () => {
    const worker = loadServiceWorker();
    let task: Promise<void> | undefined;
    worker.listeners.get('notificationclick')?.({
      notification: { data: { url: 'https://codeforces.com/contest/70001' }, close: vi.fn() },
      waitUntil: (promise: Promise<void>) => { task = promise; },
    });

    await task;
    expect(worker.openWindow).toHaveBeenCalledWith('https://codeforces.com/contest/70001');
  });

  it('rejects untrusted external notification destinations', async () => {
    const worker = loadServiceWorker();
    let task: Promise<void> | undefined;
    worker.listeners.get('notificationclick')?.({
      notification: { data: { url: 'https://attacker.example/' }, close: vi.fn() },
      waitUntil: (promise: Promise<void>) => { task = promise; },
    });

    await task;
    expect(worker.openWindow).toHaveBeenCalledWith('https://cp-coach.example/');
  });
});
