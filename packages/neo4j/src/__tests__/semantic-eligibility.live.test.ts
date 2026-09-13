// Explicit legacy vector fixtures below are unqualified historical compatibility evidence.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import neo4j, { type Driver } from 'neo4j-driver';
import { EMBEDDING_DIM } from '@memberry/core';
import { ScopedQuery } from '../query.js';
import { initSchema } from '../schema.js';

const mode = process.env.MEMBERRY_PR01_LIVE;
if (mode !== undefined && mode !== 'required') {
  throw new Error('MEMBERRY_PR01_LIVE must be exactly "required" when set');
}
const liveDescribe = mode === 'required' ? describe : describe.skip;

liveDescribe('PR-01 required live semantic eligibility', () => {
  let driver: Driver;
  const owner = `pr01-live-${Date.now()}-${process.pid}`;
  const tenant = `tenant-${owner}`;
  const foreignTenant = `foreign-${owner}`;
  const scope = `project:${owner}`;
  const foreignScope = `${scope}-foreign`;
  const tag = `tag-${owner}`;
  const entityId = `${owner}-entity`;
  const entityName = `entity-${owner}`;
  const neighborEntityId = `${owner}-neighbor-entity`;
  const neighborEntityName = `neighbor-${owner}`;
  const foreignPathEntityId = `${owner}-foreign-path-entity`;
  const foreignPathEntityName = `foreign-path-${owner}`;
  const v1 = `${owner}-v1`;
  const v2 = `${owner}-v2`;
  const crossScopeVictim = `${owner}-victim`;
  const crossScopeSuccessor = `${owner}-foreign-successor`;
  const foreignBridge = `${owner}-foreign-bridge`;
  const foreignPathOutput = `${owner}-foreign-path-output`;
  const queryVector = Object.assign(new Array<number>(EMBEDDING_DIM).fill(0), { 0: 1 });
  const currentVector = Object.assign(new Array<number>(EMBEDDING_DIM).fill(0), { 1: 1 });
  const blockerVector = Object.assign(new Array<number>(EMBEDDING_DIM).fill(0), {
    0: 0.999,
    1: 0.001,
  });
  const staleVector = Object.assign(new Array<number>(EMBEDDING_DIM).fill(0), {
    0: 0.5,
    1: 0.5,
  });

  beforeAll(async () => {
    const uri = process.env.NEO4J_URI;
    const user = process.env.NEO4J_USER;
    const password = process.env.NEO4J_PASSWORD;
    if (!uri || !user || !password) {
      throw new Error('PR-01 required live mode needs NEO4J_URI, NEO4J_USER, and NEO4J_PASSWORD');
    }
    driver = neo4j.driver(uri, neo4j.auth.basic(user, password));
    await driver.verifyConnectivity();
    await initSchema(driver);
    const session = driver.session(process.env.NEO4J_DATABASE
      ? { database: process.env.NEO4J_DATABASE }
      : undefined);
    try {
      await session.run('CALL db.awaitIndexes(60)');
      await session.run(
        `CREATE (entity:Entity {
           id: $entityId, name: $entityName, tenant_id: $tenant,
           project_scope: $scope, tags: [$scope], pr01_owner: $owner
         })
         CREATE (neighbor:Entity {
           id: $neighborEntityId, name: $neighborEntityName, tenant_id: $tenant,
           project_scope: $scope, tags: [$scope], pr01_owner: $owner
         })
         CREATE (foreignPathEntity:Entity {
           id: $foreignPathEntityId, name: $foreignPathEntityName, tenant_id: $tenant,
           project_scope: $scope, tags: [$scope], pr01_owner: $owner
         })
         CREATE (v1:Semantic {
           id: $v1, content: 'obsolete strongest', confidence: 0.99,
           signal_count: 1, created_at: $v1At, updated_at: $v1At,
           valid_at: $v1At, invalid_at: $v2At, decay_class: 'stable',
           tags: [$tag, $scope], scope: $scope, tenant_id: $tenant,
           embedding: $queryVector, pr01_owner: $owner
         })
         CREATE (v2:Semantic {
           id: $v2, content: 'current weaker vector', confidence: 0.9,
           signal_count: 1, created_at: $v2At, updated_at: $v2At,
           valid_at: $v2At, decay_class: 'stable', tags: [$tag, $scope],
           scope: $scope, tenant_id: $tenant, embedding: $currentVector,
           pr01_owner: $owner
         })
         CREATE (victim:Semantic {
           id: $victim, content: 'authorized victim', confidence: 0.3,
           signal_count: 1, created_at: $v1At, updated_at: $v1At,
           valid_at: $v1At, decay_class: 'stable', tags: [$tag, $scope],
           scope: $scope, tenant_id: $tenant, pr01_owner: $owner
         })
         CREATE (foreignSuccessor:Semantic {
           id: $foreignSuccessor, content: 'foreign successor', confidence: 1,
           signal_count: 1, created_at: $v2At, updated_at: $v2At,
           valid_at: $v2At, decay_class: 'stable', tags: [$tag, $foreignScope],
           scope: $foreignScope, tenant_id: $tenant, pr01_owner: $owner
         })
         CREATE (goodBridge:Semantic {
           id: $goodBridge, content: 'authorized graph bridge', confidence: 0.2,
           signal_count: 1, created_at: $v2At, updated_at: $v2At,
           valid_at: $v2At, decay_class: 'stable', tags: [$scope],
           scope: $scope, tenant_id: $tenant, pr01_owner: $owner
         })
         CREATE (foreignBridge:Semantic {
           id: $foreignBridge, content: 'foreign graph bridge', confidence: 0.2,
           signal_count: 1, created_at: $v2At, updated_at: $v2At,
           valid_at: $v2At, decay_class: 'stable', tags: [$scope],
           scope: $scope, tenant_id: $foreignTenant, pr01_owner: $owner
         })
         CREATE (foreignPathOutput:Semantic {
           id: $foreignPathOutput, content: 'must not cross foreign bridge', confidence: 0.25,
           signal_count: 1, created_at: $v2At, updated_at: $v2At,
           valid_at: $v2At, decay_class: 'stable', tags: [$scope],
           scope: $scope, tenant_id: $tenant, pr01_owner: $owner
         })
         CREATE (v1)-[:ABOUT {valid_at: $v1At, invalid_at: $v2At}]->(entity)
         CREATE (v2)-[:ABOUT {valid_at: $v2At}]->(entity)
         CREATE (v2)-[:ABOUT {valid_at: $v2At}]->(neighbor)
         CREATE (goodBridge)-[:ABOUT {valid_at: $v2At}]->(entity)
         CREATE (goodBridge)-[:ABOUT {valid_at: $v2At}]->(neighbor)
         CREATE (foreignBridge)-[:ABOUT {valid_at: $v2At}]->(entity)
         CREATE (foreignBridge)-[:ABOUT {valid_at: $v2At}]->(foreignPathEntity)
         CREATE (foreignPathOutput)-[:ABOUT {valid_at: $v2At}]->(foreignPathEntity)
         CREATE (v2)-[:SUPERSEDES]->(v1)
         CREATE (foreignSuccessor)-[:SUPERSEDES]->(victim)`,
        {
          owner,
          tenant,
          foreignTenant,
          scope,
          foreignScope,
          tag,
          entityId,
          entityName,
          neighborEntityId,
          neighborEntityName,
          foreignPathEntityId,
          foreignPathEntityName,
          v1,
          v2,
          victim: crossScopeVictim,
          foreignSuccessor: crossScopeSuccessor,
          goodBridge: `${owner}-good-bridge`,
          foreignBridge,
          foreignPathOutput,
          queryVector,
          currentVector,
          v1At: '2025-01-01T00:00:00.000Z',
          v2At: '2026-01-01T00:00:00.000Z',
        },
      );
      await session.run(
        `UNWIND range(0, 7) AS ordinal
         CREATE (:Semantic {
           id: $owner + '-blocker-' + toString(ordinal), content: 'ineligible vector blocker',
           confidence: 0.1, signal_count: 0, created_at: $v1At, updated_at: $v1At,
           valid_at: $v1At, invalid_at: $v2At, decay_class: 'stable', tags: [$scope],
           scope: $scope, tenant_id: $tenant, embedding: $blockerVector,
           pr01_owner: $owner
         })`,
        {
          owner,
          tenant,
          scope,
          blockerVector,
          v1At: '2025-01-01T00:00:00.000Z',
          v2At: '2026-01-01T00:00:00.000Z',
        },
      );
      await session.run(
        `UNWIND range(0, 1000) AS ordinal
         CREATE (:Semantic {
           id: $owner + '-stale-' + toString(ordinal), content: 'stale active distractor',
           confidence: 0.05, signal_count: 0, created_at: $v1At, updated_at: $v1At,
           valid_at: $v1At, decay_class: 'stable', tags: [$scope], scope: $scope,
           tenant_id: $tenant, embedding: $staleVector, pr01_owner: $owner
         })`,
        {
          owner,
          tenant,
          scope,
          staleVector,
          v1At: '2025-01-01T00:00:00.000Z',
        },
      );
    } finally {
      await session.close();
    }
  }, 120_000);

  afterAll(async () => {
    if (!driver) return;
    const session = driver.session(process.env.NEO4J_DATABASE
      ? { database: process.env.NEO4J_DATABASE }
      : undefined);
    try {
      await session.run('MATCH (node {pr01_owner: $owner}) DETACH DELETE node', { owner });
    } finally {
      await session.close();
      await driver.close();
    }
  }, 60_000);

  it('uses the real vector index while the overflow fallback returns only the active successor', async () => {
    const session = driver.session();
    try {
      const indexed = await session.run(
        `CALL db.index.vector.queryNodes('semantic_embedding', 1, $embedding)
         YIELD node, score
         RETURN node.id AS id, score`,
        { embedding: queryVector },
      );
      expect(indexed.records[0]?.get('id')).toBe(v1);
    } finally {
      await session.close();
    }

    const result = await new ScopedQuery(driver, { legacyUnqualified: true }).byVector(queryVector, 1, tenant, scope);
    expect(result).toEqual([expect.objectContaining({ id: v2, score: 0 })]);
  });

  it('applies one eligibility predicate to tag, entity, scoped-name, and stable-ID paths', async () => {
    const query = new ScopedQuery(driver, { legacyUnqualified: true });
    const paths = await Promise.all([
      query.byTag(tag, 20, tenant),
      query.byEntity(entityName, 20, undefined, tenant, scope),
      query.byScope({
        entities: [entityName], tags: [tag], limit: 20, tenantId: tenant, projectScope: scope,
      }),
      query.byScope({
        entityIds: [entityId], tags: [tag], limit: 20, tenantId: tenant, projectScope: scope,
      }),
      query.byEntityWithFacts(entityName, undefined, tenant, scope).then((result) => result.semantics),
    ]);
    for (const nodes of paths) {
      expect(nodes.map((node) => node.id)).toContain(v2);
      expect(nodes.map((node) => node.id)).not.toContain(v1);
    }
  });

  it('preserves history and ignores cross-scope suppression', async () => {
    const query = new ScopedQuery(driver, { legacyUnqualified: true });
    const current = await query.byTag(tag, 20, tenant);
    expect(current.map((node) => node.id)).toContain(crossScopeVictim);
    const historical = await query.byEntity(
      entityName, 20, '2025-06-01T00:00:00.000Z', tenant, scope,
    );
    expect(historical.map((node) => node.id)).toContain(v1);
    expect(historical.map((node) => node.id)).not.toContain(v2);
  });

  it('rejects an authorized output reached only through a foreign bridge', async () => {
    const expanded = await new ScopedQuery(driver, { legacyUnqualified: true }).expandByGraph(
      [entityName], 1, 20, undefined, tenant, scope,
    );
    expect(expanded.map((node) => node.id)).toContain(v2);
    expect(expanded.map((node) => node.id)).not.toContain(foreignPathOutput);
  });

  it('terminal evaluator agrees with the candidate paths on the same fixture', async () => {
    await expect(new ScopedQuery(driver, { legacyUnqualified: true }).evaluateActiveEligibility({
      semanticIds: [v1, v2, crossScopeVictim, crossScopeSuccessor, `${owner}-missing`],
      tenantId: tenant,
      projectScope: scope,
    })).resolves.toEqual([
      { id: v1, status: 'ineligible' },
      { id: v2, status: 'eligible' },
      { id: crossScopeVictim, status: 'eligible' },
      { id: crossScopeSuccessor, status: 'unknown' },
      { id: `${owner}-missing`, status: 'unknown' },
    ]);
  });

  it('never resurrects an unclosed legacy predecessor when its successor expires or is archived', async () => {
    const ids = ['legacy-first', 'legacy-second', 'legacy-third'].map(suffix => `${owner}-${suffix}`);
    const legacyTag = `${tag}-chain`;
    const session = driver.session();
    try {
      await session.run(`UNWIND $nodes AS props CREATE (n:Semantic) SET n = props`, {
        nodes: ids.map((id, index) => ({ id, content: id, confidence: 0.1, signal_count: 1,
          created_at: `2026-0${index + 1}-01T00:00:00.000Z`, updated_at: '2026-03-01T00:00:00.000Z',
          valid_at: `2026-0${index + 1}-01T00:00:00.000Z`,
          ...(index === 1 ? { invalid_at: '2026-03-01T00:00:00.000Z' } : {}),
          decay_class: 'stable', tenant_id: tenant, scope, tags: [scope, legacyTag], pr01_owner: owner,
        })),
      });
      await session.run(`MATCH (a:Semantic {id: $a}), (b:Semantic {id: $b}), (c:Semantic {id: $c})
        CREATE (b)-[:SUPERSEDES]->(a) CREATE (c)-[:SUPERSEDES]->(b)`, { a: ids[0], b: ids[1], c: ids[2] });
      const query = new ScopedQuery(driver, { legacyUnqualified: true });
      expect((await query.byTag(legacyTag, 10, tenant)).map(n => n.id)).toEqual([ids[2]]);
      await expect(query.evaluateActiveEligibility({ semanticIds: ids, tenantId: tenant, projectScope: scope,
        asOf: '2026-01-15T00:00:00.000Z' })).resolves.toEqual([
        { id: ids[0], status: 'eligible' }, { id: ids[1], status: 'ineligible' }, { id: ids[2], status: 'ineligible' },
      ]);
      await session.run('MATCH (s:Semantic {id: $id}) SET s.archived = true', { id: ids[1] });
      expect((await query.byTag(legacyTag, 10, tenant)).map(n => n.id)).toEqual([ids[2]]);
      await expect(query.evaluateActiveEligibility({ semanticIds: ids, tenantId: tenant, projectScope: scope,
        asOf: '2026-03-01T00:00:00.000Z' })).resolves.toEqual([
        { id: ids[0], status: 'ineligible' }, { id: ids[1], status: 'ineligible' }, { id: ids[2], status: 'eligible' },
      ]);
    } finally { await session.close(); }
  });

  it('fails closed on unknown successor cutoffs and malformed timestamps and uses exact temporal instants', async () => {
    const malformed = `${owner}-malformed-time`, unknownOld = `${owner}-unknown-old`, unknownNew = `${owner}-unknown-new`;
    const boundary = `${owner}-equivalent-boundary`;
    const session = driver.session();
    try {
      await session.run(`UNWIND $nodes AS props CREATE (n:Semantic) SET n = props`, {
        nodes: [
          { id: malformed, valid_at: '0000-not-a-timestamp' },
          { id: unknownOld, valid_at: '2025-01-01T00:00:00.000Z' },
          { id: unknownNew },
          { id: boundary, valid_at: '2025-01-01T00:00:00Z', invalid_at: '2026-01-01T00:00:00Z' },
        ].map(props => ({ ...props, tenant_id: tenant, scope, tags: [scope], pr01_owner: owner })),
      });
      await session.run(`MATCH (old:Semantic {id: $old}), (new:Semantic {id: $new}) CREATE (new)-[:SUPERSEDES]->(old)`,
        { old: unknownOld, new: unknownNew });
      await expect(new ScopedQuery(driver, { legacyUnqualified: true }).evaluateActiveEligibility({
        semanticIds: [malformed, unknownOld, unknownNew, boundary], tenantId: tenant, projectScope: scope,
        asOf: '2026-01-01T00:00:00.000Z',
      })).resolves.toEqual([malformed, unknownOld, unknownNew, boundary].map(id => ({ id, status: 'ineligible' })));
    } finally { await session.close(); }
  });
});
