import { describe, expect, it, vi } from 'vitest';
import type { Driver } from 'neo4j-driver';
import {
  KnowledgeEpochStore,
  UNSCOPED_KNOWLEDGE_PROJECT,
  bumpKnowledgeEpoch,
} from '../knowledge-epoch.js';

describe('KnowledgeEpochStore', () => {
  it('reads an exact decimal string without converting through JavaScript number', async () => {
    const close = vi.fn().mockResolvedValue(undefined);
    const run = vi.fn().mockResolvedValue({
      records: [{ get: () => '9223372036854775807' }],
    });
    const store = new KnowledgeEpochStore({
      session: vi.fn(() => ({ run, close })),
    } as unknown as Driver);

    await expect(
      store.read({ tenantId: 'tenant-a', projectScope: 'PROJECT:Alpha', timeoutMs: 321 }),
    ).resolves.toEqual({ knowledgeEpoch: '9223372036854775807' });
    expect(run.mock.calls[0]![1]).toEqual({
      epochTenantId: 'tenant-a',
      epochProjectScope: 'project:alpha',
    });
    expect((run.mock.calls[0]![2] as { timeout: { toNumber(): number } }).timeout.toNumber()).toBe(321);
    expect(close).toHaveBeenCalledOnce();
  });

  it('rejects an already-aborted read before opening a session', async () => {
    const controller = new AbortController();
    controller.abort();
    const session = vi.fn();
    const store = new KnowledgeEpochStore({ session } as unknown as Driver);
    await expect(store.read({
      tenantId: 'tenant-a', projectScope: 'project:alpha', timeoutMs: 1_000,
      signal: controller.signal,
    })).rejects.toThrow('knowledge_epoch:aborted');
    expect(session).not.toHaveBeenCalled();
  });

  it('cooperatively aborts an in-flight read and closes its session', async () => {
    const controller = new AbortController();
    const close = vi.fn().mockResolvedValue(undefined);
    const run = vi.fn(() => new Promise<never>(() => {}));
    const store = new KnowledgeEpochStore({
      session: vi.fn(() => ({ run, close })),
    } as unknown as Driver);
    const pending = store.read({
      tenantId: 'tenant-a', projectScope: 'project:alpha', timeoutMs: 1_000,
      signal: controller.signal,
    });
    controller.abort();
    await expect(pending).rejects.toThrow('knowledge_epoch:aborted');
    expect(close).toHaveBeenCalledOnce();
  });

  it('uses an explicit sentinel for unscoped authority', async () => {
    const run = vi.fn().mockResolvedValue({ records: [{ get: () => '1' }] });
    await expect(
      bumpKnowledgeEpoch({ run }, { tenantId: 'default', projectScope: null }),
    ).resolves.toBe('1');
    expect(run.mock.calls[0]![1]).toEqual({
      epochTenantId: 'default',
      epochProjectScope: UNSCOPED_KNOWLEDGE_PROJECT,
    });
  });

  it('advances the exact project and tenant-wide unscoped lanes together', async () => {
    const run = vi.fn()
      .mockResolvedValueOnce({ records: [{ get: () => '7' }] })
      .mockResolvedValueOnce({ records: [{ get: () => '19' }] });
    await expect(
      bumpKnowledgeEpoch({ run }, { tenantId: 'tenant-a', projectScope: 'project:alpha' }),
    ).resolves.toBe('7');
    expect(run.mock.calls.map((call) => call[1])).toEqual([
      { epochTenantId: 'tenant-a', epochProjectScope: 'project:alpha' },
      { epochTenantId: 'tenant-a', epochProjectScope: UNSCOPED_KNOWLEDGE_PROJECT },
    ]);
  });

  it.each([
    { tenantId: '', projectScope: 'project:a' },
    { tenantId: 'tenant:*', projectScope: 'project:a' },
    { tenantId: 'tenant-a', projectScope: '*' },
    { tenantId: 'tenant-a', projectScope: 'project:*' },
    { tenantId: 'tenant-a', projectScope: 'not-project' },
  ])('rejects ambiguous or wildcard scope %#', async (scope) => {
    const run = vi.fn();
    await expect(bumpKnowledgeEpoch({ run }, scope)).rejects.toThrow('knowledge_epoch:');
    expect(run).not.toHaveBeenCalled();
  });

  it('rejects missing or malformed authority values', async () => {
    const run = vi.fn().mockResolvedValue({ records: [] });
    await expect(
      bumpKnowledgeEpoch({ run }, { tenantId: 'tenant-a', projectScope: 'project:a' }),
    ).rejects.toThrow('knowledge_epoch:invalid_authority_value');
  });
});
