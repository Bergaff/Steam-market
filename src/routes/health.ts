/**
 * /health — healthcheck (TZ §10): DB status + last successful scan + pause state.
 */

import type { AppContext } from './middleware';
import { toIso } from '../lib/time';
import { STATE_KEYS, getStateInt, getState } from '../db/state';

export async function healthHandler(c: AppContext): Promise<Response> {
	const cfg = c.get('cfg');
	const db = c.env.DB;
	const now = Date.now();

	let dbOk = true;
	let lastScan: number | null = null;
	let pausedUntil = 0;
	let queueDepth: number | null = null;
	let lastTickSummary: unknown = null;
	let consecutive429 = 0;
	interface RecentError {
		endpoint: string;
		status: number | null;
		error: string | null;
		created_at_iso: string | null;
	}
	let recentErrors: RecentError[] = [];

	try {
		lastScan = (await db.prepare('SELECT MAX(last_scan_at) AS last FROM games').first<{ last: number | null }>())?.last ?? null;
		const stateLast = await getStateInt(db, STATE_KEYS.lastSuccessfulScanAt);
		if (stateLast > (lastScan ?? 0)) lastScan = stateLast;
		pausedUntil = await getStateInt(db, STATE_KEYS.pausedUntil);
		consecutive429 = await getStateInt(db, STATE_KEYS.consecutive429);
		queueDepth = (await db.prepare('SELECT COUNT(*) AS n FROM scan_queue').first<{ n: number }>())?.n ?? null;
		const summary = await getState(db, STATE_KEYS.lastTickSummary);
		if (summary) {
			try {
				lastTickSummary = JSON.parse(summary);
			} catch {
				lastTickSummary = summary;
			}
		}
		// Last failed Steam requests — the fastest way to see WHY scans stall
		// (429 rate limits, TLS issues, unexpected shapes...). Harmless public
		// data: endpoint name, HTTP status, error text, time.
		const errRows = await db
			.prepare(
				`SELECT endpoint, status, error, created_at
				 FROM scan_log WHERE ok = 0
				 ORDER BY id DESC LIMIT 5`
			)
			.all<{ endpoint: string; status: number | null; error: string | null; created_at: number }>();
		recentErrors = errRows.results.map((r) => ({
			endpoint: r.endpoint,
			status: r.status,
			error: r.error,
			created_at_iso: toIso(r.created_at),
		}));
	} catch {
		dbOk = false;
	}

	const paused = pausedUntil > now;
	const staleMs = lastScan === null ? null : now - lastScan;
	// Degraded: paused by Steam, or no successful scan for > 30 minutes
	// (demo mode expects a tick every few minutes).
	const degraded = !dbOk || paused || (staleMs !== null && staleMs > 30 * 60 * 1000);

	const body = {
		status: !dbOk ? 'down' : paused ? 'paused' : degraded ? 'degraded' : 'ok',
		demo_mode: cfg.demoMode,
		scan_limits: {
			min_request_interval_ms: cfg.scan.minRequestIntervalMs,
			max_steam_requests_per_run: cfg.scan.maxRequestsPerRun,
			max_run_wall_ms: cfg.scan.maxRunWallMs,
			scan_pages_per_game: cfg.scan.pagesPerGame,
			details_per_tick: cfg.scan.detailsPerTick,
		},
		db: dbOk,
		steam_cookie_configured: cfg.steam.webCookie !== null,
		last_successful_scan_at: lastScan,
		last_successful_scan_at_iso: toIso(lastScan),
		last_successful_scan_age_ms: staleMs,
		paused_until: paused ? pausedUntil : null,
		paused_until_iso: paused ? toIso(pausedUntil) : null,
		consecutive_429: consecutive429,
		scan_queue_depth: queueDepth,
		recent_errors: recentErrors,
		last_tick: lastTickSummary,
		time_iso: toIso(now),
	};

	const httpStatus = !dbOk ? 503 : 200;
	return c.json(body, httpStatus as 200 | 503);
}
