import { ToolError } from '../errors.js';
import { defineTool, isoDate, money } from './shared.js';

const MAX_RANGE_DAYS = 366;
const COUNTED_STATUSES = `('paid','shipped','delivered')`;

/** Adds days to a YYYY-MM-DD date and returns YYYY-MM-DD (UTC). */
function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export const salesSummary = defineTool({
  name: 'sales_summary',
  title: 'Sales summary',
  description:
    'Summarise sales between two dates (inclusive, UTC): order count, units, revenue, average ' +
    'order value, revenue by category and top 5 products. Cancelled and refunded orders are ' +
    `excluded from totals but counted separately. Maximum range ${MAX_RANGE_DAYS} days.`,
  scope: 'read',
  annotations: { readOnlyHint: true, openWorldHint: false },
  inputSchema: {
    from: isoDate('First day of the period, YYYY-MM-DD (inclusive)'),
    to: isoDate('Last day of the period, YYYY-MM-DD (inclusive)'),
  },
  handler({ from, to }, { db, currency }) {
    if (from > to) throw new ToolError('INVALID_ARGUMENT', '"from" must be on or before "to".');
    const days = (Date.parse(to) - Date.parse(from)) / 86_400_000 + 1;
    if (days > MAX_RANGE_DAYS) {
      throw new ToolError(
        'INVALID_ARGUMENT',
        `Date range is ${days} days; the maximum is ${MAX_RANGE_DAYS}.`,
      );
    }

    // created_at is an ISO-8601 UTC timestamp, so string comparison is chronological.
    const range = [from, addDays(to, 1)];
    const inRange = 'o.created_at >= ? AND o.created_at < ?';

    const totals = db
      .prepare(
        `SELECT COUNT(DISTINCT o.id) AS orders, COALESCE(SUM(i.quantity), 0) AS units,
                COALESCE(SUM(i.quantity * i.unit_price_cents), 0) AS revenue_cents
         FROM orders o JOIN order_items i ON i.order_id = o.id
         WHERE ${inRange} AND o.status IN ${COUNTED_STATUSES}`,
      )
      .get(...range) as { orders: number; units: number; revenue_cents: number };

    const excluded = db
      .prepare(
        `SELECT status, COUNT(*) AS n FROM orders o
         WHERE ${inRange} AND o.status NOT IN ${COUNTED_STATUSES} GROUP BY status`,
      )
      .all(...range) as { status: string; n: number }[];

    const byCategory = db
      .prepare(
        `SELECT p.category, SUM(i.quantity) AS units, SUM(i.quantity * i.unit_price_cents) AS revenue_cents
         FROM orders o JOIN order_items i ON i.order_id = o.id JOIN products p ON p.id = i.product_id
         WHERE ${inRange} AND o.status IN ${COUNTED_STATUSES}
         GROUP BY p.category ORDER BY revenue_cents DESC`,
      )
      .all(...range) as { category: string; units: number; revenue_cents: number }[];

    const topProducts = db
      .prepare(
        `SELECT p.sku, p.name, SUM(i.quantity) AS units, SUM(i.quantity * i.unit_price_cents) AS revenue_cents
         FROM orders o JOIN order_items i ON i.order_id = o.id JOIN products p ON p.id = i.product_id
         WHERE ${inRange} AND o.status IN ${COUNTED_STATUSES}
         GROUP BY p.id ORDER BY revenue_cents DESC, p.sku LIMIT 5`,
      )
      .all(...range) as { sku: string; name: string; units: number; revenue_cents: number }[];

    const share = (cents: number) =>
      totals.revenue_cents ? Math.round((cents / totals.revenue_cents) * 1000) / 10 : 0;

    return {
      period: { from, to, days },
      currency,
      orders: totals.orders,
      units: totals.units,
      revenue: money(totals.revenue_cents),
      average_order_value: totals.orders ? money(totals.revenue_cents / totals.orders) : 0,
      excluded_orders: Object.fromEntries(excluded.map((e) => [e.status, e.n])),
      by_category: byCategory.map((c) => ({
        category: c.category,
        units: c.units,
        revenue: money(c.revenue_cents),
        share_pct: share(c.revenue_cents),
      })),
      top_products: topProducts.map((p) => ({
        sku: p.sku,
        name: p.name,
        units: p.units,
        revenue: money(p.revenue_cents),
      })),
    };
  },
});
