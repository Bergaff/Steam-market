import { describe, it, expect } from 'vitest';
import {
	parsePriceCents,
	parseCount,
	parseSearchRender,
	parsePriceOverview,
	parseHistogram,
	parseOrderTable,
	parseItemNameid,
	stripHtml,
} from '../src/steam/parse';

describe('parsePriceCents', () => {
	it('parses russian decimal comma format', () => {
		expect(parsePriceCents('123,45 ₽')).toBe(12345);
		expect(parsePriceCents('43,55 руб.')).toBe(4355);
		expect(parsePriceCents('0,03 ₽')).toBe(3);
	});

	it('parses russian thousands with (narrow) spaces', () => {
		expect(parsePriceCents('1 234,56 ₽')).toBe(123456);
		expect(parsePriceCents('1\u00a0234,56\u00a0₽')).toBe(123456);
		expect(parsePriceCents('12 345 ₽')).toBe(1234500);
	});

	it('parses the "--" no-decimals marker', () => {
		expect(parsePriceCents('12345,-- ₽')).toBe(1234500);
		expect(parsePriceCents('7,--')).toBe(700);
	});

	it('parses english format', () => {
		expect(parsePriceCents('$12.34')).toBe(1234);
		expect(parsePriceCents('1,234.56')).toBe(123456);
		expect(parsePriceCents('$1,000')).toBe(100000);
	});

	it('treats a single ",ddd" group as english thousands, not a decimal', () => {
		expect(parsePriceCents('1,234')).toBe(123400);
		expect(parsePriceCents('1,234,567')).toBe(123456700);
		// ...while ",dd" stays a decimal fraction (kopecks)
		expect(parsePriceCents('1,23')).toBe(123);
	});

	it('parses european format (dot thousands, comma decimal)', () => {
		expect(parsePriceCents('1.234,56')).toBe(123456);
		expect(parsePriceCents('€ 2.999,99')).toBe(299999);
	});

	it('parses plain integers as whole units', () => {
		expect(parsePriceCents('1234')).toBe(123400);
		expect(parsePriceCents('5')).toBe(500);
	});

	it('returns null for garbage', () => {
		expect(parsePriceCents('')).toBeNull();
		expect(parsePriceCents(null)).toBeNull();
		expect(parsePriceCents(undefined)).toBeNull();
		expect(parsePriceCents('₽')).toBeNull();
		expect(parsePriceCents('нет данных')).toBeNull();
	});

	it('rounds 3-decimal fractions to cents', () => {
		expect(parsePriceCents('1.234')).toBe(123); // dot-decimal with 3 digits: 1.234 -> 123.4 -> 123
		expect(parsePriceCents('1.235')).toBe(124);
	});
});

describe('parseCount', () => {
	it('parses plain and grouped numbers', () => {
		expect(parseCount('42')).toBe(42);
		expect(parseCount('1,234')).toBe(1234);
		expect(parseCount('1 234')).toBe(1234);
	});

	it('takes the last number group, skipping text prefixes', () => {
		expect(parseCount('Продано: 1 234')).toBe(1234);
		expect(parseCount('Sold: 42')).toBe(42);
	});

	it('returns null when there are no digits', () => {
		expect(parseCount('')).toBeNull();
		expect(parseCount(null)).toBeNull();
		expect(parseCount('мало')).toBeNull();
	});
});

describe('parseSearchRender', () => {
	it('normalizes a search/render page', () => {
		const payload = {
			total_count: 1234,
			start: 0,
			results: [
				{
					name: 'Юбилейный набор',
					hash_name: 'Anniversary Bundle',
					sell_listings: 42,
					sell_price: 12345,
					sell_price_text: '123,45 ₽',
					asset_description: { icon_url: 'abc/def123' },
				},
				{
					name: 'Ключ',
					hash_name: 'Key',
					sell_listings: 0,
					sell_price: 0,
					asset_description: {},
				},
				{ hash_name: '' }, // invalid row, must be skipped
				null,
			],
		};

		const parsed = parseSearchRender(payload);
		expect(parsed).not.toBeNull();
		expect(parsed!.totalCount).toBe(1234);
		expect(parsed!.items).toHaveLength(2);
		expect(parsed!.items[0]).toEqual({
			hashName: 'Anniversary Bundle',
			name: 'Юбилейный набор',
			iconUrl: 'https://steamcommunity-a.akamaihd.net/economy/image/abc/def123',
			sellListings: 42,
			sellPriceCents: 12345,
			priceText: '123,45 ₽',
		});
		expect(parsed!.items[1]!.iconUrl).toBeNull();
		expect(parsed!.items[1]!.sellPriceCents).toBe(0);
	});

	it('rejects non-search payloads', () => {
		expect(parseSearchRender({})).toBeNull();
		expect(parseSearchRender('text')).toBeNull();
		expect(parseSearchRender(null)).toBeNull();
	});
});

describe('parsePriceOverview', () => {
	it('parses a ru-locale priceoverview response', () => {
		const parsed = parsePriceOverview({
			success: true,
			lowest_price: '123,45 ₽',
			median_price: '130 ₽',
			volume: '1 234',
			sell_listings: '42',
		});
		expect(parsed).toEqual({
			lowestPriceCents: 12345,
			medianPriceCents: 13000,
			volume24h: 1234,
			volumeStatus: 'parsed',
			sellListings: 42,
			currency: 'RUB',
		});
	});

	it('handles missing volume and success=false', () => {
		expect(parsePriceOverview({ success: true, lowest_price: '5,-- ₽' })).toEqual({
			lowestPriceCents: 500,
			medianPriceCents: null,
			volume24h: null,
			volumeStatus: 'missing_field',
			sellListings: null,
			currency: 'RUB',
		});
		expect(parsePriceOverview({ success: true, volume: '--' })?.volumeStatus).toBe('unparseable');
		expect(parsePriceOverview({ success: true, volume: 0 })).toMatchObject({ volume24h: 0, volumeStatus: 'parsed' });
		expect(parsePriceOverview({ success: false })).toBeNull();
	});
});

describe('parseOrderTable / parseHistogram', () => {
	const buyTable = [
		'<div class="market_commodity_orders_table">',
		'<table><tbody>',
		'<tr class="market_order_table_row "><td class="market_commodity_orders_price"><span>43,55 ₽</span></td><td>112</td></tr>',
		'<tr class="market_order_table_row "><td class="market_commodity_orders_price"><span>42,10 ₽</span></td><td>30</td></tr>',
		'</tbody></table></div>',
	].join('');
	const sellTable = [
		'<table><tbody>',
		'<tr><td><span class="market_commodity_orders_price">48,90 ₽</span></td><td>25</td></tr>',
		'<tr><td><span class="market_commodity_orders_price">49,15 ₽</span></td><td>14</td></tr>',
		'</tbody></table>',
	].join('');

	it('extracts rows from the table HTML', () => {
		const rows = parseOrderTable(buyTable);
		expect(rows).toEqual([
			{ priceCents: 4355, count: 112 },
			{ priceCents: 4210, count: 30 },
		]);
	});

	it('parses the histogram JSON with cent-string summaries', () => {
		const parsed = parseHistogram({
			success: true,
			highest_buy_order: '4355',
			lowest_sell_order: '4890',
			buy_order_table: buyTable,
			sell_order_table: sellTable,
			number_of_listings: '39',
		});
		expect(parsed).not.toBeNull();
		expect(parsed!.highestBuyCents).toBe(4355);
		expect(parsed!.lowestSellCents).toBe(4890);
		expect(parsed!.buyOrdersCount).toBe(142); // 112 + 30
		expect(parsed!.sellOrdersCount).toBe(39); // 25 + 14
	});

	it('falls back to table rows when summary fields are missing', () => {
		const parsed = parseHistogram({ success: true, buy_order_table: buyTable, sell_order_table: sellTable });
		expect(parsed!.highestBuyCents).toBe(4355);
		expect(parsed!.lowestSellCents).toBe(4890);
	});

	it('rejects success=false and non-objects', () => {
		expect(parseHistogram({ success: false })).toBeNull();
		expect(parseHistogram('nope')).toBeNull();
	});
});

describe('parseItemNameid', () => {
	it('finds Market_LoadOrderSpread(<id>)', () => {
		const html = `<html><body><script>Market_LoadOrderSpread( 3895894 );</script></body></html>`;
		expect(parseItemNameid(html)).toBe(3895894);
	});

	it('finds a JSON-embedded item_nameid as fallback', () => {
		expect(parseItemNameid('{"item_nameid": "123456"}')).toBe(123456);
		expect(parseItemNameid('"item_nameid":123457')).toBe(123457);
	});

	it('returns null when there is no order book', () => {
		expect(parseItemNameid('<html>nothing here</html>')).toBeNull();
		expect(parseItemNameid('')).toBeNull();
		expect(parseItemNameid(null)).toBeNull();
	});
});

describe('stripHtml', () => {
	it('strips tags and decodes entities', () => {
		expect(stripHtml('<span>43,55&nbsp;₽</span>')).toBe('43,55 ₽');
		expect(stripHtml('a &amp; b &#8381;')).toBe('a & b ₽');
	});
});
