import { useMemo, useState } from 'react';
import { api, type OpportunitiesQuery } from '../api';
import { useFetch, useDebounced } from '../hooks';
import { Spinner, ErrorNote, Pagination } from '../components/Bits';
import OpportunityTable from '../components/OpportunityTable';
import { formatNumber } from '../format';

type SortKey = 'profit' | 'profit_abs' | 'volume' | 'updated' | 'price';

const SORTS: { key: SortKey; label: string }[] = [
	{ key: 'profit', label: 'Профит %' },
	{ key: 'profit_abs', label: 'Профит ₽' },
	{ key: 'volume', label: 'Объём 24ч' },
	{ key: 'price', label: 'Цена sell' },
	{ key: 'updated', label: 'Обновление' },
];

/** Страница «Возможности» (TZ §8): расширенный список сигналов + фильтры + CSV. */
export default function OpportunitiesPage() {
	const [page, setPage] = useState(0);
	const [sort, setSort] = useState<SortKey>('profit');
	const [minProfit, setMinProfit] = useState('10');
	const [minVolume, setMinVolume] = useState('5');
	const [appidFilter, setAppidFilter] = useState('');
	const LIMIT = 50;

	const debProfit = useDebounced(minProfit);
	const debVolume = useDebounced(minVolume);

	const games = useFetch(() => api.games());

	const query = useMemo<OpportunitiesQuery>(
		() => ({
			limit: LIMIT,
			offset: page * LIMIT,
			sort,
			dir: 'desc',
			min_profit_pct: debProfit !== '' ? parseFloat(debProfit.replace(',', '.')) || null : null,
			min_volume: debVolume !== '' ? parseInt(debVolume, 10) || null : null,
			appid: appidFilter !== '' ? parseInt(appidFilter, 10) : null,
		}),
		[page, sort, debProfit, debVolume, appidFilter]
	);

	const opps = useFetch(() => api.opportunities(query), 60_000);

	return (
		<div className="space-y-4">
			<div className="flex flex-wrap items-baseline gap-3">
				<h1 className="text-2xl font-extrabold">Возможности</h1>
				<p className="text-sm text-muted">
					Предметы, где <code className="text-accent font-mono text-xs">sell × 0.85 − buy</code> даёт прибыль выше порога. Сигналы
					пересчитываются каждые 2 минуты.
				</p>
				{opps.data && <span className="ml-auto text-xs text-muted tnum">найдено: {formatNumber(opps.data.total)}</span>}
			</div>

			{/* Filters */}
			<div className="rounded-card border border-line bg-surface p-3 flex flex-wrap items-center gap-2">
				<label className="text-xs text-muted flex items-center gap-1.5">
					Профит ≥
					<input
						className="w-20 rounded-lg border border-line bg-surface2 px-2 py-1.5 text-xs tnum focus:outline-none focus:border-accent/60"
						value={minProfit}
						inputMode="decimal"
						onChange={(e) => { setMinProfit(e.target.value); setPage(0); }}
					/>
					%
				</label>
				<label className="text-xs text-muted flex items-center gap-1.5">
					Объём ≥
					<input
						className="w-20 rounded-lg border border-line bg-surface2 px-2 py-1.5 text-xs tnum focus:outline-none focus:border-accent/60"
						value={minVolume}
						inputMode="numeric"
						onChange={(e) => { setMinVolume(e.target.value); setPage(0); }}
					/>
				</label>
				<label className="text-xs text-muted flex items-center gap-1.5">
					Игра
					<select
						className="rounded-lg border border-line bg-surface2 px-2 py-1.5 text-xs text-ink focus:outline-none focus:border-accent/60 max-w-[200px]"
						value={appidFilter}
						onChange={(e) => { setAppidFilter(e.target.value); setPage(0); }}
					>
						<option value="">все</option>
						{(games.data?.games ?? []).map((g) => (
							<option key={g.appid} value={g.appid}>
								{g.name}
							</option>
						))}
					</select>
				</label>
				<label className="text-xs text-muted flex items-center gap-1.5">
					Сортировка
					<select
						className="rounded-lg border border-line bg-surface2 px-2 py-1.5 text-xs text-ink focus:outline-none focus:border-accent/60"
						value={sort}
						onChange={(e) => { setSort(e.target.value as SortKey); setPage(0); }}
					>
						{SORTS.map((s) => (
							<option key={s.key} value={s.key}>
								{s.label}
							</option>
						))}
					</select>
				</label>
				<a
					href={api.opportunitiesCsvUrl({ ...query, limit: 500, offset: 0 })}
					className="ml-auto inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold border border-line2 bg-surface2 text-ink hover:border-accent/60 hover:text-accent transition-colors"
					title="Экспорт первых 500 сигналов в CSV (Excel)"
				>
					⬇️ Экспорт CSV
				</a>
			</div>

			{opps.loading && !opps.data ? (
				<Spinner />
			) : opps.error ? (
				<ErrorNote message={opps.error} onRetry={opps.refresh} />
			) : (
				<>
					<OpportunityTable rows={opps.data?.opportunities ?? []} currency={opps.data?.currency ?? 'RUB'} />
					<Pagination total={opps.data?.total ?? 0} limit={LIMIT} offset={page * LIMIT} onChange={(off) => setPage(off / LIMIT)} />
				</>
			)}
		</div>
	);
}
