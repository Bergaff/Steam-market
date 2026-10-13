/**
 * Pure parsing helpers for Steam Community Market responses.
 *
 * Steam returns prices as localized strings ("1 234,56 ₽", "12345,-- руб.",
 * "$12.34") depending on language/currency cookies, and integer cents in
 * search/render (`sell_price`). These helpers normalize everything to
 * INTEGER CENTS.
 */

// ---------------------------------------------------------------------------
// Prices
// ---------------------------------------------------------------------------

const CURRENCY_SYMBOLS = ['₽', 'руб.', 'руб', '$', '€', '£', '¥', '₴', '₩', '₺', '₸', 'R$', 'CDN$', 'A$', 'NZ$', 'S$', 'RM', 'SR', 'DH', '﷼', 'S/.', 'CLP$', 'COL$', 'CRC₡', 'USD', 'EUR', 'GBP', 'BYN', 'KZT', 'INR', 'CNY', 'JPY', 'KRW', 'HKD', 'TWD', 'THB', 'MYR', 'PHP', 'SGD', 'VND', 'IDR', 'ZAR', 'MXN', 'CAD', 'AUD', 'BRL', 'PLN', 'NOK', 'SEK', 'CHF', 'UAH', 'AED', 'SAR', 'QAR', 'KWD', 'ILS', 'PEN', 'ARS', 'CRC', 'UYU', 'CLP', 'COP'];

/**
 * Parse a localized price string into integer cents.
 *
 * Handles:
 *   "123,45 ₽"      -> 12345     (ru decimal comma)
 *   "1 234,56 руб." -> 123456    (ru thousands space)
 *   "12345,-- ₽"    -> 1234500   (no decimals marker)
 *   "$12.34"        -> 1234      (en decimal point)
 *   "1,234.56"      -> 123456    (en thousands comma + decimal point)
 *   "1.234,56"      -> 123456    (eu thousands dot + decimal comma)
 *   "1234"          -> 123400    (whole units)
 *   "" / garbage    -> null
 */
export function parsePriceCents(text: string | null | undefined): number | null {
	if (text === null || text === undefined) return null;
	let s = String(text).trim();
	if (s.length === 0) return null;

	// Strip everything that is not part of a number: currency symbols/letters.
	for (const sym of CURRENCY_SYMBOLS) {
		if (s.includes(sym)) s = s.split(sym).join(' ');
	}
	// Remove non-breaking / narrow spaces.
	s = s.replace(/[\u00a0\u2007\u202f\u2009]/g, ' ');
	// Drop any remaining letters and stray characters.
	s = s.replace(/[^\d.,\-\s]/g, ' ').trim();
	// Collapse spaces.
	s = s.replace(/\s+/g, ' ');

	if (s.length === 0) return null;

	const noSpaces = s.replace(/ /g, '');

	// English thousands groups without decimals: "1,000", "1,234,567".
	if (/^\d{1,3}(,\d{3})+$/.test(noSpaces)) {
		return parseInt(noSpaces.split(',').join(''), 10) * 100;
	}

	const lastComma = s.lastIndexOf(',');
	const lastDot = s.lastIndexOf('.');

	let intPart: string;
	let fracPart: string;

	if (lastComma === -1 && lastDot === -1) {
		// Plain integer (spaces as thousand separators removed).
		intPart = s.replace(/ /g, '');
		fracPart = '';
	} else if (lastComma > lastDot) {
		// Comma is the last separator.
		const rawInt = s.slice(0, lastComma).replace(/\s/g, '');
		const rawFrac = s.slice(lastComma + 1).replace(/\s/g, '');
		if (lastDot === -1 && /^\d{1,3}$/.test(rawInt) && /^\d{3}$/.test(rawFrac)) {
			// Single ",ddd" group = English thousands separator ("$1,000"),
			// NOT a decimal: real decimal fractions have 1–2 digits (kopecks/cents).
			intPart = rawInt + rawFrac;
			fracPart = '';
		} else {
			// Decimal comma (ru/eu): "1 234,56", "1.234,56", "12345,--"
			intPart = rawInt.replace(/\./g, '');
			fracPart = rawFrac;
		}
	} else {
		// Dot is the decimal separator (en): "1,234.56", "12.34"
		intPart = s.slice(0, lastDot).replace(/[,\s]/g, '');
		fracPart = s.slice(lastDot + 1).replace(/\s/g, '');
	}

	// "12345,--" style: dashes mean "no decimals".
	if (/^-+$/.test(fracPart)) fracPart = '';

	if (!/^\d+$/.test(intPart)) return null;
	if (fracPart.length > 0 && !/^\d+$/.test(fracPart)) return null;

	const units = parseInt(intPart, 10);
	if (fracPart.length === 0) return units * 100;
	if (fracPart.length === 1) return units * 100 + parseInt(fracPart, 10) * 10;
	// 2+ digits: take first two (some locales use 3 decimals, e.g. KWD — round).
	const frac = parseInt(fracPart.slice(0, 2), 10);
	const rest = fracPart.slice(2);
	let cents = units * 100 + frac;
	if (rest.length > 0 && parseInt(rest[0] ?? '0', 10) >= 5) cents += 1;
	return cents;
}

/**
 * Parse a volume/count string: "1 234", "1,234", "Sold: 42" -> integer.
 * Returns null when no digits found.
 */
export function parseCount(text: string | null | undefined): number | null {
	if (text === null || text === undefined) return null;
	const s = String(text);
	// Take the LAST group of digits (skips prefixes like "Продано: 1 234").
	const groups = s.match(/\d[\d\s\u00a0\u2007\u202f.,]*/g);
	if (!groups || groups.length === 0) return null;
	const digits = groups[groups.length - 1]!.replace(/\D/g, '');
	if (digits.length === 0) return null;
	const n = parseInt(digits, 10);
	return Number.isFinite(n) ? n : null;
}

// ---------------------------------------------------------------------------
// Currency detection — guard against wrong-currency responses
// ---------------------------------------------------------------------------

/**
 * Steam currency code → ISO-ish label (the subset we care about).
 * 5 = RUB per TZ; null for unknown codes (guard disabled then).
 */
export function steamCurrencyToIso(code: number): string | null {
	switch (code) {
		case 1: return 'USD';
		case 2: return 'GBP';
		case 3: return 'EUR';
		case 5: return 'RUB';
		case 6: return 'PLN';
		case 7: return 'BRL';
		case 16: return 'KRW';
		case 17: return 'TRY';
		case 18: return 'UAH';
		case 20: return 'CAD';
		case 21: return 'AUD';
		case 23: return 'CNY';
		case 33: return 'SEK';
		case 36: return 'BYN';
		case 37: return 'KZT';
		default: return null;
	}
}

/**
 * Order matters: composite symbols (US$, CDN$, R$) must be tested before
 * the bare `$`.
 */
const CURRENCY_PATTERNS: [RegExp, string][] = [
	[/руб|₽/i, 'RUB'],
	[/грн|₴/i, 'UAH'],
	[/\bBYN\b|Br/, 'BYN'],
	[/тенге|₸|\bKZT\b/i, 'KZT'],
	[/zł|\bPLN\b/i, 'PLN'],
	[/R\$/, 'BRL'],
	[/US\$/, 'USD'],
	[/CDN\$|\bCAD\b/i, 'CAD'],
	[/NZ\$/, 'NZD'],
	[/HK\$/, 'HKD'],
	[/S\$/, 'SGD'],
	[/A\$/, 'AUD'],
	[/€|\bEUR\b/i, 'EUR'],
	[/£|\bGBP\b/i, 'GBP'],
	[/\$/, 'USD'],
];

/**
 * Detect the currency of a localized price text: "1 234,56 руб." → 'RUB',
 * "$12.34" → 'USD'. Returns null when nothing recognizable.
 */
export function detectCurrency(text: string | null | undefined): string | null {
	if (!text) return null;
	for (const [re, iso] of CURRENCY_PATTERNS) {
		if (re.test(text)) return iso;
	}
	return null;
}

/** True when a detected currency conflicts with the expected Steam currency. */
export function isWrongCurrency(detected: string | null, expectedIso: string | null): boolean {
	return detected !== null && expectedIso !== null && detected !== expectedIso;
}

// ---------------------------------------------------------------------------
// search/render
// ---------------------------------------------------------------------------

export interface SearchRenderAssetDescription {
	icon_url?: string;
	icon_url_large?: string;
	name?: string;
	market_hash_name?: string;
	[key: string]: unknown;
}

export interface SearchRenderResult {
	name: string;
	hash_name: string;
	sell_listings: number;
	sell_price: number; // integer cents
	sell_price_text?: string;
	app_icon?: string;
	app_name?: string;
	asset_description?: SearchRenderAssetDescription;
	[key: string]: unknown;
}

export interface SearchRenderResponse {
	total_count: number;
	results: SearchRenderResult[];
	start?: number;
	page_size?: number;
}

export interface ParsedMarketItem {
	hashName: string;
	name: string;
	iconUrl: string | null;
	sellListings: number;
	sellPriceCents: number | null;
	/** Localized price string from the response — used for currency detection. */
	priceText: string | null;
}

/** Normalize a search/render response into flat item rows. */
export function parseSearchRender(json: unknown): { totalCount: number; items: ParsedMarketItem[] } | null {
	if (typeof json !== 'object' || json === null) return null;
	const data = json as Partial<SearchRenderResponse>;
	if (!Array.isArray(data.results)) return null;

	const items: ParsedMarketItem[] = [];
	for (const r of data.results) {
		if (!r || typeof r !== 'object') continue;
		const hashName = typeof r.hash_name === 'string' ? r.hash_name : '';
		if (hashName.length === 0) continue;

		const iconPath = r.asset_description?.icon_url;
		items.push({
			hashName,
			name: typeof r.name === 'string' && r.name.length > 0 ? r.name : hashName,
			iconUrl: typeof iconPath === 'string' && iconPath.length > 0 ? `https://steamcommunity-a.akamaihd.net/economy/image/${iconPath}` : null,
			sellListings: typeof r.sell_listings === 'number' ? r.sell_listings : parseCount(String(r.sell_listings ?? '')) ?? 0,
			sellPriceCents: typeof r.sell_price === 'number' ? r.sell_price : parsePriceCents(String(r.sell_price ?? '')),
			priceText: typeof r.sell_price_text === 'string' && r.sell_price_text.length > 0 ? r.sell_price_text : null,
		});
	}

	const totalCount = typeof data.total_count === 'number' ? data.total_count : items.length;
	return { totalCount, items };
}

// ---------------------------------------------------------------------------
// priceoverview
// ---------------------------------------------------------------------------

export interface PriceOverviewRaw {
	success?: boolean;
	lowest_price?: string;
	median_price?: string;
	volume?: string;
	lowest_sell_order?: string;
	sell_listings?: string;
	[key: string]: unknown;
}

export interface ParsedPriceOverview {
	lowestPriceCents: number | null;
	medianPriceCents: number | null;
	volume24h: number | null;
	volumeStatus: 'parsed' | 'missing_field' | 'unparseable';
	sellListings: number | null;
	/** Currency detected from the localized price strings (null = unknown). */
	currency: string | null;
}

export function parsePriceOverview(json: unknown): ParsedPriceOverview | null {
	if (typeof json !== 'object' || json === null) return null;
	const data = json as PriceOverviewRaw;
	if (data.success === false) return null;
	const volume24h = parseCount(data.volume === undefined || data.volume === null ? null : String(data.volume));
	const volumeStatus =
		data.volume === undefined || data.volume === null ? 'missing_field' : volume24h === null ? 'unparseable' : 'parsed';
	return {
		lowestPriceCents: parsePriceCents(data.lowest_price),
		medianPriceCents: parsePriceCents(data.median_price),
		volume24h,
		volumeStatus,
		sellListings: parseCount(data.sell_listings),
		currency: detectCurrency(data.lowest_price) ?? detectCurrency(data.median_price),
	};
}

// ---------------------------------------------------------------------------
// itemordershistogram
// ---------------------------------------------------------------------------

export interface OrderRow {
	priceCents: number;
	count: number | null;
}

/** Strip HTML tags and decode the most common entities. */
export function stripHtml(html: string): string {
	return html
		.replace(/<[^>]*>/g, ' ')
		.replace(/&nbsp;/gi, ' ')
		.replace(/&amp;/gi, '&')
		.replace(/&lt;/gi, '<')
		.replace(/&gt;/gi, '>')
		.replace(/&quot;/gi, '"')
		.replace(/&#(\d+);/g, (_, d: string) => String.fromCharCode(parseInt(d, 10)))
		.replace(/\s+/g, ' ')
		.trim();
}

/**
 * Parse order rows out of an orders-histogram table HTML fragment.
 * Each row: first cell = price, second cell = order count.
 * Rows come in Steam's display order (buy table: highest price first).
 */
export function parseOrderTable(html: string | null | undefined): OrderRow[] {
	if (!html) return [];
	const rows: OrderRow[] = [];
	const trRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
	let trMatch: RegExpExecArray | null;
	while ((trMatch = trRegex.exec(html)) !== null) {
		const tr = trMatch[1] ?? '';
		if (/<th/i.test(tr)) continue; // header row
		const cells: string[] = [];
		const tdRegex = /<td[^>]*>([\s\S]*?)<\/td>/gi;
		let tdMatch: RegExpExecArray | null;
		while ((tdMatch = tdRegex.exec(tr)) !== null) {
			cells.push(stripHtml(tdMatch[1] ?? ''));
		}
		if (cells.length < 2) continue;
		const priceCents = parsePriceCents(cells[0]);
		const count = parseCount(cells[1]);
		if (priceCents !== null && priceCents > 0) {
			rows.push({ priceCents, count });
		}
	}
	return rows;
}

export interface ParsedHistogram {
	highestBuyCents: number | null;
	lowestSellCents: number | null;
	buyOrdersCount: number | null;
	sellOrdersCount: number | null;
	buyRows: OrderRow[];
	sellRows: OrderRow[];
	/** Currency detected from price_prefix/price_suffix or the order tables. */
	currency: string | null;
}

/**
 * Parse the itemordershistogram JSON response.
 *
 * The response contains `highest_buy_order` / `lowest_sell_order` as strings
 * of integer CENTS, plus `buy_order_table` / `sell_order_table` HTML with the
 * full order book. Order counts per price level are parsed from the HTML.
 */
export function parseHistogram(json: unknown): ParsedHistogram | null {
	if (typeof json !== 'object' || json === null) return null;
	const data = json as Record<string, unknown>;
	if (data.success === false) return null;

	const highestBuyRaw = data.highest_buy_order;
	const lowestSellRaw = data.lowest_sell_order;

	// highest_buy_order / lowest_sell_order are integer cents as strings.
	const highestBuyCents =
		typeof highestBuyRaw === 'string' || typeof highestBuyRaw === 'number'
			? parseInt(String(highestBuyRaw), 10) || null
			: null;
	const lowestSellCents =
		typeof lowestSellRaw === 'string' || typeof lowestSellRaw === 'number'
			? parseInt(String(lowestSellRaw), 10) || null
			: null;

	const buyTableHtml = typeof data.buy_order_table === 'string' ? data.buy_order_table : '';
	const sellTableHtml = typeof data.sell_order_table === 'string' ? data.sell_order_table : '';
	const buyRows = parseOrderTable(buyTableHtml);
	const sellRows = parseOrderTable(sellTableHtml);

	// Currency: itemordershistogram exposes price_prefix/price_suffix around
	// the numbers ("$", " руб."); fall back to the localized table HTML.
	const affixes = `${typeof data.price_prefix === 'string' ? data.price_prefix : ''} ${typeof data.price_suffix === 'string' ? data.price_suffix : ''}`;
	const currency = detectCurrency(affixes) ?? detectCurrency(buyTableHtml.slice(0, 2000)) ?? detectCurrency(sellTableHtml.slice(0, 2000));

	// Total buy orders = sum of counts across levels; fall back to the top row.
	const sumCounts = (rows: OrderRow[]): number | null => {
		if (rows.length === 0) return null;
		let sum = 0;
		let sawCount = false;
		for (const r of rows) {
			if (r.count !== null) {
				sum += r.count;
				sawCount = true;
			}
		}
		return sawCount ? sum : null;
	};

	return {
		highestBuyCents: highestBuyCents ?? (buyRows[0]?.priceCents ?? null),
		lowestSellCents: lowestSellCents ?? (sellRows[0]?.priceCents ?? null),
		buyOrdersCount: sumCounts(buyRows),
		sellOrdersCount: sumCounts(sellRows),
		buyRows,
		sellRows,
		currency,
	};
}

// ---------------------------------------------------------------------------
// Item page HTML (item_nameid extraction)
// ---------------------------------------------------------------------------

/**
 * Extract the market item_nameid from a listing page.
 * The current known format is `Market_LoadOrderSpread( 1234567 );`.
 */
export function parseItemNameid(html: string | null | undefined): number | null {
	if (!html) return null;
	const m = html.match(/Market_LoadOrderSpread\(\s*(\d+)\s*\)/);
	if (m && m[1]) return parseInt(m[1], 10);
	const m2 = html.match(/"item_nameid"\s*:\s*"?(\d+)"?/);
	if (m2 && m2[1]) return parseInt(m2[1], 10);
	return null;
}

/** Return a compact, non-sensitive page-shape label for failed extraction. */
export function classifyItemNameidPage(html: string | null | undefined): string {
	if (!html?.trim()) return 'empty_response';
	if (/captcha|access denied|verify you are human|too many requests|temporarily blocked/i.test(html)) {
		return 'challenge_or_block_page';
	}
	// These broader signatures are deliberately only diagnostic. If either is
	// present after parseItemNameid returned null, it points to an unhandled
	// spelling without storing or exposing the HTML itself.
	if (/Market_LoadOrderSpread\s*\(\s*(['"]?)\d+\1\s*\)/i.test(html)) return 'orderbook_id_format_variant';
	if (/["']item_nameid["']\s*:\s*["']?\d+/i.test(html)) return 'item_nameid_field_format_variant';
	if (/Market_LoadOrderSpread\s*\(/i.test(html)) return 'orderbook_marker_without_numeric_id';
	if (/item_nameid|itemNameId|data-item-nameid|g_rgItemNameID/i.test(html)) return 'nameid_marker_without_parseable_id';
	if (/<html\b|<!doctype\s+html/i.test(html)) return 'html_without_nameid_marker';
	if (/^\s*[\[{]/.test(html)) return 'json_or_object_without_nameid';
	return 'unrecognized_response';
}
