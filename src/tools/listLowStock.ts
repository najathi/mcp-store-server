import { z } from 'zod';
import { CATEGORIES } from '../seed.js';
import { defineTool } from './shared.js';

interface Row {
  sku: string;
  name: string;
  category: string;
  stock: number;
  reorder_level: number;
}

export const listLowStock = defineTool({
  name: 'list_low_stock',
  title: 'List low stock',
  description:
    'List products at or below their reorder level, lowest stock first, with a suggested ' +
    'reorder quantity (enough to reach twice the reorder level).',
  scope: 'read',
  annotations: { readOnlyHint: true, openWorldHint: false },
  inputSchema: {
    category: z.enum(CATEGORIES).optional().describe('Only check this category'),
    include_out_of_stock: z
      .boolean()
      .default(true)
      .describe('Include products with zero stock (default true)'),
    limit: z.number().int().min(1).max(100).default(25).describe('Maximum results (1-100)'),
  },
  handler(args, { db }) {
    const where = ['stock <= reorder_level'];
    const params: unknown[] = [];
    if (args.category) {
      where.push('category = ?');
      params.push(args.category);
    }
    if (!args.include_out_of_stock) where.push('stock > 0');

    const rows = db
      .prepare(
        `SELECT sku, name, category, stock, reorder_level FROM products
         WHERE ${where.join(' AND ')}
         ORDER BY stock ASC, sku ASC LIMIT ?`,
      )
      .all(...params, args.limit) as Row[];

    return {
      count: rows.length,
      products: rows.map((p) => ({
        ...p,
        out_of_stock: p.stock === 0,
        suggested_reorder_qty: Math.max(p.reorder_level * 2 - p.stock, 0),
      })),
    };
  },
});
