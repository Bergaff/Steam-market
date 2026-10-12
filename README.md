# 📈 Steam Market Analytics

Веб-сервис аналитики **нишевых рынков Steam Community Market** (не CS2/Dota2/Rust): активность рынка, топ предметов по спросу, спред между buy-ордером и sell-лотом, прибыль после комиссии Steam (15%), история цен.

Построен полностью на **Cloudflare** (Workers + D1 + Cron Triggers + Static Assets) — без серверов, без Docker, деплой одной командой, бесплатно на free-плане.

> ⚠️ Сервис **никогда** не запрашивает логин/пароль Steam, API-ключ или trade-ссылку. Используются только публичные read-only данные торговой площадки.

---

## Статус (по этапам ТЗ, раздел 12)

| Этап | Что | Статус |
|---|---|---|
| MVP | Миграции/модели БД, воркер 1 (сканер списка), API `/games`, `/games/{appid}/items`, главная + страница игры | ✅ |
| V2 | Воркер 2 (buy orders через `itemordershistogram`), воркер 3 (детектор спредов), `/opportunities` + таблица сигналов на главной | ✅ |
| V3 | Графики истории цен, фильтры/сортировки, экспорт CSV, healthcheck, админка с API-ключом, rate-limiting, логирование скана, пауза после 429 | ✅ |
| V3+ | Telegram-бот с алертами | ⏳ next |
| V4 | Регистрация, тарифы, вотч-листы | ⏳ later |

---

## Архитектура

```
                        ┌────────────────────────────────────────────┐
                        │           Cloudflare Worker (Hono)         │
  Браузер ─────────────▶│  • Static Assets: React SPA (frontend/dist)│
  (React SPA,           │  • REST API: /api/v1/*, /health            │
   polling 60 сек)      │  • Cron Trigger "* * * * *" → планировщик  │
                        └───────────────┬────────────────────────────┘
                                        │ D1 (SQLite)
                        ┌───────────────▼────────────────────────────┐
                        │ games · items · price_snapshots            │
                        │ spread_opportunities · scan_queue          │
                        │ scan_log · scheduler_state · item_latest   │
                        └────────────────────────────────────────────┘
                                        ▲
                                        │ HTTPS, ~1 запрос / 2.5 сек,
                                        │ retry + backoff, пауза на 429
                        ┌───────────────┴────────────────────────────┐
                        │        Steam Community Market (публичный)  │
                        │  search/render · priceoverview ·           │
                        │  itemordershistogram · listings page       │
                        └────────────────────────────────────────────┘
```

### Планировщик (один cron в минуту)

Cron-тикер каждую минуту решает, какую работу сделать, в пределах бюджета
(`MAX_STEAM_REQUESTS_PER_RUN` запросов и `MAX_RUN_WALL_MS` wall-time на invocation — ограничения платформы Workers):

1. **Пауза после 429** — если Steam ответил 429, планировщик ставит глобальную паузу 60 сек (после 3 подряд — 5 минут, ТЗ §10) и пропускает тики.
2. **Воркер 3 (детектор спредов)** — каждые 2 минуты, чистая работа с БД: `net = round(sell × 0.85) − buy`, сигнал при `net% ≥ 10`, `volume ≥ 5`, `buy ≥ 5 ₽`.
3. **Воркер 1 (сканер списка)** — сканирует ОДНУ «просроченную» игру за тик (tier 1 — каждые 5 мин, tier 2 — 15 мин, tier 3 — 30 мин): `search/render` с пагинацией, UPSERT `items`, INSERT `price_snapshots`, очередь топ-20 по лотам в `scan_queue`.
4. **Воркер 2 (детальный)** — по очереди: парсит `item_nameid` со страницы предмета (один раз, кэш), `itemordershistogram` → buy max, `priceoverview` → volume/медиана; мержит в последний снимок.
5. **Housekeeping** — раз в сутки чистит снапшоты/логи старше `RETENTION_DAYS`.

Все запросы к Steam идут через единый `SteamClient` (пейсинг 2.5 сек, 3 попытки с exponential backoff, лог каждого запроса в `scan_log`, хук `PROXY_URL` под будущую ротацию IP).

### Деньги и время

* Все цены хранятся **целыми копейками** (`INTEGER`), никаких float-потерь. В API — поля `*_cents` + код валюты (`RUB` при `STEAM_CURRENCY=5`).
* Все тайстемпы — unix epoch **миллисекунды**; API дополнительно отдаёт `*_iso`.

---

## Быстрый старт (локально)

Требуется Node.js ≥ 20.

```bash
git clone <repo> && cd Steam-market
npm install                        # зависимости воркера + frontend (workspaces)
cp .dev.vars.example .dev.vars     # локальные секреты (ADMIN_API_KEY, DEMO_MODE=1)
npm run db:migrate:local           # схема D1 + сид 26 игр (локальный симулятор)
npm run dev:worker                 # воркер + собранный фронт на http://localhost:8787
```

Отдельно можно поднять Vite с hot-reload (проксирует API на воркер):

```bash
npm run dev:web                    # http://localhost:5173
```

### Демо-режим (без доступа к Steam)

В `.dev.vars` стоит `DEMO_MODE=1`: вместо реальных запросов к Steam сервис генерирует синтетические данные (8 игр × 30 предметов × 72 часа истории), а каждый cron-тик «оживляет» цены. В UI показывается жёлтый баннер. Заполнить базу вручную:

```bash
npm run demo:seed                  # POST /api/v1/admin/demo-data (ключ из .dev.vars)
npm run cron:tick                  # вручную дёрнуть scheduled-обработчик
```

Для реального сканирования поставьте `DEMO_MODE=0` — воркер начнёт ходить в Steam (нужен сетевой доступ до `steamcommunity.com`).

### Тесты и типы

```bash
npm test                           # vitest: парсеры цен/histogram/nameid, формула спреда, конфиг
npm run typecheck                  # tsc для воркера и фронтенда
```

---

## Деплой на Cloudflare

### Вариант A: Workers Builds (git-интеграция, рекомендуется)

Dashboard → Workers & Pages → Create → Worker → **Connect to Git** → выбрать репозиторий и ветку. Настройки сборки leave по умолчанию: деплой-команда `npx wrangler deploy` сама соберёт фронтенд (в `wrangler.jsonc` есть `build.command: npm run build`), Node 22 подхватится из `.nvmrc`. Каждый push в подключённую ветку = автоматический redeploy.

После первого успешного деплоя одноразово:
1. **Инициализация боевой D1 (схема + 26 игр)** — просто откройте в браузере:
   ```
   https://steam-market.<ваш-субдомен>.workers.dev/api/v1/migrate?apply=1
   ```
   Пустая или **частично созданная** база достраивается без ключа (строго идемпотентно, ничего не удаляет); когда схема полная — повтор требует `X-Admin-Key` (POST). Альтернативы: `curl -X POST .../api/v1/migrate`, `npm run db:migrate:remote` или вставить `scripts/d1_console_setup.sql` в D1 → Console (скрипт без комментариев — веб-консоль схлопывает строки, и inline-комментарии `--` ломали запрос).
2. Секрет: Worker → Settings → Variables and Secrets → **Secret** `ADMIN_API_KEY` (или `npx wrangler secret put ADMIN_API_KEY`) — нужен для админки;
3. Домен: включить `*.workers.dev` или привязать свой (Worker → Settings → Domains & Routes).

### Вариант B: вручную через CLI

```bash
npx wrangler login                                   # 1. авторизация
npm run db:create                                    # 2. wrangler d1 create steam-market-db
#    -> скопируйте database_id в wrangler.jsonc (d1_databases[0].database_id)
npx wrangler secret put ADMIN_API_KEY                # 3. секрет админки
npm run deploy                                       # 4. сборка фронта + деплой воркера
npm run db:migrate:remote                            # 5. схема + сид игр в боевую D1
```

Готово: воркер отдаёт SPA и API по адресу `https://steam-market.<ваш-аккаунт>.workers.dev`, cron `* * * * *` запускается автоматически. Логи: `npm run cf:tail`.

**Лимиты free-плана, которые учтены в коде:** ≤50 внешних запросов на invocation (бюджет скана по умолчанию 30), 30 сек CPU на scheduled-событие (вся тяжёлая работа — ожидание пейсинга, не CPU), D1 100k записей/день (дельта-сжатие снимков — см. «Оптимизация под бесплатный D1» ниже), 5 млн чтений/день (списки читают компактную `item_latest_state`, ретеншн чистит историю).

### Рейт-лимиты Steam с IP Cloudflare (наблюдения из прода)

Анонимные запросы с датацентровых IP Steam лимитирует жёстко: `search/render` отдаёт по **10 строк на страницу** (игнорируя `count=100`), а после burst-фазы включает **блок на часы** (все запросы → 429). Проверено в проде: первые ~2800 предметов собрались за несколько часов, затем IP ушёл в глухой блок. Важный нюанс: probing заблокированного IP каждые 5 минут **продлевает** блок.

Как система адаптирована (анонимный профиль — текущие значения в `wrangler.jsonc`):

- пейсинг `MIN_REQUEST_INTERVAL_MS=6000` с джиттером ±15% (в коде);
- бюджет ≤24 запросов за тик, 10 страниц на игру (топ-100 предметов), до 2 игр за тик;
- пагинация по фактической длине ответа (10 строк/страница обрабатываются корректно);
- на 429 — пауза 60с (ТЗ §10), после 3 подряд — **экспоненциальный откат**: 5→10→20→40→60 мин (потолок `LONG_PAUSE_MAX_MS`), чтобы IP «остыл»; счётчик сбрасывается после первого чистого тика;
- диагностика без ключа: `/health` → `status`, `paused_until`, `consecutive_429`, `recent_errors` (5 последних неудачных запросов к Steam).

**Ускорение — сессия Steam владельца (`STEAM_WEB_COOKIE`, рекомендуется).** Официальный Steam Web API (`steamcommunity.com/dev/apikey`) доступ к маркету **не даёт** — все трекеры цен работают через веб-эндпоинты, а залогиненная сессия получает у Steam намного более высокие лимиты. Подойдёт любой аккаунт (лучше запасной, не основной); покупки/деньги на нём не нужны, сайт по-прежнему никогда не запрашивает учётные данные у посетителей — секрет ставится владельцем в своём Cloudflare-аккаунте.

Установка (5 минут):
1. В браузере войдите на `steamcommunity.com` → F12 → **Application → Cookies → https://steamcommunity.com** → скопируйте значение `steamLoginSecure` (вида `76561198...||eyJ0...` или с `%7C%7C`).
2. Dashboard → Workers & Pages → `steam-market` → **Settings → Variables and Secrets** → Add → тип **Secret**, имя `STEAM_WEB_COOKIE`, значение: `steamLoginSecure=<скопированное>`.
3. Проверьте `/health` → `"steam_cookie_configured": true`. Если сессия когда-нибудь протухнет (Steam разлогинит), `recent_errors` это покажет — просто обновите значение.

Риски: запросы идут с IP Cloudflare — Steam может показать уведомление «новый вход с другого устройства» (штатная ситуация, как при входе из путешествия). Секрет можно удалить в любой момент — система вернётся к анонимному профилю.

С cookie имеет смысл перейти на быстрый профиль (Settings → Variables или `wrangler.jsonc`): `MIN_REQUEST_INTERVAL_MS=3500`, `MAX_STEAM_REQUESTS_PER_RUN=60`, `SCAN_PAGES_PER_GAME=20`, `DETAILS_PER_TICK=8`.

---

## Конфигурация (соответствие `.env` из ТЗ)

Не-секретные настройки — в `wrangler.jsonc → vars`, секреты — `wrangler secret put` / `.dev.vars`.

| ТЗ §11 | Cloudflare | По умолчанию | Смысл |
|---|---|---|---|
| `DATABASE_URL` | binding `DB` (D1) | — | База данных |
| `REDIS_URL` | не нужен | — | Состояние планировщика в D1 (`scheduler_state`) |
| `STEAM_CURRENCY=5` | `STEAM_CURRENCY` | `5` (RUB) | Валюта цен |
| `SCAN_USER_AGENT` | `SCAN_USER_AGENT` | Chrome UA | User-Agent запросов |
| `MIN_SPREAD_PCT=10` | `MIN_SPREAD_PCT` | `10` | Порог профита сигнала, % |
| `MIN_VOLUME_24H=5` | `MIN_VOLUME_24H` | `5` | Порог объёма продаж |
| `MIN_BUY_PRICE=5` | `MIN_BUY_PRICE_CENTS` | `500` | Порог цены buy (копейки) |
| `ADMIN_API_KEY` | secret `ADMIN_API_KEY` | — | Ключ `/api/v1/admin/*` (header `X-Admin-Key`) |
| `TELEGRAM_*` | — | — | V3+ (бот с алертами — в планах) |

Дополнительно: `MIN_REQUEST_INTERVAL_MS` (2500 — пейсинг запросов к Steam), `MAX_STEAM_REQUESTS_PER_RUN` (30), `SCAN_PAGES_PER_GAME` (10), `DETAILS_TOP_N` (20), `DETAILS_PER_TICK` (6), `SNAPSHOT_HEARTBEAT_MS` (14400000 = 4 ч — как часто писать снимок на плоском рынке), `DETAIL_FRESH_MS` (43200000 = 12 ч — свежесть buy-данных для детектора), `SPREAD_INTERVAL_MS` (120000), `LOG_SUCCESS_SAMPLE_N` (10), `RATE_LIMIT_PER_MIN` (60), `RETRY_AFTER_429_MS` (60000), `LONG_PAUSE_MS` (300000), `RETENTION_DAYS` (35), `PROXY_URL` (пусто — хук для ротации IP), `DEMO_MODE` (0).

---

## API

Base URL: `/api/v1`, формат JSON. Публичные эндпоинты ограничены `RATE_LIMIT_PER_MIN` (60/мин/IP, HTTP 429 + `Retry-After`).

### Публичные

| Метод | URL | Описание |
|---|---|---|
| GET | `/api/v1/config` | Валюта, пороги сигналов, флаг демо-режима |
| GET/POST | `/api/v1/migrate` | Статус схемы / инициализация пустой БД (bootstrap без ключа; повтор — с `X-Admin-Key`) |
| GET | `/api/v1/games` | Все игры + агрегаты (предметы, лоты, объём, сигналы) |
| GET | `/api/v1/games/{appid}` | Игра: статистика + топ-10 по объёму и по спреду |
| GET | `/api/v1/games/{appid}/items` | Предметы с последними ценами. Параметры: `limit` (≤200), `offset`, `sort=volume\|price\|spread\|profit\|listings\|name`, `dir=asc\|desc`, `min_price_cents`, `min_volume`, `min_spread_pct` |
| GET | `/api/v1/games/{appid}/activity` | Активность рынка по бакетам: `period=24h\|7d\|30d` |
| GET | `/api/v1/items/{id}` | Карточка предмета + активный сигнал + статистика снимков |
| GET | `/api/v1/items/{id}/history` | История цен (даунсэмплинг ≤500 точек): `period=24h\|7d\|30d` |
| GET | `/api/v1/items/{id}/snapshots` | Сырые снимки: `limit` (по умолчанию 20) |
| GET | `/api/v1/opportunities` | Спред-сигналы: `min_profit_pct`, `min_volume`, `appid`, `sort=profit\|profit_abs\|volume\|updated\|price`, `dir`, `limit`, `offset`, **`format=csv`** (экспорт для Excel: `;`, BOM) |
| GET | `/api/v1/stats/overview` | Общая статистика сервиса + состояние сканера |
| GET | `/health` | Healthcheck: статус БД, последний успешный скан, пауза 429, очередь |

### Приватные (header `X-Admin-Key: <ADMIN_API_KEY>`)

| Метод | URL | Описание |
|---|---|---|
| POST | `/api/v1/admin/games` | Добавить игру: `{appid, name, tier?, scan_interval_sec?, is_active?}` |
| PATCH | `/api/v1/admin/games/{appid}` | Изменить `{name?, tier?, scan_interval_sec?, is_active?, scan_now?}` |
| POST | `/api/v1/admin/scan/{appid}` | Принудительный скан (фон через `waitUntil` + cron доделает) |
| POST | `/api/v1/admin/seed-games` | Идемпотентно (пере)посеять 26 игр из ТЗ |
| POST | `/api/v1/admin/demo-data` | Синтетические данные (только при `DEMO_MODE=1`) |
| GET | `/api/v1/admin/state` | Отладка: состояние планировщика, очередь, последние ошибки |

Пример:

```bash
curl "https://<worker>/api/v1/opportunities?min_profit_pct=15&sort=profit&limit=5"
```

---

## База данных (D1 / SQLite)

| Таблица | Назначение |
|---|---|
| `games` | Мониторимые игры: appid, tier, интервал, `next_scan_at`/`last_scan_at` |
| `items` | Предметы (`UNIQUE(appid, hash_name)`), кэш `item_nameid` |
| `price_snapshots` | Снимки цен: sell min/лоты, buy max/ордера, volume, медиана (индекс `item_id, snapshot_at DESC`) |
| `item_latest_state` | **Одна строка на предмет** с последними значениями — все списки/фильтры/детектор читают её (маленькая таблица вместо оконных функций по всей истории) |
| `spread_opportunities` | Сигналы: buy/sell/net/профит, `detected_at`, `is_active` (одна строка на предмет) |
| `scan_queue` | Очередь воркера 2 (топ-N по лотам каждой игры) |
| `scan_log` | Журнал запросов к Steam: ошибки — всегда, успехи — сэмплированием 1/N |
| `scheduler_state` | KV-состояние: паузы 429, счётчики, метки времени прогонов |

Миграции: `migrations/0001_init.sql` (схема), `0002_seed_games.sql` (26 игр из ТЗ: 8 ядро/5 мин, 12 второй эшелон/15 мин, 6 экспериментальных/30 мин), `0003_item_latest_state.sql` (оптимизация записи/чтения D1).

### Оптимизация под бесплатный D1 (важно!)

Лимиты D1 free: **100 000 записанных строк/день**, 5 млн прочитанных/день, 500 МБ. «Наивный» сканер (снапшот каждого предмета каждый скан) дал бы >1 млн записей/день и упёрся бы в лимит за сутки. Поэтому:

* **Дельта-сжатие снимков**: новый `price_snapshots` пишется, только если цена сдвинулась ≥1.5%, лоты ≥15% (мин. 5), либо buy/volume изменились (≥1%/≥10%), либо прошёл heartbeat `SNAPSHOT_HEARTBEAT_MS` (4 ч) — якорные точки для графиков на плоском рынке.
* **`items`**: UPDATE только при смене имени/иконки; `last_seen` освежается не чаще раза в 6 часов.
* **Очередь**: `INSERT OR IGNORE` — ноль записей при стабильном топе.
* **Логи**: успехи 1/10 (`LOG_SUCCESS_SAMPLE_N`), ошибки всегда; счётчики запросов — одна запись на тик.
* **Чтения**: списки/детектор ходят в `item_latest_state` (тысячи строк), а не в историю (миллионы).

Ориентировочно 26 игр дают **~40–90 тыс. записей/день** — впритык к free-лимиту. Контроль: Dashboard → D1 → ваша база → метрики (rows written). Если mendekatiесь к лимиту — увеличьте `SNAPSHOT_HEARTBEAT_MS` до 6–8 ч, поднимите интервал tier-1 до 600–900 с (`PATCH /admin/games/{appid}`), уменьшите `SCAN_PAGES_PER_GAME` или отключите часть игр (`is_active=false`). На Workers Paid ($5/мес) лимита записей нет (тарификация ~$1/млн строк).

---

## Frontend (React + Vite + Tailwind v4 + Recharts)

Тёмная «трейдерская» тема, шрифт Inter, mobile-first, таблицы в скролл-контейнерах.

* **`/` Дашборд** — «Сейчас на рынке» (игры/предметы/сигналы), «🔥 Топ возможностей» с автообновлением раз в минуту, блок приватности.
* **`/games`** — карточки всех игр (обложка Steam CDN, tier, статистика).
* **`/games/{appid}`** — шапка игры, график активности (24ч/7д/30д), таблица предметов: фильтры (мин. цена, мин. объём, спред ≥ X%), сортировка по любой колонке, пагинация 50/страница, топ-10 списки.
* **`/items/{id}`** — цены (sell/buy/спред/объём/лоты/медиана), график истории цен (24ч/7д/30д), «последние 20 снимков», активный сигнал.
* **`/opportunities`** — все сигналы: фильтры (игра, профит %, объём), сортировки, пагинация, **экспорт CSV**.

Продакшн-сборка (`frontend/dist`) отдаётся тем же воркером через Static Assets (SPA-fallback для клиентских роутов, `run_worker_first` для `/api/*`).

---

## Структура проекта

```
├── wrangler.jsonc              # Worker: D1, assets, cron, vars
├── migrations/                 # D1-миграции (схема + сид игр)
├── src/                        # Worker (TypeScript, Hono)
│   ├── index.ts                # fetch + scheduled handler
│   ├── config.ts / env.ts      # конфигурация из env с дефолтами ТЗ
│   ├── steam/
│   │   ├── client.ts           # SteamClient: пейсинг, retry, 429, логирование
│   │   ├── endpoints.ts        # search/render, priceoverview, histogram, listings
│   │   └── parse.ts            # чистые парсеры цен/таблиц/nameid (покрыты тестами)
│   ├── scan/
│   │   ├── scheduler.ts        # cron-тикер (оркестрация воркеров)
│   │   ├── listScanner.ts      # воркер 1: скан списка предметов игры
│   │   ├── detailScanner.ts    # воркер 2: buy orders топ-N
│   │   ├── spreadDetector.ts   # воркер 3: сигналы спреда
│   │   ├── budget.ts           # лимиты запросов/wall-time на invocation
│   │   └── housekeeping.ts     # ретеншн-чистка
│   ├── routes/                 # games, items, opportunities, stats, health, admin
│   ├── db/state.ts             # KV-состояние планировщика
│   └── demo/simulator.ts       # демо-режим (синтетика)
├── frontend/                   # React + Vite + Tailwind + Recharts
│   └── src/{pages,components}  # дашборд, игры, предмет, возможности
├── test/                       # vitest: парсеры, формула спреда, конфиг
└── .dev.vars.example           # локальные секреты
```

---

## Безопасность и надёжность

* Только read-only публичные данные Steam; никаких пользовательских секретов.
* `ADMIN_API_KEY` — единственный секрет; сравнивается constant-time, при отсутствии ключа админка отвечает 503.
* CORS: публичные GET доступны всем (данные публичные), фронт — same-origin.
* Rate-limit 60 req/min/IP на публичный API (429 + `Retry-After`).
* Пейсинг запросов к Steam ≥ 2.5 сек, retry с backoff, глобальная пауза после 429 (60 сек → 5 мин после серии), весь трафик пишется в `scan_log`.
* `GET /health` — статус БД, возраст последнего успешного скана, пауза, глубина очереди.

## Известные ограничения / планы

* `pricehistory` Steam требует cookies сессии — история цен строится из собственных снимков (ТЗ §3.3).
* Cloudflare может чаще получать 429 от Steam (общие IP) — предусмотрены паузы; при необходимости подключается `PROXY_URL` (форвардинг-прокси / другой Worker на своём IP).
* Telegram-бот, авторизация/тарифы и вотч-листы — следующие итерации (ТЗ §12 V3+/V4).
