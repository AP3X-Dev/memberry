// packages/neo4j/src/query.ts
import neo4j, { Record as Neo4jRecord, type Driver } from 'neo4j-driver';
import { isProxy } from 'node:util/types';
import type { SemanticNode, FactNode, EpisodicNode, TemporalOptions } from '@memberry/core';
import { readEnv, DEFAULT_TENANT } from '@memberry/core';
import { activeRelationshipFilter } from './temporal-edges.js';
import { tenantWhere, resolveTenant, isDefaultTenant, TENANT_PARAM } from './tenant.js';
import { normalizeSemanticSignalCount } from './semantic-signal-count.js';

/**
 * OPT-72: default bounded transaction timeout applied to EVERY rawCypher call
 * (incl. berry_query) so no raw `=~`/analytical query can pin the shared Neo4j
 * unbounded — OPT-07 only timed the grep path, leaving berry_query's raw `=~`
 * unbounded. Generous (15s) so legitimate slow analytics aren't false-aborted;
 * the grep path passes a tighter explicit bound. Override via
 * MEMBERRY_RAW_CYPHER_TIMEOUT_MS (positive int; falls back to the default).
 */
const DEFAULT_RAW_CYPHER_TIMEOUT_MS = 15_000;
function defaultRawCypherTimeoutMs(): number {
  const raw = readEnv('MEMBERRY_RAW_CYPHER_TIMEOUT_MS');
  if (raw === undefined) return DEFAULT_RAW_CYPHER_TIMEOUT_MS;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_RAW_CYPHER_TIMEOUT_MS;
}

export interface QueryScope {
  entities?: string[];
  /** @internal Authoritative exact Entity.id scope; takes precedence over names. */
  entityIds?: unknown;
  tags?: string[];
  limit: number;
  /** ISO timestamp — when provided, only traverse relationships active at this time */
  asOf?: string;
  /** Tenant to scope results to (defaults to the single default tenant). */
  tenantId?: string;
  /**
   * Canonical project scope (e.g. "project:amp"). When set, results are HARD
   * filtered to nodes whose scope property or project:* tag matches — unlike
   * `tags`, which is an advisory ANY-match. Cross-project reads omit this.
   */
  projectScope?: string;
}

/**
 * WHERE fragment enforcing project scope on a node alias. Matches the node's
 * scope property, or (legacy nodes predating the scope backfill) a project:*
 * tag. Callers must bind $projectScope.
 */
function projectScopeWhere(alias: string): string {
  return `(${alias}.scope = $projectScope OR $projectScope IN ${alias}.tags)`;
}

// ─── Cypher read-only validation ─────────────────────────────────────────────

/**
 * Mutating Cypher keywords that must not appear in user-supplied queries.
 * Checked as whole words (with word-boundary assertions) after stripping
 * string literals, line/block comments, and parameter references.
 */
const MUTATING_KEYWORDS = [
  'CREATE', 'MERGE', 'SET', 'DELETE', 'DETACH', 'REMOVE', 'DROP',
  'FOREACH', 'LOAD',
];

const ADMINISTRATIVE_COMMAND_RE = /^\s*(SHOW|USE)\b/i;
const MAX_RAW_CYPHER_LIMIT = 100;

function stripTrailingSemicolons(cypher: string): string {
  return cypher.trim().replace(/;+\s*$/g, '');
}

/**
 * Validates that a Cypher query is read-only.
 *
 * Steps:
 *  1. Strip string literals (single- and double-quoted) so keywords inside
 *     strings don't trigger false positives.
 *  2. Strip line comments (`// ...`) and block comments (`/* ... *​/`).
 *  3. Strip parameter references (`$identifier`) so parameter names like
 *     `$SET`, `$DELETE` don't trigger false positives.
 *  4. Check for mutating keywords using word-boundary regex.
 *  5. Check for `CALL` followed by a procedure name (word chars / dots),
 *     but allow `CALL {` which is a read-only subquery in Neo4j 4.x+.
 *
 * Throws an error describing the violation when a mutating construct is found.
 */
export function validateReadOnlyCypher(cypher: string): void {
  // Step 0: Unicode-normalize (NFKC) so compatibility / fullwidth homoglyphs
  // (e.g. "ＤＥＬＥＴＥ") fold to ASCII and can't slip past the keyword checks.
  // (Pure-script homoglyphs like Cyrillic "Е" don't fold here, but they also
  // aren't valid Cypher keywords to the server, and rawCypher additionally runs
  // in a server-enforced READ transaction — defense in depth.)
  const normalized = cypher.normalize('NFKC');

  // Step 1: Strip string literals (replace with empty string)
  let stripped = normalized.replace(/'(?:[^'\\]|\\.)*'/g, '""');
  stripped = stripped.replace(/"(?:[^"\\]|\\.)*"/g, '""');

  // Step 2: Strip comments
  stripped = stripped.replace(/\/\/[^\n]*/g, ' ');       // line comments
  stripped = stripped.replace(/\/\*[\s\S]*?\*\//g, ' '); // block comments

  // Step 3: Strip parameter references ($word) to prevent false positives
  // e.g. $SET, $DELETE, $REMOVE should not trigger keyword checks
  stripped = stripped.replace(/\$\w+/g, ' ');

  // Step 3.5: Single-statement enforcement. A single trailing ';' is fine, but
  // an embedded ';' means stacked statements — reject so a read query can't be
  // suffixed with a write.
  const withoutTrailingSemis = stripped.replace(/;+\s*$/g, '');
  if (withoutTrailingSemis.includes(';')) {
    throw new Error(
      'Cypher validation failed: multiple statements are not allowed via berry_query. ' +
      'Submit a single read-only statement.',
    );
  }

  const adminMatch = stripped.match(ADMINISTRATIVE_COMMAND_RE);
  if (adminMatch) {
    throw new Error(
      `Cypher validation failed: query contains administrative keyword "${adminMatch[1].toUpperCase()}". ` +
      'Only graph read queries are allowed via berry_query.',
    );
  }

  // Step 4: Check for mutating keywords
  for (const kw of MUTATING_KEYWORDS) {
    const re = new RegExp(`\\b${kw}\\b`, 'i');
    if (re.test(stripped)) {
      throw new Error(
        `Cypher validation failed: query contains mutating keyword "${kw}". ` +
        'Only read-only queries are allowed via berry_query.',
      );
    }
  }

  // Step 5: Block CALL to procedures but allow CALL {} subqueries
  // CALL { ... } is a read-only subquery in Neo4j 4.x+ → allowed
  // CALL procedureName(...) invokes a stored procedure → blocked
  // Strategy: find all CALL occurrences, check what follows each one.
  // If the first non-whitespace character after CALL is '{', it's a subquery.
  // Otherwise (word char = procedure name), it's a procedure call → reject.
  const callProcRe = /\bCALL\b\s+(?!\s*\{)[\w.]/gi;
  if (callProcRe.test(stripped)) {
    throw new Error(
      'Cypher validation failed: query contains CALL to a stored procedure. ' +
      'Only read-only queries are allowed via berry_query. ' +
      'CALL {} subqueries are permitted.',
    );
  }
}

function normalizeRawCypherLimit(limit: number): number {
  const floored = Math.floor(limit);
  if (Number.isNaN(floored)) return 1;
  if (!Number.isFinite(floored)) return MAX_RAW_CYPHER_LIMIT;
  return Math.min(MAX_RAW_CYPHER_LIMIT, Math.max(1, floored));
}

const MAX_RESOLVED_ENTITY_IDS = 32;
const MAX_ENTITY_ID_LENGTH = 200;
const SAFE_ENTITY_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const QUERY_SCOPE_KEYS = new Set([
  'entities', 'entityIds', 'tags', 'limit', 'asOf', 'tenantId', 'projectScope',
]);

function snapshotQueryScope(scope: QueryScope): QueryScope {
  if (scope === null || typeof scope !== 'object' || isProxy(scope)
    || Object.getPrototypeOf(scope) !== Object.prototype) {
    throw new Error('query_scope_invalid');
  }
  const stableDescriptor = Object.getOwnPropertyDescriptor(scope, 'entityIds');
  if (stableDescriptor === undefined) return scope;
  if (!('value' in stableDescriptor)) throw new Error('query_scope_invalid');
  const snapshot: Record<string, unknown> = {};
  for (const key of Reflect.ownKeys(scope)) {
    if (typeof key !== 'string' || !QUERY_SCOPE_KEYS.has(key)) throw new Error('query_scope_invalid');
    const descriptor = Object.getOwnPropertyDescriptor(scope, key);
    if (!descriptor || !('value' in descriptor)) throw new Error('query_scope_invalid');
    snapshot[key] = descriptor.value;
  }
  return snapshot as unknown as QueryScope;
}

/** Validate exact Entity IDs without invoking user-controlled hooks. */
function normalizeResolvedEntityIds(value: unknown): readonly string[] | undefined {
  if (value === undefined) return undefined;
  if (isProxy(value) || !Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    throw new Error('resolved_entity_ids_invalid');
  }
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
  const length = lengthDescriptor && 'value' in lengthDescriptor ? lengthDescriptor.value : undefined;
  if (!Number.isInteger(length) || length < 0 || length > MAX_RESOLVED_ENTITY_IDS) {
    throw new Error('resolved_entity_ids_invalid');
  }
  const keys = Reflect.ownKeys(value);
  if (keys.length !== length + 1 || !keys.includes('length')) {
    throw new Error('resolved_entity_ids_invalid');
  }
  const ids: string[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < length; index += 1) {
    const key = String(index);
    if (!keys.includes(key)) throw new Error('resolved_entity_ids_invalid');
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !('value' in descriptor) || typeof descriptor.value !== 'string') {
      throw new Error('resolved_entity_ids_invalid');
    }
    const id = descriptor.value;
    if (id.length === 0 || id.length > MAX_ENTITY_ID_LENGTH || !SAFE_ENTITY_ID.test(id)) {
      throw new Error('resolved_entity_ids_invalid');
    }
    if (!seen.has(id)) {
      seen.add(id);
      ids.push(id);
    }
  }
  return Object.freeze(ids);
}

export class ScopedQuery {
  constructor(private driver: Driver) {}

  async byEntity(entityName: string, limit: number, asOf?: string, tenantId?: string): Promise<SemanticNode[]> {
    const session = this.driver.session();
    try {
      const relFilter = activeRelationshipFilter('r', asOf ? 'asOf' : undefined);
      // Semantic is tenant-scoped — AND tenantWhere so this read can't surface
      // another tenant's semantics (default tenant matches legacy/null-tenant →
      // output-identical single-tenant). $tenantId is a bound parameter.
      const tenant = resolveTenant(tenantId);
      const params: Record<string, unknown> = { entityName, limit: neo4j.int(limit), [TENANT_PARAM]: tenant };
      if (asOf) params.asOf = asOf;

      const result = await session.run(
        `MATCH (s:Semantic)-[r:ABOUT]->(e:Entity {name: $entityName})
         WHERE ${relFilter}
           AND ${tenantWhere('s', tenant)}
         RETURN s { .*, embedding: null } AS s
         ORDER BY s.confidence DESC, s.updated_at DESC
         LIMIT $limit`,
        params,
      );
      return result.records.map((r) => mapSemanticNode(nodeProps(r.get('s'))));
    } finally {
      await session.close();
    }
  }

  async byTag(tag: string, limit: number, tenantId?: string): Promise<SemanticNode[]> {
    const session = this.driver.session();
    try {
      // Semantic is tenant-scoped — AND tenantWhere (bound $tenantId); default
      // tenant matches legacy/null-tenant nodes → output-identical single-tenant.
      const tenant = resolveTenant(tenantId);
      const result = await session.run(
        `MATCH (s:Semantic)
         WHERE $tag IN s.tags
           AND ${tenantWhere('s', tenant)}
         RETURN s { .*, embedding: null } AS s
         ORDER BY s.confidence DESC, s.updated_at DESC
         LIMIT $limit`,
        { tag, limit: neo4j.int(limit), [TENANT_PARAM]: tenant },
      );
      return result.records.map((r) => mapSemanticNode(nodeProps(r.get('s'))));
    } finally {
      await session.close();
    }
  }

  async byScope(scope: QueryScope): Promise<SemanticNode[]> {
    scope = snapshotQueryScope(scope);
    const entityIds = normalizeResolvedEntityIds(scope.entityIds);
    const { entities = [], tags = [], limit, asOf } = scope;
    if (entityIds !== undefined && entityIds.length === 0) return [];
    const session = this.driver.session();
    try {
      // Build query that handles entities and/or tags with DISTINCT results
      let cypher: string;
      const tenantId = resolveTenant(scope.tenantId);
      const params: Record<string, unknown> = { limit: neo4j.int(limit), [TENANT_PARAM]: tenantId };
      if (asOf) params.asOf = asOf;

      const relFilter = activeRelationshipFilter('r', asOf ? 'asOf' : undefined);
      const tFilter = tenantWhere('s', tenantId); // mandatory tenant isolation

      // Structural tenancy: project scope is a hard predicate, never advisory.
      let pFilter = '';
      if (scope.projectScope) {
        params.projectScope = scope.projectScope.toLowerCase();
        pFilter = ` AND ${projectScopeWhere('s')}`;
      }

      if (entityIds !== undefined && tags.length > 0) {
        params.entityIds = entityIds;
        params.tags = tags;
        cypher = `
          MATCH (s:Semantic)-[r:ABOUT]->(e:Entity)
          WHERE e.id IN $entityIds AND ANY(t IN $tags WHERE toLower(t) IN [x IN s.tags | toLower(x)])
            AND ${relFilter} AND ${tFilter}${pFilter}
          WITH s, head(collect(e.id)) AS entityId
          RETURN entityId, s { .id, .content, .confidence, .signal_count, .created_at, .updated_at,
            .decay_class, .memory_type, .tags, .scope, .tenant_id, embedding: null } AS s
          ORDER BY s.confidence DESC, s.updated_at DESC, s.id ASC
          LIMIT $limit`;
      } else if (entityIds !== undefined) {
        params.entityIds = entityIds;
        cypher = `
          MATCH (s:Semantic)-[r:ABOUT]->(e:Entity)
          WHERE e.id IN $entityIds
            AND ${relFilter} AND ${tFilter}${pFilter}
          WITH s, head(collect(e.id)) AS entityId
          RETURN entityId, s { .id, .content, .confidence, .signal_count, .created_at, .updated_at,
            .decay_class, .memory_type, .tags, .scope, .tenant_id, embedding: null } AS s
          ORDER BY s.confidence DESC, s.updated_at DESC, s.id ASC
          LIMIT $limit`;
      } else if (entities.length > 0 && tags.length > 0) {
        params.entities = entities;
        params.tags = tags;
        cypher = `
          MATCH (s:Semantic)-[r:ABOUT]->(e:Entity)
          WHERE e.name IN $entities AND ANY(t IN $tags WHERE toLower(t) IN [x IN s.tags | toLower(x)])
            AND ${relFilter} AND ${tFilter}${pFilter}
          RETURN DISTINCT s { .*, embedding: null } AS s
          ORDER BY s.confidence DESC, s.updated_at DESC
          LIMIT $limit`;
      } else if (entities.length > 0) {
        params.entities = entities;
        cypher = `
          MATCH (s:Semantic)-[r:ABOUT]->(e:Entity)
          WHERE e.name IN $entities
            AND ${relFilter} AND ${tFilter}${pFilter}
          RETURN DISTINCT s { .*, embedding: null } AS s
          ORDER BY s.confidence DESC, s.updated_at DESC
          LIMIT $limit`;
      } else if (tags.length > 0) {
        params.tags = tags;
        cypher = `
          MATCH (s:Semantic)
          WHERE ANY(t IN $tags WHERE toLower(t) IN [x IN s.tags | toLower(x)]) AND ${tFilter}${pFilter}
          RETURN DISTINCT s { .*, embedding: null } AS s
          ORDER BY s.confidence DESC, s.updated_at DESC
          LIMIT $limit`;
      } else {
        // No filters — return most-confident semantics (still tenant-scoped)
        cypher = `
          MATCH (s:Semantic)
          WHERE ${tFilter}${pFilter}
          RETURN s { .*, embedding: null } AS s
          ORDER BY s.confidence DESC, s.updated_at DESC
          LIMIT $limit`;
      }

      const result = await session.run(cypher, params);
      if (entityIds !== undefined) {
        return parseStableScopedSemanticResult(
          result, entityIds, limit, tenantId,
          typeof params.projectScope === 'string' ? params.projectScope : undefined,
        );
      }
      return result.records.map((r) => mapSemanticNode(nodeProps(r.get('s'))));
    } finally {
      await session.close();
    }
  }

  async byVector(
    embedding: number[],
    limit: number,
    tenantId?: string,
    projectScope?: string,
  ): Promise<Array<SemanticNode & { score: number }>> {
    const session = this.driver.session();
    try {
      const tenant = resolveTenant(tenantId);
      // The vector index returns the K nearest BEFORE filtering, so whenever a
      // post-filter applies (non-default tenant, or a project scope) we
      // over-fetch and then filter, otherwise the scope could be starved by
      // another project's nearer neighbours.
      const filtered = !isDefaultTenant(tenant) || !!projectScope;
      const fetch = filtered ? Math.min(limit * 5, 200) : limit;
      const params: Record<string, unknown> = {
        fetch: neo4j.int(fetch), limit: neo4j.int(limit), embedding, [TENANT_PARAM]: tenant,
      };
      // Structural tenancy: the vector channel enforces project scope too —
      // similarity alone must never cross a project boundary.
      let pFilter = '';
      if (projectScope) {
        params.projectScope = projectScope.toLowerCase();
        pFilter = ` AND ${projectScopeWhere('node')}`;
      }
      const result = await session.run(
        `CALL db.index.vector.queryNodes('semantic_embedding', $fetch, $embedding)
         YIELD node, score
         WHERE ${tenantWhere('node', tenant)}${pFilter}
         RETURN node { .*, embedding: null } AS node, score
         LIMIT $limit`,
        params,
      );
      return result.records.map((r) => ({
        ...mapSemanticNode(nodeProps(r.get('node'))),
        score: r.get('score') as number,
      }));
    } finally {
      await session.close();
    }
  }

  /**
   * Vector similarity over EPISODIC memories — the raw captured episodes.
   *
   * The episodic_embedding index is populated at store() time but was queried by
   * nothing, so freshly captured knowledge stayed unrecallable until (if ever)
   * consolidated into a Semantic. This channel surfaces episodes directly, so a
   * berry_load/context/ask recalls what was just stored. Mirrors byVector's
   * tenant + project-scope enforcement: similarity alone must never cross a
   * tenant or project boundary. Returns scope/tags/tenant so the caller's
   * inProjectScope guard can re-check.
   */
  async byVectorEpisodic(
    embedding: number[],
    limit: number,
    tenantId?: string,
    projectScope?: string,
  ): Promise<Array<EpisodicNode & { score: number }>> {
    const session = this.driver.session();
    try {
      const tenant = resolveTenant(tenantId);
      // Over-fetch then post-filter when a scope/tenant predicate applies, so the
      // project isn't starved by another project's nearer neighbours (see byVector).
      const filtered = !isDefaultTenant(tenant) || !!projectScope;
      const fetch = filtered ? Math.min(limit * 5, 200) : limit;
      const params: Record<string, unknown> = {
        fetch: neo4j.int(fetch), limit: neo4j.int(limit), embedding, [TENANT_PARAM]: tenant,
      };
      let pFilter = '';
      if (projectScope) {
        params.projectScope = projectScope.toLowerCase();
        pFilter = ` AND ${projectScopeWhere('node')}`;
      }
      const result = await session.run(
        `CALL db.index.vector.queryNodes('episodic_embedding', $fetch, $embedding)
         YIELD node, score
         WHERE ${tenantWhere('node', tenant)}${pFilter}
         RETURN node { .*, embedding: null } AS node, score
         LIMIT $limit`,
        params,
      );
      return result.records.map((r) => {
        const props = nodeProps(r.get('node'));
        return {
          ...mapEpisodicNode(props),
          ...(props.scope != null && { scope: props.scope as string }),
          tags: Array.isArray(props.tags) ? (props.tags as string[]) : [],
          tenant_id: (props.tenant_id as string | undefined) ?? DEFAULT_TENANT,
          score: r.get('score') as number,
        };
      });
    } finally {
      await session.close();
    }
  }

  async byFacts(entityName: string, options?: TemporalOptions, tenantId?: string): Promise<FactNode[]> {
    const session = this.driver.session();
    try {
      const timeMode = options?.time_mode ?? 'current';
      const tenant = resolveTenant(tenantId);
      const tFilter = tenantWhere('f', tenant); // tenant isolation
      let cypher: string;
      const params: Record<string, unknown> = { entityName, [TENANT_PARAM]: tenant };

      switch (timeMode) {
        case 'current':
          cypher = `
            MATCH (f:Fact)-[:FACT_ABOUT]->(e:Entity {name: $entityName})
            WHERE f.status = 'active' AND f.invalid_at IS NULL
              AND ${tFilter}
            RETURN f
            ORDER BY f.confidence DESC, f.valid_at DESC`;
          break;

        case 'historical':
          params.as_of = options?.as_of ?? new Date().toISOString();
          cypher = `
            MATCH (f:Fact)-[:FACT_ABOUT]->(e:Entity {name: $entityName})
            WHERE f.valid_at <= $as_of AND (f.invalid_at IS NULL OR f.invalid_at > $as_of)
              AND ${tFilter}
            RETURN f
            ORDER BY f.confidence DESC, f.valid_at DESC`;
          break;

        case 'interval':
          params.from = options?.from ?? '1970-01-01T00:00:00.000Z';
          params.to = options?.to ?? new Date().toISOString();
          cypher = `
            MATCH (f:Fact)-[:FACT_ABOUT]->(e:Entity {name: $entityName})
            WHERE f.valid_at <= $to AND (f.invalid_at IS NULL OR f.invalid_at > $from)
              AND ${tFilter}
            RETURN f
            ORDER BY f.confidence DESC, f.valid_at DESC`;
          break;

        case 'evolution':
          if (options?.include_invalidated) {
            cypher = `
              MATCH (f:Fact)-[:FACT_ABOUT]->(e:Entity {name: $entityName})
              WHERE ${tFilter}
              RETURN f
              ORDER BY f.valid_at ASC`;
          } else {
            cypher = `
              MATCH (f:Fact)-[:FACT_ABOUT]->(e:Entity {name: $entityName})
              WHERE f.status <> 'invalidated'
                AND ${tFilter}
              RETURN f
              ORDER BY f.valid_at ASC`;
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

  async byEntityWithFacts(
    entityName: string,
    options?: TemporalOptions,
    tenantId?: string,
  ): Promise<{ semantics: SemanticNode[]; facts: FactNode[]; episodes: EpisodicNode[] }> {
    let semantics: SemanticNode[];
    let episodes: EpisodicNode[];

    const asOf = options?.as_of;
    // Semantic and Episodic are tenant-scoped nodes — scope both reads with
    // tenantWhere (the Fact half already delegates to the tenant-scoped byFacts).
    // Default tenant matches legacy/null-tenant nodes → output-identical
    // single-tenant. $tenantId is a bound parameter.
    const tenant = resolveTenant(tenantId);

    // Query semantics and episodes in one session
    const session = this.driver.session();
    try {
      const aboutFilter = activeRelationshipFilter('r', asOf ? 'asOf' : undefined);
      const semParams: Record<string, unknown> = { entityName, [TENANT_PARAM]: tenant };
      if (asOf) semParams.asOf = asOf;

      const semanticResult = await session.run(
        `MATCH (s:Semantic)-[r:ABOUT]->(e:Entity {name: $entityName})
         WHERE ${aboutFilter}
           AND ${tenantWhere('s', tenant)}
         RETURN s { .*, embedding: null } AS s
         ORDER BY s.confidence DESC, s.updated_at DESC`,
        semParams,
      );
      semantics = semanticResult.records.map((r) =>
        mapSemanticNode(nodeProps(r.get('s'))),
      );

      const refFilter = activeRelationshipFilter('r', asOf ? 'asOf' : undefined);
      const epParams: Record<string, unknown> = { entityName, [TENANT_PARAM]: tenant };
      if (asOf) epParams.asOf = asOf;

      const episodeResult = await session.run(
        `MATCH (ep:Episodic)-[r:REFERENCES]->(e:Entity {name: $entityName})
         WHERE ${refFilter}
           AND ${tenantWhere('ep', tenant)}
         RETURN ep
         ORDER BY ep.created_at DESC`,
        epParams,
      );
      episodes = episodeResult.records.map((r) =>
        mapEpisodicNode(r.get('ep').properties),
      );
    } finally {
      await session.close();
    }

    // Query facts via byFacts (opens its own session)
    const facts = await this.byFacts(entityName, options, tenantId);

    return { semantics, facts, episodes };
  }

  /**
   * Graph-structural retrieval: expand from seed entities via ABOUT and SAME_EPISODE edges.
   * Pulls in connected knowledge that vector/fulltext search alone would miss.
   *
   * Traversal paths:
   * - Entity <-[ABOUT]- Semantic -[ABOUT]-> Entity (semantic neighbors)
   * - Entity <-[FACT_ABOUT]- Fact -[SAME_EPISODE]- Fact -[FACT_ABOUT]-> Entity (co-extracted fact neighbors)
   *
   * Returns deduplicated semantic nodes scored by distance from seed (closer = higher score).
   */
  async expandByGraph(
    entityNames: string[],
    depth: number = 1,
    maxPerHop: number = 5,
    asOf?: string,
    tenantId?: string,
  ): Promise<SemanticNode[]> {
    if (entityNames.length === 0) return [];

    // Scope the RETURNED Semantic nodes to the caller's tenant (Semantic is a
    // tenant-scoped node). Without this, a tenant's berry_load graph expansion
    // could surface another tenant's semantics about a shared entity — the
    // downstream inProjectScope guard filters by project scope, NOT tenant_id.
    // Default tenant matches legacy/null-tenant nodes → output-identical in
    // single-tenant. The bridge/seed nodes are traversal-only (never returned),
    // so scoping the returned node is both necessary and sufficient to stop the
    // content leak. $tenantId is a bound parameter (injection-safe).
    const tenant = resolveTenant(tenantId);
    const session = this.driver.session();
    try {
      const relFilter = activeRelationshipFilter('r', asOf ? 'asOf' : undefined);
      const params: Record<string, unknown> = {
        entityNames,
        maxPerHop: neo4j.int(maxPerHop),
        [TENANT_PARAM]: tenant,
      };
      if (asOf) params.asOf = asOf;

      // Path 1: Semantic neighbors — find semantics ABOUT other entities connected
      // via shared semantic nodes to the seed entities
      const semanticNeighborCypher = depth >= 2
        ? `MATCH (e:Entity)<-[r:ABOUT]-(s:Semantic)-[r2:ABOUT]->(e2:Entity)<-[r3:ABOUT]-(s2:Semantic)
           WHERE toLower(e.name) IN $lowerNames
             AND ${relFilter}
             AND r2.invalid_at IS NULL
             AND r3.invalid_at IS NULL
             AND NOT toLower(e2.name) IN $lowerNames
             AND ${tenantWhere('s2', tenant)}
           RETURN DISTINCT s2 { .*, embedding: null } AS node, 0.2 AS hopScore
           ORDER BY node.confidence DESC
           LIMIT $maxPerHop`
        : `MATCH (e:Entity)<-[r:ABOUT]-(s:Semantic)-[r2:ABOUT]->(e2:Entity)<-[r3:ABOUT]-(s2:Semantic)
           WHERE toLower(e.name) IN $lowerNames
             AND ${relFilter}
             AND r2.invalid_at IS NULL
             AND r3.invalid_at IS NULL
             AND NOT toLower(e2.name) IN $lowerNames
             AND ${tenantWhere('s2', tenant)}
           RETURN DISTINCT s2 { .*, embedding: null } AS node, 0.3 AS hopScore
           ORDER BY node.confidence DESC
           LIMIT $maxPerHop`;

      // Path 2: Co-extracted fact neighbors — traverse SAME_EPISODE edges on facts
      const factNeighborCypher =
        `MATCH (e:Entity)<-[:FACT_ABOUT]-(f1:Fact)-[:SAME_EPISODE]-(f2:Fact)-[:FACT_ABOUT]->(e2:Entity)<-[r:ABOUT]-(s:Semantic)
         WHERE toLower(e.name) IN $lowerNames
           AND NOT toLower(e2.name) IN $lowerNames
           AND ${relFilter}
           AND ${tenantWhere('s', tenant)}
         RETURN DISTINCT s { .*, embedding: null } AS node, 0.25 AS hopScore
         ORDER BY node.confidence DESC
         LIMIT $maxPerHop`;

      const lowerNames = entityNames.map(n => n.toLowerCase());
      const paramsWithLower = { ...params, lowerNames };

      // Run the two neighbor expansions in parallel, but each on its OWN session
      // — a single Neo4j session permits only one concurrent query (a shared
      // session throws "Queries cannot be run … with an open transaction").
      const factSession = this.driver.session();
      const [semResult, factResult] = await Promise.all([
        session.run(semanticNeighborCypher, paramsWithLower),
        factSession.run(factNeighborCypher, paramsWithLower).finally(() => factSession.close()),
      ]);

      const seen = new Set<string>();
      const results: SemanticNode[] = [];

      for (const record of semResult.records) {
        const node = mapSemanticNode(nodeProps(record.get('node')));
        if (!seen.has(node.id)) {
          seen.add(node.id);
          results.push(node);
        }
      }

      for (const record of factResult.records) {
        const node = mapSemanticNode(nodeProps(record.get('node')));
        if (!seen.has(node.id)) {
          seen.add(node.id);
          results.push(node);
        }
      }

      return results;
    } finally {
      await session.close();
    }
  }

  /**
   * @param timeoutMs Optional bounded transaction timeout in milliseconds, passed
   *   to neo4j-driver as `transactionConfig.timeout` so the server self-aborts a
   *   runaway query (e.g. a catastrophic `=~` regex) instead of pinning the shared
   *   Neo4j instance. OPT-72: when omitted, a generous DEFAULT
   *   (MEMBERRY_RAW_CYPHER_TIMEOUT_MS, 15s) is applied — so EVERY raw path,
   *   including berry_query, is bounded (OPT-07 only timed the grep path). An
   *   explicit timeoutMs (e.g. the tighter grep bound) still wins.
   */
  async rawCypher(cypher: string, limit: number, params: Record<string, unknown> = {}, timeoutMs?: number): Promise<Record<string, unknown>[]> {
    // Layer 1: static validation rejects mutating constructs up front.
    validateReadOnlyCypher(cypher);

    // Layer 2: server-enforced read mode. Even if validation were bypassed, a
    // READ transaction makes Neo4j itself reject any write (CREATE/MERGE/SET/…),
    // so berry_query can never mutate the graph.
    const session = this.driver.session({ defaultAccessMode: neo4j.session.READ });
    try {
      const safeLimit = normalizeRawCypherLimit(limit);
      const finalCypher = `CALL {\n${stripTrailingSemicolons(cypher)}\n}\nRETURN * LIMIT ${safeLimit}`;

      // Layer 3 (OPT-07 + OPT-72): bounded server-side transaction timeout on
      // EVERY raw query. An explicit timeoutMs (e.g. the tightened grep bound)
      // wins; otherwise the generous default is applied so even berry_query's raw
      // `=~` self-aborts instead of pinning the shared Neo4j unbounded. Passed as
      // a neo4j Integer (this file's convention for ints handed to the driver).
      const effectiveTimeoutMs =
        timeoutMs != null && Number.isFinite(timeoutMs) && timeoutMs > 0
          ? timeoutMs
          : defaultRawCypherTimeoutMs();
      const result = await session.run(finalCypher, params, { timeout: neo4j.int(effectiveTimeoutMs) });
      return result.records.map((r) => {
        const obj: Record<string, unknown> = {};
        for (const key of r.keys) {
          const strKey = String(key);
          const val = r.get(strKey);
          // Unwrap Neo4j node to its properties when applicable
          if (val !== null && typeof val === 'object' && 'properties' in val) {
            obj[strKey] = val.properties as Record<string, unknown>;
          } else {
            obj[strKey] = val;
          }
        }
        return obj;
      });
    } finally {
      await session.close();
    }
  }
}

// ─── helpers ────────────────────────────────────────────────────────────────

// A semantic read returns either a Node (driver exposes `.properties`) or a map
// projection — `s {.*, embedding: null}` — used to keep the 1536-float embedding
// OFF the read wire (no consumer of these reads uses it; GDS reads the stored
// property via its own Cypher and getById/getByIds keep it). Normalise both to a
// plain property bag so the mappers (and mock-based unit tests) work either way.
const MAX_STABLE_QUERY_RECORDS = 200;
const MAX_STABLE_PROPERTY_KEYS = 64;
const MAX_STABLE_NESTED_VALUES = 2048;
const MAX_STABLE_QUERY_STRING_BYTES = 65_536;
const MAX_STABLE_QUERY_TOTAL_STRING_BYTES = 2 * 1024 * 1024;
const MAX_STABLE_QUERY_TOTAL_VALUES = 16_384;
const STABLE_SEMANTIC_KEYS = Object.freeze([
  'id', 'content', 'confidence', 'signal_count', 'created_at', 'updated_at',
  'decay_class', 'memory_type', 'tags', 'scope', 'tenant_id', 'embedding',
] as const);
type StableQueryBudget = { values: number; stringBytes: number };

function stableQueryInvalid(): never {
  throw new Error('stable_query_result_invalid');
}

function stableDataValue(object: object, key: PropertyKey): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(object, key);
  if (!descriptor || !('value' in descriptor)) return stableQueryInvalid();
  return descriptor.value;
}

function createStableQueryBudget(): StableQueryBudget {
  return { values: 0, stringBytes: 0 };
}

function consumeStableQueryValue(budget: StableQueryBudget, value: unknown): void {
  budget.values += 1;
  if (budget.values > MAX_STABLE_QUERY_TOTAL_VALUES) return stableQueryInvalid();
  if (typeof value === 'string') {
    const bytes = Buffer.byteLength(value, 'utf8');
    if (bytes > MAX_STABLE_QUERY_STRING_BYTES) return stableQueryInvalid();
    budget.stringBytes += bytes;
    if (budget.stringBytes > MAX_STABLE_QUERY_TOTAL_STRING_BYTES) return stableQueryInvalid();
  }
}

function snapshotStableDenseArray(value: unknown, maxLength: number): unknown[] {
  if (isProxy(value) || !Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    return stableQueryInvalid();
  }
  const length = stableDataValue(value, 'length');
  if (!Number.isInteger(length) || (length as number) < 0 || (length as number) > maxLength) {
    return stableQueryInvalid();
  }
  const keys = Reflect.ownKeys(value);
  if (keys.length !== (length as number) + 1 || keys[keys.length - 1] !== 'length') {
    return stableQueryInvalid();
  }
  const snapshot: unknown[] = [];
  for (let index = 0; index < (length as number); index += 1) {
    if (keys[index] !== String(index)) return stableQueryInvalid();
    snapshot.push(stableDataValue(value, String(index)));
  }
  return snapshot;
}

function snapshotStableProjection(value: unknown, budget: StableQueryBudget): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || isProxy(value)) return stableQueryInvalid();
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return stableQueryInvalid();
  const keys = Reflect.ownKeys(value);
  if (keys.length > MAX_STABLE_PROPERTY_KEYS) return stableQueryInvalid();
  const snapshot: Record<string, unknown> = {};
  for (const key of keys) {
    if (typeof key !== 'string') return stableQueryInvalid();
    const rawItem = stableDataValue(value, key);
    const item = key === 'signal_count'
      ? normalizeOfficialStableSignalCount(rawItem)
      : rawItem;
    consumeStableQueryValue(budget, item);
    if (Array.isArray(item)) {
      const items = snapshotStableDenseArray(item, MAX_STABLE_NESTED_VALUES);
      for (const nested of items) consumeStableQueryValue(budget, nested);
      snapshot[key] = items;
    } else if (item === null || ['string', 'number', 'boolean', 'undefined'].includes(typeof item)) {
      snapshot[key] = item;
    } else {
      return stableQueryInvalid();
    }
  }
  return snapshot;
}

function normalizeOfficialStableSignalCount(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0) return stableQueryInvalid();
    return value;
  }
  if (value === null || typeof value !== 'object' || isProxy(value)
    || Object.getPrototypeOf(value) !== neo4j.Integer.prototype) return stableQueryInvalid();
  const keys = Reflect.ownKeys(value);
  if (keys.length !== 2 || keys[0] !== 'low' || keys[1] !== 'high') return stableQueryInvalid();
  const lowDescriptor = Object.getOwnPropertyDescriptor(value, 'low');
  const highDescriptor = Object.getOwnPropertyDescriptor(value, 'high');
  if (!lowDescriptor || !highDescriptor || !('value' in lowDescriptor) || !('value' in highDescriptor)
    || lowDescriptor.enumerable !== true || lowDescriptor.writable !== true || lowDescriptor.configurable !== true
    || highDescriptor.enumerable !== true || highDescriptor.writable !== true || highDescriptor.configurable !== true) {
    return stableQueryInvalid();
  }
  const low = lowDescriptor.value;
  const high = highDescriptor.value;
  if (!Number.isInteger(low) || low < -0x8000_0000 || low > 0x7fff_ffff
    || !Number.isInteger(high) || high < 0 || high > 0x7fff_ffff) return stableQueryInvalid();
  const count = high * 0x1_0000_0000 + (low >>> 0);
  if (!Number.isSafeInteger(count)) return stableQueryInvalid();
  return count;
}

function snapshotStableRecords(
  result: unknown,
  fields: readonly string[],
  maxRecords: number,
  budget: StableQueryBudget,
): unknown[][] {
  if (result === null || typeof result !== 'object' || isProxy(result)) return stableQueryInvalid();
  const records = snapshotStableDenseArray(
    stableDataValue(result, 'records'),
    Math.min(MAX_STABLE_QUERY_RECORDS, Math.max(0, maxRecords)),
  );
  return records.map((record) => {
    if (record === null || typeof record !== 'object' || isProxy(record)
      || Object.getPrototypeOf(record) !== Neo4jRecord.prototype) return stableQueryInvalid();
    const recordKeys = Reflect.ownKeys(record);
    if (recordKeys.length !== 4 || !['keys', 'length', '_fields', '_fieldLookup'].every((key) => recordKeys.includes(key))) {
      return stableQueryInvalid();
    }
    if (stableDataValue(record, 'length') !== fields.length) return stableQueryInvalid();
    const keys = snapshotStableDenseArray(stableDataValue(record, 'keys'), fields.length);
    const values = snapshotStableDenseArray(stableDataValue(record, '_fields'), fields.length);
    if (keys.length !== fields.length || fields.some((field, index) => keys[index] !== field)) {
      return stableQueryInvalid();
    }
    const lookup = stableDataValue(record, '_fieldLookup');
    if (lookup === null || typeof lookup !== 'object' || isProxy(lookup)) return stableQueryInvalid();
    const lookupProto = Object.getPrototypeOf(lookup);
    if (lookupProto !== Object.prototype && lookupProto !== null) return stableQueryInvalid();
    const lookupKeys = Reflect.ownKeys(lookup);
    if (lookupKeys.length !== fields.length || fields.some((field) => !lookupKeys.includes(field))) {
      return stableQueryInvalid();
    }
    for (let index = 0; index < fields.length; index += 1) {
      if (stableDataValue(lookup, fields[index]!) !== index) return stableQueryInvalid();
    }
    for (const value of values) consumeStableQueryValue(budget, value);
    return values;
  });
}

function hasExactStableKeys(props: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Reflect.ownKeys(props);
  return keys.length === expected.length && expected.every((key) => keys.includes(key));
}

function validateStableTenantProject(
  props: Record<string, unknown>, tenant: string, projectScope: string | undefined,
): void {
  const nodeTenant = props.tenant_id;
  if (tenant === DEFAULT_TENANT
    ? nodeTenant !== undefined && nodeTenant !== null && nodeTenant !== DEFAULT_TENANT
    : nodeTenant !== tenant) return stableQueryInvalid();
  if (!projectScope) return;
  const normalizedProject = projectScope.toLowerCase();
  if (typeof props.scope === 'string' && props.scope.length > 0) {
    if (props.scope.toLowerCase() !== normalizedProject) return stableQueryInvalid();
    return;
  }
  if (!Array.isArray(props.tags)
    || !(props.tags as unknown[]).some((tag) => typeof tag === 'string' && tag.toLowerCase() === normalizedProject)) {
    return stableQueryInvalid();
  }
}

function validateStableSemanticProjection(
  props: Record<string, unknown>, tenant: string, projectScope: string | undefined,
): void {
  if (!hasExactStableKeys(props, STABLE_SEMANTIC_KEYS)
    || typeof props.id !== 'string' || !SAFE_ENTITY_ID.test(props.id)
    || typeof props.content !== 'string'
    || typeof props.confidence !== 'number' || !Number.isFinite(props.confidence)
    || typeof props.signal_count !== 'number' || !Number.isSafeInteger(props.signal_count) || props.signal_count < 0
    || typeof props.created_at !== 'string' || typeof props.updated_at !== 'string'
    || typeof props.decay_class !== 'string'
    || (props.memory_type !== null && props.memory_type !== undefined && typeof props.memory_type !== 'string')
    || !Array.isArray(props.tags) || !(props.tags as unknown[]).every((tag) => typeof tag === 'string')
    || (props.scope !== null && props.scope !== undefined && typeof props.scope !== 'string')
    || props.embedding !== null) return stableQueryInvalid();
  validateStableTenantProject(props, tenant, projectScope);
}

function stableScopedOrderFollows(previous: SemanticNode, current: SemanticNode): boolean {
  if (current.confidence > previous.confidence) return false;
  if (current.confidence < previous.confidence) return true;
  const updated = compareStableCodeUnits(current.updated_at, previous.updated_at);
  if (updated > 0) return false;
  if (updated < 0) return true;
  return compareStableCodeUnits(current.id, previous.id) > 0;
}

function parseStableScopedSemanticResult(
  result: unknown,
  entityIds: readonly string[],
  limit: number,
  tenant: string,
  projectScope: string | undefined,
): SemanticNode[] {
  const budget = createStableQueryBudget();
  const allowed = new Set(entityIds);
  const seen = new Set<string>();
  let previous: SemanticNode | undefined;
  return snapshotStableRecords(result, ['entityId', 's'], limit, budget).map(([entityId, raw]) => {
    if (typeof entityId !== 'string' || !allowed.has(entityId)) return stableQueryInvalid();
    const props = snapshotStableProjection(raw, budget);
    validateStableSemanticProjection(props, tenant, projectScope);
    if (seen.has(props.id as string)) {
      return stableQueryInvalid();
    }
    seen.add(props.id as string);
    const node = mapSemanticNode(props);
    if (previous && !stableScopedOrderFollows(previous, node)) return stableQueryInvalid();
    previous = node;
    return node;
  });
}

function compareStableCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function nodeProps(v: unknown): Record<string, unknown> {
  const o = v as { properties?: Record<string, unknown> } | null;
  return o && o.properties ? o.properties : (v as Record<string, unknown>);
}

function mapSemanticNode(props: Record<string, unknown>): SemanticNode {
  return {
    id: props.id as string,
    content: props.content as string,
    confidence: props.confidence as number,
    signal_count: normalizeSemanticSignalCount(props.signal_count),
    created_at: props.created_at as string,
    updated_at: props.updated_at as string,
    decay_class: props.decay_class as SemanticNode['decay_class'],
    memory_type: (props.memory_type as SemanticNode['memory_type']) ?? undefined,
    tags: (props.tags as string[]) ?? [],
    ...(props.scope != null && { scope: props.scope as string }),
    embedding: props.embedding != null ? (props.embedding as number[]) : undefined,
  };
}

function mapFactNode(props: Record<string, unknown>): FactNode {
  return {
    id: props.id as string,
    subject: props.subject as string,
    predicate: props.predicate as string,
    object: props.object as string,
    entity_id: (props.entity_id as string | null) ?? null,
    source_episode_ids: (props.source_episode_ids as string[]) ?? [],
    valid_at: props.valid_at as string,
    invalid_at: (props.invalid_at as string) ?? null,
    confidence: props.confidence as number,
    status: props.status as FactNode['status'],
    supersedes_fact_id: (props.supersedes_fact_id as string) ?? null,
    scope: props.scope as FactNode['scope'],
    tags: (props.tags as string[]) ?? [],
    created_at: props.created_at as string,
    updated_at: props.updated_at as string,
    ...(typeof props.tenant_id === 'string' && { tenant_id: props.tenant_id }),
    ...(props.embedding != null && { embedding: props.embedding as number[] }),
  };
}

function mapEpisodicNode(props: Record<string, unknown>): EpisodicNode {
  return {
    id: props.id as string,
    session_id: props.session_id as string,
    agent_id: props.agent_id as string,
    task: props.task as string,
    content: props.content as string,
    outcome: (props.outcome as EpisodicNode['outcome']) ?? undefined,
    memory_type: (props.memory_type as EpisodicNode['memory_type']) ?? undefined,
    created_at: props.created_at as string,
    ttl: props.ttl != null ? (props.ttl as number) : undefined,
    embedding: props.embedding != null ? (props.embedding as number[]) : undefined,
  };
}
