import { z } from 'zod';
import { ToolError } from '../errors.js';
import { CATEGORIES } from '../seed.js';
import { defineTool, money } from './shared.js';

interface ProductRow {
  sku: string;
  name: string;
  category: string;
  price_cents: number;
  stock: number;
  reorder_level: number;
}

export const searchProducts = defineTool({
  name: 'search_products',
  title: 'Search products',
  description:
    'Search the product catalogue by text, category, price range and availability. ' +
    'Returns SKU, name, category, price and current stock. Use the SKU with update_stock.',
  scope: 'read',
  annotations: { readOnlyHint: true, openWorldHint: false },
  inputSchema: {
    query: z
      .string()
      .trim()
      .min(1)
      .max(100)
      .optional()
      .describe(
        'Case-insensitive text matched against product name and SKU, e.g. "kenya" or "GEAR-"',
      ),
    category: z.enum(CATEGORIES).optional().describe('Only return products in this category'),
    min_price: z.number().nonnegative().max(100_000).optional().describe('Minimum unit price'),
    max_price: z.number().nonnegative().max(100_000).optional().describe('Maximum unit price'),
    in_stock_only: z.boolean().default(false).describe('Exclude products with zero stock'),
    limit: z.number().int().min(1).max(50).default(10).describe('Maximum results (1-50)'),
  },
  handler(args, { db, currency }) {
    if (
      args.min_price !== undefined &&
      args.max_price !== undefined &&
      args.min_price > args.max_price
    ) {
      throw new ToolError('INVALID_ARGUMENT', 'min_price must not be greater than max_price.');
    }

    const where: string[] = [];
    const params: unknown[] = [];
    if (args.query) {
      // Escape LIKE wildcards so the search text is matched literally.
      const pattern = `%${args.query.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
      where.push(`(name LIKE ? ESCAPE '\\' OR sku LIKE ? ESCAPE '\\')`);
      params.push(pattern, pattern);
    }
    if (args.category) {
      where.push('category = ?');
      params.push(args.category);
    }
    if (args.min_price !== undefined) {
      where.push('price_cents >= ?');
      params.push(Math.round(args.min_price * 100));
    }
    if (args.max_price !== undefined) {
      where.push('price_cents <= ?');
      params.push(Math.round(args.max_price * 100));
    }
    if (args.in_stock_only) where.push('stock > 0');

    const rows = db
      .prepare(
        `SELECT sku, name, category, price_cents, stock, reorder_level FROM products
         ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
         ORDER BY category, name LIMIT ?`,
      )
      .all(...params, args.limit) as ProductRow[];

    return {
      count: rows.length,
      currency,
      products: rows.map((p) => ({
        sku: p.sku,
        name: p.name,
        category: p.category,
        price: money(p.price_cents),
        stock: p.stock,
        low_stock: p.stock <= p.reorder_level,
      })),
    };
  },
});
