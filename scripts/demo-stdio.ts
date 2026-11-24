/**
 * End-to-end demo: starts the server as a child process over stdio (like Claude Desktop does)
 * and walks through every tool, the resource and the prompt with the official SDK client.
 *
 *   npm run build && npm run demo:stdio
 *
 * Uses a throwaway database in the OS temp folder, so your data/store.db is untouched.
 */
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
  getDefaultEnvironment,
  StdioClientTransport,
} from '@modelcontextprotocol/sdk/client/stdio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

const dir = mkdtempSync(join(tmpdir(), 'mcp-store-demo-'));
const useDist = existsSync('dist/index.js');

const transport = new StdioClientTransport({
  command: process.execPath,
  args: useDist ? ['dist/index.js', 'stdio'] : ['--import', 'tsx', 'src/index.ts', 'stdio'],
  env: {
    ...getDefaultEnvironment(),
    DATABASE_PATH: join(dir, 'store.db'),
    STDIO_ACTOR: 'demo-script',
    STDIO_SCOPES: 'read,write',
  },
  stderr: 'inherit',
});
const client = new Client({ name: 'demo-stdio', version: '1.0.0' });

async function call(name: string, args: Record<string, unknown> = {}) {
  const result = (await client.callTool({ name, arguments: args })) as CallToolResult;
  return result.structuredContent as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
}

const usd = (amount: number) => `$${amount.toFixed(2)}`;
const day = (offset: number) =>
  new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

try {
  await client.connect(transport);
  console.log(
    `Connected over stdio to ${client.getServerVersion()?.name} (${useDist ? 'dist' : 'src'})`,
  );

  const { tools } = await client.listTools();
  console.log(`\nTools: ${tools.map((t) => t.name).join(', ')}`);

  const search = await call('search_products', { query: 'pour-over' });
  console.log('\nsearch_products "pour-over":');
  for (const p of search.products)
    console.log(`  ${p.sku}  ${p.name}  ${usd(p.price)}  stock ${p.stock}`);

  const order = await call('get_order', { order_id: 1042 });
  console.log(`\nget_order 1042: ${order.status}, ${usd(order.total)}, customer`, order.customer);

  const low = await call('list_low_stock', { limit: 5 });
  console.log('\nlist_low_stock (top 5):');
  for (const p of low.products)
    console.log(
      `  ${p.sku}  stock ${p.stock}/${p.reorder_level}  reorder ${p.suggested_reorder_qty}`,
    );

  const sales = await call('sales_summary', { from: day(-30), to: day(0) });
  console.log(
    `\nsales_summary ${sales.period.from}..${sales.period.to}: ${sales.orders} orders, ` +
      `${usd(sales.revenue)} revenue, AOV ${usd(sales.average_order_value)}`,
  );
  for (const c of sales.by_category)
    console.log(`  ${c.category.padEnd(14)} ${usd(c.revenue)}  (${c.share_pct}%)`);

  const args = { sku: 'COF-002', mode: 'adjust', quantity: 24, reason: 'Delivery PO-4471' };
  const preview = await call('update_stock', args);
  console.log(
    `\nupdate_stock preview: ${preview.current_stock} -> ${preview.new_stock}, ` +
      `applied=${preview.applied}, token ${String(preview.confirm_token).slice(0, 10)}...`,
  );
  const applied = await call('update_stock', { ...args, confirm_token: preview.confirm_token });
  console.log(`update_stock confirm: status=${applied.status}, new stock ${applied.new_stock}`);
  const replay = await call('update_stock', { ...args, confirm_token: preview.confirm_token });
  console.log(`update_stock replay:  ${replay.error.code}`);

  const audit = await call('get_audit_log', { limit: 5 });
  console.log('\nget_audit_log:');
  for (const e of audit.entries)
    console.log(`  #${e.id} ${e.actor} ${e.tool} ${e.outcome}: ${e.detail}`);

  const policy = await client.readResource({ uri: 'store://policies' });
  console.log(
    `\nresource store://policies: ${(policy.contents[0] as { text: string }).text.split('\n')[0]}`,
  );

  const prompt = await client.getPrompt({ name: 'weekly_sales_report', arguments: {} });
  console.log(`prompt weekly_sales_report: ${prompt.description}`);
} finally {
  await client.close();
  rmSync(dir, { recursive: true, force: true });
}
