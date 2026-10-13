/**
 * Compact scheduler history used by the browser diagnostics report.
 * The table is also created lazily so an existing production D1 starts logging
 * immediately after the Worker deploys, without a manual console migration.
 */

export const TICK_LOG_CREATE_TABLE = `CREATE TABLE IF NOT EXISTS scheduler_tick_log (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at     INTEGER NOT NULL,
  mode           TEXT NOT NULL,
  skipped        TEXT,
  steam_requests INTEGER NOT NULL DEFAULT 0,
  steam_errors   INTEGER NOT NULL DEFAULT 0,
  duration_ms    INTEGER NOT NULL DEFAULT 0,
  error          TEXT,
  summary_json   TEXT NOT NULL
)`;

export const TICK_LOG_CREATE_INDEX =
	'CREATE INDEX IF NOT EXISTS idx_scheduler_tick_log_started ON scheduler_tick_log(started_at DESC)';

export interface SchedulerTickLogEntry {
	startedAt: number;
	mode: string;
	skipped: string | null;
	steamRequests: number;
	steamErrors: number;
	durationMs: number;
	error: string | null;
	summary: object;
}

let schemaReady = false;
let schemaPromise: Promise<void> | null = null;
let prunedUtcDay = -1;

/** Idempotent lazy schema setup; safe to call from cron and the diagnostics API. */
export async function ensureTickLogSchema(db: D1Database): Promise<void> {
	if (schemaReady) return;
	if (!schemaPromise) {
		schemaPromise = (async () => {
			await db.prepare(TICK_LOG_CREATE_TABLE).run();
			await db.prepare(TICK_LOG_CREATE_INDEX).run();
			schemaReady = true;
		})();
	}
	try {
		await schemaPromise;
	} finally {
		if (!schemaReady) schemaPromise = null;
	}
}

/** Persist one compact cron invocation; diagnostics failures never stop scans. */
export async function recordSchedulerTick(db: D1Database, entry: SchedulerTickLogEntry): Promise<void> {
	try {
		await ensureTickLogSchema(db);
		await db
			.prepare(
				`INSERT INTO scheduler_tick_log
				   (started_at, mode, skipped, steam_requests, steam_errors, duration_ms, error, summary_json)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
			)
			.bind(
				entry.startedAt,
				entry.mode,
				entry.skipped,
				entry.steamRequests,
				entry.steamErrors,
				entry.durationMs,
				entry.error?.slice(0, 500) ?? null,
				JSON.stringify(entry.summary)
			)
			.run();

		// Keep a week of history. Prune once per UTC day per isolate; this is
		// also safe if the isolate is restarted because DELETE is idempotent.
		const utcDay = Math.floor(entry.startedAt / 86_400_000);
		if (utcDay !== prunedUtcDay) {
			await db.prepare('DELETE FROM scheduler_tick_log WHERE started_at < ?').bind(entry.startedAt - 7 * 86_400_000).run();
			prunedUtcDay = utcDay;
		}
	} catch (err) {
		console.error('[diagnostics] scheduler tick was not persisted:', err instanceof Error ? err.message : String(err));
	}
}
