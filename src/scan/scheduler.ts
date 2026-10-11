/**
 * Scheduler — one Cron Trigger (`* * * * *`) drives everything (TZ §6):
 *
 *   1. global pause check (after Steam 429s);
 *   2. spread detector — every SPREAD_INTERVAL_MS (2 min), pure DB work;
 *   3. worker 1 — scan ONE due game per tick (games are due per their own
 *      scan_interval_sec: tier1=5min, tier2=15min, tier3=30min);
 *   4. worker 2 — process the detail queue with whatever request budget is left;
 *   5. housekeeping — once per day (retention cleanup).
 *
 * Every invocation is bounded by WorkBudget (max Steam requests + wall-clock
 * deadline) to stay within Workers platform limits.
 */

import type { Env } from '../env';
import type { RuntimeConfig } from '../config';
import { nowMs } from '../lib/time';
import { STATE_KEYS, getStateInt, setState, incrementState, getState } from '../db/state';
import { createSteamClient } from './clientFactory';
import { WorkBudget } from './budget';
import { pickDueGames, scanGameList, type ListScanResult } from './listScanner';
import { processDetailQueue, type DetailScanResult } from './detailScanner';
import { detectSpreads, type SpreadRunResult } from './spreadDetector';
import { runHousekeeping, type HousekeepingResult } from './housekeeping';
import { RateLimitedError } from '../steam/client';
import { runDemoTick, type DemoTickResult } from '../demo/simulator';

export interface TickSummary {
	ranAt: number;
	mode: 'live' | 'demo';
	skipped?: 'paused' | 'locked';
	pausedUntil?: number;
	spread?: SpreadRunResult;
	gamesScanned: ListScanResult[];
	details?: DetailScanResult;
	housekeeping?: HousekeepingResult;
	steamRequests: number;
	steamErrors: number;
	error?: string;
	demo?: DemoTickResult;
	durationMs: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

export async function runSchedulerTick(db: D1Database, cfg: RuntimeConfig): Promise<TickSummary> {
	const started = Date.now();
	const now = nowMs();
	const summary: TickSummary = {
		ranAt: now,
		mode: cfg.demoMode ? 'demo' : 'live',
		gamesScanned: [],
		steamRequests: 0,
		steamErrors: 0,
		durationMs: 0,
	};

	// ------------------------------------------------------------------ demo
	if (cfg.demoMode) {
		summary.demo = await runDemoTick(db, cfg);
		summary.spread = await detectSpreads(db, cfg);
		await setState(db, STATE_KEYS.lastSpreadRunAt, now);
		await setState(db, STATE_KEYS.lastTickAt, now);
		await setState(db, STATE_KEYS.lastTickSummary, JSON.stringify(summarizeForState(summary)));
		summary.durationMs = Date.now() - started;
		return summary;
	}

	// ----------------------------------------------------------------- pause
	const pausedUntil = await getStateInt(db, STATE_KEYS.pausedUntil);
	if (pausedUntil > now) {
		summary.skipped = 'paused';
		summary.pausedUntil = pausedUntil;
		await setState(db, STATE_KEYS.lastTickAt, now);
		summary.durationMs = Date.now() - started;
		return summary;
	}

	// ------------------------------------------------------------------ lock
	// Best-effort overlap guard: skip if a previous tick is still running.
	const lockSince = await getStateInt(db, 'tick_lock_since');
	const lockMaxAgeMs = cfg.scan.maxRunWallMs + 60_000;
	if (lockSince > 0 && now - lockSince < lockMaxAgeMs) {
		summary.skipped = 'locked';
		summary.durationMs = Date.now() - started;
		return summary;
	}
	await setState(db, 'tick_lock_since', now);

	const client = createSteamClient(db, cfg);
	const budget = new WorkBudget(cfg.scan.maxRequestsPerRun, cfg.scan.maxRunWallMs, now);

	try {
		// ------------------------------------------- 2. spread detector (2 min)
		const lastSpread = await getStateInt(db, STATE_KEYS.lastSpreadRunAt);
		if (now - lastSpread >= cfg.spread.detectorIntervalMs) {
			summary.spread = await detectSpreads(db, cfg);
			await setState(db, STATE_KEYS.lastSpreadRunAt, now);
		}

		// ------------------------------------------ 3. worker 1: one due game
		if (budget.canRequest()) {
			const dueGames = await pickDueGames(db, 1, now);
			for (const game of dueGames) {
				if (!budget.canRequest()) break;
				const scanResult = await scanGameList(db, cfg, client, game, budget);
				summary.gamesScanned.push(scanResult);
			}
		}

		// ------------------------------------------ 4. worker 2: detail queue
		if (budget.canAfford(2)) {
			summary.details = await processDetailQueue(db, cfg, client, budget, cfg.scan.detailsPerTick);
		}

		// ---------------------------------------------- 5. housekeeping (1/day)
		const lastHousekeeping = await getStateInt(db, STATE_KEYS.lastHousekeepingAt);
		if (now - lastHousekeeping >= DAY_MS) {
			summary.housekeeping = await runHousekeeping(db, cfg);
			await setState(db, STATE_KEYS.lastHousekeepingAt, now);
		}

		// -------------------------------------------------------- bookkeeping
		if (client.requests > 0 && client.errors === 0 && !client.wasRateLimited) {
			await setState(db, STATE_KEYS.lastSuccessfulScanAt, now);
			await setState(db, STATE_KEYS.consecutive429, 0);
		}
	} catch (err) {
		if (err instanceof RateLimitedError) {
			// TZ §10: pause 30–60s after a 429; after a series of 429s — 5 minutes.
			const hits = (await getStateInt(db, STATE_KEYS.consecutive429)) + 1;
			await setState(db, STATE_KEYS.consecutive429, hits);
			const pauseMs =
				hits >= cfg.rateLimitResponse.longPauseAfterCount
					? cfg.rateLimitResponse.longPauseMs
					: Math.max(err.retryAfterMs, cfg.rateLimitResponse.retryAfterMs);
			await setState(db, STATE_KEYS.pausedUntil, now + pauseMs);
			summary.pausedUntil = now + pauseMs;
			summary.error = `rate limited (consecutive 429: ${hits}), paused for ${pauseMs}ms`;
			console.error(`[scheduler] ${summary.error}`);
		} else {
			summary.error = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
			console.error('[scheduler] tick failed:', summary.error);
		}
	} finally {
		summary.steamRequests = client.requests;
		summary.steamErrors = client.errors;
		if (client.requests > 0) await incrementState(db, STATE_KEYS.totalSteamRequests, 0); // touch updated_at
		await setState(db, 'tick_lock_since', 0);
		await setState(db, STATE_KEYS.lastTickAt, now);
		summary.durationMs = Date.now() - started;
		await setState(db, STATE_KEYS.lastTickSummary, JSON.stringify(summarizeForState(summary)));
	}

	return summary;
}

/** Compact version of the summary for scheduler_state (debugging via /health). */
function summarizeForState(s: TickSummary): object {
	return {
		ranAt: s.ranAt,
		mode: s.mode,
		skipped: s.skipped,
		games: s.gamesScanned.map((g) => ({ appid: g.appid, status: g.status, items: g.itemsUpserted })),
		details: s.details ? { ok: s.details.succeeded, failed: s.details.failed } : undefined,
		spread: s.spread ? { active: s.spread.qualifying, off: s.spread.deactivated } : undefined,
		reqs: s.steamRequests,
		errs: s.steamErrors,
		error: s.error,
		ms: s.durationMs,
	};
}

/** Entry point called from the `scheduled` handler. */
export async function handleScheduled(env: Env, cfg: RuntimeConfig): Promise<TickSummary> {
	const summary = await runSchedulerTick(env.DB, cfg);
	console.log(`[scheduler] tick: ${JSON.stringify(summarizeForState(summary))}`);
	return summary;
}

export async function getPausedUntil(db: D1Database): Promise<number> {
	return getStateInt(db, STATE_KEYS.pausedUntil);
}

export async function getLastTickSummary(db: D1Database): Promise<string | null> {
	return getState(db, STATE_KEYS.lastTickSummary);
}
