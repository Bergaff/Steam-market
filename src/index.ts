/**
 * Steam Market Analytics — Cloudflare Worker entry point.
 *
 *  - fetch:      REST API (/api/v1/*, /health) + static frontend (assets)
 *  - scheduled:  the one-minute cron tick that drives all scrapers
 *
 * The service NEVER asks users for Steam credentials — it only reads public
 * Steam Community Market data (TZ §9).
 */

import { Hono } from 'hono';
import type { Env } from './env';
import { loadConfig } from './config';
import api from './routes/api';
import { setup, cors, rateLimit, type AppContext } from './routes/middleware';
import { healthHandler } from './routes/health';
import { handleScheduled } from './scan/scheduler';

const app = new Hono<{ Bindings: Env; Variables: { cfg: ReturnType<typeof loadConfig> } }>();

// --- Healthcheck (mounted both at /health and /api/v1/health) --------------
const healthRoute = new Hono<{ Bindings: Env; Variables: { cfg: ReturnType<typeof loadConfig> } }>();
healthRoute.use('*', setup as never);
healthRoute.get('/', healthHandler as never);
app.route('/health', healthRoute);

// --- Public + admin API -----------------------------------------------------
app.route('/api/v1', api);

// --- Root info ---------------------------------------------------------------
app.get('/', async (c) => {
	// Requests for "/" are normally served by the static frontend (assets).
	// This JSON handler only runs when assets are not built yet (bare API mode).
	const cfg = loadConfig(c.env);
	return c.json({
		service: 'Steam Market Analytics',
		mode: cfg.demoMode ? 'demo' : 'live',
		api: '/api/v1',
		health: '/health',
		frontend: 'not built — run `npm run build` (see README)',
	});
});

// --- Errors & 404 -------------------------------------------------------------
app.onError((err, c) => {
	console.error(`[api] ${c.req.method} ${c.req.path}:`, err);
	return c.json({ error: 'internal_error', message: err instanceof Error ? err.message : String(err) }, 500);
});

app.notFound((c) => {
	// API paths: explicit JSON 404 (run_worker_first keeps this response).
	if (c.req.path.startsWith('/api/') || c.req.path.startsWith('/health')) {
		return c.json({ error: 'not_found', path: c.req.path }, 404);
	}
	// Other paths: 404 → the assets layer serves index.html (SPA fallback).
	return c.body(null, 404);
});

export default {
	fetch: app.fetch,

	/**
	 * Cron tick — runs every minute (wrangler.jsonc "triggers").
	 * All heavy lifting is bounded by WorkBudget inside runSchedulerTick.
	 */
	async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
		const cfg = loadConfig(env);
		ctx.waitUntil(
			handleScheduled(env, cfg).catch((err) => {
				console.error('[scheduler] unhandled tick error:', err);
			})
		);
	},
} satisfies ExportedHandler<Env>;
