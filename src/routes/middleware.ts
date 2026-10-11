/**
 * Shared Hono middleware: setup (config binding), CORS, per-IP rate limiting
 * for public API endpoints (TZ §9), admin API-key auth (TZ §7) and a global
 * JSON error handler.
 */

import type { Context, Next } from 'hono';
import type { Env } from '../env';
import { loadConfig, type RuntimeConfig } from '../config';

export type AppContext = Context<{ Bindings: Env; Variables: { cfg: RuntimeConfig } }>;

/** Parse env into a typed RuntimeConfig once per request. */
export async function setup(c: AppContext, next: Next): Promise<void> {
	c.set('cfg', loadConfig(c.env));
	await next();
}

/** CORS: public read-only API, same-origin frontend. */
export async function cors(c: AppContext, next: Next): Promise<Response | void> {
	c.header('Access-Control-Allow-Origin', '*');
	c.header('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
	c.header('Access-Control-Allow-Headers', 'Content-Type, X-Admin-Key');
	c.header('Access-Control-Max-Age', '86400');
	if (c.req.method === 'OPTIONS') {
		return c.body(null, 204);
	}
	await next();
}

// ---------------------------------------------------------------------------
// Rate limiting (best-effort, per-isolate fixed window: N requests / minute / IP)
// ---------------------------------------------------------------------------

interface WindowRecord {
	count: number;
	resetAt: number;
}

const WINDOW_MS = 60_000;
const MAX_TRACKED_IPS = 20_000;
const hits = new Map<string, WindowRecord>();

export async function rateLimit(c: AppContext, next: Next): Promise<Response | void> {
	const cfg = c.get('cfg');
	const limit = cfg.api.rateLimitPerMin;
	if (limit <= 0) return next();

	const ip = c.req.header('CF-Connecting-IP') ?? c.req.header('X-Forwarded-For') ?? c.req.header('X-Real-IP') ?? 'unknown';
	const now = Date.now();

	let rec = hits.get(ip);
	if (!rec || rec.resetAt <= now) {
		if (hits.size > MAX_TRACKED_IPS) hits.clear(); // crude memory guard
		rec = { count: 0, resetAt: now + WINDOW_MS };
		hits.set(ip, rec);
	}
	rec.count++;

	if (rec.count > limit) {
		c.header('Retry-After', String(Math.ceil((rec.resetAt - now) / 1000)));
		return c.json({ error: 'rate_limit_exceeded', message: `Limit: ${limit} requests per minute per IP` }, 429);
	}
	await next();
}

// ---------------------------------------------------------------------------
// Admin auth: X-Admin-Key header must match ADMIN_API_KEY secret
// ---------------------------------------------------------------------------

/** Length-independent string compare (avoids trivial timing attacks). */
function safeEqual(a: string, b: string): boolean {
	if (a.length !== b.length) return false;
	let diff = 0;
	for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
	return diff === 0;
}

export async function adminAuth(c: AppContext, next: Next): Promise<Response | void> {
	const cfg = c.get('cfg');
	if (!cfg.api.adminApiKey) {
		return c.json(
			{ error: 'admin_disabled', message: 'ADMIN_API_KEY is not configured (set it with `wrangler secret put ADMIN_API_KEY`)' },
			503
		);
	}
	const key = c.req.header('X-Admin-Key');
	if (!key || !safeEqual(key, cfg.api.adminApiKey)) {
		return c.json({ error: 'unauthorized', message: 'Invalid or missing X-Admin-Key header' }, 401);
	}
	await next();
}
