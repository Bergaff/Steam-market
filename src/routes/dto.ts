/**
 * DTO helpers: mapping DB rows to JSON responses.
 *
 * Money convention: the API exposes integer cents in `*_cents` fields plus a
 * top-level `currency` (ISO code). Timestamps: epoch ms + ISO string.
 */

import { computeNetProfit } from '../scan/spreadDetector';
import { toIso, clampInt } from '../lib/time';
import { currencyCode, type RuntimeConfig } from '../config';

/** ISO currency code for API responses (derived from STEAM_CURRENCY config). */
export function currencyLabel(cfg: RuntimeConfig): string {
	return currencyCode(cfg);
}

export function steamItemUrl(appid: number, hashName: string): string {
	const encoded = hashName.split('/').map(encodeURIComponent).join('/');
	return `https://steamcommunity.com/market/listings/${appid}/${encoded}`;
}

export interface ItemLatestRow {
	item_id: number;
	appid: number;
	hash_name: string;
	name: string;
	icon_url: string | null;
	item_nameid: number | null;
	first_seen: number;
	last_seen: number;
	sell_min_price: number | null;
	sell_listings: number | null;
	buy_max_price: number | null;
	buy_orders_count: number | null;
	volume_24h: number | null;
	median_price: number | null;
	snapshot_at: number | null;
	snapshot_source?: string | null;
}

export function itemDto(row: ItemLatestRow, gameName?: string | null) {
	const spread =
		row.sell_min_price !== null && row.buy_max_price !== null && row.buy_max_price > 0
			? computeNetProfit(row.sell_min_price, row.buy_max_price)
			: null;

	return {
		item_id: row.item_id,
		appid: row.appid,
		game_name: gameName ?? null,
		hash_name: row.hash_name,
		name: row.name,
		icon_url: row.icon_url,
		steam_url: steamItemUrl(row.appid, row.hash_name),
		sell_min_price_cents: row.sell_min_price,
		sell_listings: row.sell_listings,
		buy_max_price_cents: row.buy_max_price,
		buy_orders_count: row.buy_orders_count,
		volume_24h: row.volume_24h,
		median_price_cents: row.median_price,
		spread: spread
			? {
					net_profit_cents: spread.netCents,
					net_profit_pct: Math.round(spread.pct * 100) / 100,
				}
			: null,
		snapshot_at: row.snapshot_at,
		snapshot_at_iso: toIso(row.snapshot_at),
	};
}

export type ItemDto = ReturnType<typeof itemDto>;

// ---------------------------------------------------------------------------
// Query param helpers
// ---------------------------------------------------------------------------

const PERIODS_MS: Record<string, number> = {
	'24h': 24 * 60 * 60 * 1000,
	'7d': 7 * 24 * 60 * 60 * 1000,
	'30d': 30 * 24 * 60 * 60 * 1000,
};

export function parsePeriodMs(value: string | undefined): { period: string; ms: number } {
	const key = (value ?? '7d').toLowerCase();
	if (PERIODS_MS[key] !== undefined) return { period: key, ms: PERIODS_MS[key]! };
	return { period: '7d', ms: PERIODS_MS['7d']! };
}

export function parsePagination(rawLimit: string | undefined, rawOffset: string | undefined, defaultLimit = 50, maxLimit = 200) {
	const limit = clampInt(parseInt(rawLimit ?? '', 10), 1, maxLimit, defaultLimit);
	const offset = clampInt(parseInt(rawOffset ?? '', 10), 0, 100_000, 0);
	return { limit, offset };
}

export function parseSort(rawSort: string | undefined, allowed: Record<string, string>, fallback: string): string {
	const key = (rawSort ?? '').toLowerCase();
	return allowed[key] ?? fallback;
}

export function parseDirection(rawDir: string | undefined): 'ASC' | 'DESC' {
	return (rawDir ?? '').toLowerCase() === 'asc' ? 'ASC' : 'DESC';
}

/** Optional integer filter from a query param. */
export function intFilter(value: string | undefined): number | null {
	if (value === undefined || value === '') return null;
	const n = parseInt(value, 10);
	return Number.isFinite(n) ? n : null;
}

/** CSV escaping (quotes doubled, fields wrapped when needed). */
export function csvCell(value: string | number | null | undefined): string {
	if (value === null || value === undefined) return '';
	const s = String(value);
	if (/[",;\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
	return s;
}

export function centsToUnits(cents: number | null | undefined): string {
	if (cents === null || cents === undefined) return '';
	return (cents / 100).toFixed(2);
}
