/**
 * /api/v1 — public REST API + admin sub-router.
 */

import { Hono } from 'hono';
import type { Env } from '../env';
import type { RuntimeConfig } from '../config';
import { setup, cors, rateLimit, checkAdminKey } from './middleware';
import { currencyLabel } from './dto';
import { isSchemaInitialized, applySchema, SCHEMA_STATEMENTS } from '../db/migrate';
import games from './games';
import items from './items';
import opportunities from './opportunities';
import stats from './stats';
import admin from './admin';

type Ctx = { Bindings: Env; Variables: { cfg: RuntimeConfig } };

const api = new Hono<Ctx>();

api.use('*', setup as never);
api.use('*', cors as never);
api.use('*', rateLimit as never);

/**
 * GET /api/v1/migrate — schema status (safe to open in a browser).
 * POST /api/v1/migrate — initialize an EMPTY database (bootstrap: no key
 * needed, the embedded statements are strictly idempotent and non-destructive).
 * Once the schema exists, the admin key is required to re-run it.
 */
api.get('/migrate', async (c) => {
	const initialized = await isSchemaInitialized(c.env.DB);
	if (!initialized) {
		return c.json({
			initialized: false,
			message: 'Database is empty. Run: curl -X POST ' + new URL(c.req.url).origin + '/api/v1/migrate',
			statements: SCHEMA_STATEMENTS.length,
		});
	}
	const games = await c.env.DB.prepare('SELECT COUNT(*) AS n FROM games').first<{ n: number }>();
	const items = await c.env.DB.prepare('SELECT COUNT(*) AS n FROM items').first<{ n: number }>();
	return c.json({ initialized: true, games: games?.n ?? 0, items: items?.n ?? 0 });
});

api.post('/migrate', async (c) => {
	const wasInitialized = await isSchemaInitialized(c.env.DB);

	// Bootstrap mode: allow anonymous initialization of a completely empty DB.
	// Everything else requires the admin key.
	if (wasInitialized) {
		const denied = checkAdminKey(c);
		if (denied) return denied;
	}

	const status = await applySchema(c.env.DB);
	return c.json({
		ok: true,
		bootstrap: !wasInitialized,
		statements_applied: SCHEMA_STATEMENTS.length,
		...status,
		message: wasInitialized
			? 'Schema re-applied (idempotent)'
			: 'Database initialized: schema created and 26 games seeded. The cron scanner starts within a minute.',
	});
});

/** GET /api/v1/config — public client config (currency, thresholds, demo flag). */
api.get('/config', (c) => {
	const cfg = c.get('cfg');
	return c.json({
		currency: currencyLabel(cfg),
		steam_currency_id: cfg.steam.currency,
		locale: 'ru-RU',
		demo_mode: cfg.demoMode,
		thresholds: {
			min_spread_pct: cfg.spread.minProfitPct,
			min_volume_24h: cfg.spread.minVolume24h,
			min_buy_price_cents: cfg.spread.minBuyPriceCents,
		},
	});
});

api.route('/games', games);
api.route('/items', items);
api.route('/opportunities', opportunities);
api.route('/stats', stats);
api.route('/admin', admin);

api.get('/', (c) =>
	c.json({
		service: 'Steam Market Analytics',
		version: 1,
		endpoints: [
			'GET /api/v1/config',
			'GET|POST /api/v1/migrate  (bootstrap empty DB / re-apply schema with X-Admin-Key)',
			'GET /api/v1/games',
			'GET /api/v1/games/:appid',
			'GET /api/v1/games/:appid/items?limit&offset&sort&dir&min_price_cents&min_volume&min_spread_pct',
			'GET /api/v1/games/:appid/activity?period=24h|7d|30d',
			'GET /api/v1/items/:id',
			'GET /api/v1/items/:id/history?period=24h|7d|30d',
			'GET /api/v1/items/:id/snapshots?limit',
			'GET /api/v1/opportunities?min_profit_pct&min_volume&appid&sort&dir&limit&offset&format=json|csv',
			'GET /api/v1/stats/overview',
			'GET /health',
			'POST /api/v1/admin/games            (X-Admin-Key)',
			'PATCH /api/v1/admin/games/:appid     (X-Admin-Key)',
			'POST /api/v1/admin/scan/:appid       (X-Admin-Key)',
			'POST /api/v1/admin/seed-games        (X-Admin-Key)',
			'POST /api/v1/admin/demo-data         (X-Admin-Key, DEMO_MODE=1)',
			'GET /api/v1/admin/state              (X-Admin-Key)',
		],
	})
);

api.notFound((c) => c.json({ error: 'not_found', path: c.req.path }, 404));

export default api;
