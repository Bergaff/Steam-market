/**
 * /api/v1/admin — private management endpoints (TZ §7).
 * Auth: X-Admin-Key header must equal the ADMIN_API_KEY secret.
 *
 *   POST  /admin/games          — add a game to monitoring
 *   PATCH /admin/games/:appid   — change tier / interval / is_active / name
 *   POST  /admin/scan/:appid    — force a scan (queued + best-effort inline run)
 *   POST  /admin/seed-games     — re-seed the default 26 games (idempotent)
 *   POST  /admin/demo-data      — populate synthetic data (DEMO_MODE=1 only)
 *   GET   /admin/state          — scheduler state + recent errors (debugging)
 */

import { Hono } from 'hono';
import type { Env } from '../env';
import type { RuntimeConfig } from '../config';
import { nowMs, toIso } from '../lib/time';
import { adminAuth, type AppContext } from './middleware';
import { getAllState, STATE_KEYS, getStateInt, setState } from '../db/state';
import { createSteamClient } from '../scan/clientFactory';
import { WorkBudget } from '../scan/budget';
import { scanGameList, pickDueGames, type GameRow } from '../scan/listScanner';
import { processDetailQueue, enqueueTopItemsForDetails } from '../scan/detailScanner';
import { detectSpreads } from '../scan/spreadDetector';
import { seedDemoData } from '../demo/simulator';

type Ctx = { Bindings: Env; Variables: { cfg: RuntimeConfig } };

const admin = new Hono<Ctx>();
admin.use('*', adminAuth as never);

const TIER_INTERVALS: Record<number, number> = { 1: 300, 2: 900, 3: 1800 };

/** POST /admin/games {appid, name, tier?, scan_interval_sec?, is_active?} */
admin.post('/games', async (c) => {
	let body: Record<string, unknown>;
	try {
		body = await c.req.json();
	} catch {
		return c.json({ error: 'invalid_json' }, 400);
	}

	const appid = parseInt(String(body.appid ?? ''), 10);
	const name = typeof body.name === 'string' ? body.name.trim() : '';
	if (!Number.isFinite(appid) || appid <= 0) return c.json({ error: 'invalid_appid' }, 400);
	if (name.length === 0) return c.json({ error: 'name_required', message: 'Field "name" is required' }, 400);

	const tierRaw = body.tier !== undefined ? parseInt(String(body.tier), 10) : 2;
	const tier = [1, 2, 3].includes(tierRaw) ? tierRaw : 2;
	const intervalRaw = body.scan_interval_sec !== undefined ? parseInt(String(body.scan_interval_sec), 10) : TIER_INTERVALS[tier]!;
	const scanInterval = Number.isFinite(intervalRaw) && intervalRaw >= 60 ? Math.min(intervalRaw, 24 * 3600) : TIER_INTERVALS[tier]!;
	const isActive = body.is_active === undefined ? 1 : body.is_active ? 1 : 0;

	const existing = await c.env.DB.prepare('SELECT appid FROM games WHERE appid = ?').bind(appid).first();
	if (existing) {
		return c.json({ error: 'game_exists', message: `Game ${appid} is already monitored — use PATCH /admin/games/${appid}`, appid }, 409);
	}

	await c.env.DB.prepare(
		`INSERT INTO games (appid, name, tier, scan_interval_sec, is_active, next_scan_at) VALUES (?, ?, ?, ?, ?, 0)`
	)
		.bind(appid, name, tier, scanInterval, isActive)
		.run();

	return c.json({ ok: true, appid, name, tier, scan_interval_sec: scanInterval, is_active: isActive === 1 }, 201);
});

/** PATCH /admin/games/:appid {name?, tier?, scan_interval_sec?, is_active?} */
admin.patch('/games/:appid', async (c) => {
	const appid = parseInt(c.req.param('appid'), 10);
	if (!Number.isFinite(appid)) return c.json({ error: 'invalid_appid' }, 400);

	const game = await c.env.DB.prepare('SELECT * FROM games WHERE appid = ?').bind(appid).first<GameRow>();
	if (!game) return c.json({ error: 'game_not_found', appid }, 404);

	let body: Record<string, unknown>;
	try {
		body = await c.req.json();
	} catch {
		return c.json({ error: 'invalid_json' }, 400);
	}

	const sets: string[] = [];
	const params: (string | number)[] = [];

	if (typeof body.name === 'string' && body.name.trim().length > 0) {
		sets.push('name = ?');
		params.push(body.name.trim());
	}
	if (body.tier !== undefined) {
		const tier = parseInt(String(body.tier), 10);
		if (![1, 2, 3].includes(tier)) return c.json({ error: 'invalid_tier', message: 'tier must be 1, 2 or 3' }, 400);
		sets.push('tier = ?');
		params.push(tier);
		// Auto-adjust interval when it still matches the old tier default.
		if (body.scan_interval_sec === undefined && game.scan_interval_sec === TIER_INTERVALS[game.tier]) {
			sets.push('scan_interval_sec = ?');
			params.push(TIER_INTERVALS[tier]!);
		}
	}
	if (body.scan_interval_sec !== undefined) {
		const interval = parseInt(String(body.scan_interval_sec), 10);
		if (!Number.isFinite(interval) || interval < 60) {
			return c.json({ error: 'invalid_interval', message: 'scan_interval_sec must be >= 60' }, 400);
		}
		sets.push('scan_interval_sec = ?');
		params.push(Math.min(interval, 24 * 3600));
	}
	if (body.is_active !== undefined) {
		sets.push('is_active = ?');
		params.push(body.is_active ? 1 : 0);
	}
	if (body.scan_now === true) {
		sets.push('next_scan_at = 0');
	}

	if (sets.length === 0) return c.json({ error: 'nothing_to_update' }, 400);

	await c.env.DB.prepare(`UPDATE games SET ${sets.join(', ')} WHERE appid = ?`).bind(...params, appid).run();

	const updated = await c.env.DB.prepare('SELECT * FROM games WHERE appid = ?').bind(appid).first<GameRow>();
	return c.json({ ok: true, game: updated });
});

/**
 * POST /admin/scan/:appid — force a scan of one game.
 * Marks it due, queues detail scans for its top items and kicks off a
 * best-effort inline background run (waitUntil). The cron tick finishes
 * whatever does not fit into the inline budget.
 */
admin.post('/scan/:appid', async (c) => {
	const cfg = c.get('cfg');
	const appid = parseInt(c.req.param('appid'), 10);
	if (!Number.isFinite(appid)) return c.json({ error: 'invalid_appid' }, 400);

	const game = await c.env.DB.prepare('SELECT * FROM games WHERE appid = ?').bind(appid).first<GameRow>();
	if (!game) return c.json({ error: 'game_not_found', appid }, 404);

	await c.env.DB.prepare('UPDATE games SET next_scan_at = 0 WHERE appid = ?').bind(appid).run();
	const queued = await enqueueTopItemsForDetails(c.env.DB, cfg, appid);

	// Kick off a background run without blocking the HTTP response.
	let started = false;
	try {
		c.executionCtx.waitUntil(forcedScan(c.env, cfg, appid));
		started = true;
	} catch {
		// No execution context (e.g. unit tests) — cron will pick it up.
	}

	return c.json({
		ok: true,
		appid,
		game: game.name,
		detail_queue_items: queued,
		inline_run_started: started,
		message: started ? 'Scan started in background; cron tick will finish the rest' : 'Scan scheduled for the next cron tick',
	});
});

async function forcedScan(env: Env, cfg: RuntimeConfig, appid: number): Promise<void> {
	try {
		const db = env.DB;
		const client = createSteamClient(db, cfg);
		const budget = new WorkBudget(Math.min(12, cfg.scan.maxRequestsPerRun), 2 * 60 * 1000);

		const game = await db.prepare('SELECT * FROM games WHERE appid = ?').bind(appid).first<GameRow>();
		if (!game) return;

		await scanGameList(db, cfg, client, game, budget);
		await enqueueTopItemsForDetails(db, cfg, appid);
		if (budget.canAfford(2)) {
			await processDetailQueue(db, cfg, client, budget, 3);
		}
		await detectSpreads(db, cfg);
		await setState(db, STATE_KEYS.lastSpreadRunAt, nowMs());
		if (client.requests > 0 && client.errors === 0) {
			await setState(db, STATE_KEYS.lastSuccessfulScanAt, nowMs());
		}
	} catch (err) {
		console.error(`[admin] forced scan failed for appid=${appid}:`, err);
	}
}

/** The default 26 games (TZ §4) — kept in code for re-seeding convenience. */
const DEFAULT_GAMES: [number, string, number][] = [
	[440, 'Team Fortress 2', 1],
	[304930, 'Unturned', 1],
	[232090, 'Killing Floor 2', 1],
	[321360, 'Primal Carnage: Extinction', 1],
	[218620, 'PAYDAY 2', 1],
	[227300, 'Euro Truck Simulator 2', 1],
	[322330, "Don't Starve Together", 1],
	[578080, 'PUBG: BATTLEGROUNDS', 1],
	[1949740, 'Banana Shooter', 2],
	[774861, 'Project Winter', 2],
	[550650, 'Black Squad', 2],
	[299740, 'Miscreated', 2],
	[489940, 'BATTALION: Legacy', 2],
	[571740, 'Golf It!', 2],
	[282800, '100% Orange Juice', 2],
	[274940, 'Depth', 2],
	[518150, 'Intruder', 2],
	[598780, 'Boreal Blade', 2],
	[625340, 'XERA: Survival', 2],
	[238460, 'BattleBlock Theater', 2],
	[2427700, 'Backpack Battles', 3],
	[2373990, 'Solo Leveling: ARISE OVERDRIVE', 3],
	[1635450, 'Longvinter', 3],
	[1782210, 'Crab Game', 3],
	[3301740, 'TCG Master Trader', 3],
	[3678970, 'TBH', 3],
];

/** POST /admin/seed-games — idempotent insert of the default game list. */
admin.post('/seed-games', async (c) => {
	const stmts = DEFAULT_GAMES.map(([appid, name, tier]) =>
		c.env.DB.prepare(
			`INSERT OR IGNORE INTO games (appid, name, tier, scan_interval_sec, is_active, next_scan_at)
			 VALUES (?, ?, ?, ?, 1, 0)`
		).bind(appid, name, tier, TIER_INTERVALS[tier]!)
	);
	await c.env.DB.batch(stmts);
	const count = await c.env.DB.prepare('SELECT COUNT(*) AS n FROM games').first<{ n: number }>();
	return c.json({ ok: true, games_total: count?.n ?? 0, seeded: DEFAULT_GAMES.length });
});

/** POST /admin/demo-data — synthetic dataset (only when DEMO_MODE=1). */
admin.post('/demo-data', async (c) => {
	const cfg = c.get('cfg');
	if (!cfg.demoMode) {
		return c.json({ error: 'demo_mode_disabled', message: 'Set DEMO_MODE=1 to use synthetic data (never in production)' }, 403);
	}

	let body: Record<string, unknown> = {};
	try {
		body = await c.req.json();
	} catch {
		// body is optional
	}

	const result = await seedDemoData(c.env.DB, cfg, {
		games: body.games !== undefined ? parseInt(String(body.games), 10) : undefined,
		itemsPerGame: body.items_per_game !== undefined ? parseInt(String(body.items_per_game), 10) : undefined,
		historyHours: body.history_hours !== undefined ? parseInt(String(body.history_hours), 10) : undefined,
		reset: body.reset !== undefined ? Boolean(body.reset) : true,
	});
	const spread = await detectSpreads(c.env.DB, cfg);
	await setState(c.env.DB, STATE_KEYS.lastSpreadRunAt, nowMs());

	return c.json({ ok: true, seeded: result, spread_run: spread });
});

/** GET /admin/state — scheduler internals for debugging. */
admin.get('/state', async (c) => {
	const db = c.env.DB;
	const state = await getAllState(db);
	const now = nowMs();
	const pausedUntil = parseInt(state[STATE_KEYS.pausedUntil] ?? '0', 10);

	const recentErrors = await db
		.prepare(
			`SELECT endpoint, appid, item_id, status, duration_ms, error, created_at
			 FROM scan_log WHERE ok = 0 ORDER BY created_at DESC LIMIT 20`
		)
		.all();
	const recentRequests = await db
		.prepare(
			`SELECT endpoint, appid, status, duration_ms, ok, created_at
			 FROM scan_log ORDER BY created_at DESC LIMIT 20`
		)
		.all();
	const queue = await db
		.prepare(
			`SELECT q.item_id, q.appid, q.priority, q.due_at, q.attempts, q.last_error, i.name
			 FROM scan_queue q JOIN items i ON i.id = q.item_id
			 ORDER BY q.appid, q.priority LIMIT 50`
		)
		.all();
	const dueGames = await pickDueGames(db, 10, now);
	const lastSuccessfulScan = await getStateInt(db, STATE_KEYS.lastSuccessfulScanAt);

	return c.json({
		state,
		paused: pausedUntil > now,
		paused_until_iso: pausedUntil > now ? toIso(pausedUntil) : null,
		last_successful_scan_at_iso: toIso(lastSuccessfulScan || null),
		due_games: dueGames.map((g) => ({ appid: g.appid, name: g.name, tier: g.tier })),
		queue: queue.results,
		recent_requests: recentRequests.results,
		recent_errors: recentErrors.results,
	});
});

export default admin;
