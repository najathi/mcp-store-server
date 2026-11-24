import { describe, expect, it } from 'vitest';
import { connect, fakeClock, setup, stockOf } from './helpers.js';

const change = {
  sku: 'COF-002',
  mode: 'adjust',
  quantity: 24,
  reason: 'Delivery PO-4471 received',
};

describe('scopes', () => {
  it('denies update_stock to a read-only caller and audits the attempt', async () => {
    const s = await setup({ actor: 'analyst', scopes: ['read'] });
    const before = stockOf(s.db, 'COF-002');

    const result = await s.call('update_stock', change);
    expect(result.isError).toBe(true);
    expect(result.data).toMatchObject({
      error: { code: 'FORBIDDEN', details: { required_scope: 'write', granted_scopes: ['read'] } },
    });
    expect(stockOf(s.db, 'COF-002')).toBe(before);

    const audit = await s.call('get_audit_log', { outcome: 'denied' });
    expect(audit.data.entries).toEqual([
      expect.objectContaining({ actor: 'analyst', tool: 'update_stock', outcome: 'denied' }),
    ]);
    await s.close();
  });

  it('denies read tools to a write-only caller', async () => {
    const s = await setup({ scopes: ['write'] });
    const result = await s.call('search_products', {});
    expect(result.data).toMatchObject({ error: { code: 'FORBIDDEN' } });
    await s.close();
  });
});

describe('update_stock dry-run / confirm', () => {
  it('previews without writing, then applies with the confirm token', async () => {
    const s = await setup({ actor: 'ops-bot', scopes: ['read', 'write'] });
    const before = stockOf(s.db, 'COF-002');

    const preview = await s.call('update_stock', change);
    expect(preview.isError).toBe(false);
    expect(preview.data).toMatchObject({
      status: 'preview',
      applied: false,
      current_stock: before,
      new_stock: before + 24,
      change: 24,
    });
    expect(preview.data.confirm_token).toMatch(/^cfm_/);
    expect(stockOf(s.db, 'COF-002')).toBe(before); // nothing written yet

    const applied = await s.call('update_stock', {
      ...change,
      confirm_token: preview.data.confirm_token,
    });
    expect(applied.data).toMatchObject({
      status: 'applied',
      previous_stock: before,
      new_stock: before + 24,
    });
    expect(stockOf(s.db, 'COF-002')).toBe(before + 24);

    // Audit trail: preview then applied, with the token redacted.
    const audit = await s.call('get_audit_log', { tool: 'update_stock' });
    const entries = audit.data.entries as {
      outcome: string;
      actor: string;
      args: Record<string, unknown>;
    }[];
    expect(entries.map((e) => e.outcome)).toEqual(['applied', 'preview']);
    expect(entries[0]!.actor).toBe('ops-bot');
    expect(entries[0]!.args.confirm_token).toBe('[redacted]');
    expect(JSON.stringify(audit.data)).not.toContain(preview.data.confirm_token as string);
    await s.close();
  });

  it('supports mode "set"', async () => {
    const s = await setup({ scopes: ['read', 'write'] });
    const args = { sku: 'cof-006', mode: 'set', quantity: 12, reason: 'Recount after audit' };
    const preview = await s.call('update_stock', args);
    expect(preview.data).toMatchObject({ current_stock: 0, new_stock: 12 });
    await s.call('update_stock', { ...args, confirm_token: preview.data.confirm_token });
    expect(stockOf(s.db, 'COF-006')).toBe(12);
    await s.close();
  });

  it('rejects a replayed token', async () => {
    const s = await setup({ scopes: ['read', 'write'] });
    const preview = await s.call('update_stock', change);
    const token = preview.data.confirm_token;
    await s.call('update_stock', { ...change, confirm_token: token });
    const replay = await s.call('update_stock', { ...change, confirm_token: token });
    expect(replay.data).toMatchObject({ error: { code: 'CONFIRMATION_INVALID' } });
    expect(stockOf(s.db, 'COF-002')).toBe(8 + 24); // applied once only
    await s.close();
  });

  it('rejects a token used with different arguments', async () => {
    const s = await setup({ scopes: ['read', 'write'] });
    const preview = await s.call('update_stock', change);
    const tampered = await s.call('update_stock', {
      ...change,
      quantity: 2400,
      confirm_token: preview.data.confirm_token,
    });
    expect(tampered.data).toMatchObject({
      error: { code: 'CONFIRMATION_INVALID', message: expect.stringMatching(/Arguments differ/) },
    });
    expect(stockOf(s.db, 'COF-002')).toBe(8);

    const audit = await s.call('get_audit_log', { outcome: 'rejected' });
    expect(audit.data.count).toBe(1);
    await s.close();
  });

  it('rejects an expired token', async () => {
    const clock = fakeClock();
    const s = await setup({ scopes: ['read', 'write'], now: clock.now });
    const preview = await s.call('update_stock', change);
    clock.advance(121_000);
    const late = await s.call('update_stock', {
      ...change,
      confirm_token: preview.data.confirm_token,
    });
    expect(late.data).toMatchObject({
      error: { code: 'CONFIRMATION_INVALID', message: expect.stringMatching(/expired/) },
    });
    expect(stockOf(s.db, 'COF-002')).toBe(8);
    await s.close();
  });

  it('rejects a token issued to another caller', async () => {
    const s = await setup({ actor: 'alice', scopes: ['read', 'write'] });
    const preview = await s.call('update_stock', change);

    const bob = await connect({
      ...s.deps,
      defaultPrincipal: { name: 'bob', scopes: ['read', 'write'] },
    });
    const stolen = await bob.call('update_stock', {
      ...change,
      confirm_token: preview.data.confirm_token,
    });
    expect(stolen.data).toMatchObject({ error: { code: 'CONFIRMATION_INVALID' } });
    expect(stockOf(s.db, 'COF-002')).toBe(8);
    await bob.close();
    await s.close();
  });

  it('refuses to apply when stock changed after the preview', async () => {
    const s = await setup({ scopes: ['read', 'write'] });
    const preview = await s.call('update_stock', change);
    s.db.prepare(`UPDATE products SET stock = 3 WHERE sku = 'COF-002'`).run(); // e.g. a sale
    const result = await s.call('update_stock', {
      ...change,
      confirm_token: preview.data.confirm_token,
    });
    expect(result.data).toMatchObject({
      error: { code: 'CONFLICT', details: { previewed_stock: 8, current_stock: 3 } },
    });
    expect(stockOf(s.db, 'COF-002')).toBe(3);
    await s.close();
  });

  it('validates the change before issuing a token', async () => {
    const s = await setup({ scopes: ['read', 'write'] });
    const negative = await s.call('update_stock', { ...change, quantity: -100 });
    expect(negative.data).toMatchObject({ error: { code: 'INVALID_ARGUMENT' } });

    const unknown = await s.call('update_stock', { ...change, sku: 'XYZ-999' });
    expect(unknown.data).toMatchObject({ error: { code: 'NOT_FOUND' } });

    const badSku = await s.call('update_stock', { ...change, sku: 'DROP TABLE' });
    expect(badSku.isError).toBe(true);

    const noReason = await s.call('update_stock', { ...change, reason: '' });
    expect(noReason.isError).toBe(true);

    expect(s.deps.confirmations.size).toBe(0);
    await s.close();
  });
});

describe('rate limiting', () => {
  it('rejects calls over the per-minute limit with a retry hint', async () => {
    const clock = fakeClock();
    const s = await setup({ rateLimitPerMinute: 3, now: clock.now });
    for (let i = 0; i < 3; i++) {
      expect((await s.call('list_low_stock')).isError).toBe(false);
    }
    const limited = await s.call('list_low_stock');
    expect(limited.data).toMatchObject({
      error: { code: 'RATE_LIMITED', details: { retry_after_seconds: 60 } },
    });
    clock.advance(60_000);
    expect((await s.call('list_low_stock')).isError).toBe(false);
    await s.close();
  });
});
