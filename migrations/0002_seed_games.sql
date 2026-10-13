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
