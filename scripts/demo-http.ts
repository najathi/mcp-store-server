/**
 * Calls a running HTTP server with the official SDK client.
 *
 *   npm run start:http                      # in one terminal (with API_TOKENS set)
 *   MCP_TOKEN=<token> npm run demo:http     # in another
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

const url = new URL(process.env.MCP_URL ?? 'http://127.0.0.1:3000/mcp');
const token = process.env.MCP_TOKEN;
if (!token) {
  console.error('Set MCP_TOKEN to one of the tokens in API_TOKENS.');
  process.exit(1);
}

const client = new Client({ name: 'demo-http', version: '1.0.0' });
await client.connect(
  new StreamableHTTPClientTransport(url, {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  }),
);

const { tools } = await client.listTools();
console.log(`Connected to ${url}. Tools: ${tools.map((t) => t.name).join(', ')}`);

for (const [name, args] of [
  ['search_products', { query: 'matcha' }],
  ['list_low_stock', { limit: 3 }],
  ['update_stock', { sku: 'TEA-005', mode: 'adjust', quantity: 10, reason: 'HTTP demo' }],
] as const) {
  const result = (await client.callTool({ name, arguments: args })) as CallToolResult;
  const text = result.content[0]?.type === 'text' ? result.content[0].text : '';
  console.log(`\n${name} ${JSON.stringify(args)} ->${result.isError ? ' (error)' : ''}\n${text}`);
}

await client.close();
