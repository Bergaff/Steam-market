import type { Env } from './env';

/** Fully-parsed runtime configuration with sane defaults (TZ §11). */
export interface RuntimeConfig {
	steam: {
		currency: number;
		language: string;
		country: string;
		userAgent: string;
		proxyUrl: string | null;
	};
	scan: {
		minRequestIntervalMs: number;
		maxRequestsPerRun: number;
		maxRunWallMs: number;
		pagesPerGame: number;
		itemsPerPage: number;
		detailsTopN: number;
		detailsPerTick: number;
	};
	spread: {
		minProfitPct: number;
		minVolume24h: number;
		minBuyPriceCents: number;
		snapshotMaxAgeMs: number;
		detectorIntervalMs: number;
	};
	api: {
		rateLimitPerMin: number;
		adminApiKey: string | null;
	};
	maintenance: {
		retentionDays: number;
	};
	rateLimitResponse: {
		retryAfterMs: number;
		longPauseAfterCount: number;
		longPauseMs: number;
	};
	demoMode: boolean;
}

function int(value: string | undefined, fallback: number): number {
	if (value === undefined || value === '') return fallback;
	const n = parseInt(value, 10);
	return Number.isFinite(n) ? n : fallback;
}

function str(value: string | undefined, fallback: string): string {
	return value === undefined || value === '' ? fallback : value;
}

const DEFAULT_USER_AGENT =
	'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

export function loadConfig(env: Env): RuntimeConfig {
	return {
		steam: {
			currency: int(env.STEAM_CURRENCY, 5),
			language: str(env.STEAM_LANGUAGE, 'russian'),
			country: str(env.STEAM_COUNTRY, 'RU'),
			userAgent: str(env.SCAN_USER_AGENT, DEFAULT_USER_AGENT),
			proxyUrl: env.PROXY_URL && env.PROXY_URL.length > 0 ? env.PROXY_URL : null,
		},
		scan: {
			minRequestIntervalMs: int(env.MIN_REQUEST_INTERVAL_MS, 2500),
			maxRequestsPerRun: int(env.MAX_STEAM_REQUESTS_PER_RUN, 30),
			maxRunWallMs: int(env.MAX_RUN_WALL_MS, 9 * 60 * 1000),
			pagesPerGame: int(env.SCAN_PAGES_PER_GAME, 10),
			itemsPerPage: Math.min(100, Math.max(10, int(env.SCAN_ITEMS_PER_PAGE, 100))),
			detailsTopN: int(env.DETAILS_TOP_N, 20),
			detailsPerTick: int(env.DETAILS_PER_TICK, 6),
		},
		spread: {
			minProfitPct: int(env.MIN_SPREAD_PCT, 10),
			minVolume24h: int(env.MIN_VOLUME_24H, 5),
			minBuyPriceCents: int(env.MIN_BUY_PRICE_CENTS, 500),
			snapshotMaxAgeMs: int(env.SNAPSHOT_MAX_AGE_MS, 3 * 60 * 60 * 1000),
			detectorIntervalMs: int(env.SPREAD_INTERVAL_MS, 2 * 60 * 1000),
		},
		api: {
			rateLimitPerMin: int(env.RATE_LIMIT_PER_MIN, 60),
			adminApiKey: env.ADMIN_API_KEY && env.ADMIN_API_KEY.length > 0 ? env.ADMIN_API_KEY : null,
		},
		maintenance: {
			retentionDays: int(env.RETENTION_DAYS, 35),
		},
		rateLimitResponse: {
			retryAfterMs: int(env.RETRY_AFTER_429_MS, 60_000),
			longPauseAfterCount: int(env.LONG_PAUSE_AFTER_429_COUNT, 3),
			longPauseMs: int(env.LONG_PAUSE_MS, 5 * 60 * 1000),
		},
		demoMode: str(env.DEMO_MODE, '0') === '1',
	};
}

export type Config = RuntimeConfig;

/** ISO currency code for the configured Steam currency (for API responses). */
const CURRENCY_CODES: Record<number, string> = {
	1: 'USD',
	2: 'GBP',
	3: 'EUR',
	5: 'RUB',
	6: 'PLN',
	7: 'BRL',
	9: 'JPY',
	10: 'NOK',
	11: 'IDR',
	12: 'MYR',
	13: 'PHP',
	14: 'SGD',
	15: 'THB',
	16: 'VND',
	17: 'KRW',
	18: 'TRY',
	19: 'UAH',
	20: 'MXN',
	21: 'CAD',
	22: 'AUD',
	23: 'NZD',
	24: 'CNY',
	25: 'INR',
	26: 'CLP',
	27: 'PEN',
	28: 'COP',
	29: 'ZAR',
	30: 'HKD',
	31: 'TWD',
	32: 'SAR',
	33: 'AED',
	34: 'SEK',
	35: 'ARS',
	36: 'ILS',
	37: 'BYN',
	38: 'KZT',
	39: 'KWD',
	40: 'QAR',
	41: 'CRC',
	42: 'UYU',
	43: 'RUB', // alternative RUB slot used by some storefronts
};

export function currencyCode(cfg: RuntimeConfig): string {
	return CURRENCY_CODES[cfg.steam.currency] ?? 'RUB';
}
