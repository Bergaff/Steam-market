/** Formatting helpers (ru-RU locale, money from integer cents). */

export function formatMoney(cents: number | null | undefined, currency = 'RUB'): string {
	if (cents === null || cents === undefined) return '—';
	try {
		return new Intl.NumberFormat('ru-RU', {
			style: 'currency',
			currency,
			minimumFractionDigits: 2,
			maximumFractionDigits: 2,
		}).format(cents / 100);
	} catch {
		return `${(cents / 100).toFixed(2)} ${currency}`;
	}
}

/** Compact money for chart axes: 1 234 ₽, 12 345 ₽. */
export function formatMoneyShort(cents: number | null | undefined, currency = 'RUB'): string {
	if (cents === null || cents === undefined) return '—';
	const symbol = currency === 'RUB' ? '₽' : currency;
	const units = cents / 100;
	if (units >= 1000) return `${Math.round(units).toLocaleString('ru-RU')} ${symbol}`;
	return `${units.toLocaleString('ru-RU', { maximumFractionDigits: 2 })} ${symbol}`;
}

export function formatNumber(n: number | null | undefined): string {
	if (n === null || n === undefined) return '—';
	return n.toLocaleString('ru-RU');
}

export function formatPct(pct: number | null | undefined, signed = true): string {
	if (pct === null || pct === undefined || !Number.isFinite(pct)) return '—';
	const s = pct.toFixed(1).replace('.', ',');
	return `${signed && pct > 0 ? '+' : ''}${s}%`;
}

export function formatDateTime(ms: number | null | undefined): string {
	if (!ms) return '—';
	return new Date(ms).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' });
}

export function formatTime(ms: number | null | undefined): string {
	if (!ms) return '—';
	return new Date(ms).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
}

export function timeAgo(ms: number | null | undefined): string {
	if (!ms) return 'никогда';
	const sec = Math.max(0, Math.round((Date.now() - ms) / 1000));
	if (sec < 60) return `${sec} с назад`;
	const min = Math.round(sec / 60);
	if (min < 60) return `${min} мин назад`;
	const h = Math.round(min / 60);
	if (h < 24) return `${h} ч назад`;
	return `${Math.round(h / 24)} дн назад`;
}

export function pluralRu(n: number, one: string, few: string, many: string): string {
	const mod10 = n % 10;
	const mod100 = n % 100;
	if (mod10 === 1 && mod100 !== 11) return one;
	if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return few;
	return many;
}

export function gameImage(appid: number): string {
	return `https://cdn.cloudflare.steamstatic.com/steam/apps/${appid}/capsule_184x69.jpg`;
}
