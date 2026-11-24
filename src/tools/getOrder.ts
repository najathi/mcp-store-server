import { z } from 'zod';
import { ToolError } from '../errors.js';
import { maskEmail, maskName, maskPhone } from '../security/masking.js';
import { defineTool, money } from './shared.js';

interface OrderRow {
  id: number;
  status: string;
  created_at: string;
  total_cents: number;
  customer_name: string;
  customer_email: string;
  customer_phone: string;
  customer_city: string;
}

interface ItemRow {
  sku: string;
  name: string;
  quantity: number;
  unit_price_cents: number;
}

export const getOrder = defineTool({
  name: 'get_order',
  title: 'Get order',
  description:
    'Fetch one order with its line items and status. Customer contact details are masked ' +
    '(name shortened, email and phone partially hidden) to protect personal data.',
  scope: 'read',
  annotations: { readOnlyHint: true, openWorldHint: false },
  inputSchema: {
    order_id: z.number().int().min(1).max(1_000_000_000).describe('Numeric order ID, e.g. 1042'),
  },
  handler({ order_id }, { db, currency }) {
    const order = db
      .prepare(
        `SELECT o.id, o.status, o.created_at, o.total_cents,
                c.name AS customer_name, c.email AS customer_email,
                c.phone AS customer_phone, c.city AS customer_city
         FROM orders o JOIN customers c ON c.id = o.customer_id
         WHERE o.id = ?`,
      )
      .get(order_id) as OrderRow | undefined;
    if (!order) throw new ToolError('NOT_FOUND', `Order ${order_id} does not exist.`);

    const items = db
      .prepare(
        `SELECT p.sku, p.name, i.quantity, i.unit_price_cents
         FROM order_items i JOIN products p ON p.id = i.product_id
         WHERE i.order_id = ? ORDER BY p.sku`,
      )
      .all(order_id) as ItemRow[];

    return {
      order_id: order.id,
      status: order.status,
      created_at: order.created_at,
      currency,
      total: money(order.total_cents),
      customer: {
        name: maskName(order.customer_name),
        email: maskEmail(order.customer_email),
        phone: maskPhone(order.customer_phone),
        city: order.customer_city,
      },
      items: items.map((i) => ({
        sku: i.sku,
        name: i.name,
        quantity: i.quantity,
        unit_price: money(i.unit_price_cents),
        line_total: money(i.quantity * i.unit_price_cents),
      })),
    };
  },
});
