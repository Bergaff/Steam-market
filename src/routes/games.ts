/**
 * /api/v1/games — games list, game details, items of a game, market activity.
 */

import { Hono } from 'hono';
import type { Env } from '../env';
import type { RuntimeConfig } from '../config';
import { toIso } from '../lib/time';
import { ITEM_WITH_STATE_SELECT } from '../db/latestState';
import { itemDto, parsePagination, parseSort, parseDirection, intFilter, parsePeriodMs, type ItemLatestRow } from './dto';

type Ctx = { Bindings: Env; Variables: { cfg: RuntimeConfig } };

const games = new Hono<Ctx>();

interface GameListRow {
	appid: number;
	name: string;
	tier: number;
	scan_interval_sec: number;
	is_active: number;
	next_scan_at: number;
	last_scan_at: number | null;
	last_scan_status: string | null;
	items_count: number | null;
	sell_listings: number | null;
	volume_24h: number | null;
	opportunities: number | null;
}

function gameDto(row: GameListRow) {
	return {
		appid: row.appid,
		name: row.name,
		tier: row.tier,
		scan_interval_sec: row.scan_interval_sec,
		is_active: row.is_active === 1,
		last_scan_at: row.last_scan_at,
		last_scan_at_iso: toIso(row.last_scan_at),
		last_scan_status: row.last_scan_status,
		next_scan_at: row.next_scan_at,
		stats: {
			items: row.items_count ?? 0,
			sell_listings: row.sell_listings ?? 0,
			// NULL means no detail scan has supplied market volume yet; do not present it as a real zero.
			volume_24h: row.volume_24h,
			active_opportunities: row.opportunities ?? 0,
		},
	};
}

const GAME_LIST_SQL = `
	SELECT
	  g.appid, g.name, g.tier, g.scan_interval_sec, g.is_active,
	  g.next_scan_at, g.last_scan_at, g.last_scan_status,
	  agg.items_count, agg.sell_listings, agg.volume_24h,
	  op.opportunities
	FROM games g
	LEFT JOIN (
	  SELECT i.appid,
	         COUNT(*)                          AS items_count,
	         SUM(COALESCE(s.sell_listings, 0)) AS sell_listings,
	         SUM(s.volume_24h)                 AS volume_24h
	  FROM items i
	  LEFT JOIN item_latest_state s ON s.item_id = i.id
	  GROUP BY i.appid
	) agg ON agg.appid = g.appid
	LEFT JOIN (
	  SELECT i.appid, COUNT(*) AS opportunities
	  FROM spread_opportunities o
	  JOIN items i ON i.id = o.item_id
	  WHERE o.is_active = 1
	  GROUP BY i.appid
	) op ON op.appid = g.appid
`;

/** GET /api/v1/games — all monitored games with aggregate stats. */
games.get('/', async (c) => {
	const rows = await c.env.DB.prepare(`${GAME_LIST_SQL} ORDER BY g.tier ASC, g.appid ASC`).all<GameListRow>();
	return c.json({ games: rows.results.map(gameDto) });
});

/** GET /api/v1/games/:appid — game details + top items. */
games.get('/:appid', async (c) => {
	const appid = parseInt(c.req.param('appid'), 10);
	if (!Number.isFinite(appid)) return c.json({ error: 'invalid_appid' }, 400);

	const gameRows = await c.env.DB.prepare(`${GAME_LIST_SQL} WHERE g.appid = ?`).bind(appid).all<GameListRow>();
	const game = gameRows.results[0];
	if (!game) return c.json({ error: 'game_not_found', appid }, 404);

	const topByVolume = await c.env.DB.prepare(
		`SELECT v.* FROM ( ${ITEM_WITH_STATE_SELECT} ) v
		 WHERE v.appid = ? AND v.volume_24h IS NOT NULL
		 ORDER BY v.volume_24h DESC, v.sell_listings DESC
		 LIMIT 10`
	)
		.bind(appid)
		.all<ItemLatestRow>();

	const topBySpread = await c.env.DB.prepare(
		`SELECT v.* FROM ( ${ITEM_WITH_STATE_SELECT} ) v
		 WHERE v.appid = ? AND v.sell_min_price IS NOT NULL AND v.buy_max_price IS NOT NULL AND v.buy_max_price > 0
		 ORDER BY (ROUND(v.sell_min_price * 0.85) - v.buy_max_price) * 100.0 / v.buy_max_price DESC
		 LIMIT 10`
	)
		.bind(appid)
		.all<ItemLatestRow>();

	return c.json({
		game: gameDto(game),
		top_by_volume: topByVolume.results.map((r) => itemDto(r, game.name)),
		top_by_spread: topBySpread.results.map((r) => itemDto(r, game.name)),
	});
});

/** GET /api/v1/games/:appid/items — items with latest prices, filters, sorting, pagination. */
games.get('/:appid/items', async (c) => {
	const appid = parseInt(c.req.param('appid'), 10);
	if (!Number.isFinite(appid)) return c.json({ error: 'invalid_appid' }, 400);

	const { limit, offset } = parsePagination(c.req.query('limit'), c.req.query('offset'));
	const dir = parseDirection(c.req.query('dir'));
	const orderBy = parseSort(
		c.req.query('sort'),
		{
			volume: 'COALESCE(v.volume_24h, -1)',
			price: 'COALESCE(v.sell_min_price, -1)',
			spread: 'CASE WHEN v.buy_max_price IS NOT NULL AND v.buy_max_price > 0 AND v.sell_min_price IS NOT NULL THEN (ROUND(v.sell_min_price * 0.85) - v.buy_max_price) * 100.0 / v.buy_max_price ELSE -1e9 END',
			profit: 'CASE WHEN v.buy_max_price IS NOT NULL AND v.buy_max_price > 0 AND v.sell_min_price IS NOT NULL THEN (ROUND(v.sell_min_price * 0.85) - v.buy_max_price) ELSE -1e9 END',
			listings: 'COALESCE(v.sell_listings, -1)',
			name: 'v.name COLLATE NOCASE',
		},
		'COALESCE(v.volume_24h, -1)'
	);

	const minPriceCents = intFilter(c.req.query('min_price_cents'));
	const minVolume = intFilter(c.req.query('min_volume'));
	const minSpreadPctRaw = c.req.query('min_spread_pct');
	const minSpreadPct = minSpreadPctRaw !== undefined && minSpreadPctRaw !== '' ? parseFloat(minSpreadPctRaw) : null;

	const where: string[] = ['v.appid = ?'];
	const params: (number | string)[] = [appid];

	if (minPriceCents !== null) {
		where.push('v.sell_min_price >= ?');
		params.push(minPriceCents);
	}
	if (minVolume !== null) {
		where.push('COALESCE(v.volume_24h, 0) >= ?');
		params.push(minVolume);
	}
	if (minSpreadPct !== null && Number.isFinite(minSpreadPct)) {
		where.push(
			`(v.buy_max_price IS NOT NULL AND v.buy_max_price > 0 AND v.sell_min_price IS NOT NULL
			  AND (ROUND(v.sell_min_price * 0.85) - v.buy_max_price) * 100.0 / v.buy_max_price >= ?)`
		);
		params.push(minSpreadPct);
	}

	const whereSql = where.join(' AND ');

	const countRow = await c.env.DB.prepare(`SELECT COUNT(*) AS n FROM ( ${ITEM_WITH_STATE_SELECT} ) v WHERE ${whereSql}`)
		.bind(...params)
		.first<{ n: number }>();

	const rows = await c.env.DB.prepare(
		`SELECT v.* FROM ( ${ITEM_WITH_STATE_SELECT} ) v WHERE ${whereSql} ORDER BY ${orderBy} ${dir}, v.item_id ASC LIMIT ? OFFSET ?`
	)
		.bind(...params, limit, offset)
		.all<ItemLatestRow>();

	const gameRow = await c.env.DB.prepare('SELECT name FROM games WHERE appid = ?').bind(appid).first<{ name: string }>();

	return c.json({
		appid,
		game_name: gameRow?.name ?? null,
		total: countRow?.n ?? 0,
		limit,
		offset,
		items: rows.results.map((r) => itemDto(r, gameRow?.name ?? null)),
	});
});

/**
 * GET /api/v1/games/:appid/activity?period=24h|7d|30d
 * Aggregated market activity: per time bucket — total 24h volume and avg listings.
 * (per item we take MAX(volume_24h) inside the bucket to avoid double counting)
 */
games.get('/:appid/activity', async (c) => {
	const appid = parseInt(c.req.param('appid'), 10);
	if (!Number.isFinite(appid)) return c.json({ error: 'invalid_appid' }, 400);

	const { period, ms } = parsePeriodMs(c.req.query('period'));
	const since = Date.now() - ms;

	// Choose a bucket so the series has <= ~200 points.
	const targetPoints = 200;
	const bucketMs = Math.max(5 * 60 * 1000, Math.ceil(ms / targetPoints / (5 * 60 * 1000)) * 5 * 60 * 1000);

	interface ActivityRow {
		bucket: number;
		volume: number;
		listings: number;
		items: number;
	}

	// CAST keeps SQLite integer division (D1 may bind numbers as REAL).
	const rows = await c.env.DB.prepare(
		`SELECT bucket, SUM(item_volume) AS volume, SUM(item_listings) AS listings, COUNT(*) AS items
		 FROM (
		   SELECT (CAST(s.snapshot_at AS INTEGER) / CAST(? AS INTEGER)) * CAST(? AS INTEGER) AS bucket, s.item_id,
		          MAX(COALESCE(s.volume_24h, 0)) AS item_volume,
		          AVG(COALESCE(s.sell_listings, 0)) AS item_listings
		   FROM price_snapshots s
		   JOIN items i ON i.id = s.item_id
		   WHERE i.appid = ? AND s.snapshot_at >= ?
		   GROUP BY bucket, s.item_id
		 )
		 GROUP BY bucket
		 ORDER BY bucket ASC`
	)
		.bind(bucketMs, bucketMs, appid, since)
		.all<ActivityRow>();

	return c.json({
		appid,
		period,
		bucket_ms: bucketMs,
		series: rows.results.map((r) => ({
			t: r.bucket,
			t_iso: toIso(r.bucket),
			volume_24h_sum: Math.round(r.volume ?? 0),
			listings_avg: Math.round(r.listings ?? 0),
			items: r.items ?? 0,
		})),
	});
});

export default games;
