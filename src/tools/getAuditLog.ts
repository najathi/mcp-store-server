import { z } from 'zod';
import { AUDIT_OUTCOMES } from '../audit.js';
import { defineTool } from './shared.js';

export const getAuditLog = defineTool({
  name: 'get_audit_log',
  title: 'Get audit log',
  description:
    'Read recent audit entries, newest first: every write-tool call (preview, applied, rejected) ' +
    'and every denied call, with caller, arguments and outcome. Confirm tokens are redacted.',
  scope: 'read',
  annotations: { readOnlyHint: true, openWorldHint: false },
  inputSchema: {
    limit: z.number().int().min(1).max(100).default(20).describe('Maximum entries (1-100)'),
    tool: z
      .string()
      .regex(/^[a-z_]{1,64}$/)
      .optional()
      .describe('Only entries for this tool, e.g. "update_stock"'),
    outcome: z.enum(AUDIT_OUTCOMES).optional().describe('Only entries with this outcome'),
    actor: z
      .string()
      .min(1)
      .max(64)
      .optional()
      .describe('Only entries by this caller (token name)'),
  },
  handler(args, { audit }) {
    const entries = audit.list(args);
    return { count: entries.length, entries };
  },
});
