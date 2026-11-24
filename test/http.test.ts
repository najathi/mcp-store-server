import { request, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { createHttpApp } from '../src/transports/http.js';
import { seededDb } from './helpers.js';

const READ_TOKEN = 'test-read-token-0123456789';
const WRITE_TOKEN = 'test-write-token-0123456789';

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  const config = loadConfig({
    API_TOKENS: `analyst:${READ_TOKEN}:read,ops-bot:${WRITE_TOKEN}:read|write`,
    HTTP_PORT: '0',
  });
  const app = createHttpApp(seededDb(), config);
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => resolve());
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

async function connectAs(token: string) {
  const client = new Client({ name: 'http-test', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  await client.connect(transport);
  const call = async (name: string, args: Record<string, unknown> = {}) =>
    (await client.callTool({ name, arguments: args })) as CallToolResult & {
      structuredContent: Record<string, unknown>;
    };
  return { client, call };
}

const initialize = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'curl', version: '1' },
  },
};

async function post(headers: Record<string, string>) {
  return fetch(`${baseUrl}/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      ...headers,
    },
    body: JSON.stringify(initialize),
  });
}

describe('HTTP transport', () => {
  it('serves an unauthenticated health check', async () => {
    const res = await fetch(`${baseUrl}/healthz`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: 'ok' });
  });

  it('rejects requests without a bearer token', async () => {
    const res = await post({});
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toMatch(/^Bearer error="invalid_token"/);
  });

  it('rejects unknown tokens', async () => {
    const res = await post({ Authorization: 'Bearer not-a-real-token-at-all' });
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: 'invalid_token' });
  });

  it('accepts a valid token over raw JSON-RPC', async () => {
    const res = await post({ Authorization: `Bearer ${READ_TOKEN}` });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { result: { serverInfo: { name: string } } };
    expect(body.result.serverInfo.name).toBe('mcp-store-server');
  });

  it('rejects a foreign Host header (DNS-rebinding protection)', async () => {
    const status = await new Promise<number | undefined>((resolve, reject) => {
      const req = request(
        `${baseUrl}/mcp`,
        {
          method: 'POST',
          headers: { Host: 'evil.example', Authorization: `Bearer ${READ_TOKEN}` },
        },
        (res) => {
          res.resume();
          resolve(res.statusCode);
        },
      );
      req.on('error', reject);
      req.end('{}');
    });
    expect(status).toBe(403);
  });

  it('returns 405 for GET and DELETE in stateless mode', async () => {
    const res = await fetch(`${baseUrl}/mcp`, {
      headers: { Authorization: `Bearer ${READ_TOKEN}` },
    });
    expect(res.status).toBe(405);
  });

  it('lets a read token list tools and read data, but not write', async () => {
    const { client, call } = await connectAs(READ_TOKEN);
    const { tools } = await client.listTools();
    expect(tools).toHaveLength(6);

    const search = await call('search_products', { query: 'espresso' });
    expect(search.isError).toBeFalsy();
    expect(search.structuredContent.count).toBeGreaterThan(0);

    const write = await call('update_stock', {
      sku: 'TEA-005',
      mode: 'adjust',
      quantity: 10,
      reason: 'Delivery',
    });
    expect(write.isError).toBe(true);
    expect(write.structuredContent).toMatchObject({ error: { code: 'FORBIDDEN' } });
    await client.close();
  });

  it('lets a write token preview and confirm, attributing the audit entry to the token name', async () => {
    const { client, call } = await connectAs(WRITE_TOKEN);
    const args = { sku: 'TEA-005', mode: 'adjust', quantity: 10, reason: 'Delivery PO-88' };

    const preview = await call('update_stock', args);
    expect(preview.structuredContent).toMatchObject({ status: 'preview', current_stock: 3 });

    // Each HTTP request uses a fresh MCP server, so this also proves tokens survive across requests.
    const applied = await call('update_stock', {
      ...args,
      confirm_token: preview.structuredContent.confirm_token,
    });
    expect(applied.structuredContent).toMatchObject({ status: 'applied', new_stock: 13 });

    const audit = await call('get_audit_log', { limit: 5 });
    const entries = audit.structuredContent.entries as { actor: string; outcome: string }[];
    expect(entries[0]).toMatchObject({ actor: 'ops-bot', outcome: 'applied' });
    expect(entries.some((e) => e.actor === 'analyst' && e.outcome === 'denied')).toBe(true);
    await client.close();
  });
});
