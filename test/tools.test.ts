import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setup } from './helpers.js';

type Session = Awaited<ReturnType<typeof setup>>;
let s: Session;

beforeEach(async () => {
  s = await setup({ scopes: ['read'] });
});
afterEach(async () => {
  await s.close();
});

describe('server capabilities', () => {
  it('lists the six tools with schemas and safety annotations', async () => {
    const { tools } = await s.client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      'get_audit_log',
      'get_order',
      'list_low_stock',
      'sales_summary',
      'search_products',
      'update_stock',
    ]);
    for (const tool of tools) {
      expect(tool.description?.length).toBeGreaterThan(20);
      expect(tool.inputSchema.type).toBe('object');
    }
    const update = tools.find((t) => t.name === 'update_stock')!;
    expect(update.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });
    expect(update.inputSchema.required).toEqual(
      expect.arrayContaining(['sku', 'mode', 'quantity', 'reason']),
    );
    const search = tools.find((t) => t.name === 'search_products')!;
    expect(search.annotations?.readOnlyHint).toBe(true);
  });

  it('serves the store policies resource', async () => {
    const { resources } = await s.client.listResources();
    expect(resources).toEqual([
      expect.objectContaining({ uri: 'store://policies', mimeType: 'text/markdown' }),
    ]);
    const { contents } = await s.client.readResource({ uri: 'store://policies' });
    expect(contents[0]).toMatchObject({ uri: 'store://policies' });
    expect((contents[0] as { text: string }).text).toContain('## Returns and refunds');
  });

  it('builds the weekly sales report prompt', async () => {
    const { prompts } = await s.client.listPrompts();
    expect(prompts.map((p) => p.name)).toEqual(['weekly_sales_report']);
    const prompt = await s.client.getPrompt({
      name: 'weekly_sales_report',
      arguments: { week_start: '2026-10-19' },
    });
    const text = (prompt.messages[0]!.content as { text: string }).text;
    expect(text).toContain('from="2026-10-19" and to="2026-10-25"');
    expect(text).toContain('2026-10-12 to 2026-10-18');
    expect(text).toContain('list_low_stock');
  });
});

describe('search_products', () => {
  it('matches name or SKU, case-insensitively', async () => {
    const byName = await s.call('search_products', { query: 'kenya' });
    expect(byName.data.products).toEqual([
      expect.objectContaining({ sku: 'COF-007', price: 16.5 }),
    ]);

    const bySku = await s.call('search_products', { query: 'gear-', limit: 50 });
    expect(bySku.data.count).toBe(7);
  });

  it('filters by category, price and availability', async () => {
    const { data } = await s.call('search_products', {
      category: 'Coffee',
      max_price: 15,
      in_stock_only: true,
    });
    const products = data.products as { category: string; price: number; stock: number }[];
    expect(products.length).toBeGreaterThan(0);
    for (const p of products) {
      expect(p.category).toBe('Coffee');
      expect(p.price).toBeLessThanOrEqual(15);
      expect(p.stock).toBeGreaterThan(0);
    }
    expect(products.some((p) => p.stock === 0)).toBe(false);
  });

  it('treats LIKE wildcards in the query literally', async () => {
    const { data } = await s.call('search_products', { query: '%' });
    expect(data.count).toBe(0);
  });

  it('returns structured errors for invalid input', async () => {
    const range = await s.call('search_products', { min_price: 50, max_price: 10 });
    expect(range.isError).toBe(true);
    expect(range.data).toEqual({
      error: { code: 'INVALID_ARGUMENT', message: 'min_price must not be greater than max_price.' },
    });

    const schema = await s.call('search_products', { limit: 500 });
    expect(schema.isError).toBe(true);
    expect(JSON.stringify(schema.data)).toMatch(/Input validation error/);
  });
});

describe('get_order', () => {
  it('returns line items and masks customer contact details', async () => {
    const { data, raw } = await s.call('get_order', { order_id: 1001 });
    expect(data.order_id).toBe(1001);
    const customer = data.customer as Record<string, string>;
    expect(customer.email).toMatch(/^[a-z]\*\*\*@example\.com$/);
    expect(customer.phone).toMatch(/^\*\*\*-\*\*\*-\d{4}$/);
    expect(customer.name).toMatch(/^[A-Z][a-z]+ [A-Z]\.$/);

    // The full email must not appear anywhere in the response.
    const fullEmails = s.db.prepare('SELECT email FROM customers').all() as { email: string }[];
    const body = JSON.stringify(raw);
    for (const { email } of fullEmails) expect(body).not.toContain(email);

    const items = data.items as { line_total: number }[];
    const sum = items.reduce((acc, i) => acc + i.line_total, 0);
    expect(sum).toBeCloseTo(data.total as number, 2);
  });

  it('reports unknown orders as NOT_FOUND', async () => {
    const result = await s.call('get_order', { order_id: 999 });
    expect(result.isError).toBe(true);
    expect(result.data).toMatchObject({ error: { code: 'NOT_FOUND' } });
  });
});

describe('list_low_stock', () => {
  it('lists products at or below reorder level, lowest first', async () => {
    const { data } = await s.call('list_low_stock');
    const products = data.products as {
      sku: string;
      stock: number;
      reorder_level: number;
      suggested_reorder_qty: number;
    }[];
    expect(products.length).toBeGreaterThan(5);
    for (const p of products) {
      expect(p.stock).toBeLessThanOrEqual(p.reorder_level);
      expect(p.suggested_reorder_qty).toBe(p.reorder_level * 2 - p.stock);
    }
    const stocks = products.map((p) => p.stock);
    expect(stocks).toEqual([...stocks].sort((a, b) => a - b));
    expect(products.map((p) => p.sku)).toContain('COF-006'); // out of stock
  });

  it('can exclude out-of-stock products and filter by category', async () => {
    const { data } = await s.call('list_low_stock', {
      category: 'Coffee',
      include_out_of_stock: false,
    });
    const skus = (data.products as { sku: string }[]).map((p) => p.sku);
    expect(skus).not.toContain('COF-006');
    expect(skus.every((sku) => sku.startsWith('COF-'))).toBe(true);
  });
});

describe('sales_summary', () => {
  it('totals revenue by category consistently', async () => {
    const { data, isError } = await s.call('sales_summary', {
      from: '2026-09-01',
      to: '2026-11-01',
    });
    expect(isError).toBe(false);
    expect(data.orders).toBeGreaterThan(40);
    const categories = data.by_category as { revenue: number; share_pct: number }[];
    const categoryRevenue = categories.reduce((sum, c) => sum + c.revenue, 0);
    expect(categoryRevenue).toBeCloseTo(data.revenue as number, 2);
    const share = categories.reduce((sum, c) => sum + c.share_pct, 0);
    expect(share).toBeGreaterThan(99.5);
    expect(share).toBeLessThan(100.5);
    expect((data.top_products as unknown[]).length).toBe(5);

    // Every seeded order is either counted or listed as excluded.
    const excluded = Object.values(data.excluded_orders as Record<string, number>);
    expect((data.orders as number) + excluded.reduce((a, b) => a + b, 0)).toBe(60);
  });

  it('returns zeros for a period without sales', async () => {
    const { data } = await s.call('sales_summary', { from: '2025-01-01', to: '2025-01-07' });
    expect(data).toMatchObject({ orders: 0, revenue: 0, average_order_value: 0, by_category: [] });
  });

  it('validates the date range', async () => {
    const reversed = await s.call('sales_summary', { from: '2026-10-10', to: '2026-10-01' });
    expect(reversed.data).toMatchObject({ error: { code: 'INVALID_ARGUMENT' } });

    const tooLong = await s.call('sales_summary', { from: '2024-01-01', to: '2026-01-01' });
    expect(tooLong.data).toMatchObject({ error: { code: 'INVALID_ARGUMENT' } });

    const badFormat = await s.call('sales_summary', { from: '10/01/2026', to: '2026-10-31' });
    expect(badFormat.isError).toBe(true);
    expect(JSON.stringify(badFormat.data)).toMatch(/YYYY-MM-DD/);
  });
});
