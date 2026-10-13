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
import { isWrongCurrency, steamCurrencyToIso } from '../steam/parse';
import { chunk, nowMs } from '../lib/time';
import type { WorkBudget } from './budget';
import { needsDetailWrite } from './delta';
import { upsertStateDetail, touchDetailAt, type LatestStateRow } from '../db/latestState';

/** Snapshots younger than this are enriched in-place instead of inserting new rows. */
const MERGE_WINDOW_MS = 15 * 60 * 1000;
/** Failed items are retried after this delay. */
const RETRY_DELAY_MS = 10 * 60 * 1000;
/** Long backoff for items without an order book or repeatedly missing volume. */
const LONG_RETRY_DELAY_MS = 6 * 60 * 60 * 1000;
/** Switch repeated failures/missing-volume retries to a long cooldown. */
const MAX_ATTEMPTS = 4;
/** Touch `detail_at` at most this often when values did not move. */
const DETAIL_TOUCH_MIN_INTERVAL_MS = 2 * 60 * 60 * 1000;

export interface DetailScanResult {
	processed: number;
	succeeded: number;
	failed: number;
	written: number;
	skippedUnchanged: number;
	/** Items whose Steam response arrived in a currency other than configured. */
	currencyMismatches: number;
	/** Items for which priceoverview supplied a parseable 24h volume. */
	volumeRetrieved: number;
	/** Detail attempts completed without a parseable priceoverview volume. */
	volumeMissing: number;
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
		currencyMismatches: 0,
		volumeRetrieved: 0,
		volumeMissing: 0,
		stoppedByBudget: false,
	};

	const expectedIso = steamCurrencyToIso(cfg.steam.currency);

	const due = await db
		.prepare(
			`SELECT q.item_id, q.appid, i.hash_name, i.item_nameid, q.attempts
			 FROM scan_queue q
			 JOIN items i ON i.id = q.item_id
			 WHERE q.due_at <= ?
			 ORDER BY q.due_at ASC, q.priority ASC, q.appid ASC, q.item_id ASC
			 LIMIT ?`
		)
		.bind(nowMs(), limit)
		.all<QueueRow>();

	for (const row of due.results) {
		// Reserve every request needed to finish the item, including priceoverview
		// (the source of volume); never spend the last slot on nameid/histogram
		// and then silently finish without fetching volume.
		const requiredRequests = row.item_nameid === null ? 3 : 2;
		if (!budget.canAfford(requiredRequests)) {
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
						.bind(nowMs() + LONG_RETRY_DELAY_MS, 'item_nameid not found (no order book?)', row.item_id)
						.run();
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

			// --- currency guard (see listScanner): never mix currencies ----------
			// A USD buy order against a RUB sell price (or vice versa) makes the
			// spread formula produce garbage. Retry the item much later; this is
			// a configuration problem, so attempts are not burned.
			const detectedCur = hist?.currency ?? overview?.currency ?? null;
			if (isWrongCurrency(detectedCur, expectedIso)) {
				result.processed++;
				result.currencyMismatches++;
				await db
					.prepare('UPDATE scan_queue SET due_at = ?, last_error = ? WHERE item_id = ?')
					.bind(nowMs() + LONG_RETRY_DELAY_MS, `currency mismatch: got ${detectedCur}, expected ${expectedIso}`, row.item_id)
					.run();
				continue;
			}

			const ts = nowMs();
			const buyCents = hist?.highestBuyCents ?? null;
			const sellCents = hist?.lowestSellCents ?? overview?.lowestPriceCents ?? null;
			const volume = overview?.volume24h ?? null;
			if (volume !== null) result.volumeRetrieved++;
			else result.volumeMissing++;
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

			if (volume === null) {
				// A successful histogram alone is not enough: keep retrying the
				// priceoverview source of volume instead of marking this item fresh.
				const nextAttempt = row.attempts + 1;
				const retryDelay = nextAttempt >= MAX_ATTEMPTS ? LONG_RETRY_DELAY_MS : RETRY_DELAY_MS;
				await db
					.prepare('UPDATE scan_queue SET attempts = ?, due_at = ?, last_error = ? WHERE item_id = ?')
					.bind(nextAttempt, nowMs() + retryDelay, 'priceoverview volume missing', row.item_id)
					.run();
			} else {
				await db.prepare('DELETE FROM scan_queue WHERE item_id = ?').bind(row.item_id).run();
			}
			result.processed++;
			result.succeeded++;
		} catch (err) {
			if (err instanceof Error && err.name === 'RateLimitedError') {
				throw err; // global pause is handled by the scheduler
			}
			result.processed++;
			result.failed++;
			const message = err instanceof Error ? err.message : String(err);
			const nextAttempt = row.attempts + 1;
			const retryDelay = nextAttempt >= MAX_ATTEMPTS ? LONG_RETRY_DELAY_MS : RETRY_DELAY_MS;
			await db
				.prepare('UPDATE scan_queue SET attempts = ?, due_at = ?, last_error = ? WHERE item_id = ?')
				.bind(nextAttempt, nowMs() + retryDelay, message.slice(0, 400), row.item_id)
				.run();
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
