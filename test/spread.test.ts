import { describe, it, expect } from 'vitest';
import { computeNetProfit, STEAM_FEE_FACTOR } from '../src/scan/spreadDetector';
import { parsePeriodMs, csvCell, centsToUnits } from '../src/routes/dto';
import { loadConfig, currencyCode } from '../src/config';
import type { Env } from '../src/env';

describe('computeNetProfit (TZ formula)', () => {
	it('uses the 15% Steam fee: net = sell*0.85 - buy', () => {
		expect(STEAM_FEE_FACTOR).toBe(0.85);
		// sell 60.00, buy 40.00 -> 6000*0.85 = 5100 - 4000 = 1100 cents (27.5%)
		const r = computeNetProfit(6000, 4000);
		expect(r.netCents).toBe(1100);
		expect(r.pct).toBeCloseTo(27.5, 5);
	});

	it('rounds to whole cents', () => {
		// sell 48.90 -> 4890*0.85 = 4156.5 -> 4157 (Math.round)
		const r = computeNetProfit(4890, 4355);
		expect(r.netCents).toBe(4157 - 4355);
		expect(r.pct).toBeCloseTo(((4157 - 4355) / 4355) * 100, 5);
	});

	it('handles break-even and negative spreads', () => {
		expect(computeNetProfit(1000, 850).netCents).toBe(0); // 850 - 850
		expect(computeNetProfit(1000, 900).netCents).toBe(-50);
		expect(computeNetProfit(1000, 900).pct).toBeCloseTo((-50 / 900) * 100, 5);
	});

	it('guards against zero buy price', () => {
		expect(computeNetProfit(1000, 0).pct).toBe(0);
	});

	it('matches the TZ threshold example (>=10% qualifies)', () => {
		// buy 50.00, sell 60.00 -> 5100-5000 = 100 -> 2% — NOT a signal
		expect(computeNetProfit(6000, 5000).pct).toBeCloseTo(2, 5);
		// buy 50.00, sell 68.00 -> 5780-5000 = 780 -> 15.6% — signal
		expect(computeNetProfit(6800, 5000).pct).toBeGreaterThanOrEqual(10);
	});
});

describe('parsePeriodMs', () => {
	it('maps known periods', () => {
		expect(parsePeriodMs('24h')).toEqual({ period: '24h', ms: 86_400_000 });
		expect(parsePeriodMs('7d')).toEqual({ period: '7d', ms: 7 * 86_400_000 });
		expect(parsePeriodMs('30d')).toEqual({ period: '30d', ms: 30 * 86_400_000 });
	});

	it('falls back to 7d for unknown values', () => {
		expect(parsePeriodMs('1y').period).toBe('7d');
		expect(parsePeriodMs(undefined).period).toBe('7d');
	});
});

describe('CSV helpers', () => {
	it('escapes quotes and separators', () => {
		expect(csvCell('plain')).toBe('plain');
		expect(csvCell('with;semicolon')).toBe('"with;semicolon"');
		expect(csvCell('with "quotes"')).toBe('"with ""quotes"""');
		expect(csvCell(null)).toBe('');
		expect(csvCell(42)).toBe('42');
	});

	it('converts cents to decimal units', () => {
		expect(centsToUnits(12345)).toBe('123.45');
		expect(centsToUnits(500)).toBe('5.00');
		expect(centsToUnits(null)).toBe('');
	});
});

describe('loadConfig defaults (TZ §11)', () => {
	it('applies spec defaults when env is empty', () => {
		const cfg = loadConfig({} as Env);
		expect(cfg.steam.currency).toBe(5);
		expect(cfg.steam.language).toBe('russian');
		expect(cfg.spread.minProfitPct).toBe(10);
		expect(cfg.spread.minVolume24h).toBe(5);
		expect(cfg.spread.minBuyPriceCents).toBe(500);
		expect(cfg.scan.minRequestIntervalMs).toBe(2500);
		expect(cfg.api.rateLimitPerMin).toBe(60);
		expect(cfg.demoMode).toBe(false);
		expect(currencyCode(cfg)).toBe('RUB');
	});

	it('honors env overrides', () => {
		const cfg = loadConfig({
			STEAM_CURRENCY: '1',
			MIN_SPREAD_PCT: '25',
			MIN_VOLUME_24H: '10',
			MIN_BUY_PRICE_CENTS: '1000',
			DEMO_MODE: '1',
			ADMIN_API_KEY: 'secret',
		} as Env);
		expect(cfg.steam.currency).toBe(1);
		expect(currencyCode(cfg)).toBe('USD');
		expect(cfg.spread.minProfitPct).toBe(25);
		expect(cfg.spread.minVolume24h).toBe(10);
		expect(cfg.spread.minBuyPriceCents).toBe(1000);
		expect(cfg.demoMode).toBe(true);
		expect(cfg.api.adminApiKey).toBe('secret');
	});

	it('ignores garbage numeric env values', () => {
		const cfg = loadConfig({ MIN_SPREAD_PCT: 'abc', RATE_LIMIT_PER_MIN: '' } as Env);
		expect(cfg.spread.minProfitPct).toBe(10);
		expect(cfg.api.rateLimitPerMin).toBe(60);
	});
});
