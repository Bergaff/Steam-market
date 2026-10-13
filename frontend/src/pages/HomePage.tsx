import { Link } from 'react-router-dom';
import { api } from '../api';
import { useFetch } from '../hooks';
import { StatCard, Spinner, ErrorNote } from '../components/Bits';
import OpportunityTable from '../components/OpportunityTable';
import { formatMoney, formatNumber, timeAgo } from '../format';

/**
 * Главная (TZ §8): блок «Сейчас на рынке» (3 карточки) + «🔥 Топ возможностей»
 * с обновлением раз в минуту.
 */
export default function HomePage() {
	const stats = useFetch(() => api.stats(), 60_000);
	const opps = useFetch(() => api.opportunities({ limit: 15, sort: 'profit', dir: 'desc' }), 60_000);

	const currency = stats.data?.currency ?? opps.data?.currency ?? 'RUB';

	return (
		<div className="space-y-6">
			{/* Hero */}
			<div>
				<h1 className="text-2xl sm:text-3xl font-extrabold tracking-tight">Сейчас на рынке</h1>
				<p className="text-muted text-sm mt-1 max-w-3xl">
					Нишевые игры Steam Community Market в реальном времени: объёмы, спреды buy/sell и прибыль после комиссии Steam (15%).
					Данные обновляются автоматически каждые 5–30 минут в зависимости от игры.
				</p>
			</div>

			{stats.error && <ErrorNote message={`Статистика недоступна: ${stats.error}`} onRetry={stats.refresh} />}

			{/* 3 stat cards */}
			<div className="grid grid-cols-1 sm:grid-cols-3 gap-3 sm:gap-4">
				<StatCard
					label="Игр в мониторинге"
					value={stats.data ? `${stats.data.games.active} / ${stats.data.games.total}` : '…'}
					sub={stats.data ? `тир 1 — каждые 5 мин` : undefined}
				/>
				<StatCard
					label="Предметов отслеживается"
					value={stats.data ? formatNumber(stats.data.items.total) : '…'}
					sub={stats.data ? `снимков за 24ч: ${formatNumber(stats.data.snapshots_24h)}` : undefined}
					accent
				/>
				<StatCard
					label="Активных сигналов"
					value={stats.data ? formatNumber(stats.data.opportunities.active) : '…'}
					sub={
						stats.data && stats.data.opportunities.avg_profit_pct !== null
							? `средний профит: ${stats.data.opportunities.avg_profit_pct.toFixed(1)}%`
							: 'спред ≥ порога после комиссии'
					}
				/>
			</div>

			{/* Top opportunities */}
			<section>
				<div className="flex items-center justify-between gap-4 mb-3">
					<h2 className="text-lg sm:text-xl font-bold">🔥 Топ возможностей сейчас</h2>
					<div className="flex items-center gap-3 text-xs text-muted">
						{stats.data?.scanner.last_scan_at ? <span>скан: {timeAgo(stats.data.scanner.last_scan_at)}</span> : null}
						<Link to="/opportunities" className="text-accent hover:underline font-semibold">
							Все возможности →
						</Link>
					</div>
				</div>

				{opps.loading && !opps.data ? (
					<Spinner label="Ищем сигналы на рынке…" />
				) : opps.error ? (
					<ErrorNote message={opps.error} onRetry={opps.refresh} />
				) : (
					<OpportunityTable rows={opps.data?.opportunities ?? []} currency={currency} />
				)}
			</section>

			{/* Privacy / how it works */}
			<section className="rounded-card border border-line bg-surface p-4 sm:p-5 text-sm text-muted space-y-2">
				<h3 className="text-ink font-semibold">Как это работает</h3>
				<ul className="list-disc pl-5 space-y-1">
					<li>
						Сервис читает <b className="text-ink">публичные</b> данные торговой площадки Steam: цены лотов, buy-ордера, объёмы продаж.
					</li>
					<li>
						Сигнал = предмет, где <code className="text-accent font-mono text-xs">sell × 0.85 − buy ≥ 10%</code> при объёме ≥ 5 продаж/сутки и цене buy ≥ {formatMoney(500, currency)}.
					</li>
					<li>
						🔒 Мы <b className="text-ink">никогда</b> не запрашиваем логин/пароль Steam, API-ключ или trade-ссылку. Авторизация не нужна.
					</li>
				</ul>
			</section>
		</div>
	);
}
