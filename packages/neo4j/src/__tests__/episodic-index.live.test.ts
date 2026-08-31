import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildGraphBackfillIndexKeysV1 } from '@memberry/core';
import { createNeo4jDriver } from '../driver.js';
import { EpisodicIndexStore } from '../episodic-index.js';

const integrationUri = process.env.MEMBERRY_NEO4J_INTEGRATION === '1'
  ? process.env.NEO4J_URI
  : undefined;
const uri = process.env.MEMBERRY_IDX001B_LIVE_NEO4J_URI ?? integrationUri;
const user = process.env.MEMBERRY_IDX001B_LIVE_NEO4J_USER ?? 'neo4j';
const password = process.env.MEMBERRY_IDX001B_LIVE_NEO4J_PASSWORD
  ?? (integrationUri ? process.env.NEO4J_PASSWORD : undefined)
  ?? '';
const describeLive = uri && password ? describe : describe.skip;

describeLive('IDX-001B-D deterministic graph backfill live Neo4j gate', () => {
  const driver = createNeo4jDriver(uri ?? 'bolt://127.0.0.1:7687', user, password);
  const store = new EpisodicIndexStore(driver);
  const prefix = `idx001bd-${process.pid}`;
  const tenant = `${prefix}-tenant-a`;
  const foreignTenant = `${prefix}-tenant-b`;
  const scope = `project:${prefix}`;
  const goodEpisode = `${prefix}-ep-good`;
  const emptyEpisode = `${prefix}-ep-empty`;

  beforeAll(async () => {
    const session = driver.session();
    try {
      await session.run(
        `CREATE (good:Episodic {
           id: $goodEpisode, tenant_id: $tenant, scope: $scope,
           content: 'graph-backed episode', created_at: '2026-08-30T00:00:00.000Z'
         })
         CREATE (empty:Episodic {
           id: $emptyEpisode, tenant_id: $tenant, scope: $scope,
           content: 'episode without valid facts', created_at: '2026-08-30T00:00:01.000Z'
         })
         CREATE (entity:Entity {id: $entityId, name: 'Gale'})
         CREATE (invalidEntity:Entity {id: $invalidEntityId, name: 'Invalid'})
         CREATE (inactiveEntity:Entity {id: $inactiveEntityId, name: 'Inactive edge'})
         CREATE (winner:Fact {
           id: $winnerId, tenant_id: $tenant, entity_id: $entityId,
           subject: 'Gale', predicate: 'uses', object: 'Nimbus', status: 'active',
           confidence: 0.9, valid_at: '2026-08-29T00:00:00.000Z'
         })
         CREATE (lower:Fact {
           id: $lowerId, tenant_id: $tenant, entity_id: $entityId,
           subject: 'Gale', predicate: 'uses', object: 'Legacy', status: 'tentative',
           confidence: 1.0, valid_at: '2026-08-30T00:00:00.000Z'
         })
         CREATE (invalid:Fact {
           id: $invalidId, tenant_id: $tenant, entity_id: $invalidEntityId,
           subject: 'Invalid', predicate: 'uses', object: 'Secret', status: 'invalidated',
           confidence: 1.0, valid_at: '2026-08-30T00:00:00.000Z'
         })
         CREATE (foreign:Fact {
           id: $foreignId, tenant_id: $foreignTenant, entity_id: $invalidEntityId,
           subject: 'Foreign', predicate: 'uses', object: 'Secret', status: 'active',
           confidence: 1.0, valid_at: '2026-08-30T00:00:00.000Z'
         })
         CREATE (inactive:Fact {
           id: $inactiveId, tenant_id: $tenant, entity_id: $inactiveEntityId,
           subject: 'Inactive', predicate: 'uses', object: 'Secret', status: 'active',
           confidence: 1.0, valid_at: '2026-08-30T00:00:00.000Z'
         })
         CREATE (winner)-[:SOURCED_FROM]->(good)
         CREATE (lower)-[:SOURCED_FROM]->(good)
         CREATE (invalid)-[:SOURCED_FROM]->(good)
         CREATE (foreign)-[:SOURCED_FROM]->(good)
         CREATE (inactive)-[:SOURCED_FROM]->(good)
         CREATE (winner)-[:FACT_ABOUT {invalid_at: null}]->(entity)
         CREATE (lower)-[:FACT_ABOUT {invalid_at: null}]->(entity)
         CREATE (invalid)-[:FACT_ABOUT {invalid_at: null}]->(invalidEntity)
         CREATE (foreign)-[:FACT_ABOUT {invalid_at: null}]->(invalidEntity)
         CREATE (inactive)-[:FACT_ABOUT {invalid_at: '2026-08-30T01:00:00.000Z'}]->(inactiveEntity)`,
        {
          goodEpisode, emptyEpisode, tenant, foreignTenant, scope,
          entityId: `${prefix}-entity`, invalidEntityId: `${prefix}-invalid-entity`,
          inactiveEntityId: `${prefix}-inactive-entity`, winnerId: `${prefix}-winner`,
          lowerId: `${prefix}-lower`, invalidId: `${prefix}-invalid`,
          foreignId: `${prefix}-foreign`, inactiveId: `${prefix}-inactive`,
        },
      );
    } finally {
      await session.close();
    }
  });

  afterAll(async () => {
    const session = driver.session();
    try {
      await session.run('MATCH (n) WHERE n.id STARTS WITH $prefix DETACH DELETE n', { prefix });
    } finally {
      await session.close();
      await driver.close();
    }
  });

  it('selects, writes, resumes, and rolls back only authorized derived nodes', async () => {
    const batch = await store.nextGraphBackfillBatch({ tenantId: tenant, projectScope: scope, limit: 10 });
    expect(batch.map(({ id }) => id)).toEqual([goodEpisode, emptyEpisode]);
    expect(batch[0]!.facts).toEqual([{
      source_fact_id: `${prefix}-winner`, entity_id: `${prefix}-entity`,
      subject: 'Gale', predicate: 'uses', object: 'Nimbus',
    }]);
    expect(batch[1]!.facts).toEqual([]);

    const keys = buildGraphBackfillIndexKeysV1({
      episodeId: goodEpisode, facts: batch[0]!.facts, tenantId: tenant,
      projectScope: scope, createdAt: '2026-08-30T02:00:00.000Z',
    });
    await store.replaceBackfillKeys(batch[0]!, keys);
    await store.markBackfillEmpty(batch[1]!, 'graph-v1');
    await expect(store.nextGraphBackfillBatch({ tenantId: tenant, projectScope: scope, limit: 10 }))
      .resolves.toEqual([]);

    const session = driver.session();
    try {
      const stored = await session.run(
        `MATCH (ep:Episodic {id: $goodEpisode})-[:HAS_INDEX_KEY]->(key:EpisodicIndexKey)
         RETURN key.entity_id AS entityId, key.source_fact_id AS factId,
                key.derivation AS derivation, key.embedding AS embedding`,
        { goodEpisode },
      );
      expect(stored.records).toHaveLength(1);
      expect(stored.records[0]!.get('entityId')).toBe(`${prefix}-entity`);
      expect(stored.records[0]!.get('factId')).toBe(`${prefix}-winner`);
      expect(stored.records[0]!.get('derivation')).toBe('graph-v1');
      expect(stored.records[0]!.get('embedding')).toBeNull();
    } finally {
      await session.close();
    }

    await expect(store.deleteDerived({ tenantId: tenant, projectScope: scope })).resolves.toBe(2);
    const verify = driver.session();
    try {
      const result = await verify.run(
        `MATCH (ep:Episodic) WHERE ep.id IN [$goodEpisode, $emptyEpisode]
         WITH count(ep) AS episodes
         MATCH (fact:Fact) WHERE fact.id STARTS WITH $prefix
         RETURN episodes, count(fact) AS facts`,
        { goodEpisode, emptyEpisode, prefix },
      );
      expect(Number(result.records[0]!.get('episodes'))).toBe(2);
      expect(Number(result.records[0]!.get('facts'))).toBe(5);
    } finally {
      await verify.close();
    }
  }, 20_000);
});
