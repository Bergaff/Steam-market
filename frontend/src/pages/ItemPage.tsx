import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../api';
import { useFetch } from '../hooks';
import { Spinner, ErrorNote, ItemIcon, PeriodSwitch, SteamButton, ProfitBadge } from '../components/Bits';
import PriceChart from '../components/PriceChart';
import { formatMoney, formatNumber, formatDateTime, timeAgo } from '../format';

/** Страница предмета (TZ §8): цены, график 24ч/7д/30д, последние 20 снимков. */
export default function ItemPage() {
	const { id: idRaw } = useParams();
	const itemId = parseInt(idRaw ?? '', 10);
	const [period, setPeriod] = useState('24h');

	const details = useFetch(() => api.item(itemId));
	const currencyStats = useFetch(() => api.stats(), 60_000);
	const currency = currencyStats.data?.currency ?? 'RUB';
	const history = useFetch(() => api.itemHistory(itemId, period));
	const snapshots = useFetch(() => api.itemSnapshots(itemId, 20));

	if (Number.isNaN(itemId)) return <ErrorNote message="Некорректный id предмета" />;

	const item = details.data?.item;
	const opp = details.data?.opportunity;

	return (
		<div className="space-y-5">
			{details.loading && !details.data && <Spinner />}
			{details.error && <ErrorNote message={details.error} onRetry={details.refresh} />}

			{item && (
				<>
					{/* Header */}
					<div className="rounded-card border border-line bg-surface p-4 flex flex-wrap items-start gap-4">
						<ItemIcon url={item.icon_url} name={item.name} size="lg" />
						<div className="flex-1 min-w-[240px]">
							<div className="text-xs text-muted">
								<Link to={`/games/${item.appid}`} className="hover:text-accent">
									{item.game_name ?? `Игра ${item.appid}`}
								</Link>
							</div>
							<h1 className="text-xl sm:text-2xl font-extrabold leading-snug">{item.name}</h1>
							{item.hash_name !== item.name && <div className="text-xs text-muted font-mono mt-0.5 break-all">{item.hash_name}</div>}
							<div className="flex items-center gap-3 mt-2">
								<SteamButton url={item.steam_url} />
								<span className="text-[11px] text-muted">снимок: {timeAgo(item.snapshot_at)}</span>
								{opp?.is_active && <ProfitBadge pct={opp.net_profit_pct} />}
							</div>
						</div>
					</div>

					{/* Current prices */}
					<div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
						<PriceCard label="Sell min" value={formatMoney(item.sell_min_price_cents, currency)} />
						<PriceCard label="Buy max" value={formatMoney(item.buy_max_price_cents, currency)} />
						<PriceCard
							label="Спред"
							value={item.spread ? formatPctValue(item.spread.net_profit_pct) : '—'}
							valueClass={item.spread && item.spread.net_profit_pct >= 10 ? 'text-profit' : item.spread && item.spread.net_profit_pct < 0 ? 'text-loss' : ''}
							sub={item.spread ? `чистыми ${formatMoney(item.spread.net_profit_cents, currency)}` : undefined}
						/>
						<PriceCard label="Объём 24ч" value={formatNumber(item.volume_24h)} />
						<PriceCard label="Лотов" value={formatNumber(item.sell_listings)} sub={item.buy_orders_count !== null ? `buy-ордеров: ${formatNumber(item.buy_orders_count)}` : undefined} />
						<PriceCard label="Медиана" value={formatMoney(item.median_price_cents, currency)} />
					</div>

					{opp && opp.is_active && (
						<div className="rounded-card border border-profit/30 bg-profit/5 px-4 py-3 text-sm flex flex-wrap items-center gap-x-4 gap-y-1">
							<span className="font-semibold text-profit">🔥 Активный сигнал</span>
							<span className="text-muted">
								профит {formatMoney(opp.net_profit_cents, currency)} ({formatPctValue(opp.net_profit_pct)}) после комиссии Steam · обнаружен {formatDateTime(opp.detected_at)}
							</span>
						</div>
					)}

					{/* Chart */}
					<section className="rounded-card border border-line bg-surface p-4">
						<div className="flex items-center justify-between gap-3 mb-3">
							<h2 className="font-bold">История цен</h2>
							<PeriodSwitch value={period} onChange={setPeriod} />
						</div>
						{history.loading && !history.data ? <Spinner /> : <PriceChart series={history.data?.series ?? []} currency={currency} longPeriod={period !== '24h'} />}
					</section>

					{/* Last snapshots */}
					<section className="rounded-card border border-line bg-surface p-4">
						<h2 className="font-bold mb-3">Последние 20 снимков</h2>
						{snapshots.loading && !snapshots.data ? (
							<Spinner />
						) : (snapshots.data?.snapshots.length ?? 0) === 0 ? (
							<div className="text-muted text-sm">Снимков пока нет.</div>
						) : (
							<div className="overflow-x-auto scroll-thin rounded-lg border border-line">
								<table className="w-full text-sm min-w-[680px]">
									<thead>
										<tr className="text-left text-xs text-muted bg-surface2 border-b border-line">
											<th className="px-3 py-2 font-medium">Время</th>
											<th className="px-3 py-2 font-medium text-right">Sell min</th>
											<th className="px-3 py-2 font-medium text-right">Buy max</th>
											<th className="px-3 py-2 font-medium text-right">Медиана</th>
											<th className="px-3 py-2 font-medium text-right">Объём 24ч</th>
											<th className="px-3 py-2 font-medium text-right">Лоты</th>
											<th className="px-3 py-2 font-medium text-right">Buy-ордера</th>
											<th className="px-3 py-2 font-medium text-center">Источник</th>
										</tr>
									</thead>
									<tbody>
										{(snapshots.data?.snapshots ?? []).map((s) => (
											<tr key={s.id} className="border-b border-line/60 last:border-0 hover:bg-surface2/60">
												<td className="px-3 py-1.5 tnum text-muted">{formatDateTime(s.snapshot_at)}</td>
												<td className="px-3 py-1.5 text-right tnum">{formatMoney(s.sell_min_price_cents, currency)}</td>
												<td className="px-3 py-1.5 text-right tnum">{formatMoney(s.buy_max_price_cents, currency)}</td>
												<td className="px-3 py-1.5 text-right tnum text-muted">{formatMoney(s.median_price_cents, currency)}</td>
												<td className="px-3 py-1.5 text-right tnum">{formatNumber(s.volume_24h)}</td>
												<td className="px-3 py-1.5 text-right tnum text-muted">{formatNumber(s.sell_listings)}</td>
												<td className="px-3 py-1.5 text-right tnum text-muted">{formatNumber(s.buy_orders_count)}</td>
												<td className="px-3 py-1.5 text-center">
													<span className={`text-[10px] px-1.5 py-0.5 rounded ${s.source === 'detail' ? 'bg-accent/10 text-accent' : s.source === 'demo' ? 'bg-warn/10 text-warn' : 'bg-surface2 text-muted'}`}>
														{s.source}
													</span>
												</td>
											</tr>
										))}
									</tbody>
								</table>
							</div>
						)}
					</section>
				</>
			)}
		</div>
	);
}

function PriceCard({ label, value, sub, valueClass }: { label: string; value: string; sub?: string; valueClass?: string }) {
	return (
		<div className="rounded-card border border-line bg-surface px-3 py-2.5">
			<div className="text-[11px] text-muted font-medium">{label}</div>
			<div className={`text-base sm:text-lg font-bold tnum mt-0.5 ${valueClass ?? ''}`}>{value}</div>
			{sub && <div className="text-[10px] text-muted mt-0.5">{sub}</div>}
		</div>
	);
}

function formatPctValue(pct: number): string {
	const s = pct.toFixed(1).replace('.', ',');
	return `${pct > 0 ? '+' : ''}${s}%`;
}
