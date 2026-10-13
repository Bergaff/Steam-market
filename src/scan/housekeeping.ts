/**
 * Retention cleanup: keeps the D1 database small and fast.
 *  - price_snapshots older than RETENTION_DAYS are deleted
 *    (30d charts need ~35 days of history);
 *  - scan_log older than 14 days is deleted;
 *  - inactive opportunities older than 30 days are deleted.
 */

import type { RuntimeConfig } from '../config';
import { nowMs } from '../lib/time';

export interface HousekeepingResult {
	snapshotsDeleted: number;
	logsDeleted: number;
	opportunitiesDeleted: number;
	durationMs: number;
}

export async function runHousekeeping(db: D1Database, cfg: RuntimeConfig): Promise<HousekeepingResult> {
	const started = Date.now();
	const now = nowMs();
	const dayMs = 24 * 60 * 60 * 1000;

	const snapshotCutoff = now - cfg.maintenance.retentionDays * dayMs;
	const logCutoff = now - Math.min(14, cfg.maintenance.retentionDays) * dayMs;
	const oppCutoff = now - 30 * dayMs;

	const [snapshots, logs, opps] = await db.batch([
		db.prepare('DELETE FROM price_snapshots WHERE snapshot_at < ?').bind(snapshotCutoff),
		db.prepare('DELETE FROM scan_log WHERE created_at < ?').bind(logCutoff),
		db.prepare('DELETE FROM spread_opportunities WHERE is_active = 0 AND updated_at < ?').bind(oppCutoff),
	]);

	return {
		snapshotsDeleted: snapshots.meta.changes ?? 0,
		logsDeleted: logs.meta.changes ?? 0,
		opportunitiesDeleted: opps.meta.changes ?? 0,
		durationMs: Date.now() - started,
	};
}
