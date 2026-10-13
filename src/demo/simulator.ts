/**
 * Demo mode (DEMO_MODE=1) — synthetic market data instead of live Steam
 * scraping. Used for local development and previews where steamcommunity.com
 * is unreachable, and to show the full UI before the first real scans.
 *
 * Everything is clearly marked: snapshots get source='demo', the API returns
 * demo_mode=true and the frontend shows a banner.
 *
 * NEVER enable in production — it overwrites analytics data.
 */

import type { RuntimeConfig } from '../config';
import { chunk, nowMs } from '../lib/time';

export interface DemoTickResult {
	gamesSimulated: number;
	snapshotsInserted: number;
}

export interface DemoSeedOptions {
	games?: number; // how many active games to populate (default 6)
	itemsPerGame?: number; // default 35
	historyHours?: number; // default 72
	reset?: boolean; // wipe existing analytics data first (default true)
}

export interface DemoSeedResult {
	games: number;
	items: number;
	snapshots: number;
	queuedForDetails: number;
}

// ---------------------------------------------------------------------------
// Name pools — plausible niche-market items per game
// ---------------------------------------------------------------------------

const NAME_POOL: Record<number, { nouns: string[]; prefixes: string[]; special: string[] }> = {
	440: {
		nouns: ['Team Captain', 'Backpack Expander', 'Supply Crate Key', 'Tour of Duty Ticket', 'Earbuds', 'Bill’s Hat', 'Saxxy', 'Metal Kit'],
		prefixes: ['Strange', 'Genuine', 'Vintage', 'Haunted', 'Unusual', ''],
		special: ['Mann Co. Supply Crate Key', 'Mann Co. Supply Crate #83', 'Mann Co. Supply Crate #103', 'Backpack Expander', 'Tour of Duty Ticket'],
	},
	304930: {
		nouns: ['Military Knife', 'Ranger Jacket', 'Alicepack', 'Shadow Veil', 'Compound Bow', 'Tactical Vest', 'Nightvision'],
		prefixes: ['Rare', 'Golden', 'Bloodstained', ''],
		special: ['Alicepack', 'Military Knife'],
	},
	232090: {
		nouns: ['Weapon Skin', 'Character Outfit', 'Knife Skin', 'Crate Key', 'Dosh', 'Nightmare Fuel'],
		prefixes: ['Nightmare', 'Toxic', 'Arctic', 'Crimson', 'Neon', ''],
		special: ['KF2 Weapon Crate Key'],
	},
	218620: {
		nouns: ['Safe Key', 'Weapon Skin', 'Mask', 'Gloves', 'Drill', 'Crew Gear'],
		prefixes: ['StatTrack-like', 'Infamous', 'Golden', 'Delta', ''],
		special: ['PAYDAY 2 Safe Key'],
	},
	227300: {
		nouns: ['Paint Job', 'Trailer Skin', 'Cabin Accessory', 'Wheel Set', 'Horn'],
		prefixes: ['Metallic', 'Matte', 'Chrome', 'Retro', ''],
		special: ['Special Transport Paint Job'],
	},
	322330: {
		nouns: ['Character Skin', 'Emote', 'Portrait Frame', 'Weapon Skin', 'Pet Collar'],
		prefixes: ['Elegant', 'Classy', 'Spooky', 'Festive', ''],
		special: ["Don't Starve Together Chest Key"],
	},
	578080: {
		nouns: ['Crate', 'Skin', 'Mask', 'Pan', 'Jacket', 'Boots'],
		prefixes: ['Battle', 'Lone Wolf', 'Desert', 'Jungle', ''],
		special: ['PUBG Crate Key', 'Battleground Crate'],
	},
	1949740: {
		nouns: ['Banana', 'Banana Bundle', 'Golden Banana', 'Peel Kit'],
		prefixes: ['Radioactive', 'Diamond', 'Frosty', ''],
		special: ['Banana Shooter Crate'],
	},
	274940: {
		nouns: ['Shark Skin', 'Dive Mask', 'Harpoon'],
		prefixes: ['Great White', 'Hammerhead', 'Abyssal', ''],
		special: ['Depth Crate'],
	},
	571740: {
		nouns: ['Golf Ball', 'Club Skin', 'Cart', 'Trophy'],
		prefixes: ['Neon', 'Retro', 'Pro', ''],
		special: ['Golf It! Crate'],
	},
};

const GENERIC = {
	nouns: ['Skin', 'Crate', 'Key', 'Emote', 'Badge', 'Card', 'Bundle', 'Trophy', 'Jacket', 'Mask'],
	prefixes: ['Rare', 'Golden', 'Neon', 'Toxic', 'Arctic', 'Crimson', 'Shadow', 'Cosmic', 'Retro', 'Deluxe'],
	special: [] as string[],
};

function pick<T>(arr: T[]): T {
	return arr[Math.floor(Math.random() * arr.length)]!;
}

function rand(min: number, max: number): number {
	return min + Math.random() * (max - min);
}

function randInt(min: number, max: number): number {
	return Math.floor(rand(min, max + 1));
}

function generateName(appid: number, used: Set<string>): string {
	const pool = NAME_POOL[appid] ?? GENERIC;
	const specials = pool.special ?? [];
	for (let attempt = 0; attempt < 20; attempt++) {
		const useSpecial = specials.length > 0 && Math.random() < 0.25;
		const name = useSpecial ? pick(specials) : `${pick(pool.prefixes)} ${pick(pool.nouns)}`.trim();
		const variant = Math.random() < 0.4 ? `${name} ${pick(['MK-II', 'v2', '2024', '2025', 'Deluxe', 'Prime', 'Alpha', 'Omega'])}` : name;
		if (!used.has(variant)) {
			used.add(variant);
			return variant;
		}
	}
	const fallback = `${pick(pool.prefixes)} ${pick(pool.nouns)} #${used.size + 1}`.trim();
	used.add(fallback);
	return fallback;
}

// Icon: use a deterministic placeholder from Steam CDN pattern (generic crate icon path is fine for demo).
const DEMO_ICONS = [
	'https://steamcommunity-a.akamaihd.net/economy/image/-9a81dlWLwJ2UUGcVs_nsVtzdOEdtWwKGZZLQHTxDZ7I56KU0Zwwo4NUX4oFJZEHLbXH5ApeO4YmlhxYQknCRvCo04DEVlxkKgpou-6kejhz2v_9dA',
	'https://steamcommunity-a.akamaihd.net/economy/image/U8_1MQ2lV7ISzLJf2r5c2yO3P5mOxP2xQ7yQ4rJ3wL-5t9m8Kx2vB6nQ1wE3rT5yU8iO0pA2sD4fG6hJ9kL',
];

// ---------------------------------------------------------------------------
// Seeding
// ---------------------------------------------------------------------------

export async function seedDemoData(db: D1Database, cfg: RuntimeConfig, opts: DemoSeedOptions = {}): Promise<DemoSeedResult> {
	const gamesCount = opts.games ?? 6;
	const itemsPerGame = opts.itemsPerGame ?? 35;
	const historyHours = opts.historyHours ?? 72;
	const reset = opts.reset ?? true;

	if (reset) {
		await db.batch([
			db.prepare('DELETE FROM spread_opportunities'),
			db.prepare('DELETE FROM scan_queue'),
			db.prepare('DELETE FROM item_latest_state'),
			db.prepare('DELETE FROM price_snapshots'),
			db.prepare('DELETE FROM items'),
			db.prepare('DELETE FROM scan_log'),
		]);
	}

	const games = await db
		.prepare('SELECT appid, name, tier, scan_interval_sec FROM games WHERE is_active = 1 ORDER BY tier ASC, appid ASC LIMIT ?')
		.bind(gamesCount)
		.all<{ appid: number; name: string; tier: number; scan_interval_sec: number }>();

	const now = nowMs();
	const historyIntervalMs = 30 * 60 * 1000; // one snapshot per 30 minutes
	const historySteps = Math.min(400, Math.round((historyHours * 60 * 60 * 1000) / historyIntervalMs));
	const detailedPerGame = Math.min(15, itemsPerGame); // items with buy orders ("top-N")

	let itemsTotal = 0;
	let snapshotsTotal = 0;

	for (const game of games.results) {
		const usedNames = new Set<string>();
		const itemIds: number[] = [];
		const itemMeta: { basePrice: number; listings: number; isDetailed: boolean; profitable: boolean }[] = [];

		// --- create items -------------------------------------------------
		for (let i = 0; i < itemsPerGame; i++) {
			const name = generateName(game.appid, usedNames);
			const basePrice = Math.round(rand(3, 4000) * 100); // 0.03 — 40 RUB * 100... actually 3..4000 RUB in cents
			const listings = randInt(1, 260);
			const isDetailed = i < detailedPerGame;
			// ~20% of detailed items are profitable spread opportunities
			const profitable = isDetailed && Math.random() < 0.22;
			itemMeta.push({ basePrice, listings, isDetailed, profitable });

			const ins = await db
				.prepare(
					`INSERT INTO items (appid, hash_name, name, icon_url, item_nameid, first_seen, last_seen)
					 VALUES (?, ?, ?, ?, ?, ?, ?)
					 ON CONFLICT(appid, hash_name) DO UPDATE SET name = excluded.name, last_seen = excluded.last_seen`
				)
				.bind(game.appid, name, name, pick(DEMO_ICONS), isDetailed ? randInt(1000000, 9999999) : null, now - 30 * 24 * 3600 * 1000, now)
				.run();
			// D1 local: lastInsertRowId is in meta.
			const rowId = ins.meta.last_row_id;
			if (rowId) itemIds.push(Number(rowId));
		}
		itemsTotal += itemIds.length;

		// --- create history snapshots -------------------------------------
		const stmts: D1PreparedStatement[] = [];
		for (let idx = 0; idx < itemIds.length; idx++) {
			const itemId = itemIds[idx]!;
			const meta = itemMeta[idx]!;
			let price = meta.basePrice;
			let listings = meta.listings;
			// buy/sell ratio: profitable items ~0.62-0.74, others 0.86-0.97
			const buyRatio = meta.profitable ? rand(0.6, 0.73) : rand(0.85, 0.97);
			let volume = meta.profitable ? randInt(6, 90) : randInt(0, 40);

			let lastBuy: number | null = null;
			let lastBuyCount: number | null = null;
			let lastMedian: number | null = null;

			for (let step = historySteps; step >= 0; step--) {
				const ts = now - step * historyIntervalMs;
				// Random walk: +-4% per step, mean-reverting to basePrice.
				price = Math.max(1, Math.round(price * rand(0.96, 1.04) + (meta.basePrice - price) * 0.03));
				listings = Math.max(0, Math.round(listings * rand(0.95, 1.05)));
				volume = Math.max(0, Math.round(volume * rand(0.9, 1.1)));

				const isDetailedNow = meta.isDetailed;
				const buy = isDetailedNow ? Math.max(1, Math.round(price * buyRatio * rand(0.97, 1.03))) : null;
				const buyCount = isDetailedNow ? randInt(1, 60) : null;
				const median = isDetailedNow ? Math.round((price + (buy ?? price)) / 2) : null;

				stmts.push(
					db
						.prepare(
							`INSERT INTO price_snapshots
							   (item_id, sell_min_price, sell_listings, buy_max_price, buy_orders_count, volume_24h, median_price, snapshot_at, source)
							 VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'demo')`
						)
						.bind(itemId, price, listings, buy, buyCount, isDetailedNow ? volume : null, median, ts)
				);

				if (step === 0) {
					lastBuy = buy;
					lastBuyCount = buyCount;
					lastMedian = median;
				}
			}

			// Latest-state row (denormalized) for list/detector queries.
			stmts.push(
				db
					.prepare(
						`INSERT INTO item_latest_state
						   (item_id, appid, sell_min_price, sell_listings, buy_max_price, buy_orders_count, volume_24h, median_price, snapshot_at, detail_at, source, updated_at)
						 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'demo', ?)
						 ON CONFLICT(item_id) DO UPDATE SET
						   sell_min_price = excluded.sell_min_price,
						   sell_listings  = excluded.sell_listings,
						   buy_max_price  = excluded.buy_max_price,
						   buy_orders_count = excluded.buy_orders_count,
						   volume_24h     = excluded.volume_24h,
						   median_price   = excluded.median_price,
						   snapshot_at    = excluded.snapshot_at,
						   detail_at      = excluded.detail_at,
						   source         = 'demo',
						   updated_at     = excluded.updated_at`
					)
					.bind(
						itemId,
						game.appid,
						price,
						listings,
						lastBuy,
						lastBuyCount,
						meta.isDetailed ? volume : null,
						lastMedian,
						now,
						meta.isDetailed ? now : null,
						now
					)
			);
		}

		for (const part of chunk(stmts, 80)) {
			await db.batch(part);
		}
		snapshotsTotal += stmts.length;

		// --- detail queue (top items by listings) ---------------------------
		const queueStmts = itemIds.slice(0, Math.min(cfg.scan.detailsTopN, itemIds.length)).map((itemId, i) =>
			db
				.prepare(
					`INSERT INTO scan_queue (item_id, appid, priority, due_at, attempts) VALUES (?, ?, ?, 0, 0)
					 ON CONFLICT(item_id) DO UPDATE SET priority = excluded.priority, due_at = 0`
				)
				.bind(itemId, game.appid, i + 1)
		);
		for (const part of chunk(queueStmts, 80)) {
			await db.batch(part);
		}

		// --- mark the game as scanned ---------------------------------------
		await db
			.prepare('UPDATE games SET last_scan_at = ?, last_scan_status = ?, next_scan_at = ? WHERE appid = ?')
			.bind(now, 'ok', now + game.scan_interval_sec * 1000, game.appid)
			.run();
	}

	await db
		.prepare(
			`INSERT INTO scheduler_state (key, value, updated_at) VALUES ('last_successful_scan_at', ?, ?)
			 ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
		)
		.bind(String(now), now)
		.run();

	return { games: games.results.length, items: itemsTotal, snapshots: snapshotsTotal, queuedForDetails: Math.min(cfg.scan.detailsTopN, itemsPerGame) * games.results.length };
}

// ---------------------------------------------------------------------------
// Live-ish demo tick: adds fresh snapshots so the dashboard feels alive
// ---------------------------------------------------------------------------

export async function runDemoTick(db: D1Database, cfg: RuntimeConfig): Promise<DemoTickResult> {
	const now = nowMs();
	const result: DemoTickResult = { gamesSimulated: 0, snapshotsInserted: 0 };

	const dueGames = await db
		.prepare(
			`SELECT appid, scan_interval_sec FROM games
			 WHERE is_active = 1 AND next_scan_at <= ?
			 ORDER BY tier ASC, next_scan_at ASC
			 LIMIT 3`
		)
		.bind(now)
		.all<{ appid: number; scan_interval_sec: number }>();

	for (const game of dueGames.results) {
		// Pick a random subset of items to "re-scan" (keeps ticks cheap).
		const items = await db
			.prepare(
				`SELECT id FROM items WHERE appid = ? ORDER BY RANDOM() LIMIT 25`
			)
			.bind(game.appid)
			.all<{ id: number }>();

		const stmts: D1PreparedStatement[] = [];
		for (const item of items.results) {
			const latest = await db
				.prepare(
					`SELECT sell_min_price, sell_listings, buy_max_price, buy_orders_count, volume_24h
					 FROM price_snapshots WHERE item_id = ? ORDER BY snapshot_at DESC, id DESC LIMIT 1`
				)
				.bind(item.id)
				.first<{
					sell_min_price: number | null;
					sell_listings: number | null;
					buy_max_price: number | null;
					buy_orders_count: number | null;
					volume_24h: number | null;
				}>();
			if (!latest || latest.sell_min_price === null) continue;

			const sell = Math.max(1, Math.round(latest.sell_min_price * rand(0.97, 1.03)));
			const listings = Math.max(0, Math.round((latest.sell_listings ?? 5) * rand(0.9, 1.1)));
			const buy = latest.buy_max_price !== null ? Math.max(1, Math.round(latest.buy_max_price * rand(0.97, 1.03))) : null;
			const volume = latest.volume_24h !== null ? Math.max(0, Math.round(latest.volume_24h * rand(0.9, 1.12))) : null;

			stmts.push(
				db
					.prepare(
						`INSERT INTO price_snapshots
						   (item_id, sell_min_price, sell_listings, buy_max_price, buy_orders_count, volume_24h, median_price, snapshot_at, source)
						 VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'demo')`
					)
					.bind(
						item.id,
						sell,
						listings,
						buy,
						latest.buy_orders_count,
						volume,
						buy !== null ? Math.round((sell + buy) / 2) : null,
						now,
					)
			);

			// Keep the denormalized latest-state row in sync.
			stmts.push(
				db
					.prepare(
						`INSERT INTO item_latest_state
						   (item_id, appid, sell_min_price, sell_listings, buy_max_price, buy_orders_count, volume_24h, median_price, snapshot_at, detail_at, source, updated_at)
						 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'demo', ?)
						 ON CONFLICT(item_id) DO UPDATE SET
						   sell_min_price   = excluded.sell_min_price,
						   sell_listings    = excluded.sell_listings,
						   buy_max_price    = COALESCE(excluded.buy_max_price, item_latest_state.buy_max_price),
						   buy_orders_count = COALESCE(excluded.buy_orders_count, item_latest_state.buy_orders_count),
						   volume_24h       = COALESCE(excluded.volume_24h, item_latest_state.volume_24h),
						   median_price     = COALESCE(excluded.median_price, item_latest_state.median_price),
						   snapshot_at      = excluded.snapshot_at,
						   detail_at        = COALESCE(excluded.detail_at, item_latest_state.detail_at),
						   source           = 'demo',
						   updated_at       = excluded.updated_at`
					)
					.bind(
						item.id,
						game.appid,
						sell,
						listings,
						buy,
						latest.buy_orders_count,
						volume,
						buy !== null ? Math.round((sell + buy) / 2) : null,
						now,
						buy !== null ? now : null,
						now
					)
			);
		}

		for (const part of chunk(stmts, 80)) {
			await db.batch(part);
		}
		result.snapshotsInserted += stmts.length;
		result.gamesSimulated++;

		await db
			.prepare('UPDATE games SET last_scan_at = ?, last_scan_status = ?, next_scan_at = ? WHERE appid = ?')
			.bind(now, 'ok', now + game.scan_interval_sec * 1000, game.appid)
			.run();
	}

	// Simulate the detail queue draining (demo data already has buy prices).
	await db.prepare('DELETE FROM scan_queue').run();

	if (result.snapshotsInserted > 0) {
		await db
			.prepare(
				`INSERT INTO scheduler_state (key, value, updated_at) VALUES ('last_successful_scan_at', ?, ?)
				 ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
			)
			.bind(String(now), now)
			.run();
	}

	return result;
}
