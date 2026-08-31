import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EMBEDDING_DIM } from '@memberry/core';
import { createNeo4jDriver } from '@memberry/neo4j';
import { resolveRuntimeQueryPlannerAuthorityV1 } from '../runtime-query-planner.js';
import {
  EPISODIC_STRUCTURED_INDEX_FLAG,
  RuntimeCandidateChannelService,
  type RuntimeCandidateDriver,
} from '../runtime-candidate-channel.js';

const integrationUri = process.env.MEMBERRY_NEO4J_INTEGRATION === '1'
  ? process.env.NEO4J_URI
  : undefined;
const uri = process.env.MEMBERRY_IDX001B_READER_LIVE_NEO4J_URI ?? integrationUri;
const user = process.env.MEMBERRY_IDX001B_READER_LIVE_NEO4J_USER ?? 'neo4j';
const password = process.env.MEMBERRY_IDX001B_READER_LIVE_NEO4J_PASSWORD
  ?? (integrationUri ? process.env.NEO4J_PASSWORD : undefined)
  ?? '';
const describeLive = uri && password ? describe : describe.skip;

describeLive('IDX-001B-D graph-derived candidate reader live Neo4j gate', () => {
  const driver = createNeo4jDriver(uri ?? 'bolt://127.0.0.1:7687', user, password);
  const owner = `idx001bd-reader-${randomUUID().replace(/-/g, '')}`;
  const tenant = `${owner}-tenant`;
  const projectName = `${owner}-project`;
  const projectScope = `project:${projectName}`;
  const targetId = `${owner}-target`;
  const bridgeId = `${owner}-bridge`;
  const seedId = `${owner}-seed`;
  const neighborId = `${owner}-neighbor`;
  const seedFactId = `${owner}-seed-fact`;
  const neighborFactId = `${owner}-neighbor-fact`;
  const originalFlag = process.env[EPISODIC_STRUCTURED_INDEX_FLAG];
  const vector = [1, ...new Array(EMBEDDING_DIM - 1).fill(0)];

  beforeAll(async () => {
    process.env[EPISODIC_STRUCTURED_INDEX_FLAG] = '1';
    const session = driver.session();
    try {
      await session.run(
        `CREATE (project:Entity {
           id: $projectId, name: $projectName, type: 'project', tenant_id: $tenant, idx001bd_owner: $owner
         })
         CREATE (target:Entity {
           id: $targetId, name: $targetName, type: 'module', aliases: [$targetName],
           tenant_id: $tenant, idx001bd_owner: $owner
         })
         CREATE (bridge:Entity {
           id: $bridgeId, name: 'Bridge', type: 'module', tenant_id: $tenant, idx001bd_owner: $owner
         })
         CREATE (project)-[:CONTAINS]->(target)
         CREATE (project)-[:CONTAINS]->(bridge)
         CREATE (seed:Episodic {
           id: $seedId, content: 'authorized seed', memory_type: 'decision', embedding: $vector,
           tenant_id: $tenant, scope: $projectScope, archived: false, idx001bd_owner: $owner
         })
         CREATE (neighbor:Episodic {
           id: $neighborId, content: 'graph-derived neighbor', memory_type: 'decision', embedding: $vector,
           tenant_id: $tenant, scope: $projectScope, archived: false, idx001bd_owner: $owner
         })
         CREATE (seed)-[:REFERENCES {valid_at: '2026-01-01T00:00:00.000Z'}]->(target)
         CREATE (seedFact:Fact {
           id: $seedFactId, entity_id: $bridgeId, tenant_id: $tenant, status: 'active',
           valid_at: '2026-01-01T00:00:00.000Z', idx001bd_owner: $owner
         })
         CREATE (neighborFact:Fact {
           id: $neighborFactId, entity_id: $bridgeId, tenant_id: $tenant, status: 'active',
           valid_at: '2026-01-01T00:00:00.000Z', idx001bd_owner: $owner
         })
         CREATE (seedFact)-[:SOURCED_FROM]->(seed)
         CREATE (neighborFact)-[:SOURCED_FROM]->(neighbor)
         CREATE (seedFact)-[:FACT_ABOUT {valid_at: '2026-01-01T00:00:00.000Z'}]->(bridge)
         CREATE (neighborFact)-[:FACT_ABOUT {valid_at: '2026-01-01T00:00:00.000Z'}]->(bridge)
         CREATE (seedKey:EpisodicIndexKey {
           id: $seedKeyId, episode_id: $seedId, entity_id: $bridgeId, source_fact_id: $seedFactId,
           derivation: 'graph-v1', schema_version: 1, source: 'backfill', tenant_id: $tenant,
           project_scope: $projectScope, idx001bd_owner: $owner
         })
         CREATE (neighborKey:EpisodicIndexKey {
           id: $neighborKeyId, episode_id: $neighborId, entity_id: $bridgeId,
           source_fact_id: $neighborFactId, derivation: 'graph-v1', schema_version: 1,
           source: 'backfill', tenant_id: $tenant, project_scope: $projectScope, idx001bd_owner: $owner
         })
         CREATE (seed)-[:HAS_INDEX_KEY]->(seedKey)
         CREATE (neighbor)-[:HAS_INDEX_KEY]->(neighborKey)`,
        {
          owner, tenant, projectId: `${owner}-project-root`, projectName, projectScope,
          targetId, targetName: `${owner}-target-name`, bridgeId, seedId, neighborId,
          seedFactId, neighborFactId, seedKeyId: `${owner}-seed-key`,
          neighborKeyId: `${owner}-neighbor-key`, vector,
        },
      );
    } finally {
      await session.close();
    }
  });

  afterAll(async () => {
    const session = driver.session();
    try {
      await session.run('MATCH (n {idx001bd_owner: $owner}) DETACH DELETE n', { owner });
    } finally {
      await session.close();
      await driver.close();
      if (originalFlag === undefined) delete process.env[EPISODIC_STRUCTURED_INDEX_FLAG];
      else process.env[EPISODIC_STRUCTURED_INDEX_FLAG] = originalFlag;
    }
  });

  async function execute() {
    const receipt = await resolveRuntimeQueryPlannerAuthorityV1({
      authenticated: true,
      plannerEnabled: true,
      tenantId: tenant,
      projectName: projectScope,
      entityScope: [targetId],
      resolverFactory: () => ({
        resolve: async () => ({
          resolution: { state: 'resolved', canonicalEntityIds: [targetId] },
          diagnostics: [],
        }),
      }),
    });
    return new RuntimeCandidateChannelService(driver as unknown as RuntimeCandidateDriver).execute(receipt, {
      includeArchitecture: false,
      includeMemory: true,
      queryText: 'graph neighbor',
      queryVector: vector,
    });
  }

  it('executes the reader query and rechecks active source-Fact provenance', async () => {
    const active = await execute();
    const activeEpisodic = active.candidates
      .filter(({ channel }) => channel === 'memory.episodic-vector')
      .map(({ evidenceId }) => evidenceId);
    expect(activeEpisodic).toContain(seedId);
    expect(activeEpisodic).toContain(neighborId);

    const session = driver.session();
    try {
      await session.run(
        `MATCH (fact:Fact {id: $neighborFactId, tenant_id: $tenant})
         SET fact.status = 'invalidated', fact.invalid_at = '2026-08-30T00:00:00.000Z'`,
        { neighborFactId, tenant },
      );
    } finally {
      await session.close();
    }

    const invalidated = await execute();
    const invalidatedEpisodic = invalidated.candidates
      .filter(({ channel }) => channel === 'memory.episodic-vector')
      .map(({ evidenceId }) => evidenceId);
    expect(invalidatedEpisodic).toContain(seedId);
    expect(invalidatedEpisodic).not.toContain(neighborId);
  }, 20_000);
});
