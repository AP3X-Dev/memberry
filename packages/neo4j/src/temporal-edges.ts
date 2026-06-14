// packages/neo4j/src/temporal-edges.ts
// Temporal validity helpers for graph relationships.
// Relationships carry valid_at / invalid_at properties to support
// point-in-time graph queries ("as of time T").

export interface TemporalEdgeProperties {
  valid_at: string;       // ISO timestamp — when this relationship became active
  invalid_at?: string;    // ISO timestamp — when this relationship was superseded (null = active)
}

/**
 * Allowlist of relationship types that may be passed to invalidateRelationship().
 *
 * Neo4j cannot parameterize relationship types, so a dynamic relType is
 * interpolated into the Cypher pattern. To prevent Cypher injection this set is
 * enforced in-function (mirrors VALID_RELATION_TYPES in @memberry/arch
 * relation-store.ts and VALID_SYMBOL_RELS in @memberry/code indexer.ts).
 *
 * It covers every relationship type this codebase creates that may carry
 * temporal validity (valid_at/invalid_at) and could therefore be invalidated:
 *   - ABOUT, REFERENCES, FACT_ABOUT, SAME_EPISODE  (temporal knowledge edges)
 *   - SUPERSEDES, PROMOTED_FROM, SUPERSEDES_FACT     (provenance/evolution)
 *   - REINFORCES, CORRECTS, CONTRADICTS              (signal edges)
 *   - USES, CALLS, EXTENDS, IMPLEMENTS, EMITS, LISTENS  (structural edges)
 *   - SOURCED_FROM, GENERATED_BY, USED_MODEL         (other known graph edges)
 * The goal is to reject arbitrary/injected strings, not to be minimal.
 */
const VALID_REL_TYPES: Set<string> = new Set([
  'ABOUT', 'REFERENCES', 'FACT_ABOUT', 'SAME_EPISODE',
  'SUPERSEDES', 'PROMOTED_FROM', 'SUPERSEDES_FACT',
  'REINFORCES', 'CORRECTS', 'CONTRADICTS',
  'USES', 'CALLS', 'EXTENDS', 'IMPLEMENTS', 'EMITS', 'LISTENS',
  'SOURCED_FROM', 'GENERATED_BY', 'USED_MODEL',
]);

/**
 * Build a SET clause fragment that stamps temporal properties on a relationship.
 * Uses COALESCE so existing valid_at is never overwritten on MERGE.
 *
 * @param alias  Cypher alias for the relationship variable (e.g. 'r')
 * @param paramName  Name of the Cypher parameter holding the timestamp (default 'now')
 * @returns Cypher SET fragment, e.g. "SET r.valid_at = COALESCE(r.valid_at, $now)"
 */
export function temporalSetClause(alias: string, paramName = 'now'): string {
  return `SET ${alias}.valid_at = COALESCE(${alias}.valid_at, $${paramName})`;
}

/**
 * Build a WHERE clause fragment that filters for active relationships.
 *
 * When asOf is provided (via $asOf param), returns relationships that were
 * active at that point in time. Otherwise returns currently-active relationships.
 *
 * Missing valid_at is treated as "always been valid" (epoch).
 * Missing invalid_at is treated as "still active".
 *
 * @param alias  Cypher alias for the relationship variable
 * @param asOfParam  Name of the Cypher parameter for the as-of timestamp, or undefined for "current"
 * @returns Cypher WHERE fragment (without leading WHERE/AND — caller adds that)
 */
export function activeRelationshipFilter(alias: string, asOfParam?: string): string {
  if (asOfParam) {
    return `(COALESCE(${alias}.valid_at, '1970-01-01T00:00:00.000Z') <= $${asOfParam} AND (${alias}.invalid_at IS NULL OR ${alias}.invalid_at > $${asOfParam}))`;
  }
  return `${alias}.invalid_at IS NULL`;
}

/**
 * Invalidate a relationship by setting its invalid_at timestamp.
 * Only invalidates the currently-active instance (where invalid_at IS NULL).
 *
 * @param session  A neo4j session or transaction with a run() method
 * @param fromId   The id property of the source node
 * @param toId     The id property of the target node
 * @param relType  The relationship type. Validated in-function against
 *                 VALID_REL_TYPES before interpolation — Cypher cannot
 *                 parameterize relationship types, so this allowlist is the
 *                 enforced injection guard. Throws on any non-allowlisted value.
 * @param invalidAt  ISO timestamp for invalidation (defaults to now)
 * @throws Error if relType is not in the VALID_REL_TYPES allowlist.
 */
export async function invalidateRelationship(
  session: { run: (query: string, params?: Record<string, unknown>) => Promise<unknown> },
  fromId: string,
  toId: string,
  relType: string,
  invalidAt?: string,
): Promise<void> {
  // Relationship types cannot be parameterized in Cypher — enforce the
  // allowlist here (not via caller convention) to block Cypher injection.
  if (!VALID_REL_TYPES.has(relType)) {
    throw new Error(`Invalid relationship type: ${relType}. Must be one of: ${[...VALID_REL_TYPES].join(', ')}`);
  }
  const now = invalidAt ?? new Date().toISOString();
  await session.run(
    `MATCH (a {id: $fromId})-[r:${relType}]->(b {id: $toId})
     WHERE r.invalid_at IS NULL
     SET r.invalid_at = $now`,
    { fromId, toId, now },
  );
}
