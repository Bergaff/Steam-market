import { useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, type ItemsQuery } from '../api';
import { useFetch, useDebounced } from '../hooks';
import { Spinner, ErrorNote, ItemIcon, Pagination, ProfitBadge, SteamButton, PeriodSwitch, EmptyNote } from '../components/Bits';
import ActivityChart from '../components/ActivityChart';
import { formatMoney, formatNumber, timeAgo, gameImage } from '../format';
import type { GameDetailsResponse } from '../types';

type SortKey = 'volume' | 'price' | 'spread' | 'listings' | 'name';

const SORT_LABEL: Record<SortKey, string> = {
	volume: 'Объём 24ч',
	price: 'Цена sell',
	spread: 'Спред %',
	listings: 'Лоты',
	name: 'Название',
};

/** Страница игры (TZ §8): шапка, активность 7д, таблица предметов с фильтрами. */
export default function GamePage() {
	const { appid: appidRaw } = useParams();
	const appid = parseInt(appidRaw ?? '', 10);

	const [period, setPeriod] = useState('7d');
	const [page, setPage] = useState(0);
	const [sort, setSort] = useState<SortKey>('volume');
	const [dir, setDir] = useState<'asc' | 'desc'>('desc');
	const [minPrice, setMinPrice] = useState('');
	const [minVolume, setMinVolume] = useState('');
	const [minSpread, setMinSpread] = useState('');

	const debPrice = useDebounced(minPrice);
	const debVolume = useDebounced(minVolume);
	const debSpread = useDebounced(minSpread);

	const LIMIT = 50;

	const details = useFetch<GameDetailsResponse>(() => api.game(appid));
	const activity = useFetch(() => api.gameActivity(appid, period), undefined);
	const stats = useFetch(() => api.stats(), 60_000);
	const currency = stats.data?.currency ?? 'RUB';

	const query = useMemo<ItemsQuery>(
		() => ({
			limit: LIMIT,
			offset: page * LIMIT,
			sort,
			dir,
			min_price_cents: debPrice !== '' ? Math.round(parseFloat(debPrice.replace(',', '.')) * 100) || null : null,
			min_volume: debVolume !== '' ? parseInt(debVolume, 10) || null : null,
			min_spread_pct: debSpread !== '' ? parseFloat(debSpread.replace(',', '.')) || null : null,
		}),
		[page, sort, dir, debPrice, debVolume, debSpread]
	);

	const items = useFetch(() => api.gameItems(appid, query));

	if (Number.isNaN(appid)) return <ErrorNote message="Некорректный appid" />;

	const game = details.data?.game;

	const toggleSort = (key: SortKey) => {
		if (sort === key) {
			setDir(dir === 'desc' ? 'asc' : 'desc');
		} else {
			setSort(key);
			setDir('desc');
		}
		setPage(0);
	};

	return (
		<div className="space-y-5">
			{/* Game header */}
			{details.loading && !details.data && <Spinner />}
			{details.error && <ErrorNote message={details.error} onRetry={details.refresh} />}
			{game && (
				<div className="rounded-card border border-line bg-surface overflow-hidden">
					<div className="h-28 sm:h-36 relative">
						<img
							src={gameImage(game.appid)}
							alt={game.name}
							className="w-full h-full object-cover opacity-40"
							onError={(e) => ((e.target as HTMLImageElement).style.display = 'none')}
						/>
						<div className="absolute inset-0 bg-gradient-to-t from-surface via-surface/40 to-transparent" />
					</div>
					<div className="px-4 pb-4 -mt-10 relative">
						<div className="flex flex-wrap items-end gap-x-4 gap-y-1">
							<h1 className="text-2xl sm:text-3xl font-extrabold">{game.name}</h1>
							<span className="text-xs text-muted tnum">appid {game.appid} · tier {game.tier} · каждые {Math.round(game.scan_interval_sec / 60)} мин</span>
							<a
								className="text-xs text-accent hover:underline ml-auto"
								href={`https://steamcommunity.com/market/search?q=&appid=${game.appid}`}
								target="_blank"
								rel="noreferrer"
							>
								Рынок Steam ↗
							</a>
						</div>
						<div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mt-3">
							<MiniStat label="Предметов" value={formatNumber(game.stats.items)} />
							<MiniStat label="Лотов на продаже" value={formatNumber(game.stats.sell_listings)} />
							<MiniStat label="Объём продаж 24ч" value={formatNumber(game.stats.volume_24h)} />
							<MiniStat label="Активных сигналов" value={formatNumber(game.stats.active_opportunities)} highlight={game.stats.active_opportunities > 0} />
						</div>
						<div className="text-[11px] text-muted mt-2">
							Последний скан: {timeAgo(game.last_scan_at)} {game.last_scan_status ? `(${game.last_scan_status})` : ''}
							{!game.is_active && <span className="text-loss ml-2">мониторинг выключен</span>}
						</div>
					</div>
				</div>
			)}

			{/* Activity chart */}
			<section className="rounded-card border border-line bg-surface p-4">
				<div className="flex items-center justify-between gap-3 mb-3">
					<h2 className="font-bold">Активность рынка</h2>
					<PeriodSwitch value={period} onChange={setPeriod} />
				</div>
				{activity.loading && !activity.data ? (
					<Spinner />
				) : activity.error ? (
					<ErrorNote message={`Не удалось загрузить активность: ${activity.error}`} onRetry={activity.refresh} />
				) : (
					<ActivityChart series={activity.data?.series ?? []} longPeriod={period === '30d'} />
				)}
				<p className="text-[11px] text-muted mt-2">Продажи за 24 ч загружаются из детальных сканов; sell-лоты видны уже по сканам списков.</p>
			</section>

			{/* Items table */}
			<section className="rounded-card border border-line bg-surface p-4">
				<div className="flex flex-wrap items-center gap-3 mb-3">
					<h2 className="font-bold">Предметы</h2>
					<div className="flex flex-wrap items-center gap-2 ml-auto">
						<FilterInput placeholder={`мин. цена (${currency})`} value={minPrice} onChange={(v) => { setMinPrice(v); setPage(0); }} />
						<FilterInput placeholder="мин. объём 24ч" value={minVolume} onChange={(v) => { setMinVolume(v); setPage(0); }} />
						<FilterInput placeholder="спред ≥ %" value={minSpread} onChange={(v) => { setMinSpread(v); setPage(0); }} />
					</div>
				</div>

				{items.loading && !items.data ? (
					<Spinner />
				) : items.error ? (
					<ErrorNote message={items.error} onRetry={items.refresh} />
				) : (items.data?.items.length ?? 0) === 0 ? (
					<EmptyNote>Ничего не найдено по фильтрам (или данные ещё не собраны сканером).</EmptyNote>
				) : (
					<>
						<div className="overflow-x-auto scroll-thin rounded-lg border border-line">
							<table className="w-full text-sm min-w-[820px]">
								<thead>
									<tr className="text-left text-xs text-muted bg-surface2 border-b border-line">
										<th className="px-3 py-2.5 w-12"></th>
										<Th sortable onClick={() => toggleSort('name')} active={sort === 'name'} dir={dir}>Предмет</Th>
										<Th sortable onClick={() => toggleSort('price')} active={sort === 'price'} dir={dir} align="right">Sell min</Th>
										<Th align="right">Buy max</Th>
										<Th sortable onClick={() => toggleSort('spread')} active={sort === 'spread'} dir={dir} align="right">Спред</Th>
										<Th sortable onClick={() => toggleSort('volume')} active={sort === 'volume'} dir={dir} align="right">Объём 24ч</Th>
										<Th sortable onClick={() => toggleSort('listings')} active={sort === 'listings'} dir={dir} align="right">Лоты</Th>
										<th className="px-3 py-2.5 font-medium text-right w-24">Steam</th>
									</tr>
								</thead>
								<tbody>
									{(items.data?.items ?? []).map((it) => (
										<tr key={it.item_id} className="border-b border-line/60 last:border-0 hover:bg-surface2/60 transition-colors">
											<td className="px-3 py-2">
												<ItemIcon url={it.icon_url} name={it.name} size="sm" />
											</td>
											<td className="px-3 py-2 max-w-[300px]">
												<Link to={`/items/${it.item_id}`} className="font-medium hover:text-accent line-clamp-1" title={it.hash_name}>
													{it.name}
												</Link>
												<div className="text-[10px] text-muted tnum">{it.snapshot_at ? timeAgo(it.snapshot_at) : 'нет данных'}</div>
											</td>
											<td className="px-3 py-2 text-right tnum">{formatMoney(it.sell_min_price_cents, currency)}</td>
											<td className="px-3 py-2 text-right tnum text-muted">{formatMoney(it.buy_max_price_cents, currency)}</td>
											<td className="px-3 py-2 text-right">
												<ProfitBadge pct={it.spread?.net_profit_pct ?? null} />
											</td>
											<td className="px-3 py-2 text-right tnum">{formatNumber(it.volume_24h)}</td>
											<td className="px-3 py-2 text-right tnum text-muted">{formatNumber(it.sell_listings)}</td>
											<td className="px-3 py-2 text-right">
												<SteamButton url={it.steam_url} />
											</td>
										</tr>
									))}
								</tbody>
							</table>
						</div>
						<Pagination total={items.data?.total ?? 0} limit={LIMIT} offset={page * LIMIT} onChange={(off) => setPage(off / LIMIT)} />
					</>
				)}
			</section>

			{/* Top-10 quick lists */}
			{details.data && (details.data.top_by_volume.length > 0 || details.data.top_by_spread.length > 0) && (
				<div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
					<TopList title="Топ по объёму продаж" items={details.data.top_by_volume} currency={currency} />
					<TopList title="Топ по спреду" items={details.data.top_by_spread} currency={currency} />
				</div>
			)}
		</div>
	);
}

function MiniStat({ label, value, highlight }: { label: string; value: string; highlight?: boolean }) {
	return (
		<div className="rounded-lg border border-line bg-surface2/60 px-3 py-2">
			<div className={`text-lg font-bold tnum ${highlight ? 'text-profit' : ''}`}>{value}</div>
			<div className="text-[10px] text-muted">{label}</div>
		</div>
	);
}

function FilterInput({ placeholder, value, onChange }: { placeholder: string; value: string; onChange: (v: string) => void }) {
	return (
		<input
			type="text"
			inputMode="decimal"
			placeholder={placeholder}
			value={value}
			onChange={(e) => onChange(e.target.value)}
			className="w-32 rounded-lg border border-line bg-surface2 px-2.5 py-1.5 text-xs text-ink placeholder:text-muted/70 focus:outline-none focus:border-accent/60 tnum"
		/>
	);
}

function Th({
	children,
	sortable,
	active,
	dir,
	onClick,
	align = 'left',
}: {
	children: React.ReactNode;
	sortable?: boolean;
	active?: boolean;
	dir?: 'asc' | 'desc';
	onClick?: () => void;
	align?: 'left' | 'right';
}) {
	return (
		<th
			className={`px-3 py-2.5 font-medium ${align === 'right' ? 'text-right' : ''} ${sortable ? 'cursor-pointer select-none hover:text-ink' : ''} ${active ? 'text-accent' : ''}`}
			onClick={onClick}
		>
			{children}
			{sortable && active && <span className="ml-1">{dir === 'desc' ? '↓' : '↑'}</span>}
		</th>
	);
}

function TopList({ title, items, currency }: { title: string; items: GameDetailsResponse['top_by_volume']; currency: string }) {
	if (items.length === 0) return null;
	return (
		<div className="rounded-card border border-line bg-surface p-4">
			<h3 className="font-bold text-sm mb-2">{title}</h3>
			<div className="space-y-1.5">
				{items.map((it, idx) => (
					<div key={it.item_id} className="flex items-center gap-2.5 text-sm">
						<span className="text-muted text-xs tnum w-5">{idx + 1}.</span>
						<ItemIcon url={it.icon_url} name={it.name} size="sm" />
						<Link to={`/items/${it.item_id}`} className="flex-1 truncate hover:text-accent" title={it.name}>
							{it.name}
						</Link>
						<span className="tnum text-muted text-xs">{formatMoney(it.sell_min_price_cents, currency)}</span>
						{it.spread && <ProfitBadge pct={it.spread.net_profit_pct} />}
						<span className="tnum text-xs w-14 text-right">{formatNumber(it.volume_24h)}</span>
					</div>
				))}
			</div>
		</div>
	);
}
