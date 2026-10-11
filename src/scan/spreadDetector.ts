/**
 * Worker 3 — spread detector (TZ §6, воркер 3). Runs every ~2 minutes.
 *
 * For every item with a fresh game scan AND fresh order-book data:
 *
 *   net_profit     = round(sell_min_price * 0.85) - buy_max_price
 *   net_profit_pct = net_profit / buy_max_price * 100
 *
 * Signal conditions (configurable):
 *   net_profit_pct >= MIN_SPREAD_PCT (10)
 *   volume_24h     >= MIN_VOLUME_24H (5)
 *   buy_max_price  >= MIN_BUY_PRICE_CENTS (500 = 5 RUB)
 *
 * Freshness (works with delta-compressed snapshots):
 *   - the item's game was successfully scanned within SNAPSHOT_MAX_AGE_MS;
 *   - the order book was verified within DETAIL_FRESH_MS (items that fell out
 *     of the top-N detail queue age out and their signals deactivate).
 *
 * Qualifying items are upserted into spread_opportunities (is_active=1);
 * previously active signals that no longer qualify are deactivated.
 */

import type { RuntimeConfig } from '../config';
import { chunk, nowMs } from '../lib/time';

export interface SpreadRunResult {
	runAt: number;
	candidates: number;
	qualifying: number;
	deactivated: number;
	durationMs: number;
}

interface CandidateRow {
	item_id: number;
	sell_min_price: number;
	buy_max_price: number;
	volume_24h: number | null;
}

/** Steam takes ~15% fee: seller receives 85% of the listing price. */
export const STEAM_FEE_FACTOR = 0.85;

export function computeNetProfit(sellCents: number, buyCents: number): { netCents: number; pct: number } {
	const netCents = Math.round(sellCents * STEAM_FEE_FACTOR) - buyCents;
	const pct = buyCents > 0 ? (netCents / buyCents) * 100 : 0;
	return { netCents, pct };
}

export async function detectSpreads(db: D1Database, cfg: RuntimeConfig): Promise<SpreadRunResult> {
	const runAt = nowMs();
	const started = Date.now();
	const gameFreshAfter = runAt - cfg.spread.snapshotMaxAgeMs;
	const detailFreshAfter = runAt - cfg.spread.detailFreshMs;

	const rows = await db
		.prepare(
			`SELECT s.item_id, s.sell_min_price, s.buy_max_price, s.volume_24h
			 FROM item_latest_state s
			 JOIN games g ON g.appid = s.appid
			 WHERE g.is_active = 1
			   AND g.last_scan_at IS NOT NULL AND g.last_scan_at >= ?
			   AND s.detail_at IS NOT NULL AND s.detail_at >= ?
			   AND s.sell_min_price IS NOT NULL
			   AND s.buy_max_price IS NOT NULL
			   AND s.buy_max_price > 0
			   AND s.buy_max_price >= ?`
		)
		.bind(gameFreshAfter, detailFreshAfter, cfg.spread.minBuyPriceCents)
		.all<CandidateRow>();

	const qualifying: { itemId: number; buy: number; sell: number; net: number; pct: number; volume: number | null }[] = [];

	for (const r of rows.results) {
		const { netCents, pct } = computeNetProfit(r.sell_min_price, r.buy_max_price);
		const volume = r.volume_24h ?? 0;
		if (netCents > 0 && pct >= cfg.spread.minProfitPct && volume >= cfg.spread.minVolume24h) {
			qualifying.push({ itemId: r.item_id, buy: r.buy_max_price, sell: r.sell_min_price, net: netCents, pct, volume: r.volume_24h });
		}
	}

	// Upsert qualifying signals.
	for (const part of chunk(qualifying, 60)) {
		const stmts = part.map((q) =>
			db
				.prepare(
					`INSERT INTO spread_opportunities
					   (item_id, buy_price, sell_price, net_profit, net_profit_pct, volume_24h, detected_at, updated_at, last_confirmed_at, is_active)
					 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
					 ON CONFLICT(item_id) DO UPDATE SET
					   buy_price         = excluded.buy_price,
					   sell_price        = excluded.sell_price,
					   net_profit        = excluded.net_profit,
					   net_profit_pct    = excluded.net_profit_pct,
					   volume_24h        = excluded.volume_24h,
					   updated_at        = excluded.updated_at,
					   last_confirmed_at = excluded.last_confirmed_at,
					   is_active         = 1`
				)
				.bind(q.itemId, q.buy, q.sell, q.net, q.pct, q.volume, runAt, runAt, runAt)
		);
		await db.batch(stmts);
	}

	// Deactivate signals that did not qualify in THIS run.
	const deact = await db
		.prepare(
			`UPDATE spread_opportunities SET is_active = 0
			 WHERE is_active = 1 AND (last_confirmed_at IS NULL OR last_confirmed_at < ?)`
		)
		.bind(runAt)
		.run();

	return {
		runAt,
		candidates: rows.results.length,
		qualifying: qualifying.length,
		deactivated: deact.meta.changes ?? 0,
		durationMs: Date.now() - started,
	};
}
