import { Hono } from 'hono';
import type { Env } from './types';
import { subscribe } from './routes/subscribe';
import { unsubscribe } from './routes/unsubscribe';
import { bounce } from './routes/bounce';
import { runApprovalSweep } from './cron';

const app = new Hono<{ Bindings: Env }>();

app.get('/health', (c) => c.json({ ok: true }));
app.route('/', subscribe);
app.route('/', unsubscribe);
app.route('/', bounce);

export default {
  fetch: app.fetch,
  async scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(runApprovalSweep(env, event.scheduledTime));
  },
} satisfies ExportedHandler<Env>;
