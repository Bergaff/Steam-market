/**
 * Public, shareable diagnostics for the owner. Deliberately excludes raw Steam
 * URLs, cookies, API keys, proxy URLs, visitor IPs and item names.
 */

import { Hono } from 'hono';
import type { Env } from '../env';
import type { RuntimeConfig } from '../config';
import { toIso } from '../lib/time';
import { STATE_KEYS, getState, getStateInt } from '../db/state';
import { ensureTickLogSchema } from '../db/tickLog';

type Ctx = { Bindings: Env; Variables: { cfg: RuntimeConfig } };

const diagnostics = new Hono<Ctx>();
const DAY_MS = 24 * 60 * 60 * 1000;
const TICK_LOG_LIMIT = 2_000;
const RECENT_TICK_LIMIT = 120;
const RECENT_REQUEST_LIMIT = 100;
const RECENT_ERROR_LIMIT = 50;

interface GameRow {
	appid: number;
	name: string;
	tier: number;
	scan_interval_sec: number;
	is_active: number;
	next_scan_at: number;
	last_scan_at: number | null;
	last_scan_status: string | null;
}

interface CountRow {
	appid: number;
	[key: string]: number | null;
}

interface QueuePreviewRow {
	appid: number;
	game_name: string;
	tier: number;
	item_id: number;
	priority: number;
	attempts: number;
	due_at: number;
	item_nameid: number | null;
	detail_at: number | null;
	volume_24h: number | null;
	buy_max_price: number | null;
	last_error: string | null;
}

interface RequestLogRow {
	id: number;
	endpoint: string;
	appid: number | null;
	item_id: number | null;
	status: number | null;
	duration_ms: number | null;
	ok: number;
	error: string | null;
	created_at: number;
}

interface TickLogRow {
	started_at: number;
	mode: string;
	skipped: string | null;
	steam_requests: number;
	steam_errors: number;
	duration_ms: number;
	error: string | null;
	summary_json: string;
}

interface AppHourStats {
	processed: number;
	succeeded: number;
	failed: number;
	nameid_missing: number;
	volume_retrieved: number;
	volume_missing: number;
}

interface TickHourStats {
	hour_start: number;
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
	by_appid: Record<string, AppHourStats>;
}

function number(value: unknown): number {
	const n = typeof value === 'number' ? value : Number(value ?? 0);
	return Number.isFinite(n) ? n : 0;
}

function record(value: unknown): Record<string, unknown> {
	return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function parseJson(value: string | null): unknown {
	if (!value) return null;
	try {
		return JSON.parse(value) as unknown;
	} catch {
		return value;
	}
}

function safeError(value: string | null | undefined): string | null {
	if (!value) return null;
	return value
		.replace(/https?:\/\/[^\s"'<>]+/gi, '[URL скрыт]')
		.replace(/((?:cookie|authorization|admin[_ -]?api[_ -]?key|token|proxy[_ -]?url)\s*[:=]\s*)[^\s,;]+/gi, '$1[скрыто]')
		.slice(0, 500);
}

function sanitizeJson(value: unknown): unknown {
	if (typeof value === 'string') return safeError(value) ?? '';
	if (Array.isArray(value)) return value.map(sanitizeJson);
	if (value !== null && typeof value === 'object') {
		const out: Record<string, unknown> = {};
		for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
			if (/cookie|secret|admin[_-]?api[_-]?key|token|(^|_)url$/i.test(key)) continue;
			out[key] = sanitizeJson(child);
		}
		return out;
	}
	return value;
}

function incrementAppStats(target: Record<string, AppHourStats>, appid: string, source: Record<string, unknown>): void {
	const stats = (target[appid] ??= {
		processed: 0,
		succeeded: 0,
		failed: 0,
		nameid_missing: 0,
		volume_retrieved: 0,
		volume_missing: 0,
	});
	stats.processed += number(source.processed);
	stats.succeeded += number(source.succeeded);
	stats.failed += number(source.failed);
	stats.nameid_missing += number(source.nameidMissing ?? source.nameid_missing);
	stats.volume_retrieved += number(source.volumeRetrieved ?? source.volume_retrieved);
	stats.volume_missing += number(source.volumeMissing ?? source.volume_missing);
}

/** Turn compact per-tick records into a paste-friendly 24-hour hourly timeline. */
export function aggregateTickHistory(rows: TickLogRow[]): Array<TickHourStats & { hour_start_iso: string }> {
	const buckets = new Map<number, TickHourStats>();
	for (const row of rows) {
		const hourStart = Math.floor(row.started_at / 3_600_000) * 3_600_000;
		const hour =
			buckets.get(hourStart) ??
			{
				hour_start: hourStart,
				ticks: 0,
				completed_ticks: 0,
				skipped_locked: 0,
				skipped_paused: 0,
				errored_ticks: 0,
				steam_requests: 0,
				steam_errors: 0,
				duration_ms_total: 0,
				games_scanned: 0,
				partial_game_scans: 0,
				failed_game_scans: 0,
				details_processed: 0,
				details_succeeded: 0,
				details_failed: 0,
				nameid_missing: 0,
				volume_retrieved: 0,
				volume_missing: 0,
				spread_qualifying: 0,
				spread_deactivated: 0,
				by_appid: {},
			};

		hour.ticks++;
		hour.steam_requests += number(row.steam_requests);
		hour.steam_errors += number(row.steam_errors);
		hour.duration_ms_total += number(row.duration_ms);
		if (row.skipped === 'locked') hour.skipped_locked++;
		else if (row.skipped === 'paused') hour.skipped_paused++;
		else hour.completed_ticks++;
		if (row.error) hour.errored_ticks++;

		const summary = record(parseJson(row.summary_json));
		const details = record(summary.details);
		const spread = record(summary.spread);
		const games = Array.isArray(summary.games) ? summary.games : [];
		hour.details_processed += number(details.processed);
		hour.details_succeeded += number(details.ok ?? details.succeeded);
		hour.details_failed += number(details.failed);
		hour.nameid_missing += number(details.nameidMissing ?? details.nameid_missing);
		hour.volume_retrieved += number(details.volumeRetrieved ?? details.volume_retrieved);
		hour.volume_missing += number(details.volumeMissing ?? details.volume_missing);
		hour.spread_qualifying += number(spread.active ?? spread.qualifying);
		hour.spread_deactivated += number(spread.off ?? spread.deactivated);
		for (const gameValue of games) {
			const game = record(gameValue);
			hour.games_scanned++;
			if (game.status === 'partial') hour.partial_game_scans++;
			if (game.status === 'error' || game.status === 'rate_limited' || game.status === 'currency_mismatch') hour.failed_game_scans++;
		}
		for (const [appid, appValue] of Object.entries(record(details.byAppid))) incrementAppStats(hour.by_appid, appid, record(appValue));
		buckets.set(hourStart, hour);
	}

	return [...buckets.values()]
		.sort((a, b) => b.hour_start - a.hour_start)
		.map((hour) => ({ ...hour, hour_start_iso: toIso(hour.hour_start)! }));
}

diagnostics.get('/', async (c) => {
	c.header('Cache-Control', 'no-store');
	const cfg = c.get('cfg');
	const db = c.env.DB;
	const now = Date.now();
	const since24h = now - DAY_MS;
	const detailFreshAfter = now - cfg.spread.detailFreshMs;

	let tickLogAvailable = true;
	try {
		await ensureTickLogSchema(db);
	} catch {
		tickLogAvailable = false;
	}

	const [gameResult, itemResult, stateResult, queueResult, opportunityResult, snapshotResult] = await Promise.all([
		db
			.prepare(
				`SELECT appid, name, tier, scan_interval_sec, is_active, next_scan_at, last_scan_at, last_scan_status
				 FROM games ORDER BY tier ASC, appid ASC`
			)
			.all<GameRow>(),
		db
			.prepare(
				`SELECT appid,
				        COUNT(*) AS tracked_items,
				        SUM(CASE WHEN item_nameid IS NOT NULL THEN 1 ELSE 0 END) AS nameid_known_items,
				        SUM(CASE WHEN item_nameid IS NULL THEN 1 ELSE 0 END) AS nameid_missing_items
				 FROM items GROUP BY appid`
			)
			.all<CountRow>(),
		db
			.prepare(
				`SELECT appid,
				        COUNT(*) AS state_items,
				        SUM(CASE WHEN sell_min_price IS NOT NULL THEN 1 ELSE 0 END) AS sell_price_known_items,
				        SUM(CASE WHEN buy_max_price IS NOT NULL AND buy_max_price > 0 THEN 1 ELSE 0 END) AS buy_max_known_items,
				        SUM(CASE WHEN volume_24h IS NOT NULL THEN 1 ELSE 0 END) AS volume_known_items,
				        SUM(CASE WHEN detail_at IS NOT NULL THEN 1 ELSE 0 END) AS ever_detailed_items,
				        SUM(CASE WHEN detail_at IS NULL THEN 1 ELSE 0 END) AS never_detailed_items,
				        SUM(CASE WHEN detail_at >= ? THEN 1 ELSE 0 END) AS detail_fresh_items,
				        SUM(CASE WHEN detail_at IS NOT NULL AND detail_at < ? THEN 1 ELSE 0 END) AS detail_stale_items,
				        SUM(CASE WHEN detail_at IS NOT NULL AND buy_max_price IS NULL THEN 1 ELSE 0 END) AS detailed_without_buy_items,
				        MAX(detail_at) AS newest_detail_at,
				        MIN(detail_at) AS oldest_detail_at
				 FROM item_latest_state GROUP BY appid`
			)
			.bind(detailFreshAfter, detailFreshAfter)
			.all<CountRow>(),
		db
			.prepare(
				`SELECT q.appid,
				        COUNT(*) AS total,
				        SUM(CASE WHEN q.due_at <= ? THEN 1 ELSE 0 END) AS due_now,
				        SUM(CASE WHEN q.due_at > ? THEN 1 ELSE 0 END) AS waiting_for_retry,
				        SUM(CASE WHEN q.attempts > 0 THEN 1 ELSE 0 END) AS retried_items,
				        SUM(CASE WHEN i.item_nameid IS NULL THEN 1 ELSE 0 END) AS no_cached_nameid,
				        SUM(CASE WHEN q.last_error LIKE '%item_nameid%' THEN 1 ELSE 0 END) AS nameid_error_items,
				        SUM(CASE WHEN q.last_error LIKE '%priceoverview%' THEN 1 ELSE 0 END) AS volume_error_items,
				        SUM(CASE WHEN q.last_error LIKE '%orderbook%' THEN 1 ELSE 0 END) AS orderbook_error_items,
				        MAX(q.attempts) AS max_attempts,
				        MIN(q.due_at) AS earliest_due_at,
				        MIN(CASE WHEN q.due_at > ? THEN q.due_at END) AS next_future_due_at
				 FROM scan_queue q
				 LEFT JOIN items i ON i.id = q.item_id
				 GROUP BY q.appid`
			)
			.bind(now, now, now)
			.all<CountRow>(),
		db
			.prepare('SELECT i.appid, COUNT(*) AS active_opportunities FROM spread_opportunities o JOIN items i ON i.id = o.item_id WHERE o.is_active = 1 GROUP BY i.appid')
			.all<CountRow>(),
		db
			.prepare('SELECT i.appid, COUNT(*) AS snapshots_24h FROM price_snapshots s JOIN items i ON i.id = s.item_id WHERE s.snapshot_at >= ? GROUP BY i.appid')
			.bind(since24h)
			.all<CountRow>(),
	]);

	const [queuePreviewResult, requestRollupResult, requestLogResult, requestErrorResult] = await Promise.all([
		db
			.prepare(
				`SELECT q.appid, g.name AS game_name, g.tier, q.item_id, q.priority, q.attempts, q.due_at,
				        i.item_nameid, s.detail_at, s.volume_24h, s.buy_max_price, q.last_error
				 FROM scan_queue q
			 JOIN games g ON g.appid = q.appid
			 JOIN items i ON i.id = q.item_id
			 LEFT JOIN item_latest_state s ON s.item_id = q.item_id
			 ORDER BY CASE WHEN q.due_at <= ? THEN 0 ELSE 1 END, g.tier ASC, q.priority ASC, q.appid ASC, q.due_at ASC, q.item_id ASC
			 LIMIT 50`
			)
			.bind(now)
			.all<QueuePreviewRow>(),
		db
			.prepare(
				`SELECT endpoint, status, COUNT(*) AS logged_rows,
				        SUM(CASE WHEN ok = 0 THEN 1 ELSE 0 END) AS failed_rows,
				        SUM(CASE WHEN status = 429 THEN 1 ELSE 0 END) AS http_429_rows,
				        ROUND(AVG(duration_ms)) AS avg_duration_ms,
				        MAX(created_at) AS last_at
				 FROM scan_log WHERE created_at >= ?
				 GROUP BY endpoint, status ORDER BY failed_rows DESC, logged_rows DESC, endpoint ASC`
			)
			.bind(since24h)
			.all<{ endpoint: string; status: number | null; logged_rows: number; failed_rows: number; http_429_rows: number; avg_duration_ms: number | null; last_at: number | null }>(),
		db
			.prepare(
				`SELECT id, endpoint, appid, item_id, status, duration_ms, ok, error, created_at
				 FROM scan_log ORDER BY id DESC LIMIT ?`
			)
			.bind(RECENT_REQUEST_LIMIT)
			.all<RequestLogRow>(),
		db
			.prepare(
				`SELECT id, endpoint, appid, item_id, status, duration_ms, ok, error, created_at
				 FROM scan_log WHERE ok = 0 ORDER BY id DESC LIMIT ?`
			)
			.bind(RECENT_ERROR_LIMIT)
			.all<RequestLogRow>(),
	]);

	let tickRows: TickLogRow[] = [];
	if (tickLogAvailable) {
		try {
			const rows = await db
				.prepare(
					`SELECT started_at, mode, skipped, steam_requests, steam_errors, duration_ms, error, summary_json
					 FROM scheduler_tick_log WHERE started_at >= ? ORDER BY started_at DESC LIMIT ?`
				)
				.bind(since24h, TICK_LOG_LIMIT)
				.all<TickLogRow>();
			tickRows = rows.results;
		} catch {
			tickLogAvailable = false;
		}
	}

	const itemByApp = new Map(itemResult.results.map((row) => [row.appid, row]));
	const stateByApp = new Map(stateResult.results.map((row) => [row.appid, row]));
	const queueByApp = new Map(queueResult.results.map((row) => [row.appid, row]));
	const oppByApp = new Map(opportunityResult.results.map((row) => [row.appid, row]));
	const snapshotsByApp = new Map(snapshotResult.results.map((row) => [row.appid, row]));

	const gameDiagnostics = gameResult.results.map((game) => {
		const items = itemByApp.get(game.appid) ?? ({} as CountRow);
		const state = stateByApp.get(game.appid) ?? ({} as CountRow);
		const queue = queueByApp.get(game.appid) ?? ({} as CountRow);
		const opportunities = oppByApp.get(game.appid) ?? ({} as CountRow);
		const snapshots = snapshotsByApp.get(game.appid) ?? ({} as CountRow);
		return {
			appid: game.appid,
			name: game.name,
			tier: game.tier,
			is_active: game.is_active === 1,
			scan_interval_sec: game.scan_interval_sec,
			last_scan_status: game.last_scan_status,
			last_scan_at: game.last_scan_at,
			last_scan_at_iso: toIso(game.last_scan_at),
			last_scan_age_ms: game.last_scan_at === null ? null : Math.max(0, now - game.last_scan_at),
			next_scan_at: game.next_scan_at,
			next_scan_at_iso: toIso(game.next_scan_at),
			tracked_items: number(items.tracked_items),
			nameid_known_items: number(items.nameid_known_items),
			nameid_missing_items: number(items.nameid_missing_items),
			latest_state_items: number(state.state_items),
			sell_price_known_items: number(state.sell_price_known_items),
			buy_max_known_items: number(state.buy_max_known_items),
			volume_known_items: number(state.volume_known_items),
			ever_detailed_items: number(state.ever_detailed_items),
			never_detailed_items: number(state.never_detailed_items),
			detail_fresh_items: number(state.detail_fresh_items),
			detail_stale_items: number(state.detail_stale_items),
			detailed_without_buy_items: number(state.detailed_without_buy_items),
			newest_detail_at: state.newest_detail_at ?? null,
			newest_detail_at_iso: toIso(state.newest_detail_at as number | null),
			oldest_detail_at: state.oldest_detail_at ?? null,
			oldest_detail_at_iso: toIso(state.oldest_detail_at as number | null),
			snapshots_24h: number(snapshots.snapshots_24h),
			active_opportunities: number(opportunities.active_opportunities),
			queue: {
				total: number(queue.total),
				due_now: number(queue.due_now),
				waiting_for_retry: number(queue.waiting_for_retry),
				retried_items: number(queue.retried_items),
				no_cached_nameid: number(queue.no_cached_nameid),
				nameid_error_items: number(queue.nameid_error_items),
				volume_error_items: number(queue.volume_error_items),
				orderbook_error_items: number(queue.orderbook_error_items),
				max_attempts: number(queue.max_attempts),
				earliest_due_at: queue.earliest_due_at ?? null,
				earliest_due_at_iso: toIso(queue.earliest_due_at as number | null),
				next_future_due_at: queue.next_future_due_at ?? null,
				next_future_due_at_iso: toIso(queue.next_future_due_at as number | null),
			},
		};
	});

	const stateValues = await db
		.prepare('SELECT key, value FROM scheduler_state WHERE key IN (?, ?, ?, ?, ?, ?, ?, ?, ?)')
		.bind(
			STATE_KEYS.pausedUntil,
			STATE_KEYS.consecutive429,
			STATE_KEYS.lastSpreadRunAt,
			STATE_KEYS.lastSuccessfulScanAt,
			STATE_KEYS.totalSteamRequests,
			STATE_KEYS.totalSteamErrors,
			STATE_KEYS.lastTickAt,
			STATE_KEYS.lastTickSummary,
			STATE_KEYS.tickLockSince
		)
		.all<{ key: string; value: string }>();
	const state = Object.fromEntries(stateValues.results.map((row) => [row.key, row.value]));
	const pausedUntil = number(state[STATE_KEYS.pausedUntil]);
	const lastSuccessfulScanAt = number(state[STATE_KEYS.lastSuccessfulScanAt]);
	const lastGameScanAt = Math.max(0, ...gameResult.results.map((game) => number(game.last_scan_at)));
	const lastScanAt = Math.max(lastSuccessfulScanAt, lastGameScanAt) || null;
	const isPaused = pausedUntil > now;
	const lastScanAgeMs = lastScanAt === null ? null : now - lastScanAt;
	const status = isPaused ? 'paused' : lastScanAgeMs !== null && lastScanAgeMs > 30 * 60 * 1000 ? 'degraded' : 'ok';
	const lockSince = number(state[STATE_KEYS.tickLockSince]);
	const recentTicks = tickRows.slice(0, RECENT_TICK_LIMIT).map((row) => ({
		started_at: row.started_at,
		started_at_iso: toIso(row.started_at),
		mode: row.mode,
		skipped: row.skipped,
		steam_requests: number(row.steam_requests),
		steam_errors: number(row.steam_errors),
		duration_ms: number(row.duration_ms),
		error: safeError(row.error),
		summary: sanitizeJson(parseJson(row.summary_json)),
	}));

	const response = {
		format: 'steam-market-diagnostics-v1',
		generated_at: now,
		generated_at_iso: toIso(now),
		time_zone: 'UTC',
		status,
		security: {
			steam_cookie_value_included: false,
			admin_api_key_included: false,
			proxy_url_included: false,
			visitor_ip_included: false,
			raw_steam_request_urls_included: false,
			item_names_included: false,
		},
		config: {
			demo_mode: cfg.demoMode,
			steam_currency_id: cfg.steam.currency,
			steam_language: cfg.steam.language,
			steam_country: cfg.steam.country,
			steam_cookie_configured: cfg.steam.webCookie !== null,
			scan: {
				min_request_interval_ms: cfg.scan.minRequestIntervalMs,
				max_steam_requests_per_run: cfg.scan.maxRequestsPerRun,
				max_run_wall_ms: cfg.scan.maxRunWallMs,
				scan_pages_per_game: cfg.scan.pagesPerGame,
				scan_items_per_page: cfg.scan.itemsPerPage,
				details_top_n: cfg.scan.detailsTopN,
				details_per_tick: cfg.scan.detailsPerTick,
			},
			spread: {
				min_profit_pct: cfg.spread.minProfitPct,
				min_volume_24h: cfg.spread.minVolume24h,
				min_buy_price_cents: cfg.spread.minBuyPriceCents,
				detail_fresh_ms: cfg.spread.detailFreshMs,
				detector_interval_ms: cfg.spread.detectorIntervalMs,
				snapshot_max_age_ms: cfg.spread.snapshotMaxAgeMs,
			},
			logging: {
				success_sample_every_n: cfg.logging.successSampleN,
				success_requests_are_sampled: cfg.logging.successSampleN > 1,
				all_failed_requests_are_logged: true,
			},
		},
		scheduler: {
			last_tick_at: number(state[STATE_KEYS.lastTickAt]) || null,
			last_tick_at_iso: toIso(number(state[STATE_KEYS.lastTickAt]) || null),
			last_successful_scan_at: lastScanAt,
			last_successful_scan_at_iso: toIso(lastScanAt),
			last_successful_scan_age_ms: lastScanAgeMs,
			last_spread_run_at: number(state[STATE_KEYS.lastSpreadRunAt]) || null,
			last_spread_run_at_iso: toIso(number(state[STATE_KEYS.lastSpreadRunAt]) || null),
			paused_until: isPaused ? pausedUntil : null,
			paused_until_iso: isPaused ? toIso(pausedUntil) : null,
			consecutive_429: number(state[STATE_KEYS.consecutive429]),
			last_tick_lock_since: lockSince || null,
			last_tick_lock_age_ms: lockSince ? Math.max(0, now - lockSince) : null,
			total_steam_requests: number(state[STATE_KEYS.totalSteamRequests]),
			total_steam_errors: number(state[STATE_KEYS.totalSteamErrors]),
			last_tick_summary: sanitizeJson(parseJson(state[STATE_KEYS.lastTickSummary] ?? null)),
		},
		queue: {
			total: gameDiagnostics.reduce((sum, game) => sum + game.queue.total, 0),
			due_now: gameDiagnostics.reduce((sum, game) => sum + game.queue.due_now, 0),
			waiting_for_retry: gameDiagnostics.reduce((sum, game) => sum + game.queue.waiting_for_retry, 0),
			by_appid: gameDiagnostics.filter((game) => game.queue.total > 0).map((game) => ({ appid: game.appid, name: game.name, ...game.queue })),
			preview: queuePreviewResult.results.map((row) => ({
				appid: row.appid,
				game_name: row.game_name,
				tier: row.tier,
				item_id: row.item_id,
				priority: row.priority,
				attempts: row.attempts,
				due_at: row.due_at,
				due_at_iso: toIso(row.due_at),
				due_in_ms: Math.max(0, row.due_at - now),
				item_nameid_cached: row.item_nameid !== null,
				detail_at: row.detail_at,
				detail_at_iso: toIso(row.detail_at),
				volume_known: row.volume_24h !== null,
				buy_max_known: row.buy_max_price !== null && row.buy_max_price > 0,
				last_error: safeError(row.last_error),
			})),
		},
		games: gameDiagnostics,
		request_activity_24h: {
			logged_rows: requestRollupResult.results.reduce((sum, row) => sum + number(row.logged_rows), 0),
			failed_rows: requestRollupResult.results.reduce((sum, row) => sum + number(row.failed_rows), 0),
			http_429_rows: requestRollupResult.results.reduce((sum, row) => sum + number(row.http_429_rows), 0),
			successful_rows_are_sampled: cfg.logging.successSampleN > 1,
			by_endpoint_and_status: requestRollupResult.results.map((row) => ({
				endpoint: row.endpoint,
				http_status: row.status,
				logged_rows: number(row.logged_rows),
				failed_rows: number(row.failed_rows),
				http_429_rows: number(row.http_429_rows),
				avg_duration_ms: row.avg_duration_ms,
				last_at: row.last_at,
				last_at_iso: toIso(row.last_at),
			})),
		},
		recent_request_log: requestLogResult.results.map((row) => ({
			id: row.id,
			endpoint: row.endpoint,
			appid: row.appid,
			item_id: row.item_id,
			http_status: row.status,
			duration_ms: row.duration_ms,
			ok: row.ok === 1,
			error: safeError(row.error),
			created_at: row.created_at,
			created_at_iso: toIso(row.created_at),
		})),
		recent_failures: requestErrorResult.results.map((row) => ({
			id: row.id,
			endpoint: row.endpoint,
			appid: row.appid,
			item_id: row.item_id,
			http_status: row.status,
			duration_ms: row.duration_ms,
			error: safeError(row.error),
			created_at: row.created_at,
			created_at_iso: toIso(row.created_at),
		})),
		tick_history_24h: {
			available: tickLogAvailable,
			rows_captured: tickRows.length,
			first_tick_at: tickRows.length ? tickRows[tickRows.length - 1]!.started_at : null,
			first_tick_at_iso: tickRows.length ? toIso(tickRows[tickRows.length - 1]!.started_at) : null,
			hourly: aggregateTickHistory(tickRows),
			recent_ticks: recentTicks,
		},
		notes: [
			'Успешные HTTP-запросы в recent_request_log семплируются согласно logging.success_sample_every_n; ошибки записываются все.',
			'Очередь preview содержит item_id, но не содержит названий предметов или сырых URL Steam.',
			'Детали cron сохраняются по каждому запуску; почасовая сводка покрывает последние 24 часа, если журнал был включён всё это время.',
		],
	};

	return c.json(response);
});

export default diagnostics;
