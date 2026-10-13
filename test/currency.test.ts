import { describe, expect, it } from 'vitest';
import {
	detectCurrency,
	isWrongCurrency,
	steamCurrencyToIso,
	parseSearchRender,
	parsePriceOverview,
	parseHistogram,
} from '../src/steam/parse';

describe('detectCurrency (localized price strings)', () => {
	it('detects RUB from all Russian spellings', () => {
		expect(detectCurrency('1 234,56 руб.')).toBe('RUB');
		expect(detectCurrency('150,00 ₽')).toBe('RUB');
		expect(detectCurrency('12345,-- рублей')).toBe('RUB');
	});

	it('detects USD from bare and prefixed dollar signs', () => {
		expect(detectCurrency('$1.80')).toBe('USD');
		expect(detectCurrency('US$ 1.80')).toBe('USD');
		expect(detectCurrency('12.34')).toBe(null); // no symbol → unknown
	});

	it('does not confuse composite dollar currencies with USD', () => {
		expect(detectCurrency('CDN$ 2.50')).toBe('CAD');
		expect(detectCurrency('NZ$ 3.00')).toBe('NZD');
		expect(detectCurrency('HK$ 14.00')).toBe('HKD');
		expect(detectCurrency('S$ 2.40')).toBe('SGD');
		expect(detectCurrency('R$ 9,50')).toBe('BRL');
		expect(detectCurrency('A$ 2.70')).toBe('AUD');
	});

	it('detects neighbour currencies relevant to BY/RU users', () => {
		expect(detectCurrency('5,00 Br')).toBe('BYN');
		expect(detectCurrency('60,00 грн.')).toBe('UAH');
		expect(detectCurrency('₸ 850,00')).toBe('KZT');
	});

	it('detects EUR/GBP', () => {
		expect(detectCurrency('12,34 €')).toBe('EUR');
		expect(detectCurrency('£1.20')).toBe('GBP');
	});

	it('returns null for empty/garbage input', () => {
		expect(detectCurrency(null)).toBe(null);
		expect(detectCurrency('')).toBe(null);
		expect(detectCurrency('Продано: 1 234')).toBe(null);
	});
});

describe('steamCurrencyToIso', () => {
	it('maps the configured codes', () => {
		expect(steamCurrencyToIso(5)).toBe('RUB');
		expect(steamCurrencyToIso(1)).toBe('USD');
		expect(steamCurrencyToIso(3)).toBe('EUR');
		expect(steamCurrencyToIso(36)).toBe('BYN');
	});
	it('returns null for unknown codes (guard disabled)', () => {
		expect(steamCurrencyToIso(999)).toBe(null);
	});
});

describe('isWrongCurrency', () => {
	it('flags a detected currency different from expected', () => {
		expect(isWrongCurrency('USD', 'RUB')).toBe(true);
	});
	it('passes when equal or undetectable', () => {
		expect(isWrongCurrency('RUB', 'RUB')).toBe(false);
		expect(isWrongCurrency(null, 'RUB')).toBe(false);
		expect(isWrongCurrency('USD', null)).toBe(false);
	});
});

describe('parsed responses carry currency information', () => {
	it('parseSearchRender keeps sell_price_text for detection', () => {
		const parsed = parseSearchRender({
			total_count: 1,
			results: [{ name: 'Key', hash_name: 'Key', sell_listings: 100, sell_price: 180, sell_price_text: '$1.80' }],
		});
		expect(parsed).not.toBe(null);
		expect(parsed!.items[0]!.priceText).toBe('$1.80');
		expect(isWrongCurrency(detectCurrency(parsed!.items[0]!.priceText), steamCurrencyToIso(5))).toBe(true);
	});

	it('parsePriceOverview detects currency from localized strings', () => {
		const rub = parsePriceOverview({ success: true, lowest_price: '150,00 руб.', median_price: '152,10 руб.', volume: '1 000' });
		expect(rub!.currency).toBe('RUB');
		const usd = parsePriceOverview({ success: true, lowest_price: '$1.80', median_price: '$1.85', volume: '1,000' });
		expect(usd!.currency).toBe('USD');
	});

	it('parseHistogram detects currency from price affixes and tables', () => {
		const suffix = parseHistogram({
			success: true,
			highest_buy_order: '14000',
			lowest_sell_order: '15000',
			price_prefix: '',
			price_suffix: ' руб.',
			buy_order_table: '',
			sell_order_table: '',
		});
		expect(suffix!.currency).toBe('RUB');

		const fromTable = parseHistogram({
			success: true,
			highest_buy_order: '140',
			lowest_sell_order: '180',
			price_prefix: '',
			price_suffix: '',
			buy_order_table: '<tr><td>$1.40</td><td>10</td></tr>',
			sell_order_table: '',
		});
		expect(fromTable!.currency).toBe('USD');
	});
});
