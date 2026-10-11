/**
 * `item_latest_state` maintenance — one row per item with the last known
 * market values. All list/filter/sort/detector queries use this small table
 * instead of windowing over the whole price_snapshots history.
 */

export interface LatestStateRow {
	item_id: number;
	appid: number;
	sell_min_price: number | null;
	sell_listings: number | null;
	buy_max_price: number | null;
	buy_orders_count: number | null;
	volume_24h: number | null;
	median_price: number | null;
	snapshot_at: number | null;
	detail_at: number | null;
	source: string | null;
	updated_at: number;
}

/** Upsert after a LIST scan: refreshes sell-side fields only. */
export function upsertStateList(
	db: D1Database,
	itemId: number,
	appid: number,
	sellMinPrice: number | null,
	sellListings: number | null,
	snapshotAt: number,
	source = 'list'
): D1PreparedStatement {
	return db
		.prepare(
			`INSERT INTO item_latest_state
			   (item_id, appid, sell_min_price, sell_listings, snapshot_at, source, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?)
			 ON CONFLICT(item_id) DO UPDATE SET
			   appid          = excluded.appid,
			   sell_min_price = excluded.sell_min_price,
			   sell_listings  = excluded.sell_listings,
			   snapshot_at    = excluded.snapshot_at,
			   source         = excluded.source,
			   updated_at     = excluded.updated_at`
		)
		.bind(itemId, appid, sellMinPrice, sellListings, snapshotAt, source, snapshotAt);
}

/** Upsert after a DETAIL scan: refreshes order-book/volume fields (+ optional sell fallback). */
export function upsertStateDetail(
	db: D1Database,
	itemId: number,
	appid: number,
	buyMaxPrice: number | null,
	buyOrdersCount: number | null,
	volume24h: number | null,
	medianPrice: number | null,
	sellMinPriceFallback: number | null,
	snapshotAt: number
): D1PreparedStatement {
	return db
		.prepare(
			`INSERT INTO item_latest_state
			   (item_id, appid, buy_max_price, buy_orders_count, volume_24h, median_price, sell_min_price, snapshot_at, detail_at, source, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'detail', ?)
			 ON CONFLICT(item_id) DO UPDATE SET
			   buy_max_price    = COALESCE(excluded.buy_max_price, item_latest_state.buy_max_price),
			   buy_orders_count = COALESCE(excluded.buy_orders_count, item_latest_state.buy_orders_count),
			   volume_24h       = COALESCE(excluded.volume_24h, item_latest_state.volume_24h),
			   median_price     = COALESCE(excluded.median_price, item_latest_state.median_price),
			   sell_min_price   = COALESCE(item_latest_state.sell_min_price, excluded.sell_min_price),
			   snapshot_at      = excluded.snapshot_at,
			   detail_at        = excluded.detail_at,
			   source           = 'detail',
			   updated_at       = excluded.updated_at`
		)
		.bind(itemId, appid, buyMaxPrice, buyOrdersCount, volume24h, medianPrice, sellMinPriceFallback, snapshotAt, snapshotAt, snapshotAt);
}

/**
 * Cheap touch of `detail_at` for items whose order book did not move
 * (delta skip) — keeps the spread detector's freshness window honest.
 */
export function touchDetailAt(db: D1Database, itemId: number, ts: number): D1PreparedStatement {
	return db.prepare('UPDATE item_latest_state SET detail_at = ? WHERE item_id = ?').bind(ts, itemId);
}

/** The canonical JOIN used by all list-style API queries. */
export const ITEM_WITH_STATE_SELECT = `
	SELECT
	  i.id          AS item_id,
	  i.appid       AS appid,
	  i.hash_name   AS hash_name,
	  i.name        AS name,
	  i.icon_url    AS icon_url,
	  i.item_nameid AS item_nameid,
	  i.first_seen  AS first_seen,
	  i.last_seen   AS last_seen,
	  s.sell_min_price, s.sell_listings, s.buy_max_price, s.buy_orders_count,
	  s.volume_24h, s.median_price, s.snapshot_at,
	  s.source AS snapshot_source
	FROM items i
	LEFT JOIN item_latest_state s ON s.item_id = i.id
`;
