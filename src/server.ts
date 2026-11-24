import { readFileSync } from 'node:fs';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { AuditLog } from './audit.js';
import { type AppConfig, PROJECT_ROOT } from './config.js';
import type { Db } from './db.js';
import type { Principal } from './security/auth.js';
import { ConfirmationStore } from './security/confirmations.js';
import { RateLimiter } from './security/rateLimit.js';
import { getAuditLog } from './tools/getAuditLog.js';
import { getOrder } from './tools/getOrder.js';
import { listLowStock } from './tools/listLowStock.js';
import { salesSummary } from './tools/salesSummary.js';
import { searchProducts } from './tools/searchProducts.js';
import { registerStoreTool, type StoreDeps } from './tools/shared.js';
import { updateStock } from './tools/updateStock.js';

export const SERVER_NAME = 'mcp-store-server';
export const SERVER_VERSION = '1.0.0';

const POLICIES_URI = 'store://policies';
const policiesMarkdown = () => readFileSync(`${PROJECT_ROOT}content/store-policies.md`, 'utf8');

const INSTRUCTIONS = `Tools for "Harbor & Bean", an online coffee shop.
- Read tools: search_products, get_order, list_low_stock, sales_summary, get_audit_log.
- update_stock changes data and works in two steps: call it without confirm_token to get a preview,
  show the preview to the user, and only call again with the confirm_token after they agree.
- Customer contact details are masked; do not try to recover them.
- Store policies (returns, shipping, stock rules) are in the resource ${POLICIES_URI}.`;

/** Builds the long-lived services shared by every MCP session in this process. */
export function createDeps(
  db: Db,
  config: Pick<AppConfig, 'rateLimitPerMinute' | 'confirmTtlSeconds'>,
  options: { defaultPrincipal?: Principal; currency?: string; now?: () => number } = {},
): StoreDeps {
  const now = options.now ?? Date.now;
  return {
    db,
    audit: new AuditLog(db, () => new Date(now())),
    confirmations: new ConfirmationStore(config.confirmTtlSeconds * 1000, now),
    rateLimiter: new RateLimiter(config.rateLimitPerMinute, 60_000, now),
    currency: options.currency ?? 'USD',
    defaultPrincipal: options.defaultPrincipal,
  };
}

/** Creates an MCP server exposing the store tools, the policies resource and the report prompt. */
export function createStoreServer(deps: StoreDeps): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { instructions: INSTRUCTIONS },
  );

  registerStoreTool(server, deps, searchProducts);
  registerStoreTool(server, deps, getOrder);
  registerStoreTool(server, deps, listLowStock);
  registerStoreTool(server, deps, salesSummary);
  registerStoreTool(server, deps, updateStock);
  registerStoreTool(server, deps, getAuditLog);

  server.registerResource(
    'store-policies',
    POLICIES_URI,
    {
      title: 'Store policies',
      description: 'Returns, shipping, stock and data-handling policies for Harbor & Bean.',
      mimeType: 'text/markdown',
    },
    async (uri) => ({
      contents: [{ uri: uri.href, mimeType: 'text/markdown', text: policiesMarkdown() }],
    }),
  );

  server.registerPrompt(
    'weekly_sales_report',
    {
      title: 'Weekly sales report',
      description: 'Draft a weekly sales and stock report for the store manager.',
      argsSchema: {
        week_start: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD')
          .optional()
          .describe('First day of the week (YYYY-MM-DD). Defaults to the 7 days ending yesterday.'),
      },
    },
    ({ week_start }) => {
      const start = week_start ?? isoDay(-7);
      const end = shiftDay(start, 6);
      return {
        description: `Weekly sales report for ${start} to ${end}`,
        messages: [
          {
            role: 'user',
            content: {
              type: 'text',
              text: [
                `Write the weekly sales report for Harbor & Bean covering ${start} to ${end}.`,
                '',
                `1. Call sales_summary with from="${start}" and to="${end}".`,
                `2. Call sales_summary for the previous week (${shiftDay(start, -7)} to ${shiftDay(start, -1)}) to compare.`,
                '3. Call list_low_stock to find products that need reordering.',
                `4. Check the stock rules in the ${POLICIES_URI} resource.`,
                '',
                'Format the report in Markdown with these sections: Headline numbers (revenue, orders,',
                'average order value, change vs previous week in %), Category breakdown (table),',
                'Top products, Stock to reorder (table with suggested quantities), and 3 short',
                'recommendations. Do not change any data while writing the report.',
              ].join('\n'),
            },
          },
        ],
      };
    },
  );

  return server;
}

function isoDay(offsetDays: number): string {
  return shiftDay(new Date().toISOString().slice(0, 10), offsetDays);
}

function shiftDay(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
