/**
 * /api/v1/opportunities — active spread signals (TZ §6 воркер 3, §7, §8).
 * Supports filters (game, min profit %, min volume), sorting, pagination
 * and CSV export (?format=csv).
 */

import { Hono } from 'hono';
import type { Env } from '../env';
import type { RuntimeConfig } from '../config';
import { toIso } from '../lib/time';
import { parsePagination, parseSort, parseDirection, intFilter, csvCell, centsToUnits, steamItemUrl, currencyLabel } from './dto';

type Ctx = { Bindings: Env; Variables: { cfg: RuntimeConfig } };

const opportunities = new Hono<Ctx>();

interface OpportunityListRow {
	id: number;
	item_id: number;
	appid: number;
	hash_name: string;
	name: string;
	icon_url: string | null;
	game_name: string;
	buy_price: number;
	sell_price: number;
	net_profit: number;
	net_profit_pct: number;
	volume_24h: number | null;
	sell_listings: number | null;
	buy_orders_count: number | null;
	detected_at: number;
	updated_at: number;
	is_active: number;
}

const BASE_SELECT = `
	SELECT
	  o.id, o.item_id, i.appid, i.hash_name, i.name, i.icon_url,
	  g.name AS game_name,
	  o.buy_price, o.sell_price, o.net_profit, o.net_profit_pct, o.volume_24h,
	  v.sell_listings, v.buy_orders_count,
	  o.detected_at, o.updated_at, o.is_active
	FROM spread_opportunities o
	JOIN items i ON i.id = o.item_id
	JOIN games g ON g.appid = i.appid
	LEFT JOIN item_latest_state v ON v.item_id = o.item_id
`;

function dto(row: OpportunityListRow) {
	return {
		id: row.id,
		item_id: row.item_id,
		appid: row.appid,
		game_name: row.game_name,
		hash_name: row.hash_name,
		name: row.name,
		icon_url: row.icon_url,
		steam_url: steamItemUrl(row.appid, row.hash_name),
		buy_price_cents: row.buy_price,
		sell_price_cents: row.sell_price,
		net_profit_cents: row.net_profit,
		net_profit_pct: Math.round(row.net_profit_pct * 100) / 100,
		volume_24h: row.volume_24h,
		sell_listings: row.sell_listings,
		buy_orders_count: row.buy_orders_count,
		detected_at: row.detected_at,
		detected_at_iso: toIso(row.detected_at),
		updated_at: row.updated_at,
		updated_at_iso: toIso(row.updated_at),
	};
}

opportunities.get('/', async (c) => {
	const cfg = c.get('cfg');
	const { limit, offset } = parsePagination(c.req.query('limit'), c.req.query('offset'), 50, 500);
	const dir = parseDirection(c.req.query('dir'));
	const orderBy = parseSort(
		c.req.query('sort'),
		{
			profit: 'o.net_profit_pct',
			profit_abs: 'o.net_profit',
			volume: 'COALESCE(o.volume_24h, -1)',
			detected: 'o.detected_at',
			updated: 'o.updated_at',
			price: 'o.sell_price',
		},
		'o.net_profit_pct'
	);

	const where: string[] = ['o.is_active = 1'];
	const params: (number | string)[] = [];

	const minProfitPctRaw = c.req.query('min_profit_pct');
	if (minProfitPctRaw !== undefined && minProfitPctRaw !== '') {
		const v = parseFloat(minProfitPctRaw);
		if (Number.isFinite(v)) {
			where.push('o.net_profit_pct >= ?');
			params.push(v);
		}
	}
	const minVolume = intFilter(c.req.query('min_volume'));
	if (minVolume !== null) {
		where.push('COALESCE(o.volume_24h, 0) >= ?');
		params.push(minVolume);
	}
	const appid = intFilter(c.req.query('appid'));
	if (appid !== null) {
		where.push('i.appid = ?');
		params.push(appid);
	}

	const whereSql = where.join(' AND ');

	const countRow = await c.env.DB.prepare(`SELECT COUNT(*) AS n FROM spread_opportunities o JOIN items i ON i.id = o.item_id WHERE ${whereSql}`)
		.bind(...params)
		.first<{ n: number }>();

	const rows = await c.env.DB.prepare(`${BASE_SELECT} WHERE ${whereSql} ORDER BY ${orderBy} ${dir}, o.id ASC LIMIT ? OFFSET ?`)
		.bind(...params, limit, offset)
		.all<OpportunityListRow>();

	const data = rows.results.map(dto);

	// --- CSV export ---------------------------------------------------------
	if ((c.req.query('format') ?? '').toLowerCase() === 'csv') {
		const cur = currencyLabel(cfg);
		const header = [
			'game', 'item', 'hash_name', `buy_price_${cur}`, `sell_price_${cur}`,
			`net_profit_${cur}`, 'net_profit_pct', 'volume_24h', 'sell_listings', 'buy_orders_count',
			'detected_at', 'steam_url',
		].map(csvCell).join(';');
		const lines = rows.results.map((r) =>
			[
				csvCell(r.game_name),
				csvCell(r.name),
				csvCell(r.hash_name),
				csvCell(centsToUnits(r.buy_price)),
				csvCell(centsToUnits(r.sell_price)),
				csvCell(centsToUnits(r.net_profit)),
				csvCell((Math.round(r.net_profit_pct * 100) / 100).toFixed(2)),
				csvCell(r.volume_24h),
				csvCell(r.sell_listings),
				csvCell(r.buy_orders_count),
				csvCell(toIso(r.detected_at) ?? ''),
				csvCell(steamItemUrl(r.appid, r.hash_name)),
			].join(';')
		);
		// BOM for Excel + semicolon delimiter (ru-locale Excel default).
		const csv = '\uFEFF' + [header, ...lines].join('\r\n');
		const filename = `steam-spreads-${new Date().toISOString().slice(0, 10)}.csv`;
		return c.body(csv, 200, {
			'Content-Type': 'text/csv; charset=utf-8',
			'Content-Disposition': `attachment; filename="${filename}"`,
		});
	}

	return c.json({
		total: countRow?.n ?? 0,
		limit,
		offset,
		currency: currencyLabel(cfg),
		opportunities: data,
	});
});

export default opportunities;
