import { beforeEach, describe, expect, it, vi } from 'vitest';
import { processDetailQueue } from '../src/scan/detailScanner';
import { WorkBudget } from '../src/scan/budget';
import type { RuntimeConfig } from '../src/config';
import type { SteamClient } from '../src/steam/client';

const endpointMocks = vi.hoisted(() => ({
	fetchPriceOverview: vi.fn(),
	fetchItemNameid: vi.fn(),
	fetchOrdersHistogram: vi.fn(),
}));

vi.mock('../src/steam/endpoints', () => endpointMocks);

function makeDb() {
	const executions: Array<{ sql: string; bindings: unknown[] }> = [];
	const batchedSql: string[] = [];
	const queueRow = {
		item_id: 17,
		appid: 440,
		hash_name: 'Example Item',
		item_nameid: null,
		attempts: 0,
	};

	const db = {
		prepare(sql: string) {
			let bindings: unknown[] = [];
			const statement = {
				sql,
				bind(...values: unknown[]) {
					bindings = values;
					return statement;
				},
				async all() {
					return sql.includes('FROM scan_queue q') ? { results: [queueRow] } : { results: [] };
				},
				async first() {
					return null;
				},
				async run() {
					executions.push({ sql, bindings });
					return { meta: { changes: 1 } };
				},
			};
			return statement;
		},
		async batch(statements: Array<{ sql?: string }>) {
			batchedSql.push(...statements.map((statement) => statement.sql ?? ''));
			return [];
		},
	};

	return { db: db as unknown as D1Database, executions, batchedSql };
}

describe('processDetailQueue', () => {
	beforeEach(() => {
		vi.resetAllMocks();
	});

	it('fetches and stores priceoverview volume even when item_nameid is not found', async () => {
		const order: string[] = [];
		endpointMocks.fetchPriceOverview.mockImplementation(async () => {
			order.push('priceoverview');
			return {
				lowestPriceCents: 125,
				medianPriceCents: 120,
				volume24h: 23,
				sellListings: 8,
				currency: 'USD',
			};
		});
		endpointMocks.fetchItemNameid.mockImplementation(async () => {
			order.push('item_page');
			return null;
		});

		const { db, executions, batchedSql } = makeDb();
		const cfg = {
			steam: { currency: 1 },
			scan: { snapshotHeartbeatMs: 4 * 60 * 60 * 1000 },
		} as RuntimeConfig;
		const client = {} as SteamClient;
		const result = await processDetailQueue(db, cfg, client, new WorkBudget(3, 60_000), 6);

		expect(order).toEqual(['priceoverview', 'item_page']);
		expect(endpointMocks.fetchOrdersHistogram).not.toHaveBeenCalled();
		expect(result.volumeRetrieved).toBe(1);
		expect(result.nameidMissing).toBe(1);
		expect(result.succeeded).toBe(1);
		expect(result.failed).toBe(0);
		expect(batchedSql.some((sql) => sql.includes('INSERT INTO price_snapshots'))).toBe(true);
		const retry = executions.find(({ sql }) => sql.includes('UPDATE scan_queue SET attempts'));
		expect(retry?.bindings.at(-2)).toContain('item_nameid not found');
	});
});
