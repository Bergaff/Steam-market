import {
	Area,
	ComposedChart,
	Line,
	ResponsiveContainer,
	Tooltip,
	XAxis,
	YAxis,
	CartesianGrid,
} from 'recharts';
import type { HistoryPoint } from '../types';
import { formatMoney, formatMoneyShort, formatNumber, formatTime, formatDateTime } from '../format';

/**
 * Price history chart for an item (sell avg + buy avg), dark theme.
 * Data comes from /items/:id/history (downsampled buckets).
 */
export default function PriceChart({ series, currency = 'RUB', longPeriod }: { series: HistoryPoint[]; currency?: string; longPeriod: boolean }) {
	if (series.length === 0) {
		return <div className="h-64 flex items-center justify-center text-muted text-sm border border-dashed border-line rounded-card">Нет данных за период</div>;
	}

	return (
		<div className="h-64 sm:h-80">
			<ResponsiveContainer width="100%" height="100%">
				<ComposedChart data={series} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
					<defs>
						<linearGradient id="sellFill" x1="0" y1="0" x2="0" y2="1">
							<stop offset="0%" stopColor="#4f8cff" stopOpacity={0.35} />
							<stop offset="100%" stopColor="#4f8cff" stopOpacity={0.02} />
						</linearGradient>
					</defs>
					<CartesianGrid stroke="#232a3a" strokeDasharray="3 3" vertical={false} />
					<XAxis
						dataKey="t"
						tickFormatter={(t: number) => (longPeriod ? new Date(t).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' }) : formatTime(t))}
						stroke="#8b93a7"
						fontSize={11}
						tickLine={false}
						minTickGap={40}
					/>
					<YAxis
						tickFormatter={(v: number) => formatMoneyShort(v, currency)}
						stroke="#8b93a7"
						fontSize={11}
						tickLine={false}
						axisLine={false}
						width={70}
						domain={['auto', 'auto']}
					/>
					<Tooltip
						contentStyle={{ background: '#11151f', border: '1px solid #2e3850', borderRadius: 10, fontSize: 12 }}
						labelStyle={{ color: '#8b93a7' }}
						labelFormatter={(t) => formatDateTime(Number(t))}
						formatter={(value, name) => {
							const v = typeof value === 'number' ? value : null;
							const label = String(name) === 'buy' ? 'Buy (max)' : 'Sell (min)';
							return [v === null ? '—' : formatMoney(v, currency), label];
						}}
					/>
					<Area type="monotone" dataKey="sell_avg_cents" name="sell" stroke="#4f8cff" strokeWidth={2} fill="url(#sellFill)" connectNulls isAnimationActive={false} />
					<Line type="monotone" dataKey="buy_avg_cents" name="buy" stroke="#3ddc84" strokeWidth={1.75} dot={false} connectNulls isAnimationActive={false} />
				</ComposedChart>
			</ResponsiveContainer>
			<div className="flex items-center gap-4 text-xs text-muted mt-2 px-1">
				<span className="flex items-center gap-1.5"><span className="w-3 h-0.5 bg-accent inline-block rounded" /> Sell min (средняя по снимкам)</span>
				<span className="flex items-center gap-1.5"><span className="w-3 h-0.5 bg-profit inline-block rounded" /> Buy max</span>
				<span className="ml-auto tnum">точек: {formatNumber(series.length)}</span>
			</div>
		</div>
	);
}
