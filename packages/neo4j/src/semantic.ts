// packages/neo4j/src/semantic.ts
import { createHash } from 'node:crypto';
import { type Driver } from 'neo4j-driver';
import { type SemanticNode, type EmbeddingProvider, type EmbeddingRequest, DEFAULT_TENANT } from '@memberry/core';
import { temporalSetClause } from './temporal-edges.js';
import { normalizeSemanticSignalCount } from './semantic-signal-count.js';
import { archivedWhere, endpointProjectScopeWhere, semanticTimestampValidWhere } from './query.js';
import { bumpKnowledgeEpoch, projectKnowledgeScope } from './knowledge-epoch.js';

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

type SupersessionInput = {
  tenantId: string;
  requestedScope: string | null;
  nonProjectTags: string[];
};

/**
 * Fail closed before opening a transaction when the caller presents an
 * ambiguous project identity. The predecessor remains authoritative for the
 * final scope; this only validates the caller's optional assertion.
 */
function prepareSupersessionInput(node: SemanticNode): SupersessionInput {
  const tenantId = (node.tenant_id ?? DEFAULT_TENANT).trim();
  if (!tenantId || tenantId.includes('*')) {
    throw new Error('Semantic supersession requires one concrete tenant');
  }

  const tags = canonicalTags(node.tags);
  const projectTags = tags.filter((tag) => /^project:/i.test(tag));
  if (projectTags.length > 1) {
    throw new Error('Semantic supersession accepts at most one project tag');
  }
  const explicitScope = node.scope?.toLowerCase() ?? null;
  const tagScope = projectTags[0] ?? null;
  for (const scope of [explicitScope, tagScope]) {
    if (scope !== null && (!/^project:[^*\s]+$/.test(scope) || scope.includes('*'))) {
      throw new Error('Semantic supersession requires one concrete project scope');
    }
  }
  if (explicitScope !== null && tagScope !== null && explicitScope !== tagScope) {
    throw new Error('Semantic supersession scope conflicts with its project tag');
  }

  return {
    tenantId,
    requestedScope: explicitScope ?? tagScope,
    nonProjectTags: tags.filter((tag) => !/^project:/i.test(tag)),
  };
}

function supersessionOperationDigest(
  oldId: string,
  node: SemanticNode,
  input: SupersessionInput,
  embedding: number[] | undefined,
): string {
  const immutablePayload = [
    'semantic-supersession-v1',
    oldId,
    node.id,
    node.content,
    node.confidence,
    node.signal_count,
    node.created_at,
    node.updated_at,
    node.decay_class,
    node.memory_type ?? null,
    input.nonProjectTags,
    input.requestedScope,
    input.tenantId,
    embedding ?? null,
  ];
  return `sha256:${createHash('sha256').update(JSON.stringify(immutablePayload)).digest('hex')}`;
}

/** Driver error code raised when a MERGE violates a uniqueness constraint. */
const CONSTRAINT_VIOLATION_CODE = 'Neo.ClientError.Schema.ConstraintValidationFailed';

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
    request?: EmbeddingRequest,
  ): Promise<number[] | undefined> {
    if (node.embedding && node.embedding.length > 0) return node.embedding;
    if (this.embedding && this.embedding.available !== false && node.content) {
      try {
        return request
          ? await this.embedding.embed(node.content, request)
          : await this.embedding.embed(node.content);
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
      const scope = semanticScope(node);
      const projectTags = (node.tags ?? []).filter((tag) => /^project:/i.test(tag)).map((tag) => tag.toLowerCase());
      const unambiguous = new Set([...(scope ? [scope] : []), ...projectTags]).size <= 1;
      const embedding = await this.resolveEmbedding(node, unambiguous && scope !== null
        ? { tenantId: node.tenant_id ?? DEFAULT_TENANT, projectScope: scope }
        : undefined);
      const query = `
        CREATE (s:Semantic {
          id: $id,
          content: $content,
          confidence: $confidence,
          signal_count: $signal_count,
          created_at: $created_at,
          updated_at: $updated_at,
          decay_class: $decay_class,
          memory_type: $memory_type,
          tags: $tags,
          scope: $scope,
          tenant_id: $tenant_id,
          status: 'active',
          valid_at: $created_at
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
        memory_type: node.memory_type ?? null,
        tags: canonicalTags(node.tags),
        scope: semanticScope(node),
        tenant_id: node.tenant_id ?? DEFAULT_TENANT,
      };
      if (embedding) {
        params.embedding = embedding;
      }
      const result = await session.executeWrite(async (tx) => {
        const created = await tx.run(query, params);
        await bumpKnowledgeEpoch(tx, {
          tenantId: params.tenant_id as string,
          projectScope: projectKnowledgeScope(params.scope as string | null),
        });
        return created;
      });
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
      signal_count: normalizeSemanticSignalCount(props.signal_count),
      created_at: props.created_at as string,
      updated_at: props.updated_at as string,
      decay_class: props.decay_class as SemanticNode['decay_class'],
      memory_type: (props.memory_type as SemanticNode['memory_type']) ?? undefined,
      tags: props.tags as string[],
      ...(props.scope != null && { scope: props.scope as string }),
      tenant_id: (props.tenant_id as string | undefined) ?? DEFAULT_TENANT,
      ...(typeof props.valid_at === 'string' && { valid_at: props.valid_at }),
      ...(typeof props.invalid_at === 'string' && { invalid_at: props.invalid_at }),
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

  /**
   * Which of `ids` actually exist as Semantic nodes. Used to validate signal
   * targets at the berry_store boundary: a signal whose target_id is not a
   * Semantic (in practice, agents passing an EPISODIC id) matches nothing in
   * linkSignal and is dropped by the consolidation engine's getByIds lookup —
   * silently, with no edge and no error. Callers reject up front instead.
   */
  async existingIds(ids: string[], tenantId?: string): Promise<string[]> {
    if (ids.length === 0) return [];
    const session = this.driver.session();
    try {
      const result = await session.run(
        `MATCH (s:Semantic)
         WHERE s.id IN $ids
           AND ($tenantId IS NULL OR coalesce(s.tenant_id, $defaultTenant) = $tenantId)
           AND ${archivedWhere('s')}
         RETURN s.id AS id`,
        { ids, tenantId: tenantId ?? null, defaultTenant: DEFAULT_TENANT },
      );
      return result.records.map((r) => r.get('id') as string);
    } finally {
      await session.close();
    }
  }

  async updateConfidence(id: string, confidence: number, applicationKey?: string): Promise<void> {
    const session = this.driver.session();
    try {
      const now = new Date().toISOString();
      await session.executeWrite(async (tx) => {
        const result = await tx.run(
        `MATCH (s:Semantic {id: $id})
         // Force a write lock before checking the idempotency ledger so two
         // concurrent retries on the same Semantic serialize safely.
         SET s.__confidence_application_lock = true
         REMOVE s.__confidence_application_lock
         WITH s, coalesce(s.applied_consolidation_keys, []) AS applied
         WHERE $application_key IS NULL OR NOT $application_key IN applied
         SET s.confidence = $confidence,
             s.updated_at = $now,
             s.applied_consolidation_keys = CASE
               WHEN $application_key IS NULL THEN applied
               ELSE applied + $application_key
             END
         RETURN s.id AS id, coalesce(s.tenant_id, $defaultTenant) AS tenantId,
                s.scope AS projectScope`,
        {
          id,
          confidence,
          now,
          application_key: applicationKey ?? null,
          defaultTenant: DEFAULT_TENANT,
        },
        );
        const record = result.records[0];
        if (record) {
          await bumpKnowledgeEpoch(tx, {
            tenantId: record.get('tenantId') as string,
            projectScope: projectKnowledgeScope(record.get('projectScope') as string | null),
          });
        }
      });
    } finally {
      await session.close();
    }
  }

  /**
   * MEM-006H reclass apply: set ONLY decay_class through the same lock +
   * applied_consolidation_keys idempotency ledger as updateConfidence.
   * Deliberately does NOT touch updated_at — a class change already lengthens
   * the half-life, and resetting the decay anchor would double-relieve.
   */
  async updateDecayClass(
    id: string,
    decayClass: 'volatile' | 'stable' | 'permanent',
    applicationKey?: string,
  ): Promise<void> {
    const session = this.driver.session();
    try {
      await session.executeWrite(async (tx) => {
        const result = await tx.run(
        `MATCH (s:Semantic {id: $id})
         // Force a write lock before checking the idempotency ledger so two
         // concurrent retries on the same Semantic serialize safely.
         SET s.__confidence_application_lock = true
         REMOVE s.__confidence_application_lock
         WITH s, coalesce(s.applied_consolidation_keys, []) AS applied
         WHERE $application_key IS NULL OR NOT $application_key IN applied
         SET s.decay_class = $decay_class,
             s.applied_consolidation_keys = CASE
               WHEN $application_key IS NULL THEN applied
               ELSE applied + $application_key
             END
         RETURN s.id AS id, coalesce(s.tenant_id, $defaultTenant) AS tenantId,
                s.scope AS projectScope`,
        {
          id,
          decay_class: decayClass,
          application_key: applicationKey ?? null,
          defaultTenant: DEFAULT_TENANT,
        },
        );
        const record = result.records[0];
        if (record) {
          await bumpKnowledgeEpoch(tx, {
            tenantId: record.get('tenantId') as string,
            projectScope: projectKnowledgeScope(record.get('projectScope') as string | null),
          });
        }
      });
    } finally {
      await session.close();
    }
  }

  async supersede(oldId: string, newNode: SemanticNode & { embedding?: number[] }): Promise<string> {
    const input = prepareSupersessionInput(newNode);
    const embedding = await this.resolveEmbedding(newNode, input.requestedScope !== null
      ? { tenantId: input.tenantId, projectScope: input.requestedScope }
      : undefined);
    const operationDigest = supersessionOperationDigest(oldId, newNode, input, embedding);
    const session = this.driver.session();
    try {
      const now = new Date().toISOString();
      const query = `
        MATCH (old:Semantic {id: $oldId})
        // Claim before deriving authorization or scope; a waiter must not retain
        // a pre-lock scope from a concurrently reassigned predecessor.
        SET old.__supersede_lock = true
        REMOVE old.__supersede_lock
        WITH old
        WHERE coalesce(old.tenant_id, $default_tenant) = $tenant_id
          AND trim(coalesce(old.tenant_id, $default_tenant)) <> ''
        WITH old,
          [tag IN coalesce(old.tags, [])
           WHERE toLower(tag) STARTS WITH 'project:' | toLower(tag)] AS oldProjectTags
        WITH old, oldProjectTags, coalesce(
          toLower(old.scope),
          head(oldProjectTags),
          ''
        ) AS oldProjectScope
        // The predecessor must itself have one unambiguous, concrete canonical
        // project identity. The caller may omit scope and inherit it.
        WHERE oldProjectScope STARTS WITH 'project:'
          AND oldProjectScope <> 'project:'
          AND NOT oldProjectScope CONTAINS '*'
          AND size(oldProjectTags) <= 1
          AND all(tag IN oldProjectTags WHERE tag = oldProjectScope)
          AND ($scope IS NULL OR oldProjectScope = $scope)
        WITH old, oldProjectScope
        OPTIONAL MATCH (successor:Semantic)-[:SUPERSEDES]->(old)
        WITH old, oldProjectScope, collect(DISTINCT successor) AS successors
        WHERE (
          // First application: the predecessor is active, its proposed id is
          // unclaimed from this predecessor, and no competing successor owns
          // this chain. Global id ownership is checked after MERGE below.
          (size(successors) = 0
            AND CASE WHEN ${semanticTimestampValidWhere('coalesce(old.valid_at, old.created_at)')}
              THEN datetime(coalesce(old.valid_at, old.created_at)) <= datetime($now) ELSE false END
            AND old.invalid_at IS NULL
            AND coalesce(old.archived, false) = false
            AND coalesce(old.status, 'active') = 'active')
          OR
          // Potential ambiguous-commit replay. The successor's global id and
          // immutable identity are checked only after claiming its node lock.
          (size(successors) > 0
            AND all(candidate IN successors WHERE candidate.id = $id)
            AND coalesce(old.status, 'superseded') = 'superseded'
            AND old.invalid_at IS NOT NULL)
        )
        MERGE (new:Semantic {id: $id})
        ON CREATE SET
          new.content = $content,
          new.confidence = $confidence,
          new.signal_count = $signal_count,
          new.created_at = $created_at,
          new.updated_at = $updated_at,
          new.decay_class = $decay_class,
          new.memory_type = coalesce($memory_type, old.memory_type),
          new.tags = $non_project_tags + [oldProjectScope],
          new.scope = oldProjectScope,
          new.tenant_id = $tenant_id,
          new.status = 'active',
          new.valid_at = $now,
          new.supersession_operation_digest = $operation_digest
          ${embedding ? ', new.embedding = $embedding' : ''}
        // MERGE plus this forced write lock serializes every claimant of the
        // globally unique successor id, including different predecessors.
        SET new.__supersession_claim_lock = true
        REMOVE new.__supersession_claim_lock
        WITH new, old, oldProjectScope, successors
        OPTIONAL MATCH (new)-[:SUPERSEDES]->(claimedPredecessor:Semantic)
        WITH new, old, oldProjectScope, successors,
             collect(DISTINCT claimedPredecessor) AS claimedPredecessors
        // Validate after the global claim. A concurrent loser can have observed
        // the id as absent before MERGE; it must not reuse the winner's node.
        WHERE coalesce(new.tenant_id, $default_tenant) = $tenant_id
          AND coalesce(toLower(new.scope), '') = oldProjectScope
          AND new.supersession_operation_digest = $operation_digest
          AND CASE WHEN ${semanticTimestampValidWhere('coalesce(new.valid_at, new.created_at)')}
            THEN datetime(coalesce(new.valid_at, new.created_at)) <= datetime($now) ELSE false END
          AND new.invalid_at IS NULL
          AND coalesce(new.archived, false) = false
          AND coalesce(new.status, 'active') = 'active'
          AND (
            (size(successors) = 0 AND size(claimedPredecessors) = 0)
            OR
            (size(successors) > 0
              AND size(claimedPredecessors) = 1
              AND claimedPredecessors[0].id = old.id
              AND old.invalid_at = new.valid_at)
          )
        // Exact replay is observation only: never reopen an ABOUT relationship
        // revoked after the original transition or overwrite later metadata.
        FOREACH (_ IN CASE WHEN size(successors) = 0 THEN [1] ELSE [] END |
          MERGE (new)-[transition:SUPERSEDES]->(old)
          SET transition.valid_at = new.valid_at,
              old.invalid_at = new.valid_at,
              old.status = 'superseded'
        )
        WITH new, old, size(successors) = 0 AS applied
        // Copy active entity associations to the successor before invalidating
        // the predecessor's relationships. Node and edge intervals all use the
        // successor's persisted valid_at, including exact replays.
        OPTIONAL MATCH (old)-[oldR:ABOUT]->(e:Entity)
        WHERE applied
          AND coalesce(e.tenant_id, $default_tenant) = $tenant_id
          AND ${endpointProjectScopeWhere('e', 'new.scope')}
          AND CASE WHEN ${semanticTimestampValidWhere('coalesce(oldR.valid_at, old.valid_at, old.created_at)')}
            THEN datetime(coalesce(oldR.valid_at, old.valid_at, old.created_at)) <= datetime(new.valid_at) ELSE false END
          AND (oldR.invalid_at IS NULL OR CASE WHEN ${semanticTimestampValidWhere('oldR.invalid_at')}
            THEN datetime(oldR.invalid_at) > datetime(new.valid_at) ELSE false END)
        WITH new, old,
             collect(oldR) AS oldRelationships,
             [entity IN collect(DISTINCT e) WHERE entity IS NOT NULL] AS entities
        FOREACH (entity IN entities |
          MERGE (new)-[newR:ABOUT]->(entity)
          SET newR.valid_at = new.valid_at,
              newR.invalid_at = null
        )
        FOREACH (oldR IN oldRelationships |
          SET oldR.invalid_at = new.valid_at
        )
        RETURN new.id AS id, new.tenant_id AS tenantId, new.scope AS projectScope
      `;
      const params: Record<string, unknown> = {
        id: newNode.id,
        content: newNode.content,
        confidence: newNode.confidence,
        signal_count: newNode.signal_count,
        created_at: newNode.created_at,
        updated_at: newNode.updated_at,
        decay_class: newNode.decay_class,
        memory_type: newNode.memory_type ?? null,
        non_project_tags: input.nonProjectTags,
        scope: input.requestedScope,
        tenant_id: input.tenantId,
        default_tenant: DEFAULT_TENANT,
        oldId,
        now,
        operation_digest: operationDigest,
      };
      if (embedding) params.embedding = embedding;
      const result = await session.executeWrite(async (tx) => {
        const writeResult = await tx.run(query, params);
        if (writeResult.records.length === 0) {
          // Throw before executeWrite can commit. This rolls back a losing
          // post-MERGE id claim as well as every later mutation in the query.
          throw new Error(
            `Semantic ${oldId} was missing, outside tenant/project, inactive, or already has a conflicting successor`,
          );
        }
        const record = writeResult.records[0]!;
        await bumpKnowledgeEpoch(tx, {
          tenantId: record.get('tenantId') as string,
          projectScope: projectKnowledgeScope(record.get('projectScope') as string),
        });
        return writeResult;
      });
      return result.records[0].get('id') as string;
    } finally {
      await session.close();
    }
  }

  /**
   * @param dedupeKey Optional content-derived key (caller computes it; this
   *   package cannot import core's `semanticDedupeKey`). Set ON CREATE so the
   *   `semantic_dedupe_unique` constraint covers promoted Semantics. When the
   *   constraint rejects the MERGE, the source episodes are linked onto the
   *   Semantic that already owns the key and ITS id is returned — no twin node.
   */
  async promoteFromEpisodic(
    episodicIds: string[],
    newNode: SemanticNode,
    tenantId?: string,
    dedupeKey?: string,
  ): Promise<string> {
    const uniqueEpisodeIds = [...new Set(episodicIds)];
    if (uniqueEpisodeIds.length === 0) {
      throw new Error('Cannot promote a Semantic without source episodes');
    }
    const session = this.driver.session();
    try {
      // Promotion derives the authoritative scope from source episodes inside the
      // transaction below. Keep this pre-transaction compatibility embed uncached.
      const embedding = await this.resolveEmbedding(newNode);
      const query = `
        MATCH (ep:Episodic)
        WHERE ep.id IN $episodicIds
          AND coalesce(ep.tenant_id, $default_tenant) = $tenant_id
        WITH collect(DISTINCT ep) AS episodes
        // Validate the complete tenant-scoped source set before any mutation.
        WHERE size(episodes) = size($episodicIds)
        // Acquire write locks on every source before checking provenance. The
        // temporary property is removed in the same transaction but its locks
        // remain held through commit, serializing overlapping promotions.
        FOREACH (ep IN episodes | SET ep.__promotion_lock = true)
        FOREACH (ep IN episodes | REMOVE ep.__promotion_lock)
        WITH episodes
        OPTIONAL MATCH (existing:Semantic {id: $id})
        OPTIONAL MATCH (existing)-[:PROMOTED_FROM]->(existingSource:Episodic)
        WITH episodes, existing, collect(DISTINCT existingSource.id) AS existingSourceIds
        // A lost commit response is safe to replay only when the deterministic
        // Semantic id already owns this exact provenance set. Any different or
        // overlapping promotion still fails closed.
        WHERE (existing IS NULL OR (
          coalesce(existing.tenant_id, $default_tenant) = $tenant_id
          AND size(existingSourceIds) = size($episodicIds)
          AND all(sourceId IN $episodicIds WHERE sourceId IN existingSourceIds)
        ))
        AND none(ep IN episodes WHERE EXISTS {
          MATCH (ep)<-[:PROMOTED_FROM]-(other:Semantic)
          WHERE other.id <> $id
        })
        // MERGE makes an exact-provenance replay a successful no-op without a
        // conditional subquery. Neo4j 5 rejects an importing WITH followed by
        // WHERE inside a CALL subquery, even though the shape parses in mocks.
        MERGE (s:Semantic {id: $id})
        ON CREATE SET s.content = $content,
                      s.confidence = $confidence,
                      s.signal_count = $signal_count,
                      s.created_at = $created_at,
                      s.updated_at = $updated_at,
                      s.decay_class = $decay_class,
                      s.memory_type = $memory_type,
                      s.tags = $tags,
                      s.scope = $scope,
                      s.tenant_id = $tenant_id,
                      s.status = 'active',
                      s.valid_at = coalesce(reduce(latest = null, ep IN episodes |
                        CASE WHEN latest IS NULL OR ep.created_at > latest
                             THEN ep.created_at ELSE latest END), $created_at)
                      ${embedding ? ', s.embedding = $embedding' : ''}${dedupeKey ? ', s.dedupe_key = $dedupeKey' : ''}
        WITH s, episodes
        UNWIND episodes AS ep
        MERGE (s)-[:PROMOTED_FROM]->(ep)
        WITH DISTINCT s, episodes
        UNWIND episodes AS ep
        OPTIONAL MATCH (ep)-[sourceR:REFERENCES|MODIFIED]->(entity:Entity)
        WHERE sourceR.invalid_at IS NULL
        WITH s, episodes,
             [linked IN collect(DISTINCT entity) WHERE linked IS NOT NULL] AS entities
        // Inherit the complete active entity association set as ABOUT edges.
        FOREACH (entity IN entities |
          MERGE (s)-[about:ABOUT]->(entity)
          SET about.valid_at = coalesce(about.valid_at, $now),
              about.invalid_at = null
        )
        WITH DISTINCT s, episodes
        SET s.scope = coalesce(
          s.scope,
          head([ep IN episodes WHERE ep.scope IS NOT NULL | ep.scope])
        )
        RETURN s.id AS id, coalesce(s.tenant_id, $default_tenant) AS tenantId,
               s.scope AS projectScope
      `;
      const params: Record<string, unknown> = {
        id: newNode.id,
        content: newNode.content,
        confidence: newNode.confidence,
        signal_count: newNode.signal_count,
        created_at: newNode.created_at,
        updated_at: newNode.updated_at,
        decay_class: newNode.decay_class,
        memory_type: newNode.memory_type ?? null,
        tags: canonicalTags(newNode.tags),
        scope: semanticScope(newNode),
        tenant_id: tenantId ?? newNode.tenant_id ?? DEFAULT_TENANT,
        default_tenant: DEFAULT_TENANT,
        episodicIds: uniqueEpisodeIds,
        now: new Date().toISOString(),
      };
      if (embedding) params.embedding = embedding;
      if (dedupeKey) params.dedupeKey = dedupeKey;
      let result;
      try {
        result = await session.executeWrite(async (tx) => {
          const promoted = await tx.run(query, params);
          const record = promoted.records[0];
          if (record) {
            await bumpKnowledgeEpoch(tx, {
              tenantId: record.get('tenantId') as string,
              projectScope: projectKnowledgeScope(record.get('projectScope') as string | null),
            });
          }
          return promoted;
        });
      } catch (err: unknown) {
        if (!dedupeKey || (err as { code?: unknown }).code !== CONSTRAINT_VIOLATION_CODE) throw err;
        // Another Semantic in this tenant already owns the dedupe_key: link the
        // source episodes onto it instead of creating a twin. Same provenance
        // guard as the create path — an episode already promoted elsewhere
        // still fails closed.
        result = await session.executeWrite(async (tx) => {
          const promoted = await tx.run(
          `
        MATCH (existing:Semantic {dedupe_key: $dedupeKey})
        WHERE coalesce(existing.tenant_id, $default_tenant) = $tenant_id
        MATCH (ep:Episodic)
        WHERE ep.id IN $episodicIds
          AND coalesce(ep.tenant_id, $default_tenant) = $tenant_id
        WITH existing, collect(DISTINCT ep) AS episodes
        WHERE size(episodes) = size($episodicIds)
          AND none(ep IN episodes WHERE EXISTS {
            MATCH (ep)<-[:PROMOTED_FROM]-(other:Semantic)
            WHERE other.id <> existing.id
          })
        UNWIND episodes AS ep
        MERGE (existing)-[:PROMOTED_FROM]->(ep)
        RETURN DISTINCT existing.id AS id,
               coalesce(existing.tenant_id, $default_tenant) AS tenantId,
               existing.scope AS projectScope
          `,
          {
            dedupeKey,
            episodicIds: uniqueEpisodeIds,
            tenant_id: params.tenant_id,
            default_tenant: DEFAULT_TENANT,
          },
          );
          const record = promoted.records[0];
          if (record) {
            await bumpKnowledgeEpoch(tx, {
              tenantId: record.get('tenantId') as string,
              projectScope: projectKnowledgeScope(record.get('projectScope') as string | null),
            });
          }
          return promoted;
        });
        if (result.records.length === 0) {
          throw new Error(
            `Promotion collided on dedupe_key but no matching Semantic in tenant ${params.tenant_id as string} accepted the sources`,
            { cause: err },
          );
        }
      }
      if (result.records.length === 0) {
        throw new Error(
          `Promotion sources were missing, already promoted, or outside tenant ${params.tenant_id as string}`,
        );
      }
      return result.records[0].get('id') as string;
    } finally {
      await session.close();
    }
  }

  async linkToEntity(semanticId: string, entityId: string): Promise<void> {
    const session = this.driver.session();
    try {
      await session.executeWrite(async (tx) => {
        const changed = await tx.run(
        `MATCH (s:Semantic {id: $semanticId}), (e:Entity {id: $entityId})
         MERGE (s)-[r:ABOUT]->(e)
         ${temporalSetClause('r')}
         RETURN coalesce(s.tenant_id, $defaultTenant) AS tenantId,
                s.scope AS projectScope`,
        { semanticId, entityId, now: new Date().toISOString(), defaultTenant: DEFAULT_TENANT },
        );
        const record = changed.records[0];
        if (record) {
          await bumpKnowledgeEpoch(tx, {
            tenantId: record.get('tenantId') as string,
            projectScope: projectKnowledgeScope(record.get('projectScope') as string | null),
          });
        }
      });
    } finally {
      await session.close();
    }
  }
}
