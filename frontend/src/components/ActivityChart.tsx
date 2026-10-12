import { Bar, BarChart, ResponsiveContainer, Tooltip, XAxis, YAxis, CartesianGrid } from 'recharts';
import type { ActivityPoint } from '../types';
import { formatNumber, formatDateTime } from '../format';

/**
 * Game market activity chart: total 24h volume per time bucket (TZ §8).
 */
export default function ActivityChart({ series, longPeriod }: { series: ActivityPoint[]; longPeriod: boolean }) {
	if (series.length === 0 || !series.some((point) => point.volume_24h_sum > 0 || point.listings_avg > 0)) {
		return (
			<div className="h-48 flex items-center justify-center text-muted text-sm border border-dashed border-line rounded-card">
				{series.length === 0 ? 'Нет снимков рынка за выбранный период' : 'Объёмы и лоты за этот период ещё не собраны'}
			</div>
		);
	}

	return (
		<div className="h-48 sm:h-56">
			<ResponsiveContainer width="100%" height="100%">
				<BarChart data={series} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
					<CartesianGrid stroke="#232a3a" strokeDasharray="3 3" vertical={false} />
					<XAxis
						dataKey="t"
						tickFormatter={(t: number) =>
							longPeriod
								? new Date(t).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' })
								: new Date(t).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })
						}
						stroke="#8b93a7"
						fontSize={11}
						tickLine={false}
						minTickGap={40}
					/>
					<YAxis
						tickFormatter={(v: number) => formatNumber(Math.round(v))}
						stroke="#8b93a7"
						fontSize={11}
						tickLine={false}
						axisLine={false}
						width={56}
					/>
					<Tooltip
						cursor={{ fill: 'rgba(79,140,255,0.08)' }}
						contentStyle={{ background: '#11151f', border: '1px solid #2e3850', borderRadius: 10, fontSize: 12 }}
						labelStyle={{ color: '#8b93a7' }}
						labelFormatter={(t) => formatDateTime(Number(t))}
						formatter={(value, name) => {
							const v = typeof value === 'number' ? value : Number(value ?? 0);
							const label = String(name) === 'volume_24h_sum' ? 'Продажи за 24 ч' : 'Sell-лоты';
							return [formatNumber(Math.round(v)), label];
						}}
					/>
					<Bar dataKey="volume_24h_sum" fill="#4f8cff" radius={[3, 3, 0, 0]} isAnimationActive={false} />
					<Bar dataKey="listings_avg" fill="#3ddc84" radius={[3, 3, 0, 0]} isAnimationActive={false} />
				</BarChart>
			</ResponsiveContainer>
			<div className="flex flex-wrap items-center justify-center gap-x-5 gap-y-1 text-[11px] text-muted mt-1">
				<span className="inline-flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-sm bg-accent" /> Продажи за 24 ч</span>
				<span className="inline-flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-sm bg-profit" /> Активные sell-лоты</span>
			</div>
		</div>
	);
}
