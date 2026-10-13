/**
 * /api/v1/stats — global service statistics (TZ §7: /stats/overview).
 */

import { Hono } from 'hono';
import type { Env } from '../env';
import type { RuntimeConfig } from '../config';
import { toIso } from '../lib/time';
import { STATE_KEYS, getStateInt, getState } from '../db/state';
import { currencyLabel } from './dto';

type Ctx = { Bindings: Env; Variables: { cfg: RuntimeConfig } };

const stats = new Hono<Ctx>();

stats.get('/overview', async (c) => {
	const cfg = c.get('cfg');
	const db = c.env.DB;
	const now = Date.now();

	const [games, items, opps, snapshots24h, lastScan, queue, errors24h] = await Promise.all([
		db.prepare('SELECT COUNT(*) AS total, SUM(is_active) AS active FROM games').first<{ total: number; active: number }>(),
		db.prepare('SELECT COUNT(*) AS total FROM items').first<{ total: number }>(),
		db
			.prepare('SELECT COUNT(*) AS active, AVG(net_profit_pct) AS avg_pct, MAX(net_profit_pct) AS max_pct FROM spread_opportunities WHERE is_active = 1')
			.first<{ active: number; avg_pct: number | null; max_pct: number | null }>(),
		db.prepare('SELECT COUNT(*) AS n FROM price_snapshots WHERE snapshot_at >= ?').bind(now - 24 * 3600 * 1000).first<{ n: number }>(),
		db.prepare('SELECT MAX(last_scan_at) AS last FROM games').first<{ last: number | null }>(),
		db.prepare('SELECT COUNT(*) AS n FROM scan_queue').first<{ n: number }>(),
		db.prepare('SELECT COUNT(*) AS n FROM scan_log WHERE ok = 0 AND created_at >= ?').bind(now - 24 * 3600 * 1000).first<{ n: number }>(),
	]);

	const pausedUntil = await getStateInt(db, STATE_KEYS.pausedUntil);
	const lastTick = await getStateInt(db, STATE_KEYS.lastTickAt);
	const totalRequests = await getStateInt(db, STATE_KEYS.totalSteamRequests);
	const totalErrors = await getStateInt(db, STATE_KEYS.totalSteamErrors);
	const lastTickSummary = await getState(db, STATE_KEYS.lastTickSummary);

	return c.json({
		currency: currencyLabel(cfg),
		demo_mode: cfg.demoMode,
		games: { total: games?.total ?? 0, active: games?.active ?? 0 },
		items: { total: items?.total ?? 0 },
		opportunities: {
			active: opps?.active ?? 0,
			avg_profit_pct: opps?.avg_pct !== null && opps?.avg_pct !== undefined ? Math.round(opps.avg_pct * 100) / 100 : null,
			max_profit_pct: opps?.max_pct !== null && opps?.max_pct !== undefined ? Math.round(opps.max_pct * 100) / 100 : null,
		},
		snapshots_24h: snapshots24h?.n ?? 0,
		queue_depth: queue?.n ?? 0,
		scanner: {
			last_scan_at: lastScan?.last ?? null,
			last_scan_at_iso: toIso(lastScan?.last ?? null),
			last_tick_at: lastTick || null,
			last_tick_at_iso: toIso(lastTick || null),
			paused_until: pausedUntil > now ? pausedUntil : null,
			paused_until_iso: pausedUntil > now ? toIso(pausedUntil) : null,
			steam_requests_total: totalRequests,
			steam_errors_total: totalErrors,
			errors_24h: errors24h?.n ?? 0,
			last_tick_summary: lastTickSummary ? safeJsonParse(lastTickSummary) : null,
		},
	});
});

function safeJsonParse(s: string): unknown {
	try {
		return JSON.parse(s);
	} catch {
		return s;
	}
}

export default stats;
