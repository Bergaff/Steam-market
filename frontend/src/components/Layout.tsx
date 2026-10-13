import { NavLink, Outlet } from 'react-router-dom';
import { useEffect, useState } from 'react';
import { api } from '../api';
import type { AppConfig } from '../types';
import { timeAgo } from '../format';

interface Health {
	status: string;
	last_successful_scan_at: number | null;
	paused_until: number | null;
	demo_mode: boolean;
}

const NAV = [
	{ to: '/', label: 'Дашборд', end: true },
	{ to: '/games', label: 'Игры', end: false },
	{ to: '/opportunities', label: 'Возможности', end: false },
	{ to: '/diagnostics', label: 'Диагностика', end: false },
];

export default function Layout() {
	const [config, setConfig] = useState<AppConfig | null>(null);
	const [health, setHealth] = useState<Health | null>(null);

	useEffect(() => {
		api.config().then(setConfig).catch(() => setConfig(null));
		const loadHealth = () =>
			fetch('/health')
				.then((r) => r.json())
				.then((h: Health) => setHealth(h))
				.catch(() => setHealth(null));
		loadHealth();
		const t = setInterval(loadHealth, 60_000);
		return () => clearInterval(t);
	}, []);

	const demoMode = config?.demo_mode || health?.demo_mode || false;
	const statusColor =
		health === null ? 'bg-muted' : health.status === 'ok' ? 'bg-profit' : health.status === 'paused' ? 'bg-warn' : 'bg-loss';

	return (
		<div className="min-h-screen flex flex-col">
			{/* Header */}
			<header className="sticky top-0 z-40 border-b border-line bg-bg/90 backdrop-blur">
				<div className="mx-auto max-w-7xl px-4 h-14 flex items-center gap-6">
					<NavLink to="/" className="flex items-center gap-2 font-bold text-base shrink-0">
						<span className="text-xl">📈</span>
						<span>
							Steam Market <span className="text-accent">Analytics</span>
						</span>
					</NavLink>

					<nav className="flex items-center gap-1 overflow-x-auto scroll-thin">
						{NAV.map((n) => (
							<NavLink
								key={n.to}
								to={n.to}
								end={n.end}
								className={({ isActive }) =>
									`px-3 py-1.5 rounded-lg text-sm font-medium whitespace-nowrap transition-colors ${
										isActive ? 'bg-surface2 text-ink' : 'text-muted hover:text-ink hover:bg-surface'
									}`
								}
							>
								{n.label}
							</NavLink>
						))}
					</nav>

					<div className="ml-auto flex items-center gap-3 text-xs text-muted shrink-0">
						{health && (
							<span className="hidden sm:flex items-center gap-1.5" title={`Последний скан: ${timeAgo(health.last_successful_scan_at)}`}>
								<span className={`w-2 h-2 rounded-full live-dot ${statusColor}`} />
								{health.status === 'ok' ? 'live' : health.status === 'paused' ? 'пауза (429)' : health.status}
							</span>
						)}
						<span className="hidden md:inline">скан: {timeAgo(health?.last_successful_scan_at)}</span>
					</div>
				</div>
			</header>

			{/* Demo banner */}
			{demoMode && (
				<div className="bg-warn/10 border-b border-warn/30 text-warn text-xs sm:text-sm">
					<div className="mx-auto max-w-7xl px-4 py-2">
						⚠️ Демо-режим: данные синтетические (Steam API не подключён). В проде установите <code className="font-mono">DEMO_MODE=0</code>.
					</div>
				</div>
			)}

			{/* Content */}
			<main className="flex-1 mx-auto w-full max-w-7xl px-4 py-6">
				<Outlet />
			</main>

			{/* Footer */}
			<footer className="border-t border-line mt-8">
				<div className="mx-auto max-w-7xl px-4 py-6 text-xs sm:text-sm text-muted space-y-2">
					<p>
						<b className="text-ink">Steam Market Analytics</b> — мониторинг нишевых рынков Steam Community Market: объёмы торгов,
						спреды между buy-ордерами и sell-лотами, прибыль с учётом комиссии Steam (15%), история цен.
					</p>
					<p className="text-muted/80">
						🔒 Сервис <b className="text-ink">никогда</b> не запрашивает логин, пароль, API-ключ Steam или trade-ссылку — используются
						только публичные read-only данные торговой площадки.
					</p>
					<p className="flex flex-wrap items-center gap-3 pt-1">
						<span>© {new Date().getFullYear()} Steam Market Analytics</span>
						<a className="hover:text-accent" href="https://t.me/" target="_blank" rel="noreferrer">
							Telegram-канал
						</a>
						<a className="hover:text-accent" href="/api/v1" target="_blank" rel="noreferrer">
							API
						</a>
						<a className="hover:text-accent" href="/health" target="_blank" rel="noreferrer">
							Health
						</a>
						<NavLink className="hover:text-accent" to="/diagnostics">
							Отчёт диагностики
						</NavLink>
						<span className="opacity-60">Не является офертой. Не связан с Valve Corporation.</span>
					</p>
				</div>
			</footer>
		</div>
	);
}
