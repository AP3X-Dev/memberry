import neo4j, { type Driver } from 'neo4j-driver';
import {
  STRUCTURED_INDEX_GRAPH_DERIVATION,
  STRUCTURED_INDEX_GRAPH_MAX_FACTS,
  type EpisodeGraphBackfillFactV1,
  type EpisodeIndexKeyNodeV1,
} from '@memberry/core';

export interface EpisodicIndexCursorV1 { createdAt: string; id: string }
export interface EpisodicIndexBackfillEpisodeV1 extends EpisodicIndexCursorV1 {
  content: string;
  tenantId: string;
  projectScope: string;
}

export interface EpisodicIndexGraphBackfillEpisodeV1 extends EpisodicIndexBackfillEpisodeV1 {
  facts: EpisodeGraphBackfillFactV1[];
}

export class EpisodicIndexStore {
  constructor(private readonly driver: Driver) {}

  async nextBackfillBatch(input: {
    tenantId: string;
    projectScope: string;
    limit: number;
    after?: EpisodicIndexCursorV1;
  }): Promise<EpisodicIndexBackfillEpisodeV1[]> {
    if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 100) {
      throw new Error('structured_index_backfill:invalid_limit');
    }
    const session = this.driver.session({ defaultAccessMode: 'READ' });
    try {
      const result = await session.run(
        `MATCH (ep:Episodic)
         WHERE ep.tenant_id = $tenantId
           AND ep.scope = $projectScope
           AND coalesce(ep.archived, false) = false
           AND coalesce(ep.content, '') <> ''
           AND ($afterCreatedAt IS NULL OR ep.created_at > $afterCreatedAt
             OR (ep.created_at = $afterCreatedAt AND ep.id > $afterId))
           AND NOT EXISTS { (ep)-[:HAS_INDEX_KEY]->(:EpisodicIndexKey {schema_version: 1}) }
           AND NOT EXISTS { (ep)-[:HAS_INDEX_OUTCOME]->(:EpisodicIndexOutcome {schema_version: 1}) }
         RETURN ep.id AS id, ep.created_at AS createdAt, ep.content AS content
         ORDER BY ep.created_at ASC, ep.id ASC
         LIMIT $limit`,
        {
          tenantId: input.tenantId,
          projectScope: input.projectScope,
          afterCreatedAt: input.after?.createdAt ?? null,
          afterId: input.after?.id ?? '',
          limit: neo4j.int(input.limit),
        },
      );
      return result.records.map((record) => ({
        id: record.get('id') as string,
        createdAt: record.get('createdAt') as string,
        content: record.get('content') as string,
        tenantId: input.tenantId,
        projectScope: input.projectScope,
      }));
    } finally {
      await session.close();
    }
  }

  /**
   * Select a bounded historical episode batch plus one current same-tenant Fact
   * per canonical Entity. Fact.scope is deliberately ignored: legacy rows only
   * contain the coarse literal "project", so project authority comes from the
   * owning Episodic node and is repeated on every derived key.
   */
  async nextGraphBackfillBatch(input: {
    tenantId: string;
    projectScope: string;
    limit: number;
    after?: EpisodicIndexCursorV1;
  }): Promise<EpisodicIndexGraphBackfillEpisodeV1[]> {
    if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 100) {
      throw new Error('structured_index_graph_backfill:invalid_limit');
    }
    const session = this.driver.session({ defaultAccessMode: 'READ' });
    try {
      const result = await session.run(
        `MATCH (ep:Episodic)
         WHERE ep.tenant_id = $tenantId
           AND ep.scope = $projectScope
           AND coalesce(ep.archived, false) = false
           AND coalesce(ep.content, '') <> ''
           AND ($afterCreatedAt IS NULL OR ep.created_at > $afterCreatedAt
             OR (ep.created_at = $afterCreatedAt AND ep.id > $afterId))
           AND NOT EXISTS {
             (ep)-[:HAS_INDEX_KEY]->(:EpisodicIndexKey {schema_version: 1, source: 'agent'})
           }
           AND NOT EXISTS {
             (ep)-[:HAS_INDEX_KEY]->(:EpisodicIndexKey {
               schema_version: 1, source: 'backfill', derivation: $derivation
             })
           }
           AND NOT EXISTS {
             (ep)-[:HAS_INDEX_OUTCOME]->(:EpisodicIndexOutcome {
               schema_version: 1, source: 'backfill', derivation: $derivation
             })
           }
         WITH ep
         OPTIONAL MATCH (fact:Fact)-[:SOURCED_FROM]->(ep)
         WHERE fact.tenant_id = $tenantId
           AND fact.status <> 'invalidated'
         OPTIONAL MATCH (fact)-[about:FACT_ABOUT]->(entity:Entity)
         WHERE about.invalid_at IS NULL
           AND fact.entity_id = entity.id
         WITH ep, entity, fact
         ORDER BY CASE fact.status
             WHEN 'active' THEN 0 WHEN 'disputed' THEN 1 WHEN 'tentative' THEN 2 ELSE 3 END,
           coalesce(fact.confidence, 0.0) DESC,
           coalesce(fact.valid_at, '') DESC,
           fact.id ASC
         WITH ep, entity, head(collect(fact)) AS fact
         ORDER BY CASE fact.status
             WHEN 'active' THEN 0 WHEN 'disputed' THEN 1 WHEN 'tentative' THEN 2 ELSE 3 END,
           coalesce(fact.confidence, 0.0) DESC,
           coalesce(fact.valid_at, '') DESC,
           entity.id ASC,
           fact.id ASC
         WITH ep, [row IN collect(CASE WHEN fact IS NULL OR entity IS NULL THEN null ELSE {
           source_fact_id: fact.id, entity_id: entity.id,
           subject: fact.subject, predicate: fact.predicate, object: fact.object
         } END) WHERE row IS NOT NULL][0..$factLimit] AS facts
         RETURN ep.id AS id, ep.created_at AS createdAt, ep.content AS content, facts
         ORDER BY ep.created_at ASC, ep.id ASC
         LIMIT $limit`,
        {
          tenantId: input.tenantId,
          projectScope: input.projectScope,
          afterCreatedAt: input.after?.createdAt ?? null,
          afterId: input.after?.id ?? '',
          derivation: STRUCTURED_INDEX_GRAPH_DERIVATION,
          factLimit: neo4j.int(STRUCTURED_INDEX_GRAPH_MAX_FACTS),
          limit: neo4j.int(input.limit),
        },
      );
      return result.records.map((record) => ({
        id: record.get('id') as string,
        createdAt: record.get('createdAt') as string,
        content: record.get('content') as string,
        facts: record.get('facts') as EpisodeGraphBackfillFactV1[],
        tenantId: input.tenantId,
        projectScope: input.projectScope,
      }));
    } finally {
      await session.close();
    }
  }

  async markBackfillEmpty(
    episode: EpisodicIndexBackfillEpisodeV1,
    derivation: 'model-v1' | typeof STRUCTURED_INDEX_GRAPH_DERIVATION = 'model-v1',
  ): Promise<void> {
    const session = this.driver.session();
    try {
      await session.executeWrite(async (tx) => {
        const owner = await tx.run(
          `MATCH (ep:Episodic {id: $episodeId, tenant_id: $tenantId, scope: $projectScope})
           RETURN count(ep) AS count`,
          { episodeId: episode.id, tenantId: episode.tenantId, projectScope: episode.projectScope },
        );
        if (Number(owner.records[0]?.get('count') ?? 0) !== 1) {
          throw new Error('structured_index_backfill:episode_not_owned');
        }
        const outcome = await tx.run(
          `MATCH (ep:Episodic {id: $episodeId})
           MERGE (outcome:EpisodicIndexOutcome {id: $outcomeId})
           ON CREATE SET outcome.episode_id = $episodeId,
                         outcome.outcome = 'empty',
                         outcome.schema_version = 1,
                         outcome.source = 'backfill',
                         outcome.tenant_id = $tenantId,
                         outcome.project_scope = $projectScope,
                         outcome.derivation = $derivation,
                         outcome.created_at = $createdAt
           WITH ep, outcome
           WHERE outcome.episode_id = $episodeId
             AND outcome.schema_version = 1
             AND outcome.source = 'backfill'
             AND outcome.tenant_id = $tenantId
             AND outcome.project_scope = $projectScope
             AND outcome.derivation = $derivation
           MERGE (ep)-[:HAS_INDEX_OUTCOME]->(outcome)
           RETURN count(outcome) AS count`,
          {
            episodeId: episode.id,
            outcomeId: derivation === STRUCTURED_INDEX_GRAPH_DERIVATION
              ? `eio1:${episode.id}:${STRUCTURED_INDEX_GRAPH_DERIVATION}:empty`
              : `eio1:${episode.id}:empty`,
            tenantId: episode.tenantId,
            projectScope: episode.projectScope,
            derivation,
            createdAt: new Date().toISOString(),
          },
        );
        if (Number(outcome.records[0]?.get('count') ?? 0) !== 1) {
          throw new Error('structured_index_backfill:outcome_authority_mismatch');
        }
      });
    } finally {
      await session.close();
    }
  }

  async replaceBackfillKeys(
    episode: EpisodicIndexBackfillEpisodeV1,
    keys: readonly EpisodeIndexKeyNodeV1[],
  ): Promise<void> {
    if (keys.some((key) => key.episode_id !== episode.id || key.tenant_id !== episode.tenantId
      || key.project_scope !== episode.projectScope || key.source !== 'backfill')) {
      throw new Error('structured_index_backfill:key_authority_mismatch');
    }
    const session = this.driver.session();
    try {
      await session.executeWrite(async (tx) => {
        const owner = await tx.run(
          `MATCH (ep:Episodic {id: $episodeId, tenant_id: $tenantId, scope: $projectScope})
           RETURN count(ep) AS count`,
          { episodeId: episode.id, tenantId: episode.tenantId, projectScope: episode.projectScope },
        );
        const count = Number(owner.records[0]?.get('count') ?? 0);
        if (count !== 1) throw new Error('structured_index_backfill:episode_not_owned');
        await tx.run(
          `MATCH (:Episodic {id: $episodeId})-[:HAS_INDEX_KEY]->(old:EpisodicIndexKey {source: 'backfill'})
           DETACH DELETE old`,
          { episodeId: episode.id },
        );
        if (keys.length > 0) {
          await tx.run(
            `UNWIND $keys AS key
             MATCH (ep:Episodic {id: $episodeId})
             CREATE (k:EpisodicIndexKey {
               id: key.id, episode_id: key.episode_id, kind: key.kind,
               value: key.value, entity_id: key.entity_id, embedding: key.embedding,
               source_fact_id: key.source_fact_id, derivation: key.derivation,
               schema_version: key.schema_version, source: key.source,
               source_hash: key.source_hash, tenant_id: key.tenant_id,
               project_scope: key.project_scope, created_at: key.created_at
             })
             MERGE (ep)-[:HAS_INDEX_KEY]->(k)`,
            { episodeId: episode.id, keys },
          );
        }
      });
    } finally {
      await session.close();
    }
  }

  async deleteDerived(input: { tenantId: string; projectScope: string }): Promise<number> {
    const session = this.driver.session();
    try {
      return await session.executeWrite(async (tx) => {
        const result = await tx.run(
          `OPTIONAL MATCH (key:EpisodicIndexKey {tenant_id: $tenantId, project_scope: $projectScope})
           WITH count(key) AS keyCount
           OPTIONAL MATCH (outcome:EpisodicIndexOutcome {tenant_id: $tenantId, project_scope: $projectScope})
           WITH keyCount, count(outcome) AS outcomeCount
           RETURN keyCount + outcomeCount AS count`,
          input,
        );
        const count = Number(result.records[0]?.get('count') ?? 0);
        await tx.run(
          `MATCH (key:EpisodicIndexKey {tenant_id: $tenantId, project_scope: $projectScope})
           DETACH DELETE key`,
          input,
        );
        await tx.run(
          `MATCH (outcome:EpisodicIndexOutcome {tenant_id: $tenantId, project_scope: $projectScope})
           DETACH DELETE outcome`,
          input,
        );
        return count;
      });
    } finally {
      await session.close();
    }
  }

  async stats(input: { tenantId: string; projectScope: string }): Promise<{
    episodes: number; indexed: number; empty: number; keys: number;
  }> {
    const session = this.driver.session({ defaultAccessMode: 'READ' });
    try {
      const result = await session.run(
        `MATCH (ep:Episodic {tenant_id: $tenantId, scope: $projectScope})
         OPTIONAL MATCH (ep)-[:HAS_INDEX_KEY]->(key:EpisodicIndexKey {schema_version: 1})
         WITH ep, collect(key) AS keys
         OPTIONAL MATCH (ep)-[:HAS_INDEX_OUTCOME]->(outcome:EpisodicIndexOutcome {schema_version: 1, outcome: 'empty'})
         RETURN count(DISTINCT ep) AS episodes,
                count(DISTINCT CASE WHEN size(keys) > 0 THEN ep END) AS indexed,
                count(DISTINCT CASE WHEN outcome IS NOT NULL THEN ep END) AS empty,
                sum(size(keys)) AS keys`,
        input,
      );
      const record = result.records[0];
      return {
        episodes: Number(record?.get('episodes') ?? 0),
        indexed: Number(record?.get('indexed') ?? 0),
        empty: Number(record?.get('empty') ?? 0),
        keys: Number(record?.get('keys') ?? 0),
      };
    } finally {
      await session.close();
    }
  }
}
