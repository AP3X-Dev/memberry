// packages/neo4j/src/semantic.ts
import { type Driver } from 'neo4j-driver';
import { type SemanticNode, type EmbeddingProvider, DEFAULT_TENANT } from '@memberry/core';
import { temporalSetClause } from './temporal-edges.js';

/**
 * Canonical project scope for a semantic node: the explicit scope when set,
 * otherwise derived from the first project:* tag. Null only for genuinely
 * project-unaffiliated knowledge (excluded from project-scoped loads).
 */
function semanticScope(node: Pick<SemanticNode, 'scope' | 'tags'>): string | null {
  if (node.scope) return node.scope.toLowerCase();
  const fromTags = (node.tags ?? []).find((t) => /^project:/i.test(t));
  return fromTags ? fromTags.toLowerCase() : null;
}

/**
 * Canonical tags for a semantic node: project:* tags are lowercased so a node's
 * `tags` stay consistent with its (lowercased) `scope`. Prevents the casing
 * fragmentation that left tag-scoped retrieval unable to match a canonical
 * lowercase project tag against an upper-cased stored tag.
 */
function canonicalTags(tags: string[] | undefined): string[] {
  return (tags ?? []).map((t) => (/^project:/i.test(t) ? t.toLowerCase() : t));
}

export class SemanticStore {
  /**
   * @param embedding Optional provider used to compute a content embedding at
   *   write time so every persisted Semantic lands in the `semantic_embedding`
   *   vector index. Without it (or with a degraded no-key provider), semantics
   *   are written WITHOUT an embedding and are unreachable by vector recall —
   *   the original "write-only memory" bug. Optional so test/CLI callers that
   *   pass only a driver keep working.
   */
  constructor(private driver: Driver, private embedding?: EmbeddingProvider) {}

  /**
   * Resolve the embedding to persist for a semantic node: an explicit vector
   * wins; otherwise compute one from the content via the injected provider.
   * Returns undefined only when no usable provider is wired or the embed fails —
   * the write still succeeds, just without vector recall for that node.
   */
  private async resolveEmbedding(
    node: { embedding?: number[]; content: string },
  ): Promise<number[] | undefined> {
    if (node.embedding && node.embedding.length > 0) return node.embedding;
    if (this.embedding && this.embedding.available !== false && node.content) {
      try {
        return await this.embedding.embed(node.content);
      } catch (err: unknown) {
        console.error(
          '[semantic-store] embedding failed; semantic will not be vector-recallable:',
          err instanceof Error ? err.message : err,
        );
      }
    }
    return undefined;
  }

  async create(node: SemanticNode & { embedding?: number[] }): Promise<string> {
    const session = this.driver.session();
    try {
      const embedding = await this.resolveEmbedding(node);
      const query = `
        CREATE (s:Semantic {
          id: $id,
          content: $content,
          confidence: $confidence,
          signal_count: $signal_count,
          created_at: $created_at,
          updated_at: $updated_at,
          decay_class: $decay_class,
          tags: $tags,
          scope: $scope,
          tenant_id: $tenant_id
        })
        ${embedding ? 'SET s.embedding = $embedding' : ''}
        RETURN s.id AS id
      `;
      const params: Record<string, unknown> = {
        id: node.id,
        content: node.content,
        confidence: node.confidence,
        signal_count: node.signal_count,
        created_at: node.created_at,
        updated_at: node.updated_at,
        decay_class: node.decay_class,
        tags: canonicalTags(node.tags),
        scope: semanticScope(node),
        tenant_id: node.tenant_id ?? DEFAULT_TENANT,
      };
      if (embedding) {
        params.embedding = embedding;
      }
      const result = await session.run(query, params);
      return result.records[0].get('id') as string;
    } finally {
      await session.close();
    }
  }

  /** Shared Semantic-node mapping so getById and getByIds (OPT-54) build the
   *  node IDENTICALLY — single source of truth, no drift. */
  private mapSemantic(props: Record<string, unknown>): SemanticNode {
    return {
      id: props.id as string,
      content: props.content as string,
      confidence: props.confidence as number,
      signal_count: props.signal_count as number,
      created_at: props.created_at as string,
      updated_at: props.updated_at as string,
      decay_class: props.decay_class as SemanticNode['decay_class'],
      tags: props.tags as string[],
      ...(props.scope != null && { scope: props.scope as string }),
      tenant_id: (props.tenant_id as string | undefined) ?? DEFAULT_TENANT,
      ...(props.embedding !== undefined && { embedding: props.embedding as number[] }),
    };
  }

  async getById(id: string): Promise<SemanticNode | null> {
    const session = this.driver.session();
    try {
      const result = await session.run(
        'MATCH (s:Semantic {id: $id}) RETURN s',
        { id }
      );
      if (result.records.length === 0) return null;
      return this.mapSemantic(result.records[0].get('s').properties as Record<string, unknown>);
    } finally {
      await session.close();
    }
  }

  /**
   * OPT-54: fetch many Semantic nodes in ONE round-trip (was N sequential
   * getById calls on the consolidation proposal path). Returns one entry per
   * FOUND id (missing ids omitted); callers map by id and skip misses, exactly
   * as the per-id getById loop did. Each node is mapped identically to getById.
   */
  async getByIds(ids: string[]): Promise<SemanticNode[]> {
    if (ids.length === 0) return [];
    const session = this.driver.session();
    try {
      const result = await session.run(
        'MATCH (s:Semantic) WHERE s.id IN $ids RETURN s',
        { ids },
      );
      return result.records.map((r) =>
        this.mapSemantic(r.get('s').properties as Record<string, unknown>),
      );
    } finally {
      await session.close();
    }
  }

  async updateConfidence(id: string, confidence: number): Promise<void> {
    const session = this.driver.session();
    try {
      const now = new Date().toISOString();
      await session.run(
        'MATCH (s:Semantic {id: $id}) SET s.confidence = $confidence, s.updated_at = $now',
        { id, confidence, now }
      );
    } finally {
      await session.close();
    }
  }

  async supersede(oldId: string, newNode: SemanticNode & { embedding?: number[] }): Promise<string> {
    const session = this.driver.session();
    try {
      const now = new Date().toISOString();
      const embedding = await this.resolveEmbedding(newNode);
      const query = `
        CREATE (new:Semantic {
          id: $id,
          content: $content,
          confidence: $confidence,
          signal_count: $signal_count,
          created_at: $created_at,
          updated_at: $updated_at,
          decay_class: $decay_class,
          tags: $tags,
          scope: $scope,
          tenant_id: $tenant_id
        })
        ${embedding ? 'SET new.embedding = $embedding' : ''}
        WITH new
        MATCH (old:Semantic {id: $oldId})
        CREATE (new)-[:SUPERSEDES]->(old)
        WITH new, old
        // The successor inherits the project scope when the caller didn't set one
        SET new.scope = coalesce(new.scope, old.scope)
        WITH new, old
        // Invalidate the old node's ABOUT relationships
        OPTIONAL MATCH (old)-[oldR:ABOUT]->(e:Entity)
        WHERE oldR.invalid_at IS NULL
        SET oldR.invalid_at = $now
        RETURN new.id AS id
      `;
      const params: Record<string, unknown> = {
        id: newNode.id,
        content: newNode.content,
        confidence: newNode.confidence,
        signal_count: newNode.signal_count,
        created_at: newNode.created_at,
        updated_at: newNode.updated_at,
        decay_class: newNode.decay_class,
        tags: canonicalTags(newNode.tags),
        scope: semanticScope(newNode),
        tenant_id: newNode.tenant_id ?? DEFAULT_TENANT,
        oldId,
        now,
      };
      if (embedding) params.embedding = embedding;
      const result = await session.run(query, params);
      return result.records[0].get('id') as string;
    } finally {
      await session.close();
    }
  }

  async promoteFromEpisodic(
    episodicId: string,
    newNode: SemanticNode,
    tenantId?: string,
  ): Promise<string> {
    const session = this.driver.session();
    try {
      const embedding = await this.resolveEmbedding(newNode);
      const query = `
        CREATE (s:Semantic {
          id: $id,
          content: $content,
          confidence: $confidence,
          signal_count: $signal_count,
          created_at: $created_at,
          updated_at: $updated_at,
          decay_class: $decay_class,
          tags: $tags,
          scope: $scope,
          tenant_id: $tenant_id
        })
        ${embedding ? 'SET s.embedding = $embedding' : ''}
        WITH s
        MATCH (ep:Episodic {id: $episodicId})
        CREATE (s)-[:PROMOTED_FROM]->(ep)
        WITH s, ep
        // Promotions inherit the source episode's project scope when unset
        SET s.scope = coalesce(s.scope, ep.scope)
        RETURN s.id AS id
      `;
      const params: Record<string, unknown> = {
        id: newNode.id,
        content: newNode.content,
        confidence: newNode.confidence,
        signal_count: newNode.signal_count,
        created_at: newNode.created_at,
        updated_at: newNode.updated_at,
        decay_class: newNode.decay_class,
        tags: canonicalTags(newNode.tags),
        scope: semanticScope(newNode),
        tenant_id: tenantId ?? newNode.tenant_id ?? DEFAULT_TENANT,
        episodicId,
      };
      if (embedding) params.embedding = embedding;
      const result = await session.run(query, params);
      return result.records[0].get('id') as string;
    } finally {
      await session.close();
    }
  }

  async linkToEntity(semanticId: string, entityId: string): Promise<void> {
    const session = this.driver.session();
    try {
      await session.run(
        `MATCH (s:Semantic {id: $semanticId}), (e:Entity {id: $entityId})
         MERGE (s)-[r:ABOUT]->(e)
         ${temporalSetClause('r')}`,
        { semanticId, entityId, now: new Date().toISOString() }
      );
    } finally {
      await session.close();
    }
  }
}
