/** DTO types mirroring the Worker API (src/routes/*). Money = integer cents. */

export interface GameStats {
	items: number;
	sell_listings: number;
	volume_24h: number | null;
	active_opportunities: number;
}

export interface Game {
	appid: number;
	name: string;
	tier: number;
	scan_interval_sec: number;
	is_active: boolean;
	last_scan_at: number | null;
	last_scan_at_iso: string | null;
	last_scan_status: string | null;
	next_scan_at: number;
	stats: GameStats;
}

export interface ItemSpread {
	net_profit_cents: number;
	net_profit_pct: number;
}

export interface Item {
	item_id: number;
	appid: number;
	game_name: string | null;
	hash_name: string;
	name: string;
	icon_url: string | null;
	steam_url: string;
	sell_min_price_cents: number | null;
	sell_listings: number | null;
	buy_max_price_cents: number | null;
	buy_orders_count: number | null;
	volume_24h: number | null;
	median_price_cents: number | null;
	spread: ItemSpread | null;
	snapshot_at: number | null;
	snapshot_at_iso: string | null;
}

export interface Opportunity {
	id: number;
	item_id: number;
	appid: number;
	game_name: string;
	hash_name: string;
	name: string;
	icon_url: string | null;
	steam_url: string;
	buy_price_cents: number;
	sell_price_cents: number;
	net_profit_cents: number;
	net_profit_pct: number;
	volume_24h: number | null;
	sell_listings: number | null;
	buy_orders_count: number | null;
	detected_at: number;
	detected_at_iso: string;
	updated_at: number;
	updated_at_iso: string;
}

export interface OpportunityListResponse {
	total: number;
	limit: number;
	offset: number;
	currency: string;
	opportunities: Opportunity[];
}

export interface GameListResponse {
	games: Game[];
}

export interface GameDetailsResponse {
	game: Game;
	top_by_volume: Item[];
	top_by_spread: Item[];
}

export interface ItemsResponse {
	appid: number;
	game_name: string | null;
	total: number;
	limit: number;
	offset: number;
	items: Item[];
}

export interface ActivityPoint {
	t: number;
	t_iso: string;
	volume_24h_sum: number;
	listings_avg: number;
	items: number;
}

export interface ActivityResponse {
	appid: number;
	period: string;
	bucket_ms: number;
	series: ActivityPoint[];
}

export interface ItemDetailsResponse {
	item: Item;
	opportunity: {
		buy_price_cents: number;
		sell_price_cents: number;
		net_profit_cents: number;
		net_profit_pct: number;
		volume_24h: number | null;
		detected_at: number;
		detected_at_iso: string;
		updated_at: number;
		is_active: boolean;
	} | null;
	snapshot_stats: {
		total: number;
		first_at: number | null;
		first_at_iso: string | null;
		last_at: number | null;
		last_at_iso: string | null;
	};
}

export interface HistoryPoint {
	t: number;
	t_iso: string;
	sell_avg_cents: number | null;
	sell_min_cents: number | null;
	sell_max_cents: number | null;
	buy_avg_cents: number | null;
	volume_24h: number | null;
	listings_avg: number | null;
}

export interface HistoryResponse {
	item_id: number;
	period: string;
	points: number;
	bucket_ms: number;
	series: HistoryPoint[];
}

export interface Snapshot {
	id: number;
	sell_min_price_cents: number | null;
	sell_listings: number | null;
	buy_max_price_cents: number | null;
	buy_orders_count: number | null;
	volume_24h: number | null;
	median_price_cents: number | null;
	snapshot_at: number;
	snapshot_at_iso: string;
	source: string;
}

export interface SnapshotsResponse {
	item_id: number;
	snapshots: Snapshot[];
}

export interface StatsOverview {
	currency: string;
	demo_mode: boolean;
	games: { total: number; active: number };
	items: { total: number };
	opportunities: { active: number; avg_profit_pct: number | null; max_profit_pct: number | null };
	snapshots_24h: number;
	queue_depth: number;
	scanner: {
		last_scan_at: number | null;
		last_scan_at_iso: string | null;
		last_tick_at: number | null;
		last_tick_at_iso: string | null;
		paused_until: number | null;
		paused_until_iso: string | null;
		steam_requests_total: number;
		steam_errors_total: number;
		errors_24h: number;
		last_tick_summary: unknown;
	};
}

export interface AppConfig {
	currency: string;
	steam_currency_id: number;
	locale: string;
	demo_mode: boolean;
	thresholds: {
		min_spread_pct: number;
		min_volume_24h: number;
		min_buy_price_cents: number;
	};
}
