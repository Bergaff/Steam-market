import { Link } from 'react-router-dom';
import type { Opportunity } from '../types';
import { formatMoney, formatNumber } from '../format';
import { ItemIcon, ProfitBadge, SteamButton, EmptyNote } from './Bits';

/**
 * «🔥 Топ возможностей» — main dashboard table (TZ §8).
 * Columns: icon | game | item | buy | sell | profit (configured currency) | profit % | volume 24h | Steam link.
 */
export default function OpportunityTable({
	rows,
	showGame = true,
	currency = 'RUB',
	emptyText = 'Активных сигналов пока нет — сканер ещё набирает данные (или спред ниже порога).',
}: {
	rows: Opportunity[];
	showGame?: boolean;
	currency?: string;
	emptyText?: string;
}) {
	if (rows.length === 0) return <EmptyNote>{emptyText}</EmptyNote>;

	return (
		<div className="overflow-x-auto scroll-thin rounded-card border border-line">
			<table className="w-full text-sm min-w-[760px]">
				<thead>
					<tr className="text-left text-xs text-muted bg-surface2 border-b border-line">
						<th className="px-3 py-2.5 font-medium w-12"></th>
						{showGame && <th className="px-3 py-2.5 font-medium">Игра</th>}
						<th className="px-3 py-2.5 font-medium">Предмет</th>
						<th className="px-3 py-2.5 font-medium text-right">Buy</th>
						<th className="px-3 py-2.5 font-medium text-right">Sell</th>
						<th className="px-3 py-2.5 font-medium text-right">Профит</th>
						<th className="px-3 py-2.5 font-medium text-right">Профит %</th>
						<th className="px-3 py-2.5 font-medium text-right">Объём 24ч</th>
						<th className="px-3 py-2.5 font-medium text-right w-24">Steam</th>
					</tr>
				</thead>
				<tbody>
					{rows.map((o) => (
						<tr key={o.id} className="border-b border-line/60 last:border-0 hover:bg-surface2/60 transition-colors">
							<td className="px-3 py-2">
								<ItemIcon url={o.icon_url} name={o.name} size="sm" />
							</td>
							{showGame && (
								<td className="px-3 py-2">
									<Link to={`/games/${o.appid}`} className="text-muted hover:text-accent text-xs whitespace-nowrap">
										{o.game_name}
									</Link>
								</td>
							)}
							<td className="px-3 py-2 max-w-[280px]">
								<Link to={`/items/${o.item_id}`} className="font-medium hover:text-accent line-clamp-1" title={o.name}>
									{o.name}
								</Link>
							</td>
							<td className="px-3 py-2 text-right tnum text-muted">{formatMoney(o.buy_price_cents, currency)}</td>
							<td className="px-3 py-2 text-right tnum">{formatMoney(o.sell_price_cents, currency)}</td>
							<td className="px-3 py-2 text-right tnum font-semibold text-profit">{formatMoney(o.net_profit_cents, currency)}</td>
							<td className="px-3 py-2 text-right">
								<ProfitBadge pct={o.net_profit_pct} />
							</td>
							<td className="px-3 py-2 text-right tnum text-muted">{formatNumber(o.volume_24h)}</td>
							<td className="px-3 py-2 text-right">
								<SteamButton url={o.steam_url} />
							</td>
						</tr>
					))}
				</tbody>
			</table>
		</div>
	);
}
