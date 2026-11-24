import type { Db } from './db.js';

export const AUDIT_OUTCOMES = ['preview', 'applied', 'rejected', 'denied'] as const;
export type AuditOutcome = (typeof AUDIT_OUTCOMES)[number];

export interface AuditEntry {
  id: number;
  created_at: string;
  actor: string;
  tool: string;
  args: unknown;
  outcome: AuditOutcome;
  detail: string;
}

/** Argument names whose values are never written to the audit log. */
const REDACTED_ARGS = new Set(['confirm_token']);

/**
 * Append-only audit trail. Every write-tool call (preview, applied, rejected) and every
 * denied call to any tool is recorded with the caller, arguments and result.
 */
export class AuditLog {
  constructor(
    private readonly db: Db,
    private readonly now: () => Date = () => new Date(),
  ) {}

  record(entry: {
    actor: string;
    tool: string;
    args: unknown;
    outcome: AuditOutcome;
    detail: string;
  }): number {
    const result = this.db
      .prepare(
        `INSERT INTO audit_log (created_at, actor, tool, args_json, outcome, detail)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        this.now().toISOString(),
        entry.actor,
        entry.tool,
        JSON.stringify(redact(entry.args)),
        entry.outcome,
        entry.detail,
      );
    return Number(result.lastInsertRowid);
  }

  list(filter: {
    limit: number;
    tool?: string;
    outcome?: AuditOutcome;
    actor?: string;
  }): AuditEntry[] {
    const where: string[] = [];
    const params: unknown[] = [];
    if (filter.tool) {
      where.push('tool = ?');
      params.push(filter.tool);
    }
    if (filter.outcome) {
      where.push('outcome = ?');
      params.push(filter.outcome);
    }
    if (filter.actor) {
      where.push('actor = ?');
      params.push(filter.actor);
    }
    const rows = this.db
      .prepare(
        `SELECT id, created_at, actor, tool, args_json, outcome, detail FROM audit_log
         ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
         ORDER BY id DESC LIMIT ?`,
      )
      .all(...params, filter.limit) as (Omit<AuditEntry, 'args'> & { args_json: string })[];
    return rows.map(({ args_json, ...rest }) => ({
      ...rest,
      args: JSON.parse(args_json) as unknown,
    }));
  }
}

function redact(args: unknown): unknown {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return args;
  return Object.fromEntries(
    Object.entries(args as Record<string, unknown>).map(([key, value]) => [
      key,
      REDACTED_ARGS.has(key) && value !== undefined ? '[redacted]' : value,
    ]),
  );
}
