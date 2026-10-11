/** Typed API client for the Worker REST API (same origin, no CORS issues). */

import type {
	ActivityResponse,
	AppConfig,
	GameDetailsResponse,
	GameListResponse,
	HistoryResponse,
	ItemDetailsResponse,
	ItemsResponse,
	OpportunityListResponse,
	SnapshotsResponse,
	StatsOverview,
} from './types';

const BASE = '/api/v1';

export class ApiError extends Error {
	readonly status: number;
	constructor(status: number, message: string) {
		super(message);
		this.name = 'ApiError';
		this.status = status;
	}
}

async function get<T>(path: string, signal?: AbortSignal): Promise<T> {
	const resp = await fetch(`${BASE}${path}`, { signal });
	if (!resp.ok) {
		let message = `HTTP ${resp.status}`;
		try {
			const body = (await resp.json()) as { error?: string; message?: string };
			message = body.message ?? body.error ?? message;
		} catch {
			/* non-JSON error body */
		}
		throw new ApiError(resp.status, message);
	}
	return (await resp.json()) as T;
}

function qs(params: Record<string, string | number | null | undefined>): string {
	const usp = new URLSearchParams();
	for (const [k, v] of Object.entries(params)) {
		if (v !== null && v !== undefined && v !== '') usp.set(k, String(v));
	}
	const s = usp.toString();
	return s.length > 0 ? `?${s}` : '';
}

export interface ItemsQuery {
	limit?: number;
	offset?: number;
	sort?: string;
	dir?: 'asc' | 'desc';
	min_price_cents?: number | null;
	min_volume?: number | null;
	min_spread_pct?: number | null;
}

export interface OpportunitiesQuery {
	limit?: number;
	offset?: number;
	sort?: string;
	dir?: 'asc' | 'desc';
	min_profit_pct?: number | null;
	min_volume?: number | null;
	appid?: number | null;
}

export const api = {
	config: () => get<AppConfig>('/config'),
	games: () => get<GameListResponse>('/games'),
	game: (appid: number) => get<GameDetailsResponse>(`/games/${appid}`),
	gameItems: (appid: number, q: ItemsQuery = {}) => get<ItemsResponse>(`/games/${appid}/items${qs(q as Record<string, string | number | null | undefined>)}`),
	gameActivity: (appid: number, period: string) => get<ActivityResponse>(`/games/${appid}/activity${qs({ period })}`),
	item: (id: number) => get<ItemDetailsResponse>(`/items/${id}`),
	itemHistory: (id: number, period: string) => get<HistoryResponse>(`/items/${id}/history${qs({ period })}`),
	itemSnapshots: (id: number, limit = 20) => get<SnapshotsResponse>(`/items/${id}/snapshots${qs({ limit })}`),
	opportunities: (q: OpportunitiesQuery = {}) =>
		get<OpportunityListResponse>(`/opportunities${qs(q as Record<string, string | number | null | undefined>)}`),
	stats: () => get<StatsOverview>('/stats/overview'),
	/** Direct link for the CSV export button (browser download). */
	opportunitiesCsvUrl: (q: OpportunitiesQuery = {}) => `${BASE}/opportunities${qs({ ...q, format: 'csv' } as Record<string, string | number | null | undefined>)}`,
};
