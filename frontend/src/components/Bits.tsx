/** Small shared UI pieces: cards, icons, spinners, pagination, profit badges. */

import { Link } from 'react-router-dom';
import { formatPct } from '../format';

export function StatCard({ label, value, sub, accent }: { label: string; value: string | number; sub?: string; accent?: boolean }) {
	return (
		<div className="rounded-card border border-line bg-surface p-4 sm:p-5">
			<div className="text-xs sm:text-sm text-muted font-medium">{label}</div>
			<div className={`mt-1 text-2xl sm:text-3xl font-bold tnum ${accent ? 'text-accent' : ''}`}>{value}</div>
			{sub && <div className="mt-1 text-xs text-muted">{sub}</div>}
		</div>
	);
}

export function ItemIcon({ url, name, size = 'md' }: { url: string | null; name: string; size?: 'sm' | 'md' | 'lg' }) {
	const cls = size === 'sm' ? 'w-8 h-8' : size === 'lg' ? 'w-16 h-16 sm:w-20 sm:h-20' : 'w-10 h-10';
	if (!url) {
		return <div className={`${cls} rounded-lg bg-surface2 border border-line flex items-center justify-center text-muted text-xs`}>нет фото</div>;
	}
	return (
		<img
			src={url}
			alt={name}
			loading="lazy"
			className={`${cls} rounded-lg object-contain bg-surface2 border border-line`}
			onError={(e) => {
				(e.target as HTMLImageElement).style.visibility = 'hidden';
			}}
		/>
	);
}

export function ProfitBadge({ pct }: { pct: number | null | undefined }) {
	if (pct === null || pct === undefined) return <span className="text-muted">—</span>;
	const positive = pct > 0;
	return (
		<span className={`inline-block px-2 py-0.5 rounded-md text-xs font-semibold tnum ${positive ? 'bg-profit/15 text-profit' : 'bg-loss/15 text-loss'}`}>
			{formatPct(pct)}
		</span>
	);
}

export function Spinner({ label = 'Загрузка…' }: { label?: string }) {
	return (
		<div className="flex items-center gap-3 text-muted py-10 justify-center">
			<svg className="animate-spin h-5 w-5 text-accent" viewBox="0 0 24 24" fill="none">
				<circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
				<path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
			</svg>
			<span className="text-sm">{label}</span>
		</div>
	);
}

export function ErrorNote({ message, onRetry }: { message: string; onRetry?: () => void }) {
	return (
		<div className="rounded-card border border-loss/40 bg-loss/10 text-loss text-sm px-4 py-3 flex items-center gap-3">
			<span>⚠️ {message}</span>
			{onRetry && (
				<button onClick={onRetry} className="ml-auto underline hover:no-underline text-xs font-semibold">
					повторить
				</button>
			)}
		</div>
	);
}

export function EmptyNote({ children }: { children: React.ReactNode }) {
	return <div className="text-center text-muted text-sm py-10 border border-dashed border-line rounded-card">{children}</div>;
}

export function Pagination({ total, limit, offset, onChange }: { total: number; limit: number; offset: number; onChange: (offset: number) => void }) {
	const pages = Math.max(1, Math.ceil(total / limit));
	const current = Math.floor(offset / limit) + 1;
	if (total <= limit) return null;

	const btn = (label: string, page: number | null, disabled = false, active = false) => (
		<button
			key={label}
			disabled={disabled || page === null}
			onClick={() => page !== null && onChange((page - 1) * limit)}
			className={`px-3 py-1.5 rounded-lg text-sm border tnum transition-colors ${
				active ? 'border-accent bg-accent/15 text-accent font-semibold' : 'border-line bg-surface text-muted hover:text-ink disabled:opacity-40'
			}`}
		>
			{label}
		</button>
	);

	const window_: number[] = [];
	for (let p = Math.max(1, current - 2); p <= Math.min(pages, current + 2); p++) window_.push(p);

	return (
		<div className="flex items-center gap-1.5 flex-wrap mt-4">
			{btn('←', current > 1 ? current - 1 : null)}
			{window_[0]! > 1 && btn('1', 1, false, current === 1)}
			{window_[0]! > 2 && <span className="text-muted px-1">…</span>}
			{window_.map((p) => btn(String(p), p, false, p === current))}
			{window_[window_.length - 1]! < pages - 1 && <span className="text-muted px-1">…</span>}
			{window_[window_.length - 1]! < pages && btn(String(pages), pages, false, current === pages)}
			{btn('→', current < pages ? current + 1 : null)}
			<span className="text-xs text-muted ml-2 tnum">
				{total.toLocaleString('ru-RU')} строк · стр. {current} из {pages}
			</span>
		</div>
	);
}

export function ItemLink({ itemId, children }: { itemId: number; children: React.ReactNode }) {
	return <Link to={`/items/${itemId}`} className="hover:text-accent transition-colors">{children}</Link>;
}

export function SteamButton({ url }: { url: string }) {
	return (
		<a
			href={url}
			target="_blank"
			rel="noreferrer"
			className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs font-semibold border border-line2 bg-surface2 text-muted hover:text-ink hover:border-accent/60 transition-colors whitespace-nowrap"
		>
			Steam ↗
		</a>
	);
}

export function PeriodSwitch({ value, onChange, periods = ['24h', '7d', '30d'] }: { value: string; onChange: (p: string) => void; periods?: string[] }) {
	const labels: Record<string, string> = { '24h': '24 часа', '7d': '7 дней', '30d': '30 дней' };
	return (
		<div className="inline-flex rounded-lg border border-line overflow-hidden">
			{periods.map((p) => (
				<button
					key={p}
					onClick={() => onChange(p)}
					className={`px-3 py-1 text-xs font-semibold transition-colors ${p === value ? 'bg-accent/20 text-accent' : 'bg-surface text-muted hover:text-ink'}`}
				>
					{labels[p] ?? p}
				</button>
			))}
		</div>
	);
}
