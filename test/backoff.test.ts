import { describe, expect, it } from 'vitest';
import { compute429PauseMs } from '../src/scan/scheduler';
import { loadConfig } from '../src/config';
import type { Env } from '../src/env';

const cfg = loadConfig({
	RETRY_AFTER_429_MS: '60000',
	LONG_PAUSE_AFTER_429_COUNT: '3',
	LONG_PAUSE_MS: '300000',
	LONG_PAUSE_MAX_MS: '3600000',
} as Env);

const MIN = 60_000;

describe('compute429PauseMs — TZ §10 + exponential backoff', () => {
	it('single 429s pause ~60s (or Retry-After when larger)', () => {
		expect(compute429PauseMs(cfg, 1, 0)).toBe(MIN);
		expect(compute429PauseMs(cfg, 2, 0)).toBe(MIN);
		expect(compute429PauseMs(cfg, 1, 90_000)).toBe(90_000);
	});

	it('third consecutive 429 starts the long pause (5 min)', () => {
		expect(compute429PauseMs(cfg, 3, 0)).toBe(5 * MIN);
	});

	it('doubles while the block persists: 10 → 20 → 40 → 60 min', () => {
		expect(compute429PauseMs(cfg, 4, 0)).toBe(10 * MIN);
		expect(compute429PauseMs(cfg, 5, 0)).toBe(20 * MIN);
		expect(compute429PauseMs(cfg, 6, 0)).toBe(40 * MIN);
		expect(compute429PauseMs(cfg, 7, 0)).toBe(60 * MIN);
	});

	it('never exceeds the configured cap', () => {
		expect(compute429PauseMs(cfg, 8, 0)).toBe(60 * MIN);
		expect(compute429PauseMs(cfg, 50, 0)).toBe(60 * MIN);
	});

	it('Retry-After header wins when larger than the backoff step', () => {
		expect(compute429PauseMs(cfg, 3, 15 * MIN)).toBe(15 * MIN);
	});
});
