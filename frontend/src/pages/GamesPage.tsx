import { Link } from 'react-router-dom';
import { api } from '../api';
import { useFetch } from '../hooks';
import { Spinner, ErrorNote } from '../components/Bits';
import { formatNumber, timeAgo, gameImage } from '../format';

const TIER_LABEL: Record<number, string> = { 1: 'Ядро · 5 мин', 2: '2-й эшелон · 15 мин', 3: 'Эксперимент · 30 мин' };
const TIER_COLOR: Record<number, string> = { 1: 'text-profit bg-profit/10', 2: 'text-accent bg-accent/10', 3: 'text-warn bg-warn/10' };

/** Список всех мониторимых игр карточками. */
export default function GamesPage() {
	const games = useFetch(() => api.games(), 120_000);

	return (
		<div className="space-y-4">
			<div className="flex items-baseline justify-between gap-4">
				<h1 className="text-2xl font-extrabold">Игры в мониторинге</h1>
				{games.data && <span className="text-xs text-muted tnum">{games.data.games.length} шт.</span>}
			</div>

			{games.loading && !games.data && <Spinner />}
			{games.error && <ErrorNote message={games.error} onRetry={games.refresh} />}

			{games.data && (
				<div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
					{games.data.games.map((g) => (
						<Link
							key={g.appid}
							to={`/games/${g.appid}`}
							className="group rounded-card border border-line bg-surface overflow-hidden hover:border-accent/50 transition-colors"
						>
							<div className="h-24 bg-surface2 relative overflow-hidden">
								<img
									src={gameImage(g.appid)}
									alt={g.name}
									loading="lazy"
									className="w-full h-full object-cover opacity-80 group-hover:opacity-100 group-hover:scale-[1.02] transition-all"
									onError={(e) => ((e.target as HTMLImageElement).style.display = 'none')}
								/>
								<span className={`absolute top-2 right-2 text-[10px] font-bold px-2 py-0.5 rounded-full ${TIER_COLOR[g.tier] ?? ''}`}>
									{TIER_LABEL[g.tier] ?? `tier ${g.tier}`}
								</span>
							</div>
							<div className="p-3">
								<div className="font-semibold text-sm line-clamp-1 group-hover:text-accent transition-colors">{g.name}</div>
								<div className="text-[11px] text-muted mt-0.5 tnum">appid {g.appid}</div>
								<div className="grid grid-cols-3 gap-2 mt-3 text-center">
									<div>
										<div className="text-sm font-bold tnum">{formatNumber(g.stats.items)}</div>
										<div className="text-[10px] text-muted">предметов</div>
									</div>
									<div>
										<div className="text-sm font-bold tnum">{formatNumber(g.stats.volume_24h)}</div>
										<div className="text-[10px] text-muted">объём 24ч</div>
									</div>
									<div>
										<div className={`text-sm font-bold tnum ${g.stats.active_opportunities > 0 ? 'text-profit' : ''}`}>
											{formatNumber(g.stats.active_opportunities)}
										</div>
										<div className="text-[10px] text-muted">сигналов</div>
									</div>
								</div>
								<div className="text-[10px] text-muted mt-2 flex justify-between">
									<span className={g.is_active ? '' : 'text-loss'}>{g.is_active ? `скан: ${timeAgo(g.last_scan_at)}` : 'выключена'}</span>
									<span>{g.last_scan_status ?? ''}</span>
								</div>
							</div>
						</Link>
					))}
				</div>
			)}
		</div>
	);
}
