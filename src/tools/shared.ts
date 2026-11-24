import type { McpServer, ToolCallback } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { AuditLog } from '../audit.js';
import type { Scope } from '../config.js';
import type { Db } from '../db.js';
import { ToolError, toolFailure, toolSuccess } from '../errors.js';
import { type Principal, principalFromAuthInfo } from '../security/auth.js';
import type { ConfirmationStore } from '../security/confirmations.js';
import type { RateLimiter } from '../security/rateLimit.js';
import { log } from '../log.js';

/** Shared services every tool call can use. Created once per process. */
export interface StoreDeps {
  db: Db;
  audit: AuditLog;
  confirmations: ConfirmationStore;
  rateLimiter: RateLimiter;
  currency: string;
  /**
   * Caller identity when the transport carries no auth (stdio, in-process tests).
   * Leave undefined on HTTP so a request that somehow skips auth is rejected.
   */
  defaultPrincipal?: Principal;
}

export interface ToolContext extends StoreDeps {
  principal: Principal;
}

export interface StoreTool<Shape extends z.ZodRawShape> {
  name: string;
  title: string;
  description: string;
  /** Scope the caller must hold. Tools needing `write` are audited on every call. */
  scope: Scope;
  inputSchema: Shape;
  annotations: ToolAnnotations;
  handler: (
    args: z.output<z.ZodObject<Shape>>,
    ctx: ToolContext,
  ) => Record<string, unknown> | Promise<Record<string, unknown>>;
}

export function defineTool<Shape extends z.ZodRawShape>(tool: StoreTool<Shape>): StoreTool<Shape> {
  return tool;
}

/**
 * Registers a tool behind the guard every call goes through:
 * authenticate -> rate limit -> scope check -> handler -> structured result / error.
 */
export function registerStoreTool<Shape extends z.ZodRawShape>(
  server: McpServer,
  deps: StoreDeps,
  tool: StoreTool<Shape>,
): void {
  // The SDK validates arguments against inputSchema before this callback runs, so the cast
  // below only restores the precise per-tool type that the generic signature loses.
  const callback: ToolCallback<z.ZodRawShape> = async (rawArgs, extra) => {
    const args = rawArgs as z.output<z.ZodObject<Shape>>;
    const principal = extra.authInfo
      ? principalFromAuthInfo(extra.authInfo)
      : deps.defaultPrincipal;
    if (!principal) {
      return toolFailure(
        new ToolError('UNAUTHENTICATED', 'No authenticated caller for this request.'),
      );
    }

    const deny = (error: ToolError) => {
      deps.audit.record({
        actor: principal.name,
        tool: tool.name,
        args,
        outcome: 'denied',
        detail: error.message,
      });
      return toolFailure(error);
    };

    const limit = deps.rateLimiter.hit(principal.name);
    if (!limit.allowed) {
      return deny(
        new ToolError('RATE_LIMITED', 'Too many tool calls. Slow down and retry later.', {
          retry_after_seconds: limit.retryAfterSeconds,
        }),
      );
    }

    if (!principal.scopes.includes(tool.scope)) {
      return deny(
        new ToolError('FORBIDDEN', `This tool requires the "${tool.scope}" scope.`, {
          required_scope: tool.scope,
          granted_scopes: principal.scopes,
        }),
      );
    }

    try {
      return toolSuccess(await tool.handler(args, { ...deps, principal }));
    } catch (err) {
      const error =
        err instanceof ToolError ? err : new ToolError('INTERNAL', 'Unexpected server error.');
      if (!(err instanceof ToolError)) log.error(`tool ${tool.name} failed`, err);
      if (tool.scope === 'write') {
        deps.audit.record({
          actor: principal.name,
          tool: tool.name,
          args,
          outcome: 'rejected',
          detail: `${error.code}: ${error.message}`,
        });
      }
      return toolFailure(error);
    }
  };

  server.registerTool(
    tool.name,
    {
      title: tool.title,
      description: tool.description,
      inputSchema: tool.inputSchema as z.ZodRawShape,
      annotations: { title: tool.title, ...tool.annotations },
    },
    callback,
  );
}

/** Integer cents to a 2-decimal amount for display. */
export function money(cents: number): number {
  return Math.round(cents) / 100;
}

export const isoDate = (description: string) =>
  z.iso.date({ message: 'Expected a date in YYYY-MM-DD format' }).describe(description);
