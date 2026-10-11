-- ============================================================================
-- Steam Market Analytics — ВСЕ миграции одним файлом
-- (для вставки в Dashboard → D1 → ваша база → Console → Execute)
--
-- Это копия migrations/0001+0002+0003 для ручного применения через веб-консоль.
-- Все операторы идемпотентны (IF NOT EXISTS / OR IGNORE) — безопасны при
-- повторном запуске. wrangler этот файл НЕ использует (он лежит вне
-- migrations/); если примените через консоль, а позже запустите
-- `npm run db:migrate:remote` — wrangler просто ещё раз применит те же
-- миграции, без конфликтов.
-- ============================================================================

-- Steam Market Analytics — initial schema (SQLite / Cloudflare D1)
--
-- Соглашения:
--   * Все денежные значения хранятся ЦЕЛЫМИ КОПЕЙКАМИ (INTEGER cents),
--     чтобы избежать ошибок округления float. В API отдаются как *_cents.
--   * Все временные метки — unix epoch в МИЛЛИСЕКУНДАХ (INTEGER).
--   * is_active и прочие boolean — INTEGER 0/1.

-- ---------------------------------------------------------------------------
-- games: список мониторимых игр (редактируется через админ-API, не кодом)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS games (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  appid             INTEGER NOT NULL UNIQUE,
  name              TEXT    NOT NULL,
  tier              INTEGER NOT NULL DEFAULT 2 CHECK (tier IN (1, 2, 3)),
  scan_interval_sec INTEGER NOT NULL DEFAULT 900,
  is_active         INTEGER NOT NULL DEFAULT 1,
  next_scan_at      INTEGER NOT NULL DEFAULT 0,          -- 0 = "просрочена, сканировать сразу"
  last_scan_at      INTEGER,                             -- последний УСПЕШНЫЙ скан списка
  last_scan_status  TEXT,                                -- ok | error | rate_limited | partial
  created_at        INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);
CREATE INDEX IF NOT EXISTS idx_games_due ON games(is_active, next_scan_at);

-- ---------------------------------------------------------------------------
-- items: предметы, замеченные на рынке (UPSERT по appid + hash_name)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS items (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  appid       INTEGER NOT NULL,
  hash_name   TEXT    NOT NULL,
  name        TEXT    NOT NULL DEFAULT '',
  icon_url    TEXT,
  item_nameid INTEGER,                                   -- кэш для itemordershistogram
  first_seen  INTEGER NOT NULL,
  last_seen   INTEGER NOT NULL,
  UNIQUE (appid, hash_name)
);
CREATE INDEX IF NOT EXISTS idx_items_appid ON items(appid);
CREATE INDEX IF NOT EXISTS idx_items_nameid ON items(item_nameid) WHERE item_nameid IS NOT NULL;

-- ---------------------------------------------------------------------------
-- price_snapshots: снимки цен (история)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS price_snapshots (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id          INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  sell_min_price   INTEGER,                              -- cents, минимальная цена продажи
  sell_listings    INTEGER,                              -- количество лотов
  buy_max_price    INTEGER,                              -- cents, макс. цена buy order
  buy_orders_count INTEGER,
  volume_24h       INTEGER,                              -- объём продаж за 24ч
  median_price     INTEGER,                              -- cents
  snapshot_at      INTEGER NOT NULL,
  source           TEXT NOT NULL DEFAULT 'list'          -- list | detail | demo
);
CREATE INDEX IF NOT EXISTS idx_snapshots_item_time ON price_snapshots(item_id, snapshot_at DESC);
CREATE INDEX IF NOT EXISTS idx_snapshots_time ON price_snapshots(snapshot_at);

-- ---------------------------------------------------------------------------
-- spread_opportunities: готовые сигналы (одна строка на предмет)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS spread_opportunities (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id           INTEGER NOT NULL UNIQUE REFERENCES items(id) ON DELETE CASCADE,
  buy_price         INTEGER NOT NULL,                    -- cents
  sell_price        INTEGER NOT NULL,                    -- cents
  net_profit        INTEGER NOT NULL,                    -- cents: sell*0.85 - buy
  net_profit_pct    REAL    NOT NULL,
  volume_24h        INTEGER,
  detected_at       INTEGER NOT NULL,                    -- когда сигнал впервые появился
  updated_at        INTEGER NOT NULL,                    -- последнее подтверждение/обновление
  last_confirmed_at INTEGER,                             -- метка последнего прогона детектора
  is_active         INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_opp_active ON spread_opportunities(is_active, net_profit_pct DESC);

-- ---------------------------------------------------------------------------
-- scan_queue: очередь детального сканирования (воркер 2: buy orders)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS scan_queue (
  item_id   INTEGER PRIMARY KEY REFERENCES items(id) ON DELETE CASCADE,
  appid     INTEGER NOT NULL,
  priority  INTEGER NOT NULL DEFAULT 100,                -- чем меньше, тем раньше (ранг по sell_listings)
  due_at    INTEGER NOT NULL DEFAULT 0,
  attempts  INTEGER NOT NULL DEFAULT 0,
  last_error TEXT
);
CREATE INDEX IF NOT EXISTS idx_queue_due ON scan_queue(due_at, priority);

-- ---------------------------------------------------------------------------
-- scan_log: журнал всех запросов к Steam (ТЗ §10)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS scan_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  endpoint    TEXT NOT NULL,                             -- search_render | priceoverview | histogram | item_page
  appid       INTEGER,
  item_id     INTEGER,
  url         TEXT NOT NULL,
  status      INTEGER,                                   -- HTTP-код (0 = сетевая ошибка)
  duration_ms INTEGER,
  ok          INTEGER NOT NULL,
  error       TEXT,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_scan_log_created ON scan_log(created_at);
CREATE INDEX IF NOT EXISTS idx_scan_log_ok ON scan_log(ok, created_at);

-- ---------------------------------------------------------------------------
-- scheduler_state: KV-состояние планировщика (паузы после 429 и т.п.)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS scheduler_state (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);

-- ---------------------------------------------------------------------------
-- item_latest: представление «предмет + его последний снимок»
-- (используется всеми API-запросами списков)
-- ---------------------------------------------------------------------------
DROP VIEW IF EXISTS item_latest;
CREATE VIEW item_latest AS
SELECT
  i.id            AS item_id,
  i.appid         AS appid,
  i.hash_name     AS hash_name,
  i.name          AS name,
  i.icon_url      AS icon_url,
  i.item_nameid   AS item_nameid,
  i.first_seen    AS first_seen,
  i.last_seen     AS last_seen,
  s.sell_min_price,
  s.sell_listings,
  s.buy_max_price,
  s.buy_orders_count,
  s.volume_24h,
  s.median_price,
  s.snapshot_at,
  s.source        AS snapshot_source
FROM items i
LEFT JOIN (
  SELECT
    ps.*,
    ROW_NUMBER() OVER (PARTITION BY ps.item_id ORDER BY ps.snapshot_at DESC, ps.id DESC) AS rn
  FROM price_snapshots ps
) s ON s.item_id = i.id AND s.rn = 1;

-- Seed: 26 нишевых игр из ТЗ (раздел 4), разбитых на 3 тира.
-- tier 1 — опрос каждые 5 минут (300s)
-- tier 2 — опрос каждые 15 минут (900s)
-- tier 3 — опрос каждые 30 минут (1800s)
-- next_scan_at = 0 → игра сразу становится «просроченной» и попадает в очередь сканера.

INSERT OR IGNORE INTO games (appid, name, tier, scan_interval_sec, is_active, next_scan_at) VALUES
  -- Ядро (tier 1)
  (440,     'Team Fortress 2',                  1,  300, 1, 0),
  (304930,  'Unturned',                         1,  300, 1, 0),
  (232090,  'Killing Floor 2',                  1,  300, 1, 0),
  (321360,  'Primal Carnage: Extinction',       1,  300, 1, 0),
  (218620,  'PAYDAY 2',                         1,  300, 1, 0),
  (227300,  'Euro Truck Simulator 2',           1,  300, 1, 0),
  (322330,  "Don't Starve Together",            1,  300, 1, 0),
  (578080,  'PUBG: BATTLEGROUNDS',              1,  300, 1, 0),
  -- Второй эшелон (tier 2)
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
  -- Экспериментальные (tier 3)
  (2427700, 'Backpack Battles',                 3, 1800, 1, 0),
  (2373990, 'Solo Leveling: ARISE OVERDRIVE',   3, 1800, 1, 0),
  (1635450, 'Longvinter',                       3, 1800, 1, 0),
  (1782210, 'Crab Game',                        3, 1800, 1, 0),
  (3301740, 'TCG Master Trader',                3, 1800, 1, 0),
  (3678970, 'TBH',                              3, 1800, 1, 0);

-- D1 write/read optimization: denormalized "latest state" table.
--
-- Why:
--  * The old `item_latest` VIEW ran a ROW_NUMBER() window over the ENTIRE
--    price_snapshots table on every API query — huge read amplification.
--  * Scanners now write snapshots only when something actually changed
--    (delta compression) or every SNAPSHOT_HEARTBEAT_MS — this keeps the
--    D1 free tier (100k written rows/day) reachable with 26 monitored games.
--
-- `item_latest_state` holds exactly ONE row per item with the last known
-- market values; all list/sort/filter/detector queries hit this small table.

CREATE TABLE IF NOT EXISTS item_latest_state (
  item_id          INTEGER PRIMARY KEY REFERENCES items(id) ON DELETE CASCADE,
  appid            INTEGER NOT NULL,
  sell_min_price   INTEGER,            -- cents
  sell_listings    INTEGER,
  buy_max_price    INTEGER,            -- cents
  buy_orders_count INTEGER,
  volume_24h       INTEGER,
  median_price     INTEGER,            -- cents
  snapshot_at      INTEGER,            -- time of the last written snapshot
  detail_at        INTEGER,            -- time of the last detail (order book) scan
  source           TEXT,               -- list | detail | demo
  updated_at       INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ils_appid ON item_latest_state(appid);
CREATE INDEX IF NOT EXISTS idx_ils_spread ON item_latest_state(sell_min_price, buy_max_price);

-- The view is superseded by the table.
DROP VIEW IF EXISTS item_latest;
