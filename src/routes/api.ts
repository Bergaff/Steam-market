/**
 * /api/v1 — public REST API + admin sub-router.
 */

import { Hono } from 'hono';
import type { Env } from '../env';
import type { RuntimeConfig } from '../config';
import { setup, cors, rateLimit } from './middleware';
import { currencyLabel } from './dto';
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
