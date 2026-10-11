/**
 * Creates a SteamClient wired to persistent logging (scan_log table).
 *
 * D1 write saving: errors are logged ALWAYS; successful requests are logged
 * with 1/N sampling (LOG_SUCCESS_SAMPLE_N, default 10). Lifetime counters are
 * flushed once per scheduler tick (see scheduler.ts), not per request.
 */

import { SteamClient } from '../steam/client';
import type { RuntimeConfig } from '../config';

export function createSteamClient(db: D1Database, cfg: RuntimeConfig): SteamClient {
	let successCount = 0;

	return new SteamClient(cfg, async (entry) => {
		if (entry.ok) {
			successCount++;
			const n = cfg.logging.successSampleN;
			if (n > 1 && successCount % n !== 1) return; // sample successful requests
		}

		await db
			.prepare(
				`INSERT INTO scan_log (endpoint, appid, item_id, url, status, duration_ms, ok, error, created_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
			)
			.bind(
				entry.endpoint,
				entry.appid,
				entry.itemId,
				entry.url,
				entry.status,
				entry.durationMs,
				entry.ok ? 1 : 0,
				entry.error,
				Date.now()
			)
			.run();
	});
}
