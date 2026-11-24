import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

export type ErrorCode =
  | 'UNAUTHENTICATED'
  | 'FORBIDDEN'
  | 'RATE_LIMITED'
  | 'INVALID_ARGUMENT'
  | 'NOT_FOUND'
  | 'CONFIRMATION_INVALID'
  | 'CONFLICT'
  | 'INTERNAL';

/**
 * An expected failure that is safe to show to the model. Anything else thrown by a tool is
 * reported as a generic INTERNAL error so stack traces and SQL never leak to the client.
 */
export class ToolError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'ToolError';
  }
}

export function toolSuccess(data: Record<string, unknown>): CallToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
    structuredContent: data,
  };
}

export function toolFailure(error: ToolError): CallToolResult {
  const body = {
    error: {
      code: error.code,
      message: error.message,
      ...(error.details ? { details: error.details } : {}),
    },
  };
  return {
    isError: true,
    content: [{ type: 'text', text: JSON.stringify(body, null, 2) }],
    structuredContent: body,
  };
}
