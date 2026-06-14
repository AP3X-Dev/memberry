// packages/neo4j/src/episodic.ts
import { type Driver } from 'neo4j-driver';
import type { EpisodicNode, Signal } from '@memberry/core';
import { temporalSetClause } from './temporal-edges.js';

export class EpisodicStore {
  constructor(private driver: Driver) {}

  /**
   * Shared CREATE query + params so create() and createWithLinks() (OPT-53) build
   * the Episodic node IDENTICALLY — single source of truth, no drift.
   * OPT-44: the conditional embedding SET keeps the property ABSENT when none is
   * given, so the persisted node matches the previous two-step (CREATE then SET) path.
   */
  private buildCreate(node: EpisodicNode): { query: string; params: Record<string, unknown> } {
    const query = `
      CREATE (e:Episodic {
        id: $id,
        session_id: $session_id,
        agent_id: $agent_id,
        task: $task,
        content: $content,
        outcome: $outcome,
        created_at: $created_at,
        ttl: $ttl,
        scope: $scope,
        tags: $tags,
        tenant_id: $tenant_id
      })
      ${node.embedding ? 'SET e.embedding = $embedding' : ''}
      RETURN e.id AS id`;
    const params: Record<string, unknown> = {
      id: node.id,
      session_id: node.session_id,
      agent_id: node.agent_id,
      task: node.task,
      content: node.content,
      outcome: node.outcome ?? null,
      created_at: node.created_at,
      ttl: node.ttl ?? null,
      scope: node.scope ?? null,
      tags: node.tags ?? [],
      tenant_id: node.tenant_id ?? null,
      ...(node.embedding ? { embedding: node.embedding } : {}),
    };
    return { query, params };
  }

  async create(node: EpisodicNode): Promise<string> {
    const session = this.driver.session();
    try {
      const { query, params } = this.buildCreate(node);
      const result = await session.run(query, params);
      return result.records[0].get('id') as string;
    } finally {
      await session.close();
    }
  }

  /**
   * OPT-53: create the episode AND its structural graph edges (agent / entities /
   * model) in ONE managed write transaction, so a mid-failure can't leave a
   * partially-linked episode. The prior path did CREATE then fanned the links out
   * as SEPARATE un-transacted round-trips: a link failure orphaned the episode
   * with missing edges, and the caller's retry minted a fresh duplicate. Each
   * statement reuses the exact same Cypher as create()/linkTo* (so the resulting
   * graph is identical); the links are best-effort MATCH→MERGE (a missing
   * Agent/Entity/Model target is skipped, exactly as the per-edge methods do).
   * Signal links and their Redis side-effects stay OUT of this tx (Redis can't
   * share a Neo4j transaction) and remain a separate post-commit step.
   */
  async createWithLinks(
    node: EpisodicNode,
    links: { agentId?: string; entityIds?: string[]; modelId?: string },
  ): Promise<string> {
    const session = this.driver.session();
    try {
      return await session.executeWrite(async (tx) => {
        const { query, params } = this.buildCreate(node);
        await tx.run(query, params);

        if (links.agentId) {
          await tx.run(
            `MATCH (e:Episodic {id: $episodicId}), (a:Agent {id: $agentId})
             MERGE (e)-[:GENERATED_BY]->(a)`,
            { episodicId: node.id, agentId: links.agentId },
          );
        }
        if (links.entityIds && links.entityIds.length > 0) {
          await tx.run(
            `MATCH (e:Episodic {id: $episodicId})
             UNWIND $entityIds AS entityId
             MATCH (ent:Entity {id: entityId})
             MERGE (e)-[r:REFERENCES]->(ent)
             ${temporalSetClause('r')}`,
            { episodicId: node.id, entityIds: links.entityIds, now: new Date().toISOString() },
          );
        }
        if (links.modelId) {
          await tx.run(
            `MATCH (e:Episodic {id: $episodicId}), (m:Model {id: $modelId})
             MERGE (e)-[:USED_MODEL]->(m)`,
            { episodicId: node.id, modelId: links.modelId },
          );
        }
        return node.id;
      });
    } finally {
      await session.close();
    }
  }

  /**
   * OPT-45: project tenant_id for many episodes in ONE query (UNWIND), instead
   * of one getById per id. Returns one entry per FOUND episode (its tenant_id,
   * or null when unset); a missing episode yields no row (omitted) — matching the
   * per-id derivation loop where a missing episode simply doesn't contribute.
   */
  async getTenantsByIds(ids: string[]): Promise<Array<string | null>> {
    if (ids.length === 0) return [];
    const session = this.driver.session();
    try {
      const result = await session.run(
        `UNWIND $ids AS id MATCH (e:Episodic {id: id}) RETURN e.tenant_id AS tenant`,
        { ids },
      );
      return result.records.map((r) => (r.get('tenant') as string | null) ?? null);
    } finally {
      await session.close();
    }
  }

  async getById(id: string): Promise<EpisodicNode | null> {
    const session = this.driver.session();
    try {
      const result = await session.run(
        `MATCH (e:Episodic {id: $id}) RETURN e`,
        { id },
      );

      if (result.records.length === 0) {
        return null;
      }

      const props = result.records[0].get('e').properties as Record<string, unknown>;
      return {
        id: props.id as string,
        session_id: props.session_id as string,
        agent_id: props.agent_id as string,
        task: props.task as string,
        content: props.content as string,
        outcome: props.outcome as EpisodicNode['outcome'] ?? undefined,
        created_at: props.created_at as string,
        ttl: props.ttl != null ? (props.ttl as number) : undefined,
        embedding: props.embedding != null ? (props.embedding as number[]) : undefined,
        scope: props.scope != null ? (props.scope as string) : undefined,
        tags: props.tags != null ? (props.tags as string[]) : undefined,
      };
    } finally {
      await session.close();
    }
  }

  async linkToAgent(episodicId: string, agentId: string): Promise<void> {
    const session = this.driver.session();
    try {
      await session.run(
        `MATCH (e:Episodic {id: $episodicId}), (a:Agent {id: $agentId})
         MERGE (e)-[:GENERATED_BY]->(a)`,
        { episodicId, agentId },
      );
    } finally {
      await session.close();
    }
  }

  async linkToEntity(episodicId: string, entityId: string): Promise<void> {
    const session = this.driver.session();
    try {
      await session.run(
        `MATCH (e:Episodic {id: $episodicId}), (ent:Entity {id: $entityId})
         MERGE (e)-[r:REFERENCES]->(ent)
         ${temporalSetClause('r')}`,
        { episodicId, entityId, now: new Date().toISOString() },
      );
    } finally {
      await session.close();
    }
  }

  async linkToModel(episodicId: string, modelId: string): Promise<void> {
    const session = this.driver.session();
    try {
      await session.run(
        `MATCH (e:Episodic {id: $episodicId}), (m:Model {id: $modelId})
         MERGE (e)-[:USED_MODEL]->(m)`,
        { episodicId, modelId },
      );
    } finally {
      await session.close();
    }
  }

  async linkSignal(episodicId: string, signal: Signal): Promise<void> {
    const relTypeMap: Record<Signal['type'], string> = {
      reinforcement: 'REINFORCES',
      correction: 'CORRECTS',
      contradiction: 'CONTRADICTS',
    };
    const relType = relTypeMap[signal.type];
    if (!relType) {
      throw new Error(`Unrecognised signal type: ${String(signal.type)}`);
    }

    const session = this.driver.session();
    try {
      // Relationship types cannot be parameterized in Cypher, so build dynamically
      await session.run(
        `MATCH (e:Episodic {id: $episodicId}), (s:Semantic {id: $targetId})
         MERGE (e)-[r:${relType}]->(s)
         SET r.detail = $detail
         ${temporalSetClause('r')}`,
        { episodicId, targetId: signal.target_id, detail: signal.detail, now: new Date().toISOString() },
      );
    } finally {
      await session.close();
    }
  }
}
