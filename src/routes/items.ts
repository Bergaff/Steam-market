/**
 * /api/v1/items — item details, price history (downsampled), raw snapshots.
 */

import { Hono } from 'hono';
import type { Env } from '../env';
import type { RuntimeConfig } from '../config';
import { toIso, clampInt } from '../lib/time';
import { itemDto, parsePeriodMs, type ItemLatestRow } from './dto';

type Ctx = { Bindings: Env; Variables: { cfg: RuntimeConfig } };

const items = new Hono<Ctx>();

interface OpportunityRow {
	buy_price: number;
	sell_price: number;
	net_profit: number;
	net_profit_pct: number;
	volume_24h: number | null;
	detected_at: number;
	updated_at: number;
	is_active: number;
}

/** GET /api/v1/items/:id — full item card. */
items.get('/:id', async (c) => {
	const itemId = parseInt(c.req.param('id'), 10);
	if (!Number.isFinite(itemId)) return c.json({ error: 'invalid_item_id' }, 400);

	const row = await c.env.DB.prepare(
		`SELECT v.*, g.name AS game_name
		 FROM item_latest v
		 JOIN games g ON g.appid = v.appid
		 WHERE v.item_id = ?`
	)
		.bind(itemId)
		.first<ItemLatestRow & { game_name: string }>();

	if (!row) return c.json({ error: 'item_not_found', item_id: itemId }, 404);

	const opp = await c.env.DB.prepare(
		`SELECT buy_price, sell_price, net_profit, net_profit_pct, volume_24h, detected_at, updated_at, is_active
		 FROM spread_opportunities WHERE item_id = ?`
	)
		.bind(itemId)
		.first<OpportunityRow>();

	const stats = await c.env.DB.prepare(
		`SELECT COUNT(*) AS snapshots, MIN(snapshot_at) AS first_snapshot, MAX(snapshot_at) AS last_snapshot
		 FROM price_snapshots WHERE item_id = ?`
	)
		.bind(itemId)
		.first<{ snapshots: number; first_snapshot: number | null; last_snapshot: number | null }>();

	return c.json({
		item: itemDto(row, row.game_name),
		opportunity: opp
			? {
					buy_price_cents: opp.buy_price,
					sell_price_cents: opp.sell_price,
					net_profit_cents: opp.net_profit,
					net_profit_pct: Math.round(opp.net_profit_pct * 100) / 100,
					volume_24h: opp.volume_24h,
					detected_at: opp.detected_at,
					detected_at_iso: toIso(opp.detected_at),
					updated_at: opp.updated_at,
					is_active: opp.is_active === 1,
				}
			: null,
		snapshot_stats: {
			total: stats?.snapshots ?? 0,
			first_at: stats?.first_snapshot ?? null,
			first_at_iso: toIso(stats?.first_snapshot ?? null),
			last_at: stats?.last_snapshot ?? null,
			last_at_iso: toIso(stats?.last_snapshot ?? null),
		},
	});
});

interface HistoryBucketRow {
	bucket: number;
	sell_avg: number | null;
	sell_min: number | null;
	sell_max: number | null;
	buy_avg: number | null;
	volume_max: number | null;
	listings_avg: number | null;
	last_ts: number;
}

/**
 * GET /api/v1/items/:id/history?period=24h|7d|30d
 * Downsampled price history (<= ~500 points) from price_snapshots.
 */
items.get('/:id/history', async (c) => {
	const itemId = parseInt(c.req.param('id'), 10);
	if (!Number.isFinite(itemId)) return c.json({ error: 'invalid_item_id' }, 400);

	const { period, ms } = parsePeriodMs(c.req.query('period'));
	const since = Date.now() - ms;

	const countRow = await c.env.DB.prepare(
		'SELECT COUNT(*) AS n FROM price_snapshots WHERE item_id = ? AND snapshot_at >= ?'
	)
		.bind(itemId, since)
		.first<{ n: number }>();
	const count = countRow?.n ?? 0;

	const targetPoints = 500;
	const bucketMs = Math.max(60 * 1000, Math.ceil(ms / targetPoints / (60 * 1000)) * 60 * 1000);

	// CAST keeps SQLite integer division (D1 may bind numbers as REAL).
	const rows = await c.env.DB.prepare(
		`SELECT (CAST(snapshot_at AS INTEGER) / CAST(? AS INTEGER)) * CAST(? AS INTEGER) AS bucket,
		        AVG(sell_min_price) AS sell_avg,
		        MIN(sell_min_price) AS sell_min,
		        MAX(sell_min_price) AS sell_max,
		        AVG(buy_max_price)  AS buy_avg,
		        MAX(volume_24h)     AS volume_max,
		        AVG(sell_listings)  AS listings_avg,
		        MAX(snapshot_at)    AS last_ts
		 FROM price_snapshots
		 WHERE item_id = ? AND snapshot_at >= ?
		 GROUP BY bucket
		 ORDER BY bucket ASC`
	)
		.bind(bucketMs, bucketMs, itemId, since)
		.all<HistoryBucketRow>();

	return c.json({
		item_id: itemId,
		period,
		points: count,
		bucket_ms: bucketMs,
		series: rows.results.map((r) => ({
			t: r.bucket,
			t_iso: toIso(r.bucket),
			sell_avg_cents: r.sell_avg !== null ? Math.round(r.sell_avg) : null,
			sell_min_cents: r.sell_min,
			sell_max_cents: r.sell_max,
			buy_avg_cents: r.buy_avg !== null ? Math.round(r.buy_avg) : null,
			volume_24h: r.volume_max,
			listings_avg: r.listings_avg !== null ? Math.round(r.listings_avg) : null,
		})),
	});
});

interface SnapshotRow {
	id: number;
	sell_min_price: number | null;
	sell_listings: number | null;
	buy_max_price: number | null;
	buy_orders_count: number | null;
	volume_24h: number | null;
	median_price: number | null;
	snapshot_at: number;
	source: string;
}

/** GET /api/v1/items/:id/snapshots?limit=20 — raw latest snapshots (TZ §8: «Последние 20 снимков»). */
items.get('/:id/snapshots', async (c) => {
	const itemId = parseInt(c.req.param('id'), 10);
	if (!Number.isFinite(itemId)) return c.json({ error: 'invalid_item_id' }, 400);
	const limit = clampInt(parseInt(c.req.query('limit') ?? '20', 10), 1, 200, 20);

	const rows = await c.env.DB.prepare(
		`SELECT id, sell_min_price, sell_listings, buy_max_price, buy_orders_count, volume_24h, median_price, snapshot_at, source
		 FROM price_snapshots WHERE item_id = ?
		 ORDER BY snapshot_at DESC, id DESC LIMIT ?`
	)
		.bind(itemId, limit)
		.all<SnapshotRow>();

	return c.json({
		item_id: itemId,
		snapshots: rows.results.map((r) => ({
			id: r.id,
			sell_min_price_cents: r.sell_min_price,
			sell_listings: r.sell_listings,
			buy_max_price_cents: r.buy_max_price,
			buy_orders_count: r.buy_orders_count,
			volume_24h: r.volume_24h,
			median_price_cents: r.median_price,
			snapshot_at: r.snapshot_at,
			snapshot_at_iso: toIso(r.snapshot_at),
			source: r.source,
		})),
	});
});

export default items;
