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
	volume_24h_sum: number | null;
	listings_avg: number;
	items: number;
	volume_items: number;
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

export interface DiagnosticsGame {
	appid: number;
	name: string;
	tier: number;
	is_active: boolean;
	scan_interval_sec: number;
	last_scan_status: string | null;
	last_scan_at: number | null;
	last_scan_at_iso: string | null;
	last_scan_age_ms: number | null;
	next_scan_at: number;
	next_scan_at_iso: string | null;
	tracked_items: number;
	nameid_known_items: number;
	nameid_missing_items: number;
	latest_state_items: number;
	sell_price_known_items: number;
	buy_max_known_items: number;
	volume_known_items: number;
	ever_detailed_items: number;
	never_detailed_items: number;
	detail_fresh_items: number;
	detail_stale_items: number;
	detailed_without_buy_items: number;
	newest_detail_at: number | null;
	newest_detail_at_iso: string | null;
	oldest_detail_at: number | null;
	oldest_detail_at_iso: string | null;
	snapshots_24h: number;
	active_opportunities: number;
	queue: {
		total: number;
		due_now: number;
		waiting_for_retry: number;
		retried_items: number;
		no_cached_nameid: number;
		nameid_error_items: number;
		volume_error_items: number;
		orderbook_error_items: number;
		max_attempts: number;
		earliest_due_at: number | null;
		earliest_due_at_iso: string | null;
		next_future_due_at: number | null;
		next_future_due_at_iso: string | null;
	};
}

export interface DiagnosticsTickHour {
	hour_start: number;
	hour_start_iso: string;
	ticks: number;
	completed_ticks: number;
	skipped_locked: number;
	skipped_paused: number;
	errored_ticks: number;
	steam_requests: number;
	steam_errors: number;
	duration_ms_total: number;
	games_scanned: number;
	partial_game_scans: number;
	failed_game_scans: number;
	details_processed: number;
	details_succeeded: number;
	details_failed: number;
	nameid_missing: number;
	volume_retrieved: number;
	volume_missing: number;
	spread_qualifying: number;
	spread_deactivated: number;
	by_appid: Record<string, {
		processed: number;
		succeeded: number;
		failed: number;
		nameid_missing: number;
		volume_retrieved: number;
		volume_missing: number;
	}>;
}

export interface DiagnosticsQueueByApp {
	appid: number;
	name: string;
	total: number;
	due_now: number;
	waiting_for_retry: number;
	retried_items: number;
	no_cached_nameid: number;
	nameid_error_items: number;
	volume_error_items: number;
	orderbook_error_items: number;
	max_attempts: number;
	earliest_due_at: number | null;
	earliest_due_at_iso: string | null;
	next_future_due_at: number | null;
	next_future_due_at_iso: string | null;
}

export interface DiagnosticsQueuePreview {
	appid: number;
	game_name: string;
	tier: number;
	item_id: number;
	priority: number;
	attempts: number;
	due_at: number;
	due_at_iso: string | null;
	due_in_ms: number;
	item_nameid_cached: boolean;
	detail_at: number | null;
	detail_at_iso: string | null;
	volume_known: boolean;
	buy_max_known: boolean;
	last_error: string | null;
}

export interface DiagnosticsLogEntry {
	id: number;
	endpoint: string;
	appid: number | null;
	item_id: number | null;
	http_status: number | null;
	duration_ms: number | null;
	ok?: boolean;
	error: string | null;
	created_at: number;
	created_at_iso: string | null;
}

export interface DiagnosticsResponse {
	format: string;
	generated_at: number;
	generated_at_iso: string | null;
	time_zone: string;
	status: string;
	security: Record<string, boolean>;
	config: {
		demo_mode: boolean;
		steam_currency_id: number;
		steam_language: string;
		steam_country: string;
		steam_cookie_configured: boolean;
		scan: Record<string, number>;
		spread: Record<string, number>;
		logging: {
			success_sample_every_n: number;
			success_requests_are_sampled: boolean;
			all_failed_requests_are_logged: boolean;
		};
	};
	scheduler: {
		last_tick_at: number | null;
		last_tick_at_iso: string | null;
		last_successful_scan_at: number | null;
		last_successful_scan_at_iso: string | null;
		last_successful_scan_age_ms: number | null;
		last_spread_run_at: number | null;
		last_spread_run_at_iso: string | null;
		paused_until: number | null;
		paused_until_iso: string | null;
		consecutive_429: number;
		last_tick_lock_since: number | null;
		last_tick_lock_age_ms: number | null;
		total_steam_requests: number;
		total_steam_errors: number;
		last_tick_summary: unknown;
	};
	queue: {
		total: number;
		due_now: number;
		waiting_for_retry: number;
		by_appid: DiagnosticsQueueByApp[];
		preview: DiagnosticsQueuePreview[];
	};
	games: DiagnosticsGame[];
	request_activity_24h: {
		logged_rows: number;
		failed_rows: number;
		http_429_rows: number;
		successful_rows_are_sampled: boolean;
		by_endpoint_and_status: Array<{
			endpoint: string;
			http_status: number | null;
			logged_rows: number;
			failed_rows: number;
			http_429_rows: number;
			avg_duration_ms: number | null;
			last_at: number | null;
			last_at_iso: string | null;
		}>;
	};
	recent_request_log: DiagnosticsLogEntry[];
	recent_failures: DiagnosticsLogEntry[];
	tick_history_24h: {
		available: boolean;
		rows_captured: number;
		first_tick_at: number | null;
		first_tick_at_iso: string | null;
		hourly: DiagnosticsTickHour[];
		recent_ticks: Array<{
			started_at: number;
			started_at_iso: string | null;
			mode: string;
			skipped: string | null;
			steam_requests: number;
			steam_errors: number;
			duration_ms: number;
			error: string | null;
			summary: unknown;
		}>;
	};
	notes: string[];
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
