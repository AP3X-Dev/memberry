import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createNeo4jDriver } from '../driver.js';
import { initSchema } from '../schema.js';
import { KnowledgeEpochStore, bumpKnowledgeEpoch } from '../knowledge-epoch.js';

const mode = process.env.MEMBERRY_PR02_LIVE;
if (mode !== undefined && mode !== 'required') {
  throw new Error('MEMBERRY_PR02_LIVE must be exactly "required" when set');
}
const liveDescribe = mode === 'required' ? describe : describe.skip;
const NEO4J_URI = process.env.NEO4J_URI || 'bolt://localhost:7687';
const NEO4J_USER = process.env.NEO4J_USER || 'neo4j';
const NEO4J_PASSWORD = process.env.NEO4J_PASSWORD || 'password';
const PREFIX = `epoch-live-${Date.now()}`;

liveDescribe('KnowledgeEpochStore live authority', () => {
  const driver = createNeo4jDriver(NEO4J_URI, NEO4J_USER, NEO4J_PASSWORD);
  const store = new KnowledgeEpochStore(driver);
  let available = false;

  beforeAll(async () => {
    if (!process.env.NEO4J_URI || !process.env.NEO4J_USER || !process.env.NEO4J_PASSWORD) {
      throw new Error('PR-02 required live mode needs NEO4J_URI, NEO4J_USER, and NEO4J_PASSWORD');
    }
    await driver.getServerInfo();
    await initSchema(driver);
    available = true;
  });

  afterAll(async () => {
    if (available) {
      const session = driver.session();
      try {
        await session.run('MATCH (n:KnowledgeEpoch) WHERE n.tenant_id STARTS WITH $prefix DELETE n', {
          prefix: PREFIX,
        });
        await session.run('MATCH (n:EpochRollbackProbe) WHERE n.id STARTS WITH $prefix DELETE n', {
          prefix: PREFIX,
        });
      } finally {
        await session.close();
      }
    }
    await driver.close().catch(() => {});
  });

  it('serializes simultaneous increments without a lost update', async () => {
    const scope = { tenantId: `${PREFIX}-tenant`, projectScope: 'project:alpha' };
    const results = await Promise.all(
      Array.from({ length: 2 }, async () => {
        const session = driver.session();
        try {
          return await session.executeWrite((tx) => bumpKnowledgeEpoch(tx, scope));
        } finally {
          await session.close();
        }
      }),
    );
    expect(new Set(results)).toEqual(new Set(['1', '2']));
    await expect(store.read(scope)).resolves.toEqual({ knowledgeEpoch: '2' });
    await expect(
      store.read({ tenantId: scope.tenantId, projectScope: null }),
    ).resolves.toEqual({ knowledgeEpoch: '2' });
  });

  it('rolls the mutation and epoch back together', async () => {
    const scope = { tenantId: `${PREFIX}-rollback`, projectScope: 'project:alpha' };
    const session = driver.session();
    try {
      await expect(
        session.executeWrite(async (tx) => {
          await tx.run('CREATE (:EpochRollbackProbe {id: $id})', { id: `${PREFIX}-probe` });
          await bumpKnowledgeEpoch(tx, scope);
          throw new Error('force-rollback');
        }),
      ).rejects.toThrow('force-rollback');
      const probe = await session.run(
        'MATCH (n:EpochRollbackProbe {id: $id}) RETURN count(n) AS count',
        { id: `${PREFIX}-probe` },
      );
      expect(Number(probe.records[0]!.get('count'))).toBe(0);
    } finally {
      await session.close();
    }
    await expect(store.read(scope)).resolves.toEqual({ knowledgeEpoch: '0' });
  });

  it('isolates tenant and project counters', async () => {
    const scopes = [
      { tenantId: `${PREFIX}-a`, projectScope: 'project:alpha' },
      { tenantId: `${PREFIX}-b`, projectScope: 'project:alpha' },
      { tenantId: `${PREFIX}-a`, projectScope: 'project:beta' },
      { tenantId: `${PREFIX}-a`, projectScope: null },
    ];
    for (const scope of scopes) {
      const session = driver.session();
      try {
        await session.executeWrite((tx) => bumpKnowledgeEpoch(tx, scope));
      } finally {
        await session.close();
      }
    }
    await expect(Promise.all(scopes.map((scope) => store.read(scope)))).resolves.toEqual([
      { knowledgeEpoch: '1' },
      { knowledgeEpoch: '1' },
      { knowledgeEpoch: '1' },
      { knowledgeEpoch: '3' },
    ]);
  });
});
