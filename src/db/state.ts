/**
 * Scheduler persistent state (key/value in `scheduler_state` table).
 *
 * Keys:
 *   paused_until              — epoch ms; scheduler skips ticks until then
 *   consecutive_429           — counter of back-to-back rate-limit hits
 *   last_spread_run_at        — epoch ms of last spread detector run
 *   last_housekeeping_at      — epoch ms of last retention cleanup
 *   last_successful_scan_at   — epoch ms of last successful Steam request batch
 *   total_steam_requests      — lifetime counter (for /health and stats)
 *   total_steam_errors        — lifetime counter
 */

export const STATE_KEYS = {
	pausedUntil: 'paused_until',
	consecutive429: 'consecutive_429',
	lastSpreadRunAt: 'last_spread_run_at',
	lastHousekeepingAt: 'last_housekeeping_at',
	lastSuccessfulScanAt: 'last_successful_scan_at',
	totalSteamRequests: 'total_steam_requests',
	totalSteamErrors: 'total_steam_errors',
	lastTickAt: 'last_tick_at',
	lastTickSummary: 'last_tick_summary',
} as const;

export async function getState(db: D1Database, key: string): Promise<string | null> {
	const row = await db.prepare('SELECT value FROM scheduler_state WHERE key = ?').bind(key).first<{ value: string }>();
	return row ? row.value : null;
}

export async function getStateInt(db: D1Database, key: string): Promise<number> {
	const v = await getState(db, key);
	const n = v === null ? NaN : parseInt(v, 10);
	return Number.isFinite(n) ? n : 0;
}

export async function setState(db: D1Database, key: string, value: string | number): Promise<void> {
	await db
		.prepare(
			`INSERT INTO scheduler_state (key, value, updated_at) VALUES (?, ?, ?)
			 ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
		)
		.bind(key, String(value), Date.now())
		.run();
}

export async function incrementState(db: D1Database, key: string, by = 1): Promise<void> {
	await db
		.prepare(
			`INSERT INTO scheduler_state (key, value, updated_at) VALUES (?, ?, ?)
			 ON CONFLICT(key) DO UPDATE SET value = CAST(CAST(value AS INTEGER) + excluded.value AS TEXT), updated_at = excluded.updated_at`
		)
		.bind(key, String(by), Date.now())
		.run();
}

export async function getAllState(db: D1Database): Promise<Record<string, string>> {
	const res = await db.prepare('SELECT key, value FROM scheduler_state').all<{ key: string; value: string }>();
	const out: Record<string, string> = {};
	for (const row of res.results) out[row.key] = row.value;
	return out;
}
