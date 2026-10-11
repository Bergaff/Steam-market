/**
 * Bindings and environment variables available to the Worker.
 *
 * Non-secret config lives in wrangler.jsonc ("vars"), secrets are set with
 * `wrangler secret put` (prod) or `.dev.vars` (local dev). All env vars
 * arrive as strings.
 */
export interface Env {
	/** Cloudflare D1 database binding (see wrangler.jsonc). */
	DB: D1Database;
	/** Static assets binding (built frontend in frontend/dist). */
	ASSETS: Fetcher;

	// --- Steam scraping -----------------------------------------------------
	/** Steam currency code, 5 = RUB. */
	STEAM_CURRENCY?: string;
	/** Steam UI language for market endpoints. */
	STEAM_LANGUAGE?: string;
	/** Storefront country code. */
	STEAM_COUNTRY?: string;
	/** Browser-like User-Agent for Steam requests. */
	SCAN_USER_AGENT?: string;
	/** Optional forwarding proxy for Steam requests: `${PROXY_URL}?url=<encoded>`. */
	PROXY_URL?: string;

	// --- Scheduler pacing ---------------------------------------------------
	/** Minimum delay between two Steam requests, ms (safe: 2000–3000). */
	MIN_REQUEST_INTERVAL_MS?: string;
	/** Max Steam requests per single scheduled invocation (free plan: <=50 subrequests). */
	MAX_STEAM_REQUESTS_PER_RUN?: string;
	/** Wall-clock deadline for one scheduled invocation, ms. */
	MAX_RUN_WALL_MS?: string;
	/** How many pages of search/render to fetch per game scan. */
	SCAN_PAGES_PER_GAME?: string;
	/** Page size for search/render (Steam max = 100). */
	SCAN_ITEMS_PER_PAGE?: string;
	/** Top-N items per game (by sell_listings) queued for detail scan. */
	DETAILS_TOP_N?: string;
	/** Max detail-scan items processed per scheduler tick. */
	DETAILS_PER_TICK?: string;
	/** Write a snapshot at least this often even when nothing moved, ms (D1 write saving). */
	SNAPSHOT_HEARTBEAT_MS?: string;

	// --- Spread detector ----------------------------------------------------
	/** Minimum net profit percent to raise a signal. */
	MIN_SPREAD_PCT?: string;
	/** Minimum 24h volume to raise a signal. */
	MIN_VOLUME_24H?: string;
	/** Minimum buy price (cents) — filters out penny junk. */
	MIN_BUY_PRICE_CENTS?: string;
	/** Snapshots older than this are ignored by the detector, ms. */
	SNAPSHOT_MAX_AGE_MS?: string;
	/** Order-book data older than this is ignored by the detector, ms. */
	DETAIL_FRESH_MS?: string;
	/** How often the spread detector runs, ms. */
	SPREAD_INTERVAL_MS?: string;
	/** Log 1 of every N successful Steam requests (errors are always logged). */
	LOG_SUCCESS_SAMPLE_N?: string;

	// --- HTTP API ------------------------------------------------------------
	/** Public API rate limit: requests per minute per IP. */
	RATE_LIMIT_PER_MIN?: string;
	/** Admin API key (secret, X-Admin-Key header). */
	ADMIN_API_KEY?: string;

	// --- Maintenance ----------------------------------------------------------
	/** Snapshots / logs older than this are pruned, days. */
	RETENTION_DAYS?: string;

	// --- 429 handling -----------------------------------------------------------
	/** Pause after a single HTTP 429, ms. */
	RETRY_AFTER_429_MS?: string;
	/** After this many consecutive 429s switch to the long pause. */
	LONG_PAUSE_AFTER_429_COUNT?: string;
	/** Long pause after repeated 429s, ms (TZ §10: 5 minutes). */
	LONG_PAUSE_MS?: string;

	// --- Demo mode -----------------------------------------------------------
	/** "1" = serve synthetic data instead of hitting Steam (local previews). */
	DEMO_MODE?: string;
}
