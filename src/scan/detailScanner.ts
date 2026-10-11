/**
 * Worker 2 — detail scanner (TZ §6, воркер 2): buy orders for top-N items.
 *
 * Per queued item:
 *   1. If `item_nameid` is unknown — parse it once from the listing page HTML;
 *   2. GET itemordershistogram → highest buy order + order counts;
 *   3. GET priceoverview → volume_24h + median_price;
 *   4. Write ONLY when the order book actually moved (delta compression) or
 *      the heartbeat passed: merge into the latest snapshot / insert a new one
 *      + refresh `item_latest_state`. Otherwise just touch `detail_at` (so the
 *      spread detector knows the data is still being verified).
 */

import type { RuntimeConfig } from '../config';
import type { SteamClient } from '../steam/client';
import { fetchItemNameid, fetchOrdersHistogram, fetchPriceOverview } from '../steam/endpoints';
import { chunk, nowMs } from '../lib/time';
import type { WorkBudget } from './budget';
import { needsDetailWrite } from './delta';
import { upsertStateDetail, touchDetailAt, type LatestStateRow } from '../db/latestState';

/** Snapshots younger than this are enriched in-place instead of inserting new rows. */
const MERGE_WINDOW_MS = 15 * 60 * 1000;
/** Failed items are retried after this delay. */
const RETRY_DELAY_MS = 10 * 60 * 1000;
/** Items without an order book (no item_nameid) are re-checked rarely. */
const NO_ORDERBOOK_DELAY_MS = 6 * 60 * 60 * 1000;
/** Drop queue entries after this many failed attempts. */
const MAX_ATTEMPTS = 4;
/** Touch `detail_at` at most this often when values did not move. */
const DETAIL_TOUCH_MIN_INTERVAL_MS = 2 * 60 * 60 * 1000;

export interface DetailScanResult {
	processed: number;
	succeeded: number;
	failed: number;
	written: number;
	skippedUnchanged: number;
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
	const result: DetailScanResult = {
		processed: 0,
		succeeded: 0,
		failed: 0,
		written: 0,
		skippedUnchanged: 0,
		stoppedByBudget: false,
	};

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

			const ts = nowMs();
			const buyCents = hist?.highestBuyCents ?? null;
			const sellCents = hist?.lowestSellCents ?? overview?.lowestPriceCents ?? null;
			const volume = overview?.volume24h ?? null;
			const median = overview?.medianPriceCents ?? null;

			// --- 4. Delta gate: write only when the order book moved ------------
			const state = await db
				.prepare(
					`SELECT item_id, appid, sell_min_price, sell_listings, buy_max_price, buy_orders_count,
					        volume_24h, median_price, snapshot_at, detail_at, source, updated_at
					 FROM item_latest_state WHERE item_id = ?`
				)
				.bind(row.item_id)
				.first<LatestStateRow>();

			const shouldWrite = needsDetailWrite(
				state
					? {
							snapshot_at: state.snapshot_at,
							sell_min_price: state.sell_min_price,
							sell_listings: state.sell_listings,
							buy_max_price: state.buy_max_price,
							volume_24h: state.volume_24h,
						}
					: null,
				{ buyCents, volume24h: volume, medianCents: median },
				ts,
				cfg.scan.snapshotHeartbeatMs
			);

			if (!shouldWrite) {
				result.skippedUnchanged++;
				// Keep the detector's freshness window honest with a cheap touch.
				if (!state || state.detail_at === null || ts - state.detail_at >= DETAIL_TOUCH_MIN_INTERVAL_MS) {
					await touchDetailAt(db, row.item_id, ts).run();
				}
			} else {
				const latest = await db
					.prepare(
						`SELECT id, snapshot_at FROM price_snapshots
						 WHERE item_id = ? ORDER BY snapshot_at DESC, id DESC LIMIT 1`
					)
					.bind(row.item_id)
					.first<{ id: number; snapshot_at: number }>();

				const stmts: D1PreparedStatement[] = [];
				if (latest && ts - latest.snapshot_at <= MERGE_WINDOW_MS) {
					stmts.push(
						db
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
							.bind(buyCents, hist?.buyOrdersCount ?? null, volume, median, sellCents, latest.id)
					);
				} else {
					stmts.push(
						db
							.prepare(
								`INSERT INTO price_snapshots
								   (item_id, sell_min_price, sell_listings, buy_max_price, buy_orders_count, volume_24h, median_price, snapshot_at, source)
								 VALUES (?, ?, NULL, ?, ?, ?, ?, ?, 'detail')`
							)
							.bind(row.item_id, sellCents, buyCents, hist?.buyOrdersCount ?? null, volume, median, ts)
					);
				}
				stmts.push(upsertStateDetail(db, row.item_id, row.appid, buyCents, hist?.buyOrdersCount ?? null, volume, median, sellCents, ts));
				await db.batch(stmts);
				result.written++;
			}

			await db.prepare('DELETE FROM scan_queue WHERE item_id = ?').bind(row.item_id).run();
			result.processed++;
			result.succeeded++;
		} catch (err) {
			if (err instanceof Error && err.name === 'RateLimitedError') {
				throw err; // global pause is handled by the scheduler
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
			`SELECT s.item_id, COALESCE(s.sell_listings, 0) AS listings
			 FROM item_latest_state s
			 WHERE s.appid = ?
			 ORDER BY listings DESC, s.item_id ASC
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
	for (const part of chunk(stmts, 90)) {
		await db.batch(part);
	}
	return stmts.length;
}
