import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { Scope } from '../src/config.js';
import { type Db, openDatabase } from '../src/db.js';
import { seedDatabase } from '../src/seed.js';
import { createDeps, createStoreServer } from '../src/server.js';
import type { StoreDeps } from '../src/tools/shared.js';

/** Fixed date so seeded orders (and therefore sales figures) are identical on every run. */
export const REFERENCE_DATE = new Date('2026-11-01T12:00:00Z');

export function seededDb(): Db {
  const db = openDatabase(':memory:');
  seedDatabase(db, REFERENCE_DATE);
  return db;
}

/** A controllable clock for expiry and rate-limit tests. */
export function fakeClock(start = REFERENCE_DATE.getTime()) {
  let now = start;
  return { now: () => now, advance: (ms: number) => (now += ms) };
}

export interface ToolCall {
  isError: boolean;
  data: Record<string, unknown>;
  raw: CallToolResult;
}

export async function connect(deps: StoreDeps) {
  const server = createStoreServer(deps);
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  const call = async (name: string, args: Record<string, unknown> = {}): Promise<ToolCall> => {
    const raw = (await client.callTool({ name, arguments: args })) as CallToolResult;
    const text = raw.content[0]?.type === 'text' ? raw.content[0].text : '';
    let data: Record<string, unknown>;
    try {
      data = (raw.structuredContent as Record<string, unknown>) ?? JSON.parse(text);
    } catch {
      data = { text }; // e.g. SDK input-validation messages are plain text
    }
    return { isError: raw.isError === true, data, raw };
  };

  return { client, server, call, close: () => client.close() };
}

/** In-process client + server sharing one seeded database. */
export async function setup(
  options: {
    actor?: string;
    scopes?: Scope[];
    now?: () => number;
    rateLimitPerMinute?: number;
  } = {},
) {
  const db = seededDb();
  const deps = createDeps(
    db,
    { rateLimitPerMinute: options.rateLimitPerMinute ?? 1000, confirmTtlSeconds: 120 },
    {
      now: options.now,
      defaultPrincipal: { name: options.actor ?? 'tester', scopes: options.scopes ?? ['read'] },
    },
  );
  const session = await connect(deps);
  return { db, deps, ...session };
}

export function stockOf(db: Db, sku: string): number {
  return (db.prepare('SELECT stock FROM products WHERE sku = ?').get(sku) as { stock: number })
    .stock;
}
