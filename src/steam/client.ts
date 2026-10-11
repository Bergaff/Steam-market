/**
 * SteamClient — the single entry point for ALL Steam Community Market HTTP
 * requests (TZ §13). Responsibilities:
 *
 *   - pacing: at most 1 request per `minRequestIntervalMs` (safe 2–3s per IP);
 *   - retries: 3 attempts with exponential backoff + jitter for network
 *     errors, 5xx and transient 403;
 *   - HTTP 429: never retried in-place — throws RateLimitedError so the
 *     scheduler can pause globally (30–60s, or 5 minutes after repeated hits);
 *   - logging: every attempt is reported through an onLog callback
 *     (endpoint, status, duration, error) for the scan_log table;
 *   - optional proxy hook (`proxyUrl`) for future IP rotation.
 */

import { sleep, jitter } from '../lib/time';
import type { RuntimeConfig } from '../config';

export class RateLimitedError extends Error {
	readonly retryAfterMs: number;
	constructor(retryAfterMs: number) {
		super(`Steam rate limit hit (HTTP 429), backing off for ${retryAfterMs}ms`);
		this.name = 'RateLimitedError';
		this.retryAfterMs = retryAfterMs;
	}
}

export class SteamHttpError extends Error {
	readonly status: number;
	readonly body: string;
	constructor(status: number, body: string) {
		super(`Steam HTTP error ${status}`);
		this.name = 'SteamHttpError';
		this.status = status;
		this.body = body.slice(0, 500);
	}
}

export interface SteamRequestLogEntry {
	endpoint: string;
	url: string;
	status: number; // HTTP status; 0 = network error
	durationMs: number;
	ok: boolean;
	error: string | null;
	appid: number | null;
	itemId: number | null;
}

export type SteamRequestLogger = (entry: SteamRequestLogEntry) => Promise<void> | void;

export interface SteamRequestContext {
	appid?: number | null;
	itemId?: number | null;
}

const MAX_ATTEMPTS = 3;
const BACKOFF_BASE_MS = 2000;

/** Errors that should abort immediately (no in-client retry). */
function isFatal(err: unknown): boolean {
	return err instanceof RateLimitedError || err instanceof SteamHttpError;
}

export class SteamClient {
	private lastRequestAt = 0;
	private requestCount = 0;
	private errorCount = 0;
	private rateLimited = false;

	constructor(
		private readonly cfg: RuntimeConfig,
		private readonly log: SteamRequestLogger
	) {}

	get requests(): number {
		return this.requestCount;
	}
	get errors(): number {
		return this.errorCount;
	}
	get wasRateLimited(): boolean {
		return this.rateLimited;
	}

	/** Wait until the pacing window allows the next request (±15% jitter). */
	private async pace(): Promise<void> {
		const interval = this.cfg.scan.minRequestIntervalMs;
		// Human-like rhythm: vary the pause by ±15% around the configured interval.
		const jittered = Math.round(interval * 0.85 + jitter(interval * 0.3));
		const waitMs = this.lastRequestAt + jittered - Date.now();
		if (waitMs > 0) await sleep(waitMs);
		this.lastRequestAt = Date.now();
	}

	/** Apply the optional forwarding proxy (for future IP rotation). */
	private proxied(url: string): string {
		const proxy = this.cfg.steam.proxyUrl;
		if (!proxy) return url;
		const sep = proxy.includes('?') ? '&' : '?';
		return `${proxy}${sep}url=${encodeURIComponent(url)}`;
	}

	private headers(): HeadersInit {
		// Steam_Language controls the market localization (names/prices).
		// An optional owner-provided session cookie (secret) dramatically
		// raises Steam's anonymous-IP rate limits; never requested from
		// site visitors.
		const baseCookies = `Steam_Language=${this.cfg.steam.language}; wants_mature_content=1`;
		const cookie = this.cfg.steam.webCookie ? `${this.cfg.steam.webCookie}; ${baseCookies}` : baseCookies;
		return {
			'User-Agent': this.cfg.steam.userAgent,
			Accept: 'application/json, text/html;q=0.9, */*;q=0.8',
			'Accept-Language': 'ru-RU,ru;q=0.9,en;q=0.5',
			Cookie: cookie,
		};
	}

	/**
	 * Perform a GET request with pacing, retries and logging.
	 * Returns the response body text on success.
	 * Throws RateLimitedError on 429, SteamHttpError on other failures.
	 */
	async getText(url: string, endpoint: string, ctx: SteamRequestContext = {}): Promise<string> {
		let lastError: unknown = null;

		for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
			await this.pace();
			this.requestCount++;

			const started = Date.now();
			let status = 0;
			let body = '';
			let ok = false;
			let errorMsg: string | null = null;

			try {
				const resp = await fetch(this.proxied(url), {
					headers: this.headers(),
					redirect: 'follow',
				});
				status = resp.status;
				body = await resp.text();

				if (status === 429) {
					// Never hammer a rate-limited endpoint: abort the whole run.
					this.rateLimited = true;
					this.errorCount++;
					const retryAfterHeader = parseInt(resp.headers.get('Retry-After') ?? '', 10);
					const retryAfterMs =
						Number.isFinite(retryAfterHeader) && retryAfterHeader > 0
							? retryAfterHeader * 1000
							: this.cfg.rateLimitResponse.retryAfterMs;
					await this.emitLog(endpoint, url, status, Date.now() - started, false, 'HTTP 429 Too Many Requests', ctx);
					throw new RateLimitedError(retryAfterMs);
				}

				if (resp.ok) {
					ok = true;
				} else if (status >= 500 || status === 403) {
					// Transient server errors / occasional throttling: retry.
					errorMsg = `HTTP ${status}`;
					lastError = new SteamHttpError(status, body);
				} else {
					// Other 4xx (404, 400...): permanent, do not retry.
					this.errorCount++;
					errorMsg = `HTTP ${status}`;
					await this.emitLog(endpoint, url, status, Date.now() - started, false, errorMsg, ctx);
					throw new SteamHttpError(status, body);
				}
			} catch (err) {
				if (isFatal(err)) throw err; // already logged above
				// Network error (DNS, timeout, offline sandbox...) — retryable.
				lastError = err;
				errorMsg = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
			}

			await this.emitLog(endpoint, url, status, Date.now() - started, ok, ok ? null : errorMsg, ctx);
			if (ok) return body;

			if (attempt < MAX_ATTEMPTS) {
				await sleep(BACKOFF_BASE_MS * Math.pow(2, attempt - 1) + jitter(1000));
			}
		}

		this.errorCount++;
		if (lastError instanceof SteamHttpError) throw lastError;
		throw new SteamHttpError(0, lastError instanceof Error ? lastError.message : 'unknown network error');
	}

	/** Perform a GET request and parse JSON. */
	async getJson<T = unknown>(url: string, endpoint: string, ctx: SteamRequestContext = {}): Promise<T> {
		const text = await this.getText(url, endpoint, ctx);
		return JSON.parse(text) as T;
	}

	private async emitLog(
		endpoint: string,
		url: string,
		status: number,
		durationMs: number,
		ok: boolean,
		error: string | null,
		ctx: SteamRequestContext
	): Promise<void> {
		try {
			await this.log({
				endpoint,
				url: url.slice(0, 2000),
				status,
				durationMs,
				ok,
				error,
				appid: ctx.appid ?? null,
				itemId: ctx.itemId ?? null,
			});
		} catch {
			// Logging must never break scraping.
		}
	}
}
