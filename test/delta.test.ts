import { describe, it, expect } from 'vitest';
import { needsSnapshot, needsDetailWrite } from '../src/scan/delta';

const NOW = 1_800_000_000_000;
const HEARTBEAT = 4 * 60 * 60 * 1000; // 4h

describe('needsSnapshot (list scanner delta gate)', () => {
	it('writes when there is no previous state', () => {
		expect(needsSnapshot(null, { sellPriceCents: 1000, sellListings: 5 }, NOW, HEARTBEAT)).toBe(true);
		expect(needsSnapshot({ snapshot_at: null, sell_min_price: null, sell_listings: null }, { sellPriceCents: 1000, sellListings: 5 }, NOW, HEARTBEAT)).toBe(true);
	});

	it('writes when the heartbeat window passed even if nothing moved', () => {
		const prev = { snapshot_at: NOW - HEARTBEAT - 1, sell_min_price: 1000, sell_listings: 10 };
		expect(needsSnapshot(prev, { sellPriceCents: 1000, sellListings: 10 }, NOW, HEARTBEAT)).toBe(true);
	});

	it('skips when price and listings are flat within thresholds', () => {
		const prev = { snapshot_at: NOW - 5 * 60 * 1000, sell_min_price: 100_00, sell_listings: 100 };
		// price move < 1.5% (100.00 -> 100.99), listings move < max(5, 15%) (100 -> 95)
		expect(needsSnapshot(prev, { sellPriceCents: 100_99, sellListings: 95 }, NOW, HEARTBEAT)).toBe(false);
	});

	it('writes when the price moved by >= 1.5%', () => {
		const prev = { snapshot_at: NOW - 5 * 60 * 1000, sell_min_price: 100_00, sell_listings: 100 };
		// 100.00 -> 101.50 = +1.5% (threshold = max(1, round(10000*0.015)) = 150)
		expect(needsSnapshot(prev, { sellPriceCents: 101_50, sellListings: 100 }, NOW, HEARTBEAT)).toBe(true);
		// down move counts too
		expect(needsSnapshot(prev, { sellPriceCents: 98_50, sellListings: 100 }, NOW, HEARTBEAT)).toBe(true);
	});

	it('writes when listings moved by >= max(5, 15%)', () => {
		const prev = { snapshot_at: NOW - 5 * 60 * 1000, sell_min_price: 100_00, sell_listings: 100 };
		expect(needsSnapshot(prev, { sellPriceCents: 100_00, sellListings: 85 }, NOW, HEARTBEAT)).toBe(true); // -15
		expect(needsSnapshot(prev, { sellPriceCents: 100_00, sellListings: 90 }, NOW, HEARTBEAT)).toBe(false); // -10 < 15
		// small listings counts use the absolute floor of 5
		const small = { snapshot_at: NOW - 5 * 60 * 1000, sell_min_price: 100, sell_listings: 10 };
		expect(needsSnapshot(small, { sellPriceCents: 100, sellListings: 5 }, NOW, HEARTBEAT)).toBe(true);
		expect(needsSnapshot(small, { sellPriceCents: 100, sellListings: 7 }, NOW, HEARTBEAT)).toBe(false);
	});

	it('writes when the price appears/disappears (null transitions)', () => {
		const prev = { snapshot_at: NOW - 1000, sell_min_price: null, sell_listings: 0 };
		expect(needsSnapshot(prev, { sellPriceCents: 500, sellListings: 1 }, NOW, HEARTBEAT)).toBe(true);
	});

	it('guarantees at most ~24/heartbeat writes per flat item per day', () => {
		// Simulation: flat item scanned every 5 minutes for 24h.
		let writes = 0;
		let lastWrite = NOW - 24 * 3600 * 1000;
		for (let t = NOW - 24 * 3600 * 1000; t <= NOW; t += 5 * 60 * 1000) {
			const prev = { snapshot_at: lastWrite, sell_min_price: 100_00, sell_listings: 50 };
			if (needsSnapshot(prev, { sellPriceCents: 100_00, sellListings: 50 }, t, HEARTBEAT)) {
				writes++;
				lastWrite = t;
			}
		}
		expect(writes).toBe(6); // 24h / 4h heartbeat
	});
});

describe('needsDetailWrite (detail scanner delta gate)', () => {
	it('writes when there is no state yet', () => {
		expect(needsDetailWrite(null, { buyCents: 500, volume24h: 10 }, NOW, HEARTBEAT)).toBe(true);
	});

	it('skips flat order books within the heartbeat', () => {
		const prev = { snapshot_at: NOW - 10 * 60 * 1000, sell_min_price: 1000, sell_listings: 10, buy_max_price: 800, volume_24h: 20 };
		// buy +0.5% (< 1%), volume +2 (< max(3, 10%))
		expect(needsDetailWrite(prev, { buyCents: 804, volume24h: 22 }, NOW, HEARTBEAT)).toBe(false);
	});

	it('writes when the buy order moved by >= 1%', () => {
		const prev = { snapshot_at: NOW - 10 * 60 * 1000, sell_min_price: 1000, sell_listings: 10, buy_max_price: 800, volume_24h: 20 };
		expect(needsDetailWrite(prev, { buyCents: 808, volume24h: 20 }, NOW, HEARTBEAT)).toBe(true); // +1%
	});

	it('writes when volume moved by >= max(3, 10%)', () => {
		const prev = { snapshot_at: NOW - 10 * 60 * 1000, sell_min_price: 1000, sell_listings: 10, buy_max_price: 800, volume_24h: 20 };
		expect(needsDetailWrite(prev, { buyCents: 800, volume24h: 23 }, NOW, HEARTBEAT)).toBe(true);
		expect(needsDetailWrite(prev, { buyCents: 800, volume24h: 21 }, NOW, HEARTBEAT)).toBe(false);
	});

	it('writes on heartbeat even when everything is flat', () => {
		const prev = { snapshot_at: NOW - HEARTBEAT - 1, sell_min_price: 1000, sell_listings: 10, buy_max_price: 800, volume_24h: 20 };
		expect(needsDetailWrite(prev, { buyCents: 800, volume24h: 20 }, NOW, HEARTBEAT)).toBe(true);
	});
});
