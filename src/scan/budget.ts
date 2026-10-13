/**
 * WorkBudget bounds a single scheduler invocation:
 *  - max number of Steam requests (free plan: 50 subrequests per invocation,
 *    so the default cap of 30 leaves headroom for logging/admin calls);
 *  - wall-clock deadline (scheduled events may run up to ~15 min; we stop earlier).
 */
export class WorkBudget {
	private used = 0;
	private readonly deadlineMs: number;

	constructor(
		private readonly maxRequests: number,
		maxWallMs: number,
		startMs: number = Date.now()
	) {
		this.deadlineMs = startMs + maxWallMs;
	}

	consume(n = 1): void {
		this.used += n;
	}

	get usedRequests(): number {
		return this.used;
	}

	get timeLeftMs(): number {
		return Math.max(0, this.deadlineMs - Date.now());
	}

	/** True when at least one more request fits into budget and deadline. */
	canRequest(): boolean {
		return this.used < this.maxRequests && Date.now() < this.deadlineMs;
	}

	/** True when `k` more requests still fit (reserve ahead of multi-call items). */
	canAfford(k: number): boolean {
		return this.used + k <= this.maxRequests && Date.now() < this.deadlineMs;
	}
}
