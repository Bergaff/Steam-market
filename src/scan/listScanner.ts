/**
 * Worker 1 — game list scanner (TZ §6, воркер 1) + D1 write optimization.
 *
 * For one game:
 *   1. GET market/search/render (count=100, paginated up to SCAN_PAGES_PER_GAME);
 *   2. INSERT new items into `items`; UPDATE existing ones only when name/icon
 *      changed or `last_seen` is stale (>6h) — avoids a write per item per scan;
 *   3. INSERT a price snapshot + refresh `item_latest_state` ONLY when values
 *      actually moved (delta compression) or the heartbeat window passed —
 *      this is what keeps us inside the D1 free tier (100k writes/day);
 *   4. Queue top-N items (by sell_listings) into `scan_queue` for worker 2
 *      (INSERT OR IGNORE — no queue churn writes on stable top lists).
 */

import type { RuntimeConfig } from '../config';
import type { SteamClient } from '../steam/client';
import { fetchSearchRender } from '../steam/endpoints';
import type { ParsedMarketItem } from '../steam/parse';
import { chunk, nowMs } from '../lib/time';
import type { WorkBudget } from './budget';
import { needsSnapshot } from './delta';
import { upsertStateList } from '../db/latestState';

export interface GameRow {
	id: number;
	appid: number;
	name: string;
	tier: number;
	scan_interval_sec: number;
	is_active: number;
	next_scan_at: number;
	last_scan_at: number | null;
	last_scan_status: string | null;
}

export interface ListScanResult {
	appid: number;
	status: 'ok' | 'partial' | 'error' | 'rate_limited';
	pagesFetched: number;
	itemsSeen: number;
	itemsInserted: number;
	itemsUpdated: number;
	snapshotsInserted: number;
	snapshotsSkipped: number;
	totalCount: number;
	queuedForDetails: number;
	error?: string;
}

const D1_BATCH_LIMIT = 90; // D1 allows up to 100 statements per batch
const IN_CLAUSE_LIMIT = 30; // keep bound params per statement well under D1 limits
/** Refresh `items.last_seen` at most this often (write saving). */
const LAST_SEEN_REFRESH_MS = 6 * 60 * 60 * 1000;

interface ExistingItemRow {
	id: number;
	hash_name: string;
	name: string;
	icon_url: string | null;
	last_seen: number;
}

interface StateRow {
	item_id: number;
	snapshot_at: number | null;
	sell_min_price: number | null;
	sell_listings: number | null;
}

export async function scanGameList(
	db: D1Database,
	cfg: RuntimeConfig,
	client: SteamClient,
	game: GameRow,
	budget: WorkBudget
): Promise<ListScanResult> {
	const ts = nowMs();
	const perPage = cfg.scan.itemsPerPage;
	let start = 0;
	let pagesFetched = 0;
	let itemsSeen = 0;
	let itemsInserted = 0;
	let itemsUpdated = 0;
	let snapshotsInserted = 0;
	let snapshotsSkipped = 0;
	let totalCount = 0;
	let stoppedByBudget = false;
	const scanned: { itemId: number; sellListings: number }[] = [];

	const result: ListScanResult = {
		appid: game.appid,
		status: 'ok',
		pagesFetched,
		itemsSeen,
		itemsInserted,
		itemsUpdated,
		snapshotsInserted,
		snapshotsSkipped,
		totalCount,
		queuedForDetails: 0,
	};

	try {
		for (let page = 0; page < cfg.scan.pagesPerGame; page++) {
			if (!budget.canRequest()) {
				stoppedByBudget = true;
				break;
			}

			const data = await fetchSearchRender(client, cfg, game.appid, start, perPage);
			budget.consume();
			pagesFetched++;
			totalCount = data.totalCount;

			if (data.items.length === 0) break;
			itemsSeen += data.items.length;

			const idMap = await syncItems(db, game.appid, data.items, ts, (ins, upd) => {
				itemsInserted += ins;
				itemsUpdated += upd;
			});

			// --- delta check against the last known state ----------------------
			const itemIds = [...idMap.values()];
			const stateMap = new Map<number, StateRow>();
			for (const part of chunk(itemIds, IN_CLAUSE_LIMIT)) {
				const placeholders = part.map(() => '?').join(', ');
				const rows = await db
					.prepare(
						`SELECT item_id, snapshot_at, sell_min_price, sell_listings
						 FROM item_latest_state WHERE item_id IN (${placeholders})`
					)
					.bind(...part)
					.all<StateRow>();
				for (const row of rows.results) stateMap.set(row.item_id, row);
			}

			// --- write snapshot + state only for moved items -------------------
			const writeStmts: D1PreparedStatement[] = [];
			for (const it of data.items) {
				const itemId = idMap.get(it.hashName);
				if (itemId === undefined) continue;
				scanned.push({ itemId, sellListings: it.sellListings });

				const prev = stateMap.get(itemId);
				const next = { sellPriceCents: it.sellPriceCents, sellListings: it.sellListings };
				if (!needsSnapshot(prev, next, ts, cfg.scan.snapshotHeartbeatMs)) {
					snapshotsSkipped++;
					continue;
				}

				writeStmts.push(
					db
						.prepare(
							`INSERT INTO price_snapshots (item_id, sell_min_price, sell_listings, snapshot_at, source)
							 VALUES (?, ?, ?, ?, 'list')`
						)
						.bind(itemId, it.sellPriceCents, it.sellListings, ts)
				);
				writeStmts.push(upsertStateList(db, itemId, game.appid, it.sellPriceCents, it.sellListings, ts));
				snapshotsInserted++;
			}
			for (const part of chunk(writeStmts, D1_BATCH_LIMIT)) {
				await db.batch(part);
			}

			start += data.items.length;
			if (totalCount > 0 && start >= totalCount) break;
		}

		// --- game bookkeeping ---------------------------------------------------
		const complete = totalCount > 0 && start >= totalCount;
		const status: ListScanResult['status'] = pagesFetched === 0 ? 'error' : complete ? 'ok' : 'partial';
		const nextDelayMs =
			status === 'error' ? Math.min(game.scan_interval_sec * 1000, 5 * 60 * 1000) : game.scan_interval_sec * 1000;
		await db
			.prepare('UPDATE games SET last_scan_at = ?, last_scan_status = ?, next_scan_at = ? WHERE appid = ?')
			.bind(pagesFetched > 0 ? ts : null, status, ts + nextDelayMs, game.appid)
			.run();

		// --- queue top-N by current sell_listings (INSERT OR IGNORE) -------------
		if (scanned.length > 0) {
			scanned.sort((a, b) => b.sellListings - a.sellListings);
			const top = scanned.slice(0, cfg.scan.detailsTopN);
			const queueStmts = top.map((s, idx) =>
				db
					.prepare(
						`INSERT OR IGNORE INTO scan_queue (item_id, appid, priority, due_at, attempts)
						 VALUES (?, ?, ?, 0, 0)`
					)
					.bind(s.itemId, game.appid, idx + 1)
			);
			for (const part of chunk(queueStmts, D1_BATCH_LIMIT)) {
				await db.batch(part);
			}
			result.queuedForDetails = top.length;
		}

		result.status = stoppedByBudget && status === 'ok' ? 'partial' : status;
		result.pagesFetched = pagesFetched;
		result.itemsSeen = itemsSeen;
		result.itemsInserted = itemsInserted;
		result.itemsUpdated = itemsUpdated;
		result.snapshotsInserted = snapshotsInserted;
		result.snapshotsSkipped = snapshotsSkipped;
		result.totalCount = totalCount;
		return result;
	} catch (err) {
		const isRateLimit = err instanceof Error && err.name === 'RateLimitedError';
		if (isRateLimit) {
			const retryAfterMs = (err as { retryAfterMs?: number }).retryAfterMs ?? cfg.rateLimitResponse.retryAfterMs;
			await db
				.prepare('UPDATE games SET last_scan_status = ?, next_scan_at = ? WHERE appid = ?')
				.bind('rate_limited', ts + retryAfterMs, game.appid)
				.run();
		} else {
			const nextDelayMs = Math.min(game.scan_interval_sec * 1000, 5 * 60 * 1000);
			await db
				.prepare('UPDATE games SET last_scan_status = ?, next_scan_at = ? WHERE appid = ?')
				.bind('error', ts + nextDelayMs, game.appid)
				.run();
		}
		result.status = isRateLimit ? 'rate_limited' : 'error';
		result.error = err instanceof Error ? err.message : String(err);
		result.pagesFetched = pagesFetched;
		result.itemsSeen = itemsSeen;
		result.itemsInserted = itemsInserted;
		result.itemsUpdated = itemsUpdated;
		result.snapshotsInserted = snapshotsInserted;
		result.snapshotsSkipped = snapshotsSkipped;
		result.totalCount = totalCount;
		if (isRateLimit) throw err; // scheduler handles the global pause
		return result;
	}
}

/**
 * Sync one page of market items into `items`:
 *  - INSERT only new rows (ids come from batch results' last_row_id);
 *  - UPDATE only rows whose name/icon changed or whose last_seen is stale.
 * Returns hash_name → item id map.
 */
async function syncItems(
	db: D1Database,
	appid: number,
	items: ParsedMarketItem[],
	ts: number,
	counters: (inserted: number, updated: number) => void
): Promise<Map<string, number>> {
	const idMap = new Map<string, number>();

	// 1. Load existing rows for this page.
	const existing = new Map<string, ExistingItemRow>();
	const hashNames = items.map((it) => it.hashName);
	for (const part of chunk(hashNames, IN_CLAUSE_LIMIT)) {
		const placeholders = part.map(() => '?').join(', ');
		const rows = await db
			.prepare(`SELECT id, hash_name, name, icon_url, last_seen FROM items WHERE appid = ? AND hash_name IN (${placeholders})`)
			.bind(appid, ...part)
			.all<ExistingItemRow>();
		for (const row of rows.results) {
			existing.set(row.hash_name, row);
			idMap.set(row.hash_name, row.id);
		}
	}

	// 2. INSERT new items (batch results keep statement order → last_row_id).
	const newItems = items.filter((it) => !existing.has(it.hashName));
	for (const part of chunk(newItems, 40)) {
		const stmts = part.map((it) =>
			db
				.prepare(
					`INSERT INTO items (appid, hash_name, name, icon_url, first_seen, last_seen)
					 VALUES (?, ?, ?, ?, ?, ?)`
				)
				.bind(appid, it.hashName, it.name, it.iconUrl, ts, ts)
		);
		const results = await db.batch(stmts);
		results.forEach((res, idx) => {
			const rowId = res.meta.last_row_id;
			if (rowId) idMap.set(part[idx]!.hashName, Number(rowId));
		});
	}
	counters(newItems.length, 0);

	// 3. UPDATE changed / stale items only.
	const updateStmts: D1PreparedStatement[] = [];
	for (const it of items) {
		const row = existing.get(it.hashName);
		if (!row) continue;
		const nameChanged = row.name !== it.name;
		const iconChanged = it.iconUrl !== null && row.icon_url !== it.iconUrl;
		const staleLastSeen = ts - row.last_seen >= LAST_SEEN_REFRESH_MS;
		if (!nameChanged && !iconChanged && !staleLastSeen) continue;
		updateStmts.push(
			db
				.prepare('UPDATE items SET name = ?, icon_url = COALESCE(?, icon_url), last_seen = ? WHERE id = ?')
				.bind(it.name, iconChanged ? it.iconUrl : null, ts, row.id)
		);
	}
	for (const part of chunk(updateStmts, D1_BATCH_LIMIT)) {
		await db.batch(part);
	}
	counters(0, updateStmts.length);

	return idMap;
}

/** Pick games that are due for a list scan (lowest tier first, oldest first). */
export async function pickDueGames(db: D1Database, limit: number, now = nowMs()): Promise<GameRow[]> {
	const rows = await db
		.prepare(
			`SELECT id, appid, name, tier, scan_interval_sec, is_active, next_scan_at, last_scan_at, last_scan_status
			 FROM games
			 WHERE is_active = 1 AND next_scan_at <= ?
			 ORDER BY tier ASC, next_scan_at ASC, appid ASC
			 LIMIT ?`
		)
		.bind(now, limit)
		.all<GameRow>();
	return rows.results;
}
