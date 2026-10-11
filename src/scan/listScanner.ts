/**
 * Worker 1 — game list scanner (TZ §6, воркер 1).
 *
 * For one game:
 *   1. GET market/search/render (count=100, paginated up to SCAN_PAGES_PER_GAME);
 *   2. UPSERT each item into `items` (by appid + hash_name);
 *   3. INSERT current sell_min_price / sell_listings into `price_snapshots`;
 *   4. Queue top-N items (by sell_listings) into `scan_queue` for worker 2.
 */

import type { RuntimeConfig } from '../config';
import type { SteamClient, RateLimitedError as RLE } from '../steam/client';
import { fetchSearchRender } from '../steam/endpoints';
import { chunk, nowMs } from '../lib/time';
import type { WorkBudget } from './budget';

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
	itemsUpserted: number;
	snapshotsInserted: number;
	totalCount: number;
	queuedForDetails: number;
	error?: string;
}

const D1_BATCH_LIMIT = 90; // D1 allows up to 100 statements per batch
const IN_CLAUSE_LIMIT = 40; // D1 allows up to ~100 bound params per statement

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
	let itemsUpserted = 0;
	let snapshotsInserted = 0;
	let totalCount = 0;
	let stoppedByBudget = false;
	const scanned: { itemId: number; sellListings: number }[] = [];

	const result: ListScanResult = {
		appid: game.appid,
		status: 'ok',
		pagesFetched,
		itemsUpserted,
		snapshotsInserted,
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

			// --- 1. UPSERT items ------------------------------------------------
			const upserts = data.items.map((it) =>
				db
					.prepare(
						`INSERT INTO items (appid, hash_name, name, icon_url, first_seen, last_seen)
						 VALUES (?, ?, ?, ?, ?, ?)
						 ON CONFLICT(appid, hash_name) DO UPDATE SET
						   name     = excluded.name,
						   icon_url = COALESCE(excluded.icon_url, items.icon_url),
						   last_seen = excluded.last_seen`
					)
					.bind(game.appid, it.hashName, it.name, it.iconUrl, ts, ts)
			);
			for (const part of chunk(upserts, D1_BATCH_LIMIT)) {
				await db.batch(part);
			}

			// --- 2. Resolve item ids -------------------------------------------
			const idMap = new Map<string, number>();
			const hashNames = data.items.map((it) => it.hashName);
			for (const part of chunk(hashNames, IN_CLAUSE_LIMIT)) {
				const placeholders = part.map(() => '?').join(', ');
				const rows = await db
					.prepare(`SELECT id, hash_name FROM items WHERE appid = ? AND hash_name IN (${placeholders})`)
					.bind(game.appid, ...part)
					.all<{ id: number; hash_name: string }>();
				for (const row of rows.results) idMap.set(row.hash_name, row.id);
			}

			// --- 3. INSERT snapshots -------------------------------------------
			const snapshotStmts: D1PreparedStatement[] = [];
			for (const it of data.items) {
				const itemId = idMap.get(it.hashName);
				if (itemId === undefined) continue;
				snapshotStmts.push(
					db
						.prepare(
							`INSERT INTO price_snapshots (item_id, sell_min_price, sell_listings, snapshot_at, source)
							 VALUES (?, ?, ?, ?, 'list')`
						)
						.bind(itemId, it.sellPriceCents, it.sellListings, ts)
				);
				scanned.push({ itemId, sellListings: it.sellListings });
			}
			for (const part of chunk(snapshotStmts, D1_BATCH_LIMIT)) {
				await db.batch(part);
			}

			itemsUpserted += data.items.length;
			snapshotsInserted += snapshotStmts.length;
			start += data.items.length;

			if (totalCount > 0 && start >= totalCount) break;
		}

		// --- 4. Update game bookkeeping -------------------------------------
		const complete = totalCount > 0 && start >= totalCount;
		const status: ListScanResult['status'] = pagesFetched === 0 ? 'error' : complete ? 'ok' : 'partial';
		const nextDelayMs = status === 'error' ? Math.min(game.scan_interval_sec * 1000, 5 * 60 * 1000) : game.scan_interval_sec * 1000;
		await db
			.prepare('UPDATE games SET last_scan_at = ?, last_scan_status = ?, next_scan_at = ? WHERE appid = ?')
			.bind(pagesFetched > 0 ? ts : null, status, ts + nextDelayMs, game.appid)
			.run();

		// --- 5. Queue top-N by sell_listings for the detail scanner ----------
		if (scanned.length > 0) {
			scanned.sort((a, b) => b.sellListings - a.sellListings);
			const top = scanned.slice(0, cfg.scan.detailsTopN);
			await db.prepare('DELETE FROM scan_queue WHERE appid = ?').bind(game.appid).run();
			const queueStmts = top.map((s, idx) =>
				db
					.prepare(
						`INSERT INTO scan_queue (item_id, appid, priority, due_at, attempts)
						 VALUES (?, ?, ?, 0, 0)
						 ON CONFLICT(item_id) DO UPDATE SET
						   priority = excluded.priority, due_at = 0, attempts = 0, last_error = NULL`
					)
					.bind(s.itemId, game.appid, idx + 1)
			);
			for (const part of chunk(queueStmts, D1_BATCH_LIMIT)) {
				await db.batch(part);
			}
			result.queuedForDetails = top.length;
		}

		if (stoppedByBudget && status === 'ok') result.status = 'partial';
		else result.status = status;
		result.pagesFetched = pagesFetched;
		result.itemsUpserted = itemsUpserted;
		result.snapshotsInserted = snapshotsInserted;
		result.totalCount = totalCount;
		return result;
	} catch (err) {
		// Rate limiting: reschedule the game and let the scheduler pause globally.
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
		result.itemsUpserted = itemsUpserted;
		result.snapshotsInserted = snapshotsInserted;
		result.totalCount = totalCount;
		if (isRateLimit) throw err; // scheduler handles the global pause
		return result;
	}
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
