/** Small time helpers. All timestamps are unix epoch milliseconds. */

export function nowMs(): number {
	return Date.now();
}

export function toIso(ms: number | null | undefined): string | null {
	if (ms === null || ms === undefined) return null;
	return new Date(ms).toISOString();
}

export function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Deterministic-ish jitter in [0, maxMs). */
export function jitter(maxMs: number): number {
	return Math.floor(Math.random() * maxMs);
}

/** Chunk an array into slices of at most `size` elements. */
export function chunk<T>(items: T[], size: number): T[][] {
	const out: T[][] = [];
	for (let i = 0; i < items.length; i += size) {
		out.push(items.slice(i, i + size));
	}
	return out;
}

/** Clamp helper for pagination params. */
export function clampInt(value: number, min: number, max: number, fallback: number): number {
	if (!Number.isFinite(value)) return fallback;
	return Math.min(max, Math.max(min, Math.trunc(value)));
}
