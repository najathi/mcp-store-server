import { createHash, randomBytes } from 'node:crypto';
import { ToolError } from '../errors.js';

interface PendingConfirmation<T> {
  actor: string;
  action: string;
  fingerprint: string;
  expiresAt: number;
  state: T;
}

/**
 * Short-lived, single-use confirmation tokens for the dry-run / confirm flow.
 *
 * A token is bound to the caller, the action and the exact arguments of the preview.
 * It is consumed on first use (even a failed one), so it cannot be replayed, and it is
 * useless for a different product, quantity or caller.
 */
export class ConfirmationStore {
  private readonly pending = new Map<string, PendingConfirmation<unknown>>();

  constructor(
    private readonly ttlMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  issue<T>(
    actor: string,
    action: string,
    args: unknown,
    state: T,
  ): { token: string; expiresAt: string } {
    this.prune();
    const token = `cfm_${randomBytes(18).toString('base64url')}`;
    const expiresAt = this.now() + this.ttlMs;
    this.pending.set(token, { actor, action, fingerprint: fingerprint(args), expiresAt, state });
    return { token, expiresAt: new Date(expiresAt).toISOString() };
  }

  /** Validates and consumes a token, returning the state saved with the preview. */
  consume<T>(token: string, actor: string, action: string, args: unknown): T {
    const entry = this.pending.get(token);
    if (!entry) {
      throw new ToolError(
        'CONFIRMATION_INVALID',
        'Unknown or already used confirm_token. Call the tool again without confirm_token to get a new preview.',
      );
    }
    this.pending.delete(token);

    if (entry.expiresAt <= this.now()) {
      throw new ToolError(
        'CONFIRMATION_INVALID',
        'confirm_token has expired. Request a new preview.',
      );
    }
    if (entry.actor !== actor || entry.action !== action) {
      throw new ToolError(
        'CONFIRMATION_INVALID',
        'confirm_token was issued for a different caller or action.',
      );
    }
    if (entry.fingerprint !== fingerprint(args)) {
      throw new ToolError(
        'CONFIRMATION_INVALID',
        'Arguments differ from the preview this confirm_token was issued for. Request a new preview.',
      );
    }
    return entry.state as T;
  }

  get size(): number {
    return this.pending.size;
  }

  private prune(): void {
    const now = this.now();
    for (const [token, entry] of this.pending) {
      if (entry.expiresAt <= now) this.pending.delete(token);
    }
  }
}

function fingerprint(value: unknown): string {
  return createHash('sha256').update(stableStringify(value)).digest('hex');
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'undefined';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
}
