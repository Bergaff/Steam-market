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
