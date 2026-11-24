/**
 * Fixed-window rate limiter keyed by caller. Deliberately simple: it stops a runaway
 * agent loop from hammering the database. Put a real gateway limit in front of the
 * HTTP transport for anything internet-facing.
 */
export class RateLimiter {
  private readonly windows = new Map<string, { start: number; count: number }>();

  constructor(
    private readonly limit: number,
    private readonly windowMs = 60_000,
    private readonly now: () => number = Date.now,
  ) {}

  /** Records one call; returns how long to wait when the caller is over the limit. */
  hit(key: string): { allowed: true } | { allowed: false; retryAfterSeconds: number } {
    const now = this.now();
    let window = this.windows.get(key);
    if (!window || now - window.start >= this.windowMs) {
      window = { start: now, count: 0 };
      this.windows.set(key, window);
    }
    if (window.count >= this.limit) {
      return {
        allowed: false,
        retryAfterSeconds: Math.ceil((window.start + this.windowMs - now) / 1000),
      };
    }
    window.count++;
    return { allowed: true };
  }
}
