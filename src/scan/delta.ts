/**
 * Delta compression for snapshot writes (keeps D1 write volume within the
 * free tier: 100k written rows/day).
 *
 * A new snapshot is written only when:
 *   - there is no previous state, OR
 *   - the last snapshot is older than the heartbeat window (anchor points
 *     for charts even on flat markets), OR
 *   - the sell price moved by >= max(1 cent, 1.5%), OR
 *   - the listings count moved by >= max(5, 15%).
 *
 * Detail (order-book) values use their own thresholds: buy price >= 1%,
 * 24h volume >= max(3, 10%).
 */

export const PRICE_DELTA_RATIO = 0.015; // 1.5%
export const LISTINGS_DELTA_RATIO = 0.15; // 15%
export const LISTINGS_DELTA_ABS = 5;
export const BUY_DELTA_RATIO = 0.01; // 1%
export const VOLUME_DELTA_RATIO = 0.1; // 10%
export const VOLUME_DELTA_ABS = 3;

export interface PrevSnapshotState {
	snapshot_at: number | null;
	sell_min_price: number | null;
	sell_listings: number | null;
	buy_max_price?: number | null;
	volume_24h?: number | null;
}

export interface NextListValues {
	sellPriceCents: number | null;
	sellListings: number | null;
}

function moved(value: number | null, prev: number | null, ratio: number, absMin: number): boolean {
	if (prev === null || prev === undefined) return value !== null && value !== undefined;
	if (value === null || value === undefined) return false;
	const threshold = Math.max(absMin, Math.round(Math.abs(prev) * ratio));
	return Math.abs(value - prev) >= threshold;
}

/** Should the list scanner write a new snapshot for this item? */
export function needsSnapshot(
	prev: PrevSnapshotState | null | undefined,
	next: NextListValues,
	nowMs: number,
	heartbeatMs: number
): boolean {
	if (!prev || prev.snapshot_at === null || prev.snapshot_at === undefined) return true;
	if (nowMs - prev.snapshot_at >= heartbeatMs) return true;
	if (moved(next.sellPriceCents, prev.sell_min_price, PRICE_DELTA_RATIO, 1)) return true;
	if (moved(next.sellListings, prev.sell_listings, LISTINGS_DELTA_RATIO, LISTINGS_DELTA_ABS)) return true;
	return false;
}

export interface NextDetailValues {
	buyCents: number | null;
	volume24h: number | null;
	medianCents?: number | null;
}

/** Should the detail scanner write (merge/insert) a snapshot for this item? */
export function needsDetailWrite(
	prev: PrevSnapshotState | null | undefined,
	next: NextDetailValues,
	nowMs: number,
	heartbeatMs: number
): boolean {
	if (!prev || prev.snapshot_at === null || prev.snapshot_at === undefined) return true;
	if (nowMs - prev.snapshot_at >= heartbeatMs) return true;
	if (next.buyCents !== null && moved(next.buyCents, prev.buy_max_price ?? null, BUY_DELTA_RATIO, 1)) return true;
	if (next.volume24h !== null && moved(next.volume24h, prev.volume_24h ?? null, VOLUME_DELTA_RATIO, VOLUME_DELTA_ABS)) return true;
	return false;
}
