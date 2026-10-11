/**
 * Embedded schema bootstrap — mirrors migrations/0001+0002+0003 as a list of
 * idempotent statements, so a fresh D1 database can be initialized through
 * the Worker itself (POST /api/v1/migrate) without wrangler CLI or the D1
 * web console.
 *
 * Keep in sync with the migration files. All statements are safe to re-run
 * (IF NOT EXISTS / OR IGNORE).
 */

export const SCHEMA_STATEMENTS: string[] = [
	// --- games ---------------------------------------------------------------
	`CREATE TABLE IF NOT EXISTS games (
	  id                INTEGER PRIMARY KEY AUTOINCREMENT,
	  appid             INTEGER NOT NULL UNIQUE,
	  name              TEXT    NOT NULL,
	  tier              INTEGER NOT NULL DEFAULT 2 CHECK (tier IN (1, 2, 3)),
	  scan_interval_sec INTEGER NOT NULL DEFAULT 900,
	  is_active         INTEGER NOT NULL DEFAULT 1,
	  next_scan_at      INTEGER NOT NULL DEFAULT 0,
	  last_scan_at      INTEGER,
	  last_scan_status  TEXT,
	  created_at        INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
	)`,
	`CREATE INDEX IF NOT EXISTS idx_games_due ON games(is_active, next_scan_at)`,

	// --- items ----------------------------------------------------------------
	`CREATE TABLE IF NOT EXISTS items (
	  id          INTEGER PRIMARY KEY AUTOINCREMENT,
	  appid       INTEGER NOT NULL,
	  hash_name   TEXT    NOT NULL,
	  name        TEXT    NOT NULL DEFAULT '',
	  icon_url    TEXT,
	  item_nameid INTEGER,
	  first_seen  INTEGER NOT NULL,
	  last_seen   INTEGER NOT NULL,
	  UNIQUE (appid, hash_name)
	)`,
	`CREATE INDEX IF NOT EXISTS idx_items_appid ON items(appid)`,
	`CREATE INDEX IF NOT EXISTS idx_items_nameid ON items(item_nameid) WHERE item_nameid IS NOT NULL`,

	// --- price_snapshots --------------------------------------------------------
	`CREATE TABLE IF NOT EXISTS price_snapshots (
	  id               INTEGER PRIMARY KEY AUTOINCREMENT,
	  item_id          INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
	  sell_min_price   INTEGER,
	  sell_listings    INTEGER,
	  buy_max_price    INTEGER,
	  buy_orders_count INTEGER,
	  volume_24h       INTEGER,
	  median_price     INTEGER,
	  snapshot_at      INTEGER NOT NULL,
	  source           TEXT NOT NULL DEFAULT 'list'
	)`,
	`CREATE INDEX IF NOT EXISTS idx_snapshots_item_time ON price_snapshots(item_id, snapshot_at DESC)`,
	`CREATE INDEX IF NOT EXISTS idx_snapshots_time ON price_snapshots(snapshot_at)`,

	// --- spread_opportunities -----------------------------------------------------
	`CREATE TABLE IF NOT EXISTS spread_opportunities (
	  id                INTEGER PRIMARY KEY AUTOINCREMENT,
	  item_id           INTEGER NOT NULL UNIQUE REFERENCES items(id) ON DELETE CASCADE,
	  buy_price         INTEGER NOT NULL,
	  sell_price        INTEGER NOT NULL,
	  net_profit        INTEGER NOT NULL,
	  net_profit_pct    REAL    NOT NULL,
	  volume_24h        INTEGER,
	  detected_at       INTEGER NOT NULL,
	  updated_at        INTEGER NOT NULL,
	  last_confirmed_at INTEGER,
	  is_active         INTEGER NOT NULL DEFAULT 1
	)`,
	`CREATE INDEX IF NOT EXISTS idx_opp_active ON spread_opportunities(is_active, net_profit_pct DESC)`,

	// --- scan_queue ------------------------------------------------------------------
	`CREATE TABLE IF NOT EXISTS scan_queue (
	  item_id   INTEGER PRIMARY KEY REFERENCES items(id) ON DELETE CASCADE,
	  appid     INTEGER NOT NULL,
	  priority  INTEGER NOT NULL DEFAULT 100,
	  due_at    INTEGER NOT NULL DEFAULT 0,
	  attempts  INTEGER NOT NULL DEFAULT 0,
	  last_error TEXT
	)`,
	`CREATE INDEX IF NOT EXISTS idx_queue_due ON scan_queue(due_at, priority)`,

	// --- scan_log --------------------------------------------------------------------
	`CREATE TABLE IF NOT EXISTS scan_log (
	  id          INTEGER PRIMARY KEY AUTOINCREMENT,
	  endpoint    TEXT NOT NULL,
	  appid       INTEGER,
	  item_id     INTEGER,
	  url         TEXT NOT NULL,
	  status      INTEGER,
	  duration_ms INTEGER,
	  ok          INTEGER NOT NULL,
	  error       TEXT,
	  created_at  INTEGER NOT NULL
	)`,
	`CREATE INDEX IF NOT EXISTS idx_scan_log_created ON scan_log(created_at)`,
	`CREATE INDEX IF NOT EXISTS idx_scan_log_ok ON scan_log(ok, created_at)`,

	// --- scheduler_state ----------------------------------------------------------------
	`CREATE TABLE IF NOT EXISTS scheduler_state (
	  key        TEXT PRIMARY KEY,
	  value      TEXT NOT NULL,
	  updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
	)`,

	// --- item_latest_state (migration 0003) --------------------------------------------------
	`CREATE TABLE IF NOT EXISTS item_latest_state (
	  item_id          INTEGER PRIMARY KEY REFERENCES items(id) ON DELETE CASCADE,
	  appid            INTEGER NOT NULL,
	  sell_min_price   INTEGER,
	  sell_listings    INTEGER,
	  buy_max_price    INTEGER,
	  buy_orders_count INTEGER,
	  volume_24h       INTEGER,
	  median_price     INTEGER,
	  snapshot_at      INTEGER,
	  detail_at        INTEGER,
	  source           TEXT,
	  updated_at       INTEGER NOT NULL
	)`,
	`CREATE INDEX IF NOT EXISTS idx_ils_appid ON item_latest_state(appid)`,
	`CREATE INDEX IF NOT EXISTS idx_ils_spread ON item_latest_state(sell_min_price, buy_max_price)`,

	// The legacy view (migration 0001) is superseded by item_latest_state.
	`DROP VIEW IF EXISTS item_latest`,

	// --- seed: the 26 niche games from the spec (migration 0002) ---------------------------
	`INSERT OR IGNORE INTO games (appid, name, tier, scan_interval_sec, is_active, next_scan_at) VALUES
	  (440,     'Team Fortress 2',                  1,  300, 1, 0),
	  (304930,  'Unturned',                         1,  300, 1, 0),
	  (232090,  'Killing Floor 2',                  1,  300, 1, 0),
	  (321360,  'Primal Carnage: Extinction',       1,  300, 1, 0),
	  (218620,  'PAYDAY 2',                         1,  300, 1, 0),
	  (227300,  'Euro Truck Simulator 2',           1,  300, 1, 0),
	  (322330,  'Don''t Starve Together',           1,  300, 1, 0),
	  (578080,  'PUBG: BATTLEGROUNDS',              1,  300, 1, 0),
	  (1949740, 'Banana Shooter',                   2,  900, 1, 0),
	  (774861,  'Project Winter',                   2,  900, 1, 0),
	  (550650,  'Black Squad',                      2,  900, 1, 0),
	  (299740,  'Miscreated',                       2,  900, 1, 0),
	  (489940,  'BATTALION: Legacy',                2,  900, 1, 0),
	  (571740,  'Golf It!',                         2,  900, 1, 0),
	  (282800,  '100% Orange Juice',                2,  900, 1, 0),
	  (274940,  'Depth',                            2,  900, 1, 0),
	  (518150,  'Intruder',                         2,  900, 1, 0),
	  (598780,  'Boreal Blade',                     2,  900, 1, 0),
	  (625340,  'XERA: Survival',                   2,  900, 1, 0),
	  (238460,  'BattleBlock Theater',              2,  900, 1, 0),
	  (2427700, 'Backpack Battles',                 3, 1800, 1, 0),
	  (2373990, 'Solo Leveling: ARISE OVERDRIVE',   3, 1800, 1, 0),
	  (1635450, 'Longvinter',                       3, 1800, 1, 0),
	  (1782210, 'Crab Game',                        3, 1800, 1, 0),
	  (3301740, 'TCG Master Trader',                3, 1800, 1, 0),
	  (3678970, 'TBH',                              3, 1800, 1, 0)`,
];

export interface SchemaStatus {
	initialized: boolean;
	games: number;
	items: number;
	snapshots: number;
}

/** Tables that must all exist for the schema to count as initialized. */
export const REQUIRED_TABLES = [
	'games',
	'items',
	'price_snapshots',
	'spread_opportunities',
	'scan_queue',
	'scan_log',
	'scheduler_state',
	'item_latest_state',
] as const;

export interface SchemaProbe {
	/** All required tables exist. */
	complete: boolean;
	existing: string[];
	missing: string[];
}

/**
 * Probe which required tables exist. A partially-initialized DB (e.g. a
 * failed console paste that died mid-script) counts as NOT complete, so the
 * idempotent bootstrap can repair it.
 */
export async function schemaProbe(db: D1Database): Promise<SchemaProbe> {
	try {
		const placeholders = REQUIRED_TABLES.map(() => '?').join(', ');
		const rows = await db
			.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (${placeholders})`)
			.bind(...REQUIRED_TABLES)
			.all<{ name: string }>();
		const existing = new Set((rows.results ?? []).map((r) => r.name));
		const missing = REQUIRED_TABLES.filter((t) => !existing.has(t));
		return { complete: missing.length === 0, existing: [...existing], missing };
	} catch {
		return { complete: false, existing: [], missing: [...REQUIRED_TABLES] };
	}
}

/** True when the core schema exists (all required tables). */
export async function isSchemaInitialized(db: D1Database): Promise<boolean> {
	return (await schemaProbe(db)).complete;
}

/** Apply all schema statements (idempotent) and return the resulting counts. */
export async function applySchema(db: D1Database): Promise<SchemaStatus> {
	await db.batch(SCHEMA_STATEMENTS.map((sql) => db.prepare(sql)));

	const games = await db.prepare('SELECT COUNT(*) AS n FROM games').first<{ n: number }>();
	const items = await db.prepare('SELECT COUNT(*) AS n FROM items').first<{ n: number }>();
	const snapshots = await db.prepare('SELECT COUNT(*) AS n FROM price_snapshots').first<{ n: number }>();

	return {
		initialized: true,
		games: games?.n ?? 0,
		items: items?.n ?? 0,
		snapshots: snapshots?.n ?? 0,
	};
}
