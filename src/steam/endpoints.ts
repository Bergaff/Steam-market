/**
 * Steam Community Market endpoint URL builders + typed fetch wrappers.
 * All requests go through SteamClient (pacing / retries / logging).
 */

import type { SteamClient } from './client';
import type { RuntimeConfig } from '../config';
import {
	parseSearchRender,
	parsePriceOverview,
	parseHistogram,
	parseItemNameid,
	classifyItemNameidPage,
	type ParsedMarketItem,
	type ParsedPriceOverview,
	type ParsedHistogram,
} from './parse';

const MARKET_BASE = 'https://steamcommunity.com/market';

export function searchRenderUrl(cfg: RuntimeConfig, appid: number, start: number, count: number): string {
	const params = new URLSearchParams({
		query: '',
		start: String(start),
		count: String(count),
		search_descriptions: '0',
		sort_column: 'popular',
		sort_dir: 'desc',
		appid: String(appid),
		norender: '1',
		currency: String(cfg.steam.currency),
	});
	return `${MARKET_BASE}/search/render/?${params.toString()}`;
}

export function priceOverviewUrl(cfg: RuntimeConfig, appid: number, marketHashName: string): string {
	const params = new URLSearchParams({
		appid: String(appid),
		currency: String(cfg.steam.currency),
		market_hash_name: marketHashName,
	});
	return `${MARKET_BASE}/priceoverview/?${params.toString()}`;
}

export function itemOrdersHistogramUrl(cfg: RuntimeConfig, itemNameid: number): string {
	const params = new URLSearchParams({
		country: cfg.steam.country,
		language: cfg.steam.language,
		currency: String(cfg.steam.currency),
		item_nameid: String(itemNameid),
		two_factor: '0',
	});
	return `${MARKET_BASE}/itemordershistogram?${params.toString()}`;
}

export function itemListingsPageUrl(appid: number, marketHashName: string): string {
	const encoded = marketHashName.split('/').map(encodeURIComponent).join('/');
	return `${MARKET_BASE}/listings/${appid}/${encoded}`;
}

export interface GameScanPage {
	totalCount: number;
	items: ParsedMarketItem[];
}

/** Worker 1: one page of the game's market listing. */
export async function fetchSearchRender(
	client: SteamClient,
	cfg: RuntimeConfig,
	appid: number,
	start: number,
	count: number
): Promise<GameScanPage> {
	const url = searchRenderUrl(cfg, appid, start, count);
	const json = await client.getJson(url, 'search_render', { appid });
	const parsed = parseSearchRender(json);
	if (!parsed) throw new Error(`search/render: unexpected response shape for appid=${appid}, start=${start}`);
	return parsed;
}

/** Worker 2: lowest/median price + 24h volume. */
export async function fetchPriceOverview(
	client: SteamClient,
	cfg: RuntimeConfig,
	appid: number,
	marketHashName: string,
	itemId?: number
): Promise<ParsedPriceOverview | null> {
	const url = priceOverviewUrl(cfg, appid, marketHashName);
	const json = await client.getJson(url, 'priceoverview', { appid, itemId: itemId ?? null });
	return parsePriceOverview(json);
}

/** Worker 2: order book (buy order max / sell listing min). */
export async function fetchOrdersHistogram(
	client: SteamClient,
	cfg: RuntimeConfig,
	itemNameid: number,
	appid?: number,
	itemId?: number
): Promise<ParsedHistogram | null> {
	const url = itemOrdersHistogramUrl(cfg, itemNameid);
	const json = await client.getJson(url, 'histogram', { appid: appid ?? null, itemId: itemId ?? null });
	return parseHistogram(json);
}

/** A successful listing-page response that contained no parseable item_nameid. */
export class ItemNameidNotFoundError extends Error {
	constructor(pageShape: string, responseLength: number) {
		super(`item_nameid not found (${pageShape}, ${responseLength} chars)`);
		this.name = 'ItemNameidNotFoundError';
	}
}

/** Worker 2: one-time fetch of item_nameid from the listing page HTML. */
export async function fetchItemNameid(
	client: SteamClient,
	appid: number,
	marketHashName: string,
	itemId?: number
): Promise<number> {
	const url = itemListingsPageUrl(appid, marketHashName);
	const html = await client.getText(url, 'item_page', { appid, itemId: itemId ?? null });
	const itemNameid = parseItemNameid(html);
	if (itemNameid !== null) return itemNameid;
	// Keep parse failures separate from HTTP failures so they remain on the
	// conservative long retry cooldown, while diagnostics record response shape.
	throw new ItemNameidNotFoundError(classifyItemNameidPage(html), html.length);
}
