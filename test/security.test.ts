import { describe, expect, it } from 'vitest';
import { loadConfig, parseApiTokens } from '../src/config.js';
import { ToolError } from '../src/errors.js';
import { StaticTokenVerifier } from '../src/security/auth.js';
import { ConfirmationStore } from '../src/security/confirmations.js';
import { maskEmail, maskName, maskPhone } from '../src/security/masking.js';
import { RateLimiter } from '../src/security/rateLimit.js';
import { fakeClock } from './helpers.js';

describe('masking', () => {
  it('masks emails, keeping the first character and domain', () => {
    expect(maskEmail('ava.thompson@example.com')).toBe('a***@example.com');
    expect(maskEmail('not-an-email')).toBe('***');
  });

  it('masks phones, keeping the last four digits', () => {
    expect(maskPhone('+1-555-0107')).toBe('***-***-0107');
    expect(maskPhone('12')).toBe('***');
  });

  it('shortens names to first name and last initial', () => {
    expect(maskName('Ava Thompson')).toBe('Ava T.');
    expect(maskName('Prince')).toBe('Prince');
  });
});

describe('ConfirmationStore', () => {
  const args = { sku: 'COF-002', mode: 'set', quantity: 20, reason: 'delivery' };

  it('returns the saved state for a matching token, once', () => {
    const store = new ConfirmationStore(60_000);
    const { token } = store.issue('ops', 'update_stock', args, { newStock: 20 });
    expect(store.consume(token, 'ops', 'update_stock', { ...args })).toEqual({ newStock: 20 });
    expect(() => store.consume(token, 'ops', 'update_stock', args)).toThrow(/already used/);
  });

  it('ignores key order when comparing arguments', () => {
    const store = new ConfirmationStore(60_000);
    const { token } = store.issue('ops', 'update_stock', args, 1);
    const reordered = { reason: 'delivery', quantity: 20, mode: 'set', sku: 'COF-002' };
    expect(store.consume(token, 'ops', 'update_stock', reordered)).toBe(1);
  });

  it('rejects expired tokens', () => {
    const clock = fakeClock();
    const store = new ConfirmationStore(60_000, clock.now);
    const { token } = store.issue('ops', 'update_stock', args, 1);
    clock.advance(60_001);
    expect(() => store.consume(token, 'ops', 'update_stock', args)).toThrow(/expired/);
  });

  it('rejects a different caller, action or arguments, and burns the token', () => {
    const store = new ConfirmationStore(60_000);
    const a = store.issue('ops', 'update_stock', args, 1);
    expect(() => store.consume(a.token, 'intruder', 'update_stock', args)).toThrow(
      /different caller/,
    );
    expect(() => store.consume(a.token, 'ops', 'update_stock', args)).toThrow(/already used/);

    const b = store.issue('ops', 'update_stock', args, 1);
    expect(() => store.consume(b.token, 'ops', 'update_stock', { ...args, quantity: 999 })).toThrow(
      /Arguments differ/,
    );

    const c = store.issue('ops', 'update_stock', args, 1);
    expect(() => store.consume(c.token, 'ops', 'refund_order', args)).toThrow(ToolError);
  });

  it('prunes expired tokens when issuing new ones', () => {
    const clock = fakeClock();
    const store = new ConfirmationStore(1_000, clock.now);
    store.issue('ops', 'x', {}, 1);
    clock.advance(2_000);
    store.issue('ops', 'x', {}, 2);
    expect(store.size).toBe(1);
  });
});

describe('RateLimiter', () => {
  it('allows up to the limit per window, per caller', () => {
    const clock = fakeClock();
    const limiter = new RateLimiter(2, 60_000, clock.now);
    expect(limiter.hit('a').allowed).toBe(true);
    expect(limiter.hit('a').allowed).toBe(true);
    expect(limiter.hit('a')).toEqual({ allowed: false, retryAfterSeconds: 60 });
    expect(limiter.hit('b').allowed).toBe(true);
    clock.advance(60_000);
    expect(limiter.hit('a').allowed).toBe(true);
  });
});

describe('configuration', () => {
  it('parses API tokens with scopes', () => {
    expect(
      parseApiTokens('analyst:aaaaaaaaaaaaaaaa:read, ops-bot:bbbbbbbbbbbbbbbb:read|write'),
    ).toEqual([
      { name: 'analyst', token: 'aaaaaaaaaaaaaaaa', scopes: ['read'] },
      { name: 'ops-bot', token: 'bbbbbbbbbbbbbbbb', scopes: ['read', 'write'] },
    ]);
  });

  it('rejects weak, malformed or duplicate tokens', () => {
    expect(() => parseApiTokens('a:short:read')).toThrow(/at least 16/);
    expect(() => parseApiTokens('a:aaaaaaaaaaaaaaaa:admin')).toThrow(/scopes/);
    expect(() => parseApiTokens('a:aaaaaaaaaaaaaaaa')).toThrow(/name:token:scopes/);
    expect(() => parseApiTokens('a:aaaaaaaaaaaaaaaa:read,a:bbbbbbbbbbbbbbbb:read')).toThrow(
      /duplicate/,
    );
  });

  it('defaults stdio to read-only', () => {
    const config = loadConfig({});
    expect(config.stdio.scopes).toEqual(['read']);
    expect(config.http.host).toBe('127.0.0.1');
    expect(config.apiTokens).toEqual([]);
  });

  it('reports invalid environment values', () => {
    expect(() => loadConfig({ HTTP_PORT: 'abc' })).toThrow(/HTTP_PORT/);
    expect(() => loadConfig({ STDIO_SCOPES: 'root' })).toThrow(/STDIO_SCOPES/);
    expect(loadConfig({ STDIO_SCOPES: 'read, write' }).stdio.scopes).toEqual(['read', 'write']);
  });
});

describe('StaticTokenVerifier', () => {
  const verifier = new StaticTokenVerifier(
    parseApiTokens('analyst:aaaaaaaaaaaaaaaa:read,ops:bbbbbbbbbbbbbbbb:read|write'),
  );

  it('resolves a known token to its name and scopes', async () => {
    const info = await verifier.verifyAccessToken('bbbbbbbbbbbbbbbb');
    expect(info.clientId).toBe('ops');
    expect(info.scopes).toEqual(['read', 'write']);
    expect(info.expiresAt).toBeGreaterThan(Date.now() / 1000);
  });

  it('rejects unknown tokens', async () => {
    await expect(verifier.verifyAccessToken('cccccccccccccccc')).rejects.toThrow(/Invalid/);
  });
});
