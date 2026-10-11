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

	try {
		lastScan = (await db.prepare('SELECT MAX(last_scan_at) AS last FROM games').first<{ last: number | null }>())?.last ?? null;
		const stateLast = await getStateInt(db, STATE_KEYS.lastSuccessfulScanAt);
		if (stateLast > (lastScan ?? 0)) lastScan = stateLast;
		pausedUntil = await getStateInt(db, STATE_KEYS.pausedUntil);
		queueDepth = (await db.prepare('SELECT COUNT(*) AS n FROM scan_queue').first<{ n: number }>())?.n ?? null;
		const summary = await getState(db, STATE_KEYS.lastTickSummary);
		if (summary) {
			try {
				lastTickSummary = JSON.parse(summary);
			} catch {
				lastTickSummary = summary;
			}
		}
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
		db: dbOk,
		last_successful_scan_at: lastScan,
		last_successful_scan_at_iso: toIso(lastScan),
		last_successful_scan_age_ms: staleMs,
		paused_until: paused ? pausedUntil : null,
		paused_until_iso: paused ? toIso(pausedUntil) : null,
		scan_queue_depth: queueDepth,
		last_tick: lastTickSummary,
		time_iso: toIso(now),
	};

	const httpStatus = !dbOk ? 503 : 200;
	return c.json(body, httpStatus as 200 | 503);
}
