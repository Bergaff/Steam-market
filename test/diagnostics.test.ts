import { describe, expect, it } from 'vitest';
import { aggregateTickHistory } from '../src/routes/diagnostics';

describe('aggregateTickHistory', () => {
	it('builds hourly totals and preserves per-app detail counters', () => {
		const startedAt = Date.UTC(2026, 9, 13, 9, 15);
		const rows = [
			{
				started_at: startedAt,
				mode: 'live',
				skipped: null,
				steam_requests: 8,
				steam_errors: 1,
				duration_ms: 45_000,
				error: null,
				summary_json: JSON.stringify({
					games: [{ appid: 440, status: 'partial' }],
					details: {
						processed: 2,
						ok: 2,
						failed: 0,
						nameidMissing: 1,
						volumeRetrieved: 2,
						volumeMissing: 0,
						byAppid: {
							'440': { processed: 1, succeeded: 1, failed: 0, nameidMissing: 1, volumeRetrieved: 1, volumeMissing: 0 },
						},
					},
					spread: { active: 1, off: 0 },
				}),
			},
			{
				started_at: startedAt + 10 * 60_000,
				mode: 'live',
				skipped: 'locked',
				steam_requests: 0,
				steam_errors: 0,
				duration_ms: 2,
				error: null,
				summary_json: JSON.stringify({ skipped: 'locked', games: [] }),
			},
		];

		const result = aggregateTickHistory(rows);
		expect(result).toHaveLength(1);
		expect(result[0]).toMatchObject({
			ticks: 2,
			completed_ticks: 1,
			skipped_locked: 1,
			steam_requests: 8,
			steam_errors: 1,
			games_scanned: 1,
			partial_game_scans: 1,
			details_processed: 2,
			nameid_missing: 1,
			volume_retrieved: 2,
			spread_qualifying: 1,
		});
		expect(result[0]!.by_appid['440']).toMatchObject({ processed: 1, nameid_missing: 1, volume_retrieved: 1 });
	});
});
