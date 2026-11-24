import type { Server } from 'node:http';
import { createMcpExpressApp } from '@modelcontextprotocol/sdk/server/express.js';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Express, Request, Response } from 'express';
import type { AppConfig } from '../config.js';
import type { Db } from '../db.js';
import { log } from '../log.js';
import { StaticTokenVerifier } from '../security/auth.js';
import { createDeps, createStoreServer, SERVER_NAME, SERVER_VERSION } from '../server.js';

/**
 * Builds the Streamable HTTP app.
 *
 * - `POST /mcp` requires `Authorization: Bearer <token>`; the SDK middleware rejects missing or
 *   unknown tokens with 401 before any MCP code runs.
 * - Stateless mode: each request gets a fresh MCP server and transport. Shared state (database,
 *   audit log, confirm tokens, rate-limit counters) lives in `deps` for the life of the process.
 *   Confirm tokens and rate limits are in memory, so run one replica or move them to Redis.
 * - `GET /healthz` is unauthenticated and reveals nothing but liveness.
 */
export function createHttpApp(db: Db, config: AppConfig): Express {
  if (config.apiTokens.length === 0) {
    throw new Error(
      'HTTP transport needs at least one API token. Set API_TOKENS (see .env.example).',
    );
  }

  const deps = createDeps(db, config); // no defaultPrincipal: every request must authenticate
  const app = createMcpExpressApp({
    host: config.http.host,
    // Loopback names stay allowed so local clients and the container health check keep working.
    allowedHosts: config.http.allowedHosts && [
      ...new Set([...config.http.allowedHosts, 'localhost', '127.0.0.1', '[::1]']),
    ],
  });
  app.disable('x-powered-by');

  app.get('/healthz', (_req, res) => {
    res.json({ status: 'ok', name: SERVER_NAME, version: SERVER_VERSION });
  });

  const auth = requireBearerAuth({ verifier: new StaticTokenVerifier(config.apiTokens) });

  app.post('/mcp', auth, async (req: Request, res: Response) => {
    const server = createStoreServer(deps);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      log.error('failed to handle MCP request', err);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: '2.0',
          error: { code: -32603, message: 'Internal server error' },
          id: null,
        });
      }
    }
  });

  // Stateless server: no SSE stream to resume and no session to delete.
  const methodNotAllowed = (_req: Request, res: Response) => {
    res
      .status(405)
      .set('Allow', 'POST')
      .json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed.' }, id: null });
  };
  app.get('/mcp', methodNotAllowed);
  app.delete('/mcp', methodNotAllowed);

  return app;
}

export function runHttp(db: Db, config: AppConfig): Promise<Server> {
  const app = createHttpApp(db, config);
  return new Promise((resolve, reject) => {
    const server = app.listen(config.http.port, config.http.host, () => {
      log.info(
        `HTTP server listening on http://${config.http.host}:${config.http.port}/mcp ` +
          `(${config.apiTokens.length} API token(s) configured)`,
      );
      resolve(server);
    });
    server.on('error', reject);
  });
}
