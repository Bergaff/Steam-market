/**
 * /api/v1 — public REST API + admin sub-router.
 */

import { Hono } from 'hono';
import type { Env } from '../env';
import type { RuntimeConfig } from '../config';
import { setup, cors, rateLimit, checkAdminKey, type AppContext } from './middleware';
import { currencyLabel } from './dto';
import { schemaProbe, applySchema, SCHEMA_STATEMENTS } from '../db/migrate';
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
 * GET /api/v1/migrate — schema status; with ?apply=1 also initializes an
 * incomplete database straight from a browser (no terminal, no D1 console).
 * POST /api/v1/migrate — same bootstrap via curl/API clients.
 *
 * Bootstrap (anonymous) is allowed while ANY required table is missing — the
 * embedded statements are strictly idempotent and non-destructive, so it also
 * repairs a partially-created schema (e.g. a failed console paste). Once the
 * schema is complete, re-applying requires the admin key.
 */
api.get('/migrate', async (c) => {
	const probe = await schemaProbe(c.env.DB);
	const apply = c.req.query('apply') === '1';

	if (!probe.complete && apply) {
		const status = await applySchema(c.env.DB);
		return c.json({
			ok: true,
			bootstrap: true,
			repaired_missing_tables: probe.missing,
			statements_applied: SCHEMA_STATEMENTS.length,
			...status,
			message: 'Database initialized: schema created and 26 games seeded. The cron scanner starts within a minute.',
		});
	}

	if (!probe.complete) {
		return c.json({
			initialized: false,
			missing_tables: probe.missing,
			statements: SCHEMA_STATEMENTS.length,
			message: 'Database is incomplete. Open this URL with ?apply=1 (browser) or send POST /api/v1/migrate to initialize.',
		});
	}

	const games = await c.env.DB.prepare('SELECT COUNT(*) AS n FROM games').first<{ n: number }>();
	const items = await c.env.DB.prepare('SELECT COUNT(*) AS n FROM items').first<{ n: number }>();
	return c.json({
		initialized: true,
		games: games?.n ?? 0,
		items: items?.n ?? 0,
		message: apply
			? 'Already initialized; re-applying requires POST with X-Admin-Key'
			: 'Schema complete. POST with X-Admin-Key re-applies it (idempotent).',
	});
});

api.post('/migrate', async (c) => {
	const probe = await schemaProbe(c.env.DB);

	// Bootstrap mode: allow anonymous initialization/repair while the schema
	// is incomplete. A complete schema requires the admin key.
	if (probe.complete) {
		const denied = checkAdminKey(c);
		if (denied) return denied;
	}

	const status = await applySchema(c.env.DB);
	return c.json({
		ok: true,
		bootstrap: !probe.complete,
		repaired_missing_tables: probe.missing,
		statements_applied: SCHEMA_STATEMENTS.length,
		...status,
		message: probe.complete
			? 'Schema re-applied (idempotent)'
			: 'Database initialized: schema created and 26 games seeded. The cron scanner starts within a minute.',
	});
});

/**
 * GET|POST /api/v1/system/wipe-market-data?key=<ADMIN_API_KEY>&confirm=1
 *
 * Deletes ALL collected market data (price snapshots, latest state, spread
 * signals, detail queue) but keeps games, items and their cached nameids.
 * Used to clear poisoned data — e.g. prices recorded in the wrong currency.
 * The admin key is accepted via header OR query param so the owner can run
 * it straight from a browser (documented in README).
 */
async function wipeMarketDataHandler(c: AppContext): Promise<Response> {
	const denied = checkAdminKey(c, { allowQueryKey: true });
	if (denied) return denied;

	if (c.req.query('confirm') !== '1') {
		return c.json(
			{
				error: 'confirm_required',
				message:
					'This DELETES all price history, latest state, spread signals and the detail queue (games/items are kept). Re-run with &confirm=1 appended.',
			},
			400
		);
	}

	const db = c.env.DB;
	const countOf = async (table: string): Promise<number> =>
		(await db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>())?.n ?? 0;

	const deleted = {
		price_snapshots: await countOf('price_snapshots'),
		spread_opportunities: await countOf('spread_opportunities'),
		scan_queue: await countOf('scan_queue'),
		item_latest_state: await countOf('item_latest_state'),
	};

	await db.batch([
		db.prepare('DELETE FROM price_snapshots'),
		db.prepare('DELETE FROM spread_opportunities'),
		db.prepare('DELETE FROM scan_queue'),
		db.prepare('DELETE FROM item_latest_state'),
		db.prepare('UPDATE games SET next_scan_at = 0, last_scan_at = NULL, last_scan_status = NULL'),
	]);

	return c.json({
		ok: true,
		deleted,
		message: 'Market data wiped; games re-scan from scratch within a minute (items and cached nameids are kept).',
	});
}

api.get('/system/wipe-market-data', wipeMarketDataHandler);
api.post('/system/wipe-market-data', wipeMarketDataHandler);

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
			'GET|POST /api/v1/system/wipe-market-data?key=...&confirm=1  (clear poisoned price data, admin key)',
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
