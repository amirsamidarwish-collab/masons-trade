import { Hono } from 'hono';
import type { Env } from './types';
import { subscribe } from './routes/subscribe';
import { unsubscribe } from './routes/unsubscribe';
import { bounce } from './routes/bounce';
import { telegram } from './routes/telegram';
import { runApprovalSweep, runStuckBroadcastSweep } from './cron';

const app = new Hono<{ Bindings: Env }>();

app.get('/health', (c) => c.json({ ok: true }));
app.route('/', subscribe);
app.route('/', unsubscribe);
app.route('/', bounce);
app.route('/', telegram);

export default {
  fetch: app.fetch,
  async scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(
      runApprovalSweep(env, event.scheduledTime).catch((err) => {
        console.error('runApprovalSweep failed', err instanceof Error ? err.message : err);
      }),
    );
    ctx.waitUntil(
      runStuckBroadcastSweep(env, event.scheduledTime).catch((err) => {
        console.error('runStuckBroadcastSweep failed', err instanceof Error ? err.message : err);
      }),
    );
  },
} satisfies ExportedHandler<Env>;
