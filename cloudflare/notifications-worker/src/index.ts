import { handleApiRequest } from './api';
import { runScheduledWorker } from './scheduler';
import type { Env } from './types';

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      return await handleApiRequest(request, env);
    } catch (error) {
      console.error('[NotificationWorker] API request failed.');
      return new Response(JSON.stringify({ error: 'Notification service request failed' }), {
        status: 500,
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'no-store',
        },
      });
    }
  },

  async scheduled(
    _controller: ScheduledController,
    env: Env,
    _context: ExecutionContext,
  ): Promise<void> {
    await runScheduledWorker(env);
  },
};
