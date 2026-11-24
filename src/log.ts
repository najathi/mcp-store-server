/**
 * Minimal logger. Everything goes to stderr: on the stdio transport, stdout carries the
 * MCP protocol and must never receive log lines.
 */
export const log = {
  info: (message: string) => console.error(`[mcp-store] ${message}`),
  warn: (message: string) => console.warn(`[mcp-store] warn: ${message}`),
  error: (message: string, err?: unknown) =>
    console.error(`[mcp-store] error: ${message}`, err instanceof Error ? err.stack : (err ?? '')),
};
