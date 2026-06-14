// packages/neo4j/src/fact.ts
import { type Driver } from 'neo4j-driver';
import { nanoid } from 'nanoid';
import type { FactNode, FactTimeline, FactDiff, TemporalOptions } from '@memberry/core';
import { EntityResolver } from './entity-resolver.js';
import { temporalSetClause } from './temporal-edges.js';
import { tenantWhere, resolveTenant, TENANT_PARAM } from './tenant.js';

export class FactStore {
  private resolver: EntityResolver;

  constructor(private driver: Driver) {
    this.resolver = new EntityResolver(driver);
  }

  async create(fact: FactNode): Promise<string> {
    const session = this.driver.session();
    const tx = session.beginTransaction();
    try {
      // Resolve subject to canonical entity WITHIN the transaction
      // so entity creation/alias mutation is atomic with fact creation
      const resolved = await this.resolver.resolve(fact.subject, 'concept', tx);

      // Create the Fact node with entity_id for canonical lookup
      await tx.run(
        `CREATE (f:Fact {
          id: $id,
          subject: $subject,
          predicate: $predicate,
          object: $object,
          entity_id: $entity_id,
          source_episode_ids: $source_episode_ids,
          valid_at: $valid_at,
          invalid_at: $invalid_at,
          confidence: $confidence,
          status: $status,
          inference_type: $inference_type,
          supersedes_fact_id: $supersedes_fact_id,
          scope: $scope,
          tags: $tags,
          tenant_id: $tenant_id,
          created_at: $created_at,
          updated_at: $updated_at
        })`,
        {
          id: fact.id,
          subject: fact.subject,
          predicate: fact.predicate,
          object: fact.object,
          entity_id: resolved.id,
          source_episode_ids: fact.source_episode_ids,
          valid_at: fact.valid_at,
          invalid_at: fact.invalid_at,
          confidence: fact.confidence,
          status: fact.status,
          inference_type: fact.inference_type ?? 'deductive',
          supersedes_fact_id: fact.supersedes_fact_id,
          scope: fact.scope,
          tags: fact.tags,
          tenant_id: resolveTenant(fact.tenant_id),
          created_at: fact.created_at,
          updated_at: fact.updated_at,
        },
      );

      // Link SOURCED_FROM → Episodic for each source episode. OPT-43: one batched
      // UNWIND MERGE instead of a MERGE round-trip per episode. Graph-identical —
      // each episodeId still does MATCH (f),(e:Episodic{id}) + MERGE the edge, so
      // a missing Episodic is skipped exactly as the per-row loop skipped it.
      if (fact.source_episode_ids.length > 0) {
        await tx.run(
          `UNWIND $episodeIds AS episodeId
           MATCH (f:Fact {id: $factId}), (e:Episodic {id: episodeId})
           MERGE (f)-[:SOURCED_FROM]->(e)`,
          { factId: fact.id, episodeIds: fact.source_episode_ids },
        );
      }

      // Link FACT_ABOUT → canonical Entity (resolved by EntityResolver)
      await tx.run(
        `MATCH (f:Fact {id: $factId}), (e:Entity {id: $entityId})
         MERGE (f)-[r:FACT_ABOUT]->(e)
         ${temporalSetClause('r')}`,
        { factId: fact.id, entityId: resolved.id, now: new Date().toISOString() },
      );

      // Set embedding if provided
      if (fact.embedding) {
        await tx.run(
          `MATCH (f:Fact {id: $id}) SET f.embedding = $embedding`,
          { id: fact.id, embedding: fact.embedding },
        );
      }

      // Link SUPERSEDES → old Fact if supersedes_fact_id is set
      if (fact.supersedes_fact_id) {
        await tx.run(
          `MATCH (newF:Fact {id: $newId}), (oldF:Fact {id: $oldId})
           MERGE (newF)-[:SUPERSEDES_FACT]->(oldF)`,
          { newId: fact.id, oldId: fact.supersedes_fact_id },
        );
      }

      await tx.commit();
      return fact.id;
    } catch (err) {
      await tx.rollback();
      throw err;
    } finally {
      await session.close();
    }
  }

  async getById(id: string): Promise<FactNode | null> {
    const session = this.driver.session();
    try {
      const result = await session.run(
        'MATCH (f:Fact {id: $id}) RETURN f',
        { id },
      );
      if (result.records.length === 0) return null;
      return mapFactNode(result.records[0].get('f').properties);
    } finally {
      await session.close();
    }
  }

  async getActive(entityName: string, options?: TemporalOptions, tenantId?: string): Promise<FactNode[]> {
    // Resolve entityName to canonical ID via EntityResolver (handles
    // exact match, case-insensitive, and alias matching)
    const resolved = await this.resolver.resolveExisting(entityName);
    if (!resolved) return []; // No known entity → no facts

    const session = this.driver.session();
    try {
      const timeMode = options?.time_mode ?? 'current';
      const tenant = resolveTenant(tenantId);
      const tFilter = tenantWhere('f', tenant); // tenant isolation
      let cypher: string;
      const params: Record<string, unknown> = { entityId: resolved.id, [TENANT_PARAM]: tenant };

      switch (timeMode) {
        case 'current':
          cypher = `
            MATCH (f:Fact) WHERE f.entity_id = $entityId
              AND f.status = 'active' AND f.invalid_at IS NULL
              AND ${tFilter}
            RETURN f ORDER BY f.valid_at DESC`;
          break;

        case 'historical':
          params.as_of = options?.as_of ?? new Date().toISOString();
          cypher = `
            MATCH (f:Fact) WHERE f.entity_id = $entityId
              AND f.valid_at <= $as_of AND (f.invalid_at IS NULL OR f.invalid_at > $as_of)
              AND ${tFilter}
            RETURN f ORDER BY f.valid_at DESC`;
          break;

        case 'interval':
          params.from = options?.from ?? '1970-01-01T00:00:00.000Z';
          params.to = options?.to ?? new Date().toISOString();
          cypher = `
            MATCH (f:Fact) WHERE f.entity_id = $entityId
              AND f.valid_at <= $to AND (f.invalid_at IS NULL OR f.invalid_at > $from)
              AND ${tFilter}
            RETURN f ORDER BY f.valid_at DESC`;
          break;

        case 'evolution':
          if (options?.include_invalidated) {
            cypher = `
              MATCH (f:Fact) WHERE f.entity_id = $entityId
                AND ${tFilter}
              RETURN f ORDER BY f.valid_at ASC`;
          } else {
            cypher = `
              MATCH (f:Fact) WHERE f.entity_id = $entityId
                AND f.status <> 'invalidated'
                AND ${tFilter}
              RETURN f ORDER BY f.valid_at ASC`;
          }
          break;

        default: {
          const _exhaustive: never = timeMode;
          throw new Error(`Unknown time_mode: ${String(_exhaustive)}`);
        }
      }

      const result = await session.run(cypher, params);
      return result.records.map((r) => mapFactNode(r.get('f').properties));
    } finally {
      await session.close();
    }
  }

  /**
   * OPT-41: batched getActive for many entity names. Resolution stays per-entity
   * (unchanged precedence semantics), but ALL resolved entities' active facts are
   * fetched in ONE round-trip (UNWIND distinct ids → per-id ordered collect)
   * instead of one fact query per entity — collapsing the load() hot path from
   * O(2N) round-trips to O(N resolves + 1 fetch). Returns one FactNode[] per
   * input name, in input order, each IDENTICAL to getActive(name, options,
   * tenantId): same per-mode filter, same `ORDER BY f.valid_at`. Callers that
   * dedup+rank the union are therefore output-identical. (Batching the resolve
   * too would mean replicating EntityResolver precedence in one query — deferred.)
   */
  async getActiveBatch(
    entityNames: string[],
    options?: TemporalOptions,
    tenantId?: string,
  ): Promise<FactNode[][]> {
    if (entityNames.length === 0) return [];
    const resolved = await Promise.all(entityNames.map((n) => this.resolver.resolveExisting(n)));
    const ids = resolved.map((r) => (r ? r.id : null));
    const distinct = [...new Set(ids.filter((x): x is string => x !== null))];
    if (distinct.length === 0) return entityNames.map(() => []);

    const timeMode = options?.time_mode ?? 'current';
    const tenant = resolveTenant(tenantId);
    const tFilter = tenantWhere('f', tenant);
    const params: Record<string, unknown> = { ids: distinct, [TENANT_PARAM]: tenant };

    // Mirror getActive's per-mode filter + sort EXACTLY (see the switch above).
    let factFilter: string;
    let order: 'ASC' | 'DESC';
    switch (timeMode) {
      case 'current':
        factFilter = `f.status = 'active' AND f.invalid_at IS NULL`;
        order = 'DESC';
        break;
      case 'historical':
        params.as_of = options?.as_of ?? new Date().toISOString();
        factFilter = `f.valid_at <= $as_of AND (f.invalid_at IS NULL OR f.invalid_at > $as_of)`;
        order = 'DESC';
        break;
      case 'interval':
        params.from = options?.from ?? '1970-01-01T00:00:00.000Z';
        params.to = options?.to ?? new Date().toISOString();
        factFilter = `f.valid_at <= $to AND (f.invalid_at IS NULL OR f.invalid_at > $from)`;
        order = 'DESC';
        break;
      case 'evolution':
        factFilter = options?.include_invalidated ? 'true' : `f.status <> 'invalidated'`;
        order = 'ASC';
        break;
      default: {
        const _exhaustive: never = timeMode;
        throw new Error(`Unknown time_mode: ${String(_exhaustive)}`);
      }
    }

    const session = this.driver.session();
    try {
      // OPTIONAL MATCH + collect inside the per-id subquery so an id with no
      // matching facts still yields a row (→ [] for that position) rather than
      // being eliminated; $ids is distinct so there is no aggregation-merge.
      const cypher = `
        UNWIND $ids AS eid
        CALL {
          WITH eid
          OPTIONAL MATCH (f:Fact) WHERE f.entity_id = eid AND ${factFilter} AND ${tFilter}
          WITH f ORDER BY f.valid_at ${order}
          RETURN collect(f) AS facts
        }
        RETURN eid, facts`;
      const result = await session.run(cypher, params);
      const byId = new Map<string, FactNode[]>();
      for (const rec of result.records) {
        const eid = rec.get('eid') as string;
        const nodes = rec.get('facts') as Array<{ properties: Record<string, unknown> }>;
        byId.set(eid, nodes.map((n) => mapFactNode(n.properties)));
      }
      // Map back to input order (duplicate names share their resolved id's facts).
      return ids.map((id) => (id ? (byId.get(id) ?? []) : []));
    } finally {
      await session.close();
    }
  }

  async invalidate(id: string, invalidAt: string, supersededById?: string): Promise<void> {
    const session = this.driver.session();
    try {
      const now = new Date().toISOString();
      await session.run(
        `MATCH (f:Fact {id: $id})
         SET f.status = 'invalidated', f.invalid_at = $invalidAt, f.updated_at = $now`,
        { id, invalidAt, now },
      );

      if (supersededById) {
        await session.run(
          `MATCH (newF:Fact {id: $newId}), (oldF:Fact {id: $oldId})
           MERGE (newF)-[:SUPERSEDES_FACT]->(oldF)`,
          { newId: supersededById, oldId: id },
        );
      }
    } finally {
      await session.close();
    }
  }

  async dispute(id: string): Promise<void> {
    const session = this.driver.session();
    try {
      const now = new Date().toISOString();
      await session.run(
        `MATCH (f:Fact {id: $id})
         SET f.status = 'disputed', f.updated_at = $now`,
        { id, now },
      );
    } finally {
      await session.close();
    }
  }

  async timeline(entityName: string, tenantId?: string): Promise<FactTimeline> {
    const resolved = await this.resolver.resolveExisting(entityName);
    if (!resolved) return { entity: entityName, facts: [] };

    const session = this.driver.session();
    try {
      const tenant = resolveTenant(tenantId);
      const result = await session.run(
        `MATCH (f:Fact) WHERE f.entity_id = $entityId
           AND ${tenantWhere('f', tenant)}
         RETURN f ORDER BY f.valid_at ASC`,
        { entityId: resolved.id, [TENANT_PARAM]: tenant },
      );

      const facts = result.records.map((r) => {
        const fact = mapFactNode(r.get('f').properties);
        let event: 'created' | 'invalidated' | 'disputed' | 'superseded';
        let at: string;

        if (fact.status === 'invalidated') {
          event = fact.supersedes_fact_id ? 'superseded' : 'invalidated';
          at = fact.invalid_at ?? fact.updated_at;
        } else if (fact.status === 'disputed') {
          event = 'disputed';
          at = fact.updated_at;
        } else {
          event = 'created';
          at = fact.valid_at;
        }

        return { ...fact, event, at };
      });

      return { entity: entityName, facts };
    } finally {
      await session.close();
    }
  }

  async diff(entityName: string, from: string, to: string, tenantId?: string): Promise<FactDiff> {
    const resolved = await this.resolver.resolveExisting(entityName);
    if (!resolved) return { entity: entityName, from, to, added: [], invalidated: [], changed: [] };

    const session = this.driver.session();
    try {
      const tenant = resolveTenant(tenantId);
      const tFilter = tenantWhere('f', tenant);
      // Facts active at 'from' timestamp
      const fromResult = await session.run(
        `MATCH (f:Fact) WHERE f.entity_id = $entityId
           AND f.valid_at <= $from AND (f.invalid_at IS NULL OR f.invalid_at > $from)
           AND ${tFilter}
         RETURN f`,
        { entityId: resolved.id, from, [TENANT_PARAM]: tenant },
      );
      const fromFacts = fromResult.records.map((r) => mapFactNode(r.get('f').properties));

      // Facts active at 'to' timestamp
      const toResult = await session.run(
        `MATCH (f:Fact) WHERE f.entity_id = $entityId
           AND f.valid_at <= $to AND (f.invalid_at IS NULL OR f.invalid_at > $to)
           AND ${tFilter}
         RETURN f`,
        { entityId: resolved.id, to, [TENANT_PARAM]: tenant },
      );
      const toFacts = toResult.records.map((r) => mapFactNode(r.get('f').properties));

      const fromIds = new Set(fromFacts.map((f) => f.id));
      const toIds = new Set(toFacts.map((f) => f.id));

      // Added: in 'to' but not in 'from'
      const added = toFacts.filter((f) => !fromIds.has(f.id));

      // Invalidated: in 'from' but not in 'to'
      const invalidated = fromFacts.filter((f) => !toIds.has(f.id));

      // Changed: facts that supersede other facts — find pairs
      const changed: Array<{ before: FactNode; after: FactNode }> = [];
      for (const addedFact of added) {
        if (addedFact.supersedes_fact_id) {
          const beforeFact = invalidated.find((f) => f.id === addedFact.supersedes_fact_id);
          if (beforeFact) {
            changed.push({ before: beforeFact, after: addedFact });
          }
        }
      }

      // Remove changed items from added/invalidated to avoid double-counting
      const changedBeforeIds = new Set(changed.map((c) => c.before.id));
      const changedAfterIds = new Set(changed.map((c) => c.after.id));

      return {
        entity: entityName,
        from,
        to,
        added: added.filter((f) => !changedAfterIds.has(f.id)),
        invalidated: invalidated.filter((f) => !changedBeforeIds.has(f.id)),
        changed,
      };
    } finally {
      await session.close();
    }
  }

  async findBySubjectPredicate(
    subject: string,
    predicate: string,
    tenantId?: string,
    opts?: { includeTentative?: boolean },
  ): Promise<FactNode[]> {
    // Resolve subject to canonical entity_id first — same resolution
    // path as getActive/timeline/diff to avoid fragmentation
    const resolved = await this.resolver.resolveExisting(subject);
    if (!resolved) return []; // No known entity → no facts

    const session = this.driver.session();
    try {
      const tenant = resolveTenant(tenantId);
      // OPT-70: callers reconciling extraction-origin facts opt into seeing
      // `tentative` contenders so an unconfirmed fact can be corroborated and
      // promoted. Default = active-only — byte-identical for every existing
      // caller (e.g. consolidation). The status list is a bound parameter; no
      // caller-derived value is interpolated into the Cypher.
      const statuses = opts?.includeTentative ? ['active', 'tentative'] : ['active'];
      const result = await session.run(
        `MATCH (f:Fact)
         WHERE f.entity_id = $entityId
           AND toLower(f.predicate) = toLower($predicate)
           AND f.status IN $statuses
           AND ${tenantWhere('f', tenant)}
         RETURN f
         ORDER BY f.valid_at DESC`,
        { entityId: resolved.id, predicate, statuses, [TENANT_PARAM]: tenant },
      );
      return result.records.map((r) => mapFactNode(r.get('f').properties));
    } finally {
      await session.close();
    }
  }

  async setEmbedding(id: string, embedding: number[]): Promise<void> {
    const session = this.driver.session();
    try {
      await session.run(
        `MATCH (f:Fact {id: $id}) SET f.embedding = $embedding`,
        { id, embedding },
      );
    } finally {
      await session.close();
    }
  }

  /**
   * Link two facts that were co-extracted from the same episode.
   * Creates a bidirectional SAME_EPISODE edge (stored as undirected via single direction).
   */
  async linkCoExtracted(factId1: string, factId2: string, episodeId: string): Promise<void> {
    const session = this.driver.session();
    try {
      await session.run(
        `MATCH (f1:Fact {id: $id1}), (f2:Fact {id: $id2})
         MERGE (f1)-[r:SAME_EPISODE]->(f2)
         SET r.episode_id = $episodeId, r.created_at = COALESCE(r.created_at, $now)`,
        { id1: factId1, id2: factId2, episodeId, now: new Date().toISOString() },
      );
    } finally {
      await session.close();
    }
  }

  /**
   * Update the confidence score of a fact.
   * Used by staleness detection to decay confidence of unmentioned facts.
   */
  async updateConfidence(id: string, confidence: number): Promise<void> {
    const session = this.driver.session();
    try {
      await session.run(
        'MATCH (f:Fact {id: $id}) SET f.confidence = $confidence, f.updated_at = $now',
        { id, confidence, now: new Date().toISOString() },
      );
    } finally {
      await session.close();
    }
  }

  /**
   * OPT-42: apply many confidence updates in ONE round-trip (UNWIND SET),
   * instead of one updateConfidence query per fact. End-state is identical to
   * calling updateConfidence for each {id, confidence} (same SET of confidence +
   * updated_at); all rows just share one updated_at timestamp. No-op on empty.
   */
  async updateConfidenceBatch(updates: Array<{ id: string; confidence: number }>): Promise<void> {
    if (updates.length === 0) return;
    const session = this.driver.session();
    try {
      await session.run(
        `UNWIND $updates AS u
         MATCH (f:Fact {id: u.id})
         SET f.confidence = u.confidence, f.updated_at = $now`,
        { updates, now: new Date().toISOString() },
      );
    } finally {
      await session.close();
    }
  }

  /**
   * Promote a tentative/abductive fact that explicit evidence has now corroborated:
   * mark it active + deductive and raise its confidence. Used when a real episode
   * yields the same subject/predicate/object a dream hypothesis had guessed.
   */
  async corroborate(id: string, confidence: number): Promise<void> {
    const session = this.driver.session();
    try {
      await session.run(
        `MATCH (f:Fact {id: $id})
         SET f.status = 'active', f.inference_type = 'deductive',
             f.confidence = $confidence, f.updated_at = $now`,
        { id, confidence, now: new Date().toISOString() },
      );
    } finally {
      await session.close();
    }
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function mapFactNode(props: Record<string, unknown>): FactNode {
  const now = new Date().toISOString();
  return {
    id: typeof props.id === 'string' ? props.id : '',
    subject: typeof props.subject === 'string' ? props.subject : '',
    predicate: typeof props.predicate === 'string' ? props.predicate : '',
    object: typeof props.object === 'string' ? props.object : '',
    entity_id: typeof props.entity_id === 'string' ? props.entity_id : null,
    source_episode_ids: Array.isArray(props.source_episode_ids) ? (props.source_episode_ids as string[]) : [],
    valid_at: typeof props.valid_at === 'string' ? props.valid_at : now,
    invalid_at: typeof props.invalid_at === 'string' ? props.invalid_at : null,
    confidence: typeof props.confidence === 'number' ? props.confidence : 0.5,
    status: typeof props.status === 'string' ? (props.status as FactNode['status']) : 'tentative',
    inference_type: typeof props.inference_type === 'string' ? (props.inference_type as FactNode['inference_type']) : 'deductive',
    supersedes_fact_id: typeof props.supersedes_fact_id === 'string' ? props.supersedes_fact_id : null,
    scope: typeof props.scope === 'string' ? (props.scope as FactNode['scope']) : 'project',
    tags: Array.isArray(props.tags) ? (props.tags as string[]) : [],
    created_at: typeof props.created_at === 'string' ? props.created_at : now,
    updated_at: typeof props.updated_at === 'string' ? props.updated_at : now,
    ...(typeof props.tenant_id === 'string' && { tenant_id: props.tenant_id }),
    ...(props.embedding != null && Array.isArray(props.embedding) && { embedding: props.embedding as number[] }),
  };
}
