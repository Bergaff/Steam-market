/**
 * Worker 2 — detail scanner (TZ §6, воркер 2): buy orders for top-N items.
 *
 * Per queued item:
 *   1. If `item_nameid` is unknown — parse it once from the listing page HTML;
 *   2. GET itemordershistogram → highest buy order + order counts;
 *   3. GET priceoverview → volume_24h + median_price;
 *   4. Merge results into the latest snapshot (same scan cycle) or insert a new one.
 */

import type { RuntimeConfig } from '../config';
import type { SteamClient } from '../steam/client';
import { fetchItemNameid, fetchOrdersHistogram, fetchPriceOverview } from '../steam/endpoints';
import { nowMs } from '../lib/time';
import type { WorkBudget } from './budget';

/** Snapshots younger than this are enriched in-place instead of inserting new rows. */
const MERGE_WINDOW_MS = 15 * 60 * 1000;
/** Failed items are retried after this delay. */
const RETRY_DELAY_MS = 10 * 60 * 1000;
/** Items without an order book (no item_nameid) are re-checked rarely. */
const NO_ORDERBOOK_DELAY_MS = 6 * 60 * 60 * 1000;
/** Drop queue entries after this many failed attempts (until next list scan re-queues them). */
const MAX_ATTEMPTS = 4;

export interface DetailScanResult {
	processed: number;
	succeeded: number;
	failed: number;
	stoppedByBudget: boolean;
	error?: string;
}

interface QueueRow {
	item_id: number;
	appid: number;
	hash_name: string;
	item_nameid: number | null;
	attempts: number;
}

export async function processDetailQueue(
	db: D1Database,
	cfg: RuntimeConfig,
	client: SteamClient,
	budget: WorkBudget,
	limit: number
): Promise<DetailScanResult> {
	const result: DetailScanResult = { processed: 0, succeeded: 0, failed: 0, stoppedByBudget: false };

	const due = await db
		.prepare(
			`SELECT q.item_id, q.appid, i.hash_name, i.item_nameid, q.attempts
			 FROM scan_queue q
			 JOIN items i ON i.id = q.item_id
			 WHERE q.due_at <= ?
			 ORDER BY q.appid ASC, q.priority ASC
			 LIMIT ?`
		)
		.bind(nowMs(), limit)
		.all<QueueRow>();

	for (const row of due.results) {
		// Each item needs up to 3 Steam requests (nameid page, histogram, overview).
		if (!budget.canAfford(2)) {
			result.stoppedByBudget = true;
			break;
		}

		try {
			let nameid = row.item_nameid;

			// --- 1. item_nameid (one-time, cached on the item) -----------------
			if (nameid === null) {
				nameid = await fetchItemNameid(client, row.appid, row.hash_name, row.item_id);
				budget.consume();
				if (nameid !== null) {
					await db.prepare('UPDATE items SET item_nameid = ? WHERE id = ?').bind(nameid, row.item_id).run();
				} else {
					// No order book for this item — check again much later.
					await db
						.prepare('UPDATE scan_queue SET attempts = attempts + 1, due_at = ?, last_error = ? WHERE item_id = ?')
						.bind(nowMs() + NO_ORDERBOOK_DELAY_MS, 'item_nameid not found (no order book?)', row.item_id)
						.run();
					await db.prepare('DELETE FROM scan_queue WHERE item_id = ? AND attempts >= ?').bind(row.item_id, MAX_ATTEMPTS).run();
					result.processed++;
					result.failed++;
					continue;
				}
			}

			// --- 2. Order book: highest buy order -------------------------------
			const hist = await fetchOrdersHistogram(client, cfg, nameid, row.appid, row.item_id);
			budget.consume();

			// --- 3. priceoverview: volume + median ------------------------------
			let overview = null;
			if (budget.canRequest()) {
				overview = await fetchPriceOverview(client, cfg, row.appid, row.hash_name, row.item_id);
				budget.consume();
			}

			if (!hist && !overview) {
				throw new Error('both histogram and priceoverview returned nothing');
			}

			// --- 4. Merge into the latest snapshot or insert a new one ----------
			const ts = nowMs();
			const latest = await db
				.prepare(
					`SELECT id, snapshot_at FROM price_snapshots
					 WHERE item_id = ? ORDER BY snapshot_at DESC, id DESC LIMIT 1`
				)
				.bind(row.item_id)
				.first<{ id: number; snapshot_at: number }>();

			const buyCents = hist?.highestBuyCents ?? null;
			const sellCents = hist?.lowestSellCents ?? overview?.lowestPriceCents ?? null;

			if (latest && ts - latest.snapshot_at <= MERGE_WINDOW_MS) {
				await db
					.prepare(
						`UPDATE price_snapshots SET
						   buy_max_price    = COALESCE(?, buy_max_price),
						   buy_orders_count = COALESCE(?, buy_orders_count),
						   volume_24h       = COALESCE(?, volume_24h),
						   median_price     = COALESCE(?, median_price),
						   sell_min_price   = COALESCE(sell_min_price, ?),
						   source           = 'detail'
						 WHERE id = ?`
					)
					.bind(
						buyCents,
						hist?.buyOrdersCount ?? null,
						overview?.volume24h ?? null,
						overview?.medianPriceCents ?? null,
						sellCents,
						latest.id
					)
					.run();
			} else {
				await db
					.prepare(
						`INSERT INTO price_snapshots
						   (item_id, sell_min_price, sell_listings, buy_max_price, buy_orders_count, volume_24h, median_price, snapshot_at, source)
						 VALUES (?, ?, NULL, ?, ?, ?, ?, ?, 'detail')`
					)
					.bind(
						row.item_id,
						sellCents,
						buyCents,
						hist?.buyOrdersCount ?? null,
						overview?.volume24h ?? null,
						overview?.medianPriceCents ?? null,
						ts
					)
					.run();
			}

			await db.prepare('DELETE FROM scan_queue WHERE item_id = ?').bind(row.item_id).run();
			result.processed++;
			result.succeeded++;
		} catch (err) {
			if (err instanceof Error && err.name === 'RateLimitedError') {
				// Global pause is handled by the scheduler — stop processing.
				throw err;
			}
			result.processed++;
			result.failed++;
			const message = err instanceof Error ? err.message : String(err);
			await db
				.prepare('UPDATE scan_queue SET attempts = attempts + 1, due_at = ?, last_error = ? WHERE item_id = ?')
				.bind(nowMs() + RETRY_DELAY_MS, message.slice(0, 400), row.item_id)
				.run();
			await db.prepare('DELETE FROM scan_queue WHERE item_id = ? AND attempts >= ?').bind(row.item_id, MAX_ATTEMPTS).run();
		}
	}

	return result;
}

/**
 * Force-queue detail scans for the current top-N items of a game
 * (used by POST /admin/scan/{appid}).
 */
export async function enqueueTopItemsForDetails(db: D1Database, cfg: RuntimeConfig, appid: number): Promise<number> {
	const rows = await db
		.prepare(
			`SELECT v.item_id, COALESCE(v.sell_listings, 0) AS listings
			 FROM item_latest v
			 WHERE v.appid = ?
			 ORDER BY listings DESC, v.item_id ASC
			 LIMIT ?`
		)
		.bind(appid, cfg.scan.detailsTopN)
		.all<{ item_id: number; listings: number }>();

	const stmts = rows.results.map((r, idx) =>
		db
			.prepare(
				`INSERT INTO scan_queue (item_id, appid, priority, due_at, attempts)
				 VALUES (?, ?, ?, 0, 0)
				 ON CONFLICT(item_id) DO UPDATE SET priority = excluded.priority, due_at = 0, attempts = 0, last_error = NULL`
			)
			.bind(r.item_id, appid, idx + 1)
	);
	if (stmts.length > 0) await db.batch(stmts);
	return stmts.length;
}
