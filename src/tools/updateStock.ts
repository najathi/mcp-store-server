import { z } from 'zod';
import { ToolError } from '../errors.js';
import { defineTool } from './shared.js';

const MAX_STOCK = 100_000;

/** State saved with a preview and checked again when the change is confirmed. */
interface PreviewState {
  productId: number;
  previousStock: number;
  newStock: number;
}

export const updateStock = defineTool({
  name: 'update_stock',
  title: 'Update stock (two-step)',
  description:
    'Change the stock level of one product. Requires the "write" scope. ' +
    'Two steps: (1) call WITHOUT confirm_token to get a dry-run preview and a short-lived ' +
    'confirm_token; nothing is changed. (2) Show the preview to the user and, only after they ' +
    'agree, call again with the SAME arguments plus confirm_token to apply it. ' +
    'Every call is recorded in the audit log.',
  scope: 'write',
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: false,
  },
  inputSchema: {
    sku: z
      .string()
      .trim()
      .toUpperCase()
      .regex(/^[A-Z]{2,5}-\d{3}$/, 'Expected a SKU like "COF-002"')
      .describe('Product SKU, e.g. "COF-002" (see search_products)'),
    mode: z
      .enum(['set', 'adjust'])
      .describe('"set" replaces the stock level; "adjust" adds (or, if negative, removes) units'),
    quantity: z
      .number()
      .int()
      .min(-MAX_STOCK)
      .max(MAX_STOCK)
      .describe('New stock level for "set" (>= 0), or the change for "adjust" (non-zero)'),
    reason: z
      .string()
      .trim()
      .min(3)
      .max(200)
      .describe(
        'Why the stock is changing, e.g. "Delivery PO-4471 received". Stored in the audit log.',
      ),
    confirm_token: z
      .string()
      .regex(/^cfm_[A-Za-z0-9_-]{16,64}$/, 'Malformed confirm_token')
      .optional()
      .describe('Token from the preview step. Omit it to get a preview.'),
  },
  handler(args, { db, audit, confirmations, principal }) {
    const { confirm_token, ...change } = args;

    if (change.mode === 'set' && change.quantity < 0) {
      throw new ToolError('INVALID_ARGUMENT', 'quantity must be 0 or more when mode is "set".');
    }
    if (change.mode === 'adjust' && change.quantity === 0) {
      throw new ToolError('INVALID_ARGUMENT', 'quantity must not be 0 when mode is "adjust".');
    }

    const product = db
      .prepare('SELECT id, sku, name, stock FROM products WHERE sku = ?')
      .get(change.sku) as { id: number; sku: string; name: string; stock: number } | undefined;
    if (!product) throw new ToolError('NOT_FOUND', `No product with SKU ${change.sku}.`);

    // Step 1: dry run. Nothing is written except the audit entry.
    if (!confirm_token) {
      const newStock = change.mode === 'set' ? change.quantity : product.stock + change.quantity;
      if (newStock < 0) {
        throw new ToolError(
          'INVALID_ARGUMENT',
          `Stock cannot go below zero (current ${product.stock}, change ${change.quantity}).`,
        );
      }
      if (newStock > MAX_STOCK) {
        throw new ToolError('INVALID_ARGUMENT', `Stock cannot exceed ${MAX_STOCK}.`);
      }

      const { token, expiresAt } = confirmations.issue<PreviewState>(
        principal.name,
        'update_stock',
        change,
        {
          productId: product.id,
          previousStock: product.stock,
          newStock,
        },
      );
      audit.record({
        actor: principal.name,
        tool: 'update_stock',
        args,
        outcome: 'preview',
        detail: `${product.sku}: ${product.stock} -> ${newStock} (not applied)`,
      });

      return {
        status: 'preview',
        applied: false,
        product: { sku: product.sku, name: product.name },
        current_stock: product.stock,
        new_stock: newStock,
        change: newStock - product.stock,
        confirm_token: token,
        expires_at: expiresAt,
        next_step:
          'Ask the user to confirm this change. If they agree, call update_stock again with the ' +
          'same sku, mode, quantity and reason plus this confirm_token.',
      };
    }

    // Step 2: confirm. The token must match this caller and these exact arguments.
    const state = confirmations.consume<PreviewState>(
      confirm_token,
      principal.name,
      'update_stock',
      change,
    );

    const applied = db.transaction(() => {
      // Optimistic concurrency: only apply if stock is still what the user saw in the preview.
      const result = db
        .prepare('UPDATE products SET stock = ? WHERE id = ? AND stock = ?')
        .run(state.newStock, state.productId, state.previousStock);
      if (result.changes !== 1) return undefined;
      return audit.record({
        actor: principal.name,
        tool: 'update_stock',
        args,
        outcome: 'applied',
        detail: `${product.sku}: ${state.previousStock} -> ${state.newStock}`,
      });
    })();

    if (applied === undefined) {
      throw new ToolError(
        'CONFLICT',
        'Stock changed since the preview was made. Request a new preview and confirm again.',
        { previewed_stock: state.previousStock, current_stock: product.stock },
      );
    }

    return {
      status: 'applied',
      applied: true,
      product: { sku: product.sku, name: product.name },
      previous_stock: state.previousStock,
      new_stock: state.newStock,
      audit_id: applied,
    };
  },
});
