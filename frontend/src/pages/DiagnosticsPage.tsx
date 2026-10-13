import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import { formatDateTime, formatNumber, timeAgo } from '../format';
import type { DiagnosticsResponse } from '../types';

function ageLabel(ms: number | null): string {
	if (ms === null) return 'нет данных';
	return timeAgo(Date.now() - ms);
}

function dueLabel(ms: number): string {
	if (ms <= 0) return 'готово';
	const minutes = Math.ceil(ms / 60_000);
	if (minutes < 60) return `через ${minutes} мин`;
	const hours = Math.floor(minutes / 60);
	const rest = minutes % 60;
	return rest ? `через ${hours} ч ${rest} мин` : `через ${hours} ч`;
}

function statusStyle(status: string | null | undefined): string {
	if (status === 'ok') return 'text-profit bg-profit/10 border-profit/30';
	if (status === 'partial') return 'text-warn bg-warn/10 border-warn/30';
	if (status === 'error' || status === 'rate_limited' || status === 'currency_mismatch') return 'text-loss bg-loss/10 border-loss/30';
	return 'text-muted bg-surface2 border-line';
}

function MiniMetric({ label, value, hint }: { label: string; value: string; hint?: string }) {
	return (
		<div className="rounded-xl border border-line bg-surface p-3 min-w-0">
			<div className="text-[11px] uppercase tracking-wide text-muted">{label}</div>
			<div className="mt-1 text-lg font-bold tnum truncate">{value}</div>
			{hint && <div className="mt-1 text-[11px] text-muted truncate">{hint}</div>}
		</div>
	);
}

async function copyText(text: string): Promise<void> {
	if (navigator.clipboard?.writeText) {
		await navigator.clipboard.writeText(text);
		return;
	}
	const textarea = document.createElement('textarea');
	textarea.value = text;
	textarea.style.position = 'fixed';
	textarea.style.opacity = '0';
	document.body.appendChild(textarea);
	textarea.select();
	const copied = document.execCommand('copy');
	document.body.removeChild(textarea);
	if (!copied) throw new Error('Браузер не разрешил копирование');
}

export default function DiagnosticsPage() {
	const [report, setReport] = useState<DiagnosticsResponse | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [loading, setLoading] = useState(true);
	const [refreshing, setRefreshing] = useState(false);
	const [copyMessage, setCopyMessage] = useState('');

	const load = useCallback(async (showSpinner = true) => {
		if (showSpinner) setRefreshing(true);
		try {
			const next = await api.diagnostics();
			setReport(next);
			setError(null);
			return next;
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			setError(message);
			return null;
		} finally {
			setLoading(false);
			setRefreshing(false);
		}
	}, []);

	useEffect(() => {
		void load(false);
		const timer = window.setInterval(() => void load(false), 60_000);
		return () => window.clearInterval(timer);
	}, [load]);

	const json = useMemo(() => (report ? JSON.stringify(report, null, 2) : ''), [report]);
	const tf2 = report?.games.find((game) => game.appid === 440);
	const tickTotals = report?.tick_history_24h.hourly.reduce(
		(total, hour) => ({
			ticks: total.ticks + hour.ticks,
			requests: total.requests + hour.steam_requests,
			errors: total.errors + hour.steam_errors,
			details: total.details + hour.details_processed,
			nameidMissing: total.nameidMissing + hour.nameid_missing,
			volume: total.volume + hour.volume_retrieved,
		}),
		{ ticks: 0, requests: 0, errors: 0, details: 0, nameidMissing: 0, volume: 0 }
	);

	const copyReport = async () => {
		setCopyMessage('');
		const latest = await load(false);
		const payload = latest ?? report;
		if (!payload) {
			setCopyMessage('Отчёт пока не загружен');
			return;
		}
		try {
			await copyText(JSON.stringify(payload, null, 2));
			setCopyMessage('Отчёт скопирован — вставьте его сюда в чат.');
		} catch (err) {
			setCopyMessage(err instanceof Error ? err.message : 'Не удалось скопировать отчёт');
		}
	};

	const downloadReport = () => {
		if (!report) return;
		const blob = new Blob([JSON.stringify(report, null, 2)], { type: 'application/json;charset=utf-8' });
		const url = URL.createObjectURL(blob);
		const link = document.createElement('a');
		link.href = url;
		link.download = `steam-market-diagnostics-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
		link.click();
		URL.revokeObjectURL(url);
	};

	return (
		<div className="space-y-5">
			<div className="flex flex-wrap items-start justify-between gap-3">
				<div>
					<h1 className="text-2xl sm:text-3xl font-extrabold tracking-tight">Диагностика сканера</h1>
					<p className="mt-1 max-w-3xl text-sm text-muted">
						Подробный отчёт о работе Steam-запросов, очереди buy-данных, объёмах и состоянии игр. Страница обновляется автоматически раз в минуту.
					</p>
				</div>
				<div className="flex flex-wrap gap-2">
					<button
						type="button"
						onClick={() => void load(true)}
						disabled={refreshing}
						className="rounded-lg border border-line2 bg-surface2 px-3 py-2 text-sm font-semibold hover:border-accent/60 disabled:opacity-50"
					>
						{refreshing ? 'Обновляю…' : '↻ Обновить'}
					</button>
					<button
						type="button"
						onClick={() => void copyReport()}
						disabled={!report}
						className="rounded-lg bg-accent px-3 py-2 text-sm font-semibold text-white hover:bg-accent2 disabled:opacity-50"
					>
						📋 Скопировать отчёт
					</button>
					<button
						type="button"
						onClick={downloadReport}
						disabled={!report}
						className="rounded-lg border border-line2 bg-surface2 px-3 py-2 text-sm font-semibold hover:border-accent/60 disabled:opacity-50"
					>
						⬇ JSON
					</button>
				</div>
			</div>

			{copyMessage && <div className="rounded-lg border border-accent/30 bg-accent/10 px-3 py-2 text-sm text-accent">{copyMessage}</div>}
			{error && (
				<div className="rounded-lg border border-loss/30 bg-loss/10 px-3 py-2 text-sm text-loss">
					Не удалось загрузить диагностику: {error}. Нажмите «Обновить» и попробуйте ещё раз.
				</div>
			)}
			{loading && !report && <div className="rounded-card border border-line bg-surface p-6 text-sm text-muted">Собираю отчёт…</div>}

			{report && (
				<>
					<div className="rounded-card border border-line bg-surface p-4 text-sm text-muted">
						<div className="flex flex-wrap items-center gap-x-3 gap-y-1">
							<span className={`rounded-full border px-2 py-0.5 text-xs font-semibold ${statusStyle(report.status === 'ok' ? 'ok' : report.status)}`}>
								{report.status === 'ok' ? 'Сканер отвечает' : report.status}
							</span>
							<span>Отчёт на {formatDateTime(report.generated_at)}</span>
							<span>Последний успешный запрос: {ageLabel(report.scheduler.last_successful_scan_age_ms)}</span>
							<span>Успехи в HTTP-логе семплируются 1 из {report.config.logging.success_sample_every_n}</span>
						</div>
						<p className="mt-2 text-xs">
							В отчёт не попадают Steam-cookie, admin-ключ, proxy URL, IP посетителей, названия предметов и сырые URL запросов. Ошибки запросов записываются все; успешные HTTP-запросы — выборочно.
						</p>
					</div>

					<div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
						<MiniMetric label="Тиков за период" value={formatNumber(tickTotals?.ticks ?? report.tick_history_24h.rows_captured)} hint="история до 24 часов" />
						<MiniMetric label="Steam-запросы" value={formatNumber(tickTotals?.requests ?? 0)} hint={`ошибок в тиках: ${formatNumber(tickTotals?.errors ?? 0)}`} />
						<MiniMetric label="Очередь деталей" value={formatNumber(report.queue.total)} hint={`${formatNumber(report.queue.due_now)} готовы · ${formatNumber(report.queue.waiting_for_retry)} ждут`} />
						<MiniMetric label="TF2 Buy Max" value={`${formatNumber(tf2?.buy_max_known_items ?? 0)} / ${formatNumber(tf2?.tracked_items ?? 0)}`} hint="предметов с buy-ценой / отслеживается" />
						<MiniMetric label="TF2 item_nameid" value={`${formatNumber(tf2?.nameid_known_items ?? 0)} / ${formatNumber(tf2?.tracked_items ?? 0)}`} hint="ID найден / отслеживается" />
						<MiniMetric label="429 за 24ч" value={formatNumber(report.request_activity_24h.http_429_rows)} hint={`сейчас подряд: ${report.scheduler.consecutive_429}`} />
					</div>

					<section className="rounded-card border border-line bg-surface p-4">
						<div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
							<h2 className="text-lg font-bold">Состояние игр и заполненность данных</h2>
							<span className="text-xs text-muted">Buy Max из ордербука · volume из priceoverview · freshness: {Math.round(report.config.spread.detail_fresh_ms / 3_600_000)} ч</span>
						</div>
						<div className="scroll-thin overflow-x-auto">
							<table className="w-full min-w-[1120px] text-xs">
								<thead className="text-muted">
									<tr className="border-b border-line text-left">
										<th className="px-2 py-2">Игра</th>
										<th className="px-2 py-2">Последний список</th>
										<th className="px-2 py-2 text-right">Предметы</th>
										<th className="px-2 py-2 text-right">NameID</th>
										<th className="px-2 py-2 text-right">Buy Max</th>
										<th className="px-2 py-2 text-right">Объём</th>
										<th className="px-2 py-2 text-right">Детали свежие</th>
										<th className="px-2 py-2 text-right">Без buy после деталей</th>
										<th className="px-2 py-2 text-right">Очередь</th>
										<th className="px-2 py-2 text-right">Снимков 24ч</th>
									</tr>
								</thead>
								<tbody>
									{report.games.map((game) => (
										<tr key={game.appid} className={`border-b border-line/70 ${game.appid === 440 ? 'bg-accent/5' : ''}`}>
											<td className="px-2 py-2">
												<a className="font-semibold text-ink hover:text-accent" href={`/games/${game.appid}`}>{game.name}</a>
												<div className="text-[10px] text-muted">{game.appid} · tier {game.tier}</div>
											</td>
											<td className="px-2 py-2">
												<span className={`rounded border px-1.5 py-0.5 ${statusStyle(game.last_scan_status)}`}>{game.last_scan_status ?? 'ещё не сканировалась'}</span>
												<div className="mt-1 text-muted">{ageLabel(game.last_scan_age_ms)}</div>
											</td>
											<td className="px-2 py-2 text-right tnum">{formatNumber(game.tracked_items)}</td>
											<td className="px-2 py-2 text-right tnum">{formatNumber(game.nameid_known_items)} <span className="text-muted">/ {formatNumber(game.nameid_missing_items)} без ID</span></td>
											<td className="px-2 py-2 text-right tnum">{formatNumber(game.buy_max_known_items)}</td>
											<td className="px-2 py-2 text-right tnum">{formatNumber(game.volume_known_items)}</td>
											<td className="px-2 py-2 text-right tnum">{formatNumber(game.detail_fresh_items)} <span className="text-muted">/ {formatNumber(game.ever_detailed_items)} всего</span></td>
											<td className="px-2 py-2 text-right tnum">{formatNumber(game.detailed_without_buy_items)}</td>
											<td className="px-2 py-2 text-right tnum">{formatNumber(game.queue.due_now)} / {formatNumber(game.queue.total)}</td>
											<td className="px-2 py-2 text-right tnum">{formatNumber(game.snapshots_24h)}</td>
										</tr>
									))}
								</tbody>
							</table>
						</div>
					</section>

					<section className="rounded-card border border-line bg-surface p-4">
						<div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
							<h2 className="text-lg font-bold">Почасовая история за последние 24 часа</h2>
							<span className="text-xs text-muted">собрано тиков: {formatNumber(report.tick_history_24h.rows_captured)} · с {formatDateTime(report.tick_history_24h.first_tick_at)}</span>
						</div>
						{!report.tick_history_24h.available ? (
							<p className="text-sm text-warn">История тиков пока недоступна; новые запуски начнут записываться автоматически после обновления Worker.</p>
						) : report.tick_history_24h.hourly.length === 0 ? (
							<p className="text-sm text-muted">Запуски ещё не записаны. Оставьте страницу и вернитесь позже — журнал сохраняется в D1.</p>
						) : (
							<div className="scroll-thin max-h-80 overflow-auto">
								<table className="w-full min-w-[930px] text-xs">
									<thead className="sticky top-0 bg-surface text-muted">
										<tr className="border-b border-line text-left">
											<th className="px-2 py-2">Час (UTC)</th>
											<th className="px-2 py-2 text-right">Тики</th>
											<th className="px-2 py-2 text-right">Steam req / err</th>
											<th className="px-2 py-2 text-right">Детали</th>
											<th className="px-2 py-2 text-right">TF2 detail</th>
											<th className="px-2 py-2 text-right">NameID missing</th>
											<th className="px-2 py-2 text-right">Объём найден</th>
											<th className="px-2 py-2 text-right">429-паузы/ошибки</th>
										</tr>
									</thead>
									<tbody>
										{report.tick_history_24h.hourly.map((hour) => {
											const tf2Hour = hour.by_appid['440'];
											return (
												<tr key={hour.hour_start} className="border-b border-line/70">
													<td className="px-2 py-2">{formatDateTime(hour.hour_start)}</td>
													<td className="px-2 py-2 text-right tnum">{hour.completed_ticks}/{hour.ticks} <span className="text-muted">(lock {hour.skipped_locked}, pause {hour.skipped_paused})</span></td>
													<td className="px-2 py-2 text-right tnum">{hour.steam_requests} / {hour.steam_errors}</td>
													<td className="px-2 py-2 text-right tnum">{hour.details_processed} <span className="text-muted">(ok {hour.details_succeeded}, fail {hour.details_failed})</span></td>
													<td className="px-2 py-2 text-right tnum">{tf2Hour ? `${tf2Hour.processed} · vol ${tf2Hour.volume_retrieved} · ID− ${tf2Hour.nameid_missing}` : '—'}</td>
													<td className="px-2 py-2 text-right tnum">{hour.nameid_missing}</td>
													<td className="px-2 py-2 text-right tnum">{hour.volume_retrieved}/{hour.details_processed}</td>
													<td className="px-2 py-2 text-right tnum">{hour.errored_ticks} <span className="text-muted">(список: partial {hour.partial_game_scans}, err {hour.failed_game_scans})</span></td>
												</tr>
											);
										})}
									</tbody>
								</table>
							</div>
						)}
					</section>

					<section className="rounded-card border border-line bg-surface p-4">
						<div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
							<h2 className="text-lg font-bold">Очередь деталей (первые 50)</h2>
							<span className="text-xs text-muted">Без названий предметов; список показывает, до чего очередь должна дойти дальше.</span>
						</div>
						{report.queue.preview.length === 0 ? (
							<p className="text-sm text-muted">Очередь пуста.</p>
						) : (
							<div className="scroll-thin max-h-80 overflow-auto">
								<table className="w-full min-w-[850px] text-xs">
									<thead className="sticky top-0 bg-surface text-muted">
										<tr className="border-b border-line text-left">
											<th className="px-2 py-2">Игра</th>
											<th className="px-2 py-2">item_id</th>
											<th className="px-2 py-2 text-right">Ранг / попытки</th>
											<th className="px-2 py-2">Следующая попытка</th>
											<th className="px-2 py-2">Данные</th>
											<th className="px-2 py-2">Последняя причина</th>
										</tr>
									</thead>
									<tbody>
										{report.queue.preview.map((row) => (
											<tr key={`${row.appid}-${row.item_id}`} className={`border-b border-line/70 ${row.appid === 440 ? 'bg-accent/5' : ''}`}>
												<td className="px-2 py-2">{row.game_name} <span className="text-muted">({row.appid})</span></td>
												<td className="px-2 py-2 font-mono">{row.item_id}</td>
												<td className="px-2 py-2 text-right tnum">{row.priority} / {row.attempts}</td>
												<td className="px-2 py-2">{dueLabel(row.due_in_ms)}</td>
												<td className="px-2 py-2">ID {row.item_nameid_cached ? '✓' : '—'} · vol {row.volume_known ? '✓' : '—'} · buy {row.buy_max_known ? '✓' : '—'}</td>
												<td className="px-2 py-2 text-muted">{row.last_error ?? '—'}</td>
											</tr>
										))}
									</tbody>
								</table>
							</div>
						)}
					</section>

					<section className="rounded-card border border-line bg-surface p-4">
						<div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
							<h2 className="text-lg font-bold">Последние HTTP-запросы к Steam</h2>
							<span className="text-xs text-muted">Последние {report.recent_request_log.length}; все ошибки дополнительно вынесены отдельно в JSON.</span>
						</div>
						{report.recent_request_log.length === 0 ? (
							<p className="text-sm text-muted">Запросов в журнале пока нет.</p>
						) : (
							<div className="scroll-thin max-h-80 overflow-auto">
								<table className="w-full min-w-[760px] text-xs">
									<thead className="sticky top-0 bg-surface text-muted">
										<tr className="border-b border-line text-left">
											<th className="px-2 py-2">Время</th>
											<th className="px-2 py-2">Endpoint</th>
											<th className="px-2 py-2">Игра / item_id</th>
											<th className="px-2 py-2">HTTP</th>
											<th className="px-2 py-2 text-right">мс</th>
											<th className="px-2 py-2">Ошибка</th>
										</tr>
									</thead>
									<tbody>
										{report.recent_request_log.map((row) => (
											<tr key={row.id} className="border-b border-line/70">
												<td className="px-2 py-2 whitespace-nowrap">{formatDateTime(row.created_at)}</td>
												<td className="px-2 py-2 font-mono">{row.endpoint}</td>
												<td className="px-2 py-2">{row.appid ?? '—'} / {row.item_id ?? '—'}</td>
												<td className={`px-2 py-2 ${row.ok ? 'text-profit' : 'text-loss'}`}>{row.http_status ?? 'NET'}{row.ok ? ' ✓' : ' ✕'}</td>
												<td className="px-2 py-2 text-right tnum">{row.duration_ms ?? '—'}</td>
												<td className="max-w-sm truncate px-2 py-2 text-muted">{row.error ?? '—'}</td>
											</tr>
										))}
									</tbody>
								</table>
							</div>
						)}
					</section>

					<section className="grid gap-4 xl:grid-cols-2">
						<div className="rounded-card border border-line bg-surface p-4">
							<h2 className="mb-3 text-lg font-bold">Сводка Steam-запросов за 24 часа</h2>
							<div className="scroll-thin max-h-72 overflow-auto">
								<table className="w-full min-w-[520px] text-xs">
									<thead className="sticky top-0 bg-surface text-muted">
										<tr className="border-b border-line text-left">
											<th className="px-2 py-2">Endpoint / HTTP</th>
											<th className="px-2 py-2 text-right">Записей*</th>
											<th className="px-2 py-2 text-right">Ошибок / 429</th>
											<th className="px-2 py-2 text-right">Среднее мс</th>
											<th className="px-2 py-2">Последний</th>
										</tr>
									</thead>
									<tbody>
										{report.request_activity_24h.by_endpoint_and_status.map((row) => (
											<tr key={`${row.endpoint}-${row.http_status}`} className="border-b border-line/70">
												<td className="px-2 py-2 font-mono">{row.endpoint} / {row.http_status ?? 'NET'}</td>
												<td className="px-2 py-2 text-right tnum">{row.logged_rows}</td>
												<td className="px-2 py-2 text-right tnum">{row.failed_rows} / {row.http_429_rows}</td>
												<td className="px-2 py-2 text-right tnum">{row.avg_duration_ms ?? '—'}</td>
												<td className="px-2 py-2">{formatDateTime(row.last_at)}</td>
											</tr>
										))}
									</tbody>
								</table>
							</div>
							<p className="mt-2 text-[11px] text-muted">* Успешные запросы семплируются, поэтому число записей успеха меньше реального числа вызовов.</p>
						</div>
						<div className="rounded-card border border-line bg-surface p-4">
							<h2 className="mb-3 text-lg font-bold">Последние ошибки Steam</h2>
							{report.recent_failures.length === 0 ? (
								<p className="text-sm text-muted">Ошибок в журнале нет.</p>
							) : (
								<div className="scroll-thin max-h-72 overflow-auto">
									<table className="w-full min-w-[520px] text-xs">
										<thead className="sticky top-0 bg-surface text-muted">
											<tr className="border-b border-line text-left">
												<th className="px-2 py-2">Время</th>
												<th className="px-2 py-2">Endpoint</th>
												<th className="px-2 py-2">Игра/item</th>
												<th className="px-2 py-2">HTTP</th>
												<th className="px-2 py-2">Причина</th>
											</tr>
										</thead>
										<tbody>
											{report.recent_failures.map((row) => (
												<tr key={row.id} className="border-b border-line/70">
													<td className="whitespace-nowrap px-2 py-2">{formatDateTime(row.created_at)}</td>
													<td className="px-2 py-2 font-mono">{row.endpoint}</td>
													<td className="px-2 py-2">{row.appid ?? '—'} / {row.item_id ?? '—'}</td>
													<td className="px-2 py-2 text-loss">{row.http_status ?? 'NET'}</td>
													<td className="max-w-sm truncate px-2 py-2 text-muted">{row.error ?? '—'}</td>
												</tr>
											))}
										</tbody>
									</table>
								</div>
							)}
						</div>
					</section>

					<details className="rounded-card border border-line bg-surface p-4">
						<summary className="cursor-pointer font-semibold">Полный JSON отчёта ({formatNumber(new Blob([json]).size)} байт)</summary>
						<p className="mt-2 text-xs text-muted">Этот же JSON копируется кнопкой «Скопировать отчёт» или сохраняется кнопкой «JSON».</p>
						<pre className="scroll-thin mt-3 max-h-[32rem] overflow-auto rounded-lg border border-line bg-bg p-3 text-[11px] leading-relaxed text-muted">{json}</pre>
					</details>
				</>
			)}
		</div>
	);
}
