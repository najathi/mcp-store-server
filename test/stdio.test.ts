import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
  getDefaultEnvironment,
  StdioClientTransport,
} from '@modelcontextprotocol/sdk/client/stdio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterAll, describe, expect, it } from 'vitest';

const dir = mkdtempSync(join(tmpdir(), 'mcp-store-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('stdio transport (real child process)', () => {
  it('starts, seeds an empty database, lists tools and answers calls', async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ['--import', 'tsx', 'src/index.ts', 'stdio'],
      cwd: process.cwd(),
      env: {
        ...getDefaultEnvironment(),
        DATABASE_PATH: join(dir, 'store.db'),
        STDIO_ACTOR: 'stdio-test',
        STDIO_SCOPES: 'read',
      },
      stderr: 'pipe',
    });
    const client = new Client({ name: 'stdio-test', version: '1.0.0' });
    await client.connect(transport);

    expect(client.getServerVersion()).toMatchObject({ name: 'mcp-store-server' });
    const { tools } = await client.listTools();
    expect(tools).toHaveLength(6);

    const low = (await client.callTool({
      name: 'list_low_stock',
      arguments: {},
    })) as CallToolResult;
    expect(low.isError).toBeFalsy();
    expect((low.structuredContent as { count: number }).count).toBeGreaterThan(0);

    // STDIO_SCOPES=read, so writes are refused.
    const write = (await client.callTool({
      name: 'update_stock',
      arguments: { sku: 'COF-002', mode: 'set', quantity: 1, reason: 'test' },
    })) as CallToolResult;
    expect(write.structuredContent).toMatchObject({ error: { code: 'FORBIDDEN' } });

    await client.close();
  });
});
