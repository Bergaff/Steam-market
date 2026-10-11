/**
 * Creates a SteamClient wired to persistent logging (scan_log table)
 * and lifetime counters in scheduler_state.
 */

import { SteamClient } from '../steam/client';
import type { RuntimeConfig } from '../config';
import { STATE_KEYS, incrementState } from '../db/state';

export function createSteamClient(db: D1Database, cfg: RuntimeConfig): SteamClient {
	return new SteamClient(cfg, async (entry) => {
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

		await incrementState(db, STATE_KEYS.totalSteamRequests, 1);
		if (!entry.ok) await incrementState(db, STATE_KEYS.totalSteamErrors, 1);
	});
}
