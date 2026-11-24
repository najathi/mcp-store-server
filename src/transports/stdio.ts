import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { AppConfig } from '../config.js';
import type { Db } from '../db.js';
import { log } from '../log.js';
import { createDeps, createStoreServer } from '../server.js';

/**
 * Runs the server over stdio for local clients (Claude Desktop, Claude Code, Cursor).
 * There is no token on stdio: the caller is whoever started the process, so it gets the
 * identity and scopes from STDIO_ACTOR / STDIO_SCOPES (read-only by default).
 */
export async function runStdio(db: Db, config: AppConfig): Promise<void> {
  const deps = createDeps(db, config, {
    defaultPrincipal: { name: config.stdio.actor, scopes: config.stdio.scopes },
  });
  const server = createStoreServer(deps);
  await server.connect(new StdioServerTransport());
  log.info(
    `stdio server ready (actor "${config.stdio.actor}", scopes: ${config.stdio.scopes.join(', ')})`,
  );
}
