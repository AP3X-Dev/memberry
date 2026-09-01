import { types as nodeUtilTypes } from 'node:util';
import neo4j, { type Driver, type ManagedTransaction } from 'neo4j-driver';
import {
  QUERY_PLAN_CONTRACT_ID,
  QUERY_PLAN_CONTRACT_VERSION,
  QUERY_PLAN_MAX_PROJECT_SCOPES,
  parseQueryPlanV1,
  type QueryPlanResolutionV1,
  type QueryPlanV1,
} from './query-plan.js';

export const SCOPED_ENTITY_RESOLVER_MAX_RESULTS = 32 as const;
export const SCOPED_ENTITY_RESOLVER_MAX_CONTAINMENT_DEPTH = 16 as const;
/** V1 ignores rooted and unrooted containment topology deeper than this bound. */
export const SCOPED_ENTITY_RESOLVER_MAX_AUTHORITATIVE_DEPTH = 64 as const;
export const SCOPED_ENTITY_RESOLVER_TIMEOUT_MS = 3_000 as const;

export type ScopedEntityResolverDiagnosticCode =
  | 'authority_mismatch'
  | 'project_denied'
  | 'entity_not_found'
  | 'entity_ambiguous'
  | 'entity_id_denied'
  | 'entity_multi_project'
  | 'entity_path_ambiguous'
  | 'entity_containment_cycle'
  | 'entity_scope_overflow';

export type ScopedEntityResolverErrorCode =
  | 'invalid_authority'
  | 'invalid_plan'
  | 'invalid_plan_state'
  | 'invalid_record'
  | 'result_over_cap'
  | 'query_failed';

export interface ScopedEntityResolutionResultV1 {
  readonly resolution: QueryPlanResolutionV1;
  readonly diagnostics: readonly ScopedEntityResolverDiagnosticCode[];
}

/**
 * Structurally validated authority supplied separately from plan bytes.
 * Authentication and request-context binding belong to the RET-002C caller;
 * constructing this object alone does not establish an authenticated identity.
 */
export interface ScopedEntityTrustedAuthorityV1 {
  readonly tenantId: string;
  readonly projectScopes: readonly string[];
}

/** Fixed, value-free failure. Caller-supplied identifiers never enter the message. */
export class ScopedEntityResolverError extends Error {
  constructor(readonly code: ScopedEntityResolverErrorCode) {
    super(`scoped_entity_resolver:${code}`);
    this.name = 'ScopedEntityResolverError';
  }
}

type SnapshotRecord = ReadonlyMap<string, unknown>;
type ReadQueryRunner = Pick<ManagedTransaction, 'run'>;

const DEFAULT_TENANT = 'default';
const SAFE_CANONICAL_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const SAFE_TENANT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const CANONICAL_PROJECT_SCOPE = /^project:[a-z0-9][a-z0-9._-]*$/;
const MAX_CANONICAL_ID_LENGTH = 200;
const MAX_TENANT_ID_LENGTH = 128;
const MAX_PROJECT_SCOPE_LENGTH = 136;

// Mirrors the safe display-name canonicalization at the MCP boundary: lowercase
// ASCII alphanumerics, collapse every separator run to one dash, and trim a
// trailing dash. The exact lowercase-name comparison remains alongside it so
// already-canonical project scopes containing dots or underscores retain their
// historical identity.
const PROJECT_DISPLAY_NAME_SLUG = `
reduce(slug = '', character IN split(toLower(project.name), '') |
  CASE
    WHEN character =~ '[a-z0-9]' THEN slug + character
    WHEN slug = '' OR right(slug, 1) = '-' THEN slug
    ELSE slug + '-'
  END)`;

function requireTrustedAuthority(input: ScopedEntityTrustedAuthorityV1): ScopedEntityTrustedAuthorityV1 {
  try {
    if (typeof input !== 'object'
      || input === null
      || nodeUtilTypes.isProxy(input)
      || Array.isArray(input)
      || Object.getPrototypeOf(input) !== Object.prototype) {
      throw new Error();
    }
    const keys = Reflect.ownKeys(input);
    if (keys.length !== 2 || !keys.includes('tenantId') || !keys.includes('projectScopes')) {
      throw new Error();
    }
    const tenantDescriptor = Object.getOwnPropertyDescriptor(input, 'tenantId');
    const projectsDescriptor = Object.getOwnPropertyDescriptor(input, 'projectScopes');
    if (tenantDescriptor === undefined
      || projectsDescriptor === undefined
      || !Object.prototype.hasOwnProperty.call(tenantDescriptor, 'value')
      || !Object.prototype.hasOwnProperty.call(projectsDescriptor, 'value')
      || tenantDescriptor.enumerable !== true
      || projectsDescriptor.enumerable !== true) {
      throw new Error();
    }
    const tenantId = tenantDescriptor.value;
    const projectScopes = projectsDescriptor.value;
    if (typeof tenantId !== 'string'
      || tenantId.length < 1
      || tenantId.length > MAX_TENANT_ID_LENGTH
      || !SAFE_TENANT_ID.test(tenantId)
      || typeof projectScopes !== 'object'
      || projectScopes === null
      || nodeUtilTypes.isProxy(projectScopes)
      || !Array.isArray(projectScopes)
      || Object.getPrototypeOf(projectScopes) !== Array.prototype) {
      throw new Error();
    }
    const lengthDescriptor = Object.getOwnPropertyDescriptor(projectScopes, 'length');
    if (lengthDescriptor === undefined
      || !Object.prototype.hasOwnProperty.call(lengthDescriptor, 'value')
      || !Number.isSafeInteger(lengthDescriptor.value)
      || lengthDescriptor.value < 1
      || lengthDescriptor.value > QUERY_PLAN_MAX_PROJECT_SCOPES
      || Reflect.ownKeys(projectScopes).length !== lengthDescriptor.value + 1) {
      throw new Error();
    }
    const snapshot: string[] = [];
    for (let index = 0; index < lengthDescriptor.value; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(projectScopes, String(index));
      if (descriptor === undefined
        || !Object.prototype.hasOwnProperty.call(descriptor, 'value')
        || descriptor.enumerable !== true
        || typeof descriptor.value !== 'string'
        || descriptor.value.length > MAX_PROJECT_SCOPE_LENGTH
        || !CANONICAL_PROJECT_SCOPE.test(descriptor.value)
        || (index > 0 && snapshot[index - 1]! >= descriptor.value)) {
        throw new Error();
      }
      snapshot.push(descriptor.value);
    }
    return Object.freeze({ tenantId, projectScopes: Object.freeze(snapshot) });
  } catch {
    throw new ScopedEntityResolverError('invalid_authority');
  }
}

/*
 * Project authority is resolved before any Entity candidate query runs. A
 * project root uses the canonical scope suffix against the display name only;
 * aliases cannot broaden it. Named tenants must own the project
 * root directly. The legacy null owner is accepted only for the default tenant;
 * caller-authored memory tags are never an ownership ACL.
 */
const PROJECT_AUTHORITY_QUERY = `
UNWIND $projectScopes AS projectScope
CALL {
  WITH projectScope
  CALL {
    WITH projectScope
    MATCH (tenantProject:Entity {tenant_id: $tenantId})
    WHERE tenantProject.type = 'project'
    RETURN tenantProject AS project
    UNION ALL
    WITH projectScope
    MATCH (legacyProject:Entity)
    WHERE $tenantId = $defaultTenant
      AND legacyProject.tenant_id IS NULL
    WITH legacyProject
    WHERE legacyProject.type = 'project'
    RETURN legacyProject AS project
  }
  WITH projectScope, project,
       toLower(project.name) AS lowerProjectName,
       ${PROJECT_DISPLAY_NAME_SLUG} AS projectSlugWithPossibleTrailingDash
  WITH projectScope, project, lowerProjectName,
       CASE
         WHEN right(projectSlugWithPossibleTrailingDash, 1) = '-'
         THEN left(projectSlugWithPossibleTrailingDash, size(projectSlugWithPossibleTrailingDash) - 1)
         ELSE projectSlugWithPossibleTrailingDash
       END AS projectSlug
  WHERE lowerProjectName = substring(projectScope, 8)
     OR projectSlug = substring(projectScope, 8)
  WITH project
  LIMIT 2
  RETURN collect(project) AS projects
}
WITH projectScope,
     projects,
     size(projects) = 0 AS missing,
     size(projects) > 1 AS duplicate,
     CASE WHEN size(projects) = 1 THEN projects[0] ELSE null END AS project
WITH projectScope, missing, duplicate, project,
     CASE
       WHEN project IS NULL THEN false
       ELSE true
     END AS tenantOwned
RETURN projectScope,
       missing,
       duplicate,
       tenantOwned,
       CASE
         WHEN NOT missing AND NOT duplicate AND tenantOwned THEN project.id
         ELSE null
       END AS projectId
ORDER BY projectScope
LIMIT $projectCap`;

/*
 * Explicit stable IDs are matched only below already-authorized roots. Missing,
 * stale, duplicate, and foreign IDs therefore share one fixed denial and cannot
 * form an existence oracle. V1 treats only authorized-rooted paths through the
 * finite authoritative depth as scope evidence. Deeper or unrooted topology is
 * non-authoritative and cannot broaden or alter the caller's result.
 */
const EXPLICIT_ENTITY_QUERY = `
UNWIND range(0, size($explicitEntityIds) - 1) AS ordinal
WITH ordinal, $explicitEntityIds[ordinal] AS requestedId
CALL {
  WITH ordinal, requestedId
  MATCH candidatePath = (candidateRoot:Entity {type: 'project'})-[:CONTAINS*0..${SCOPED_ENTITY_RESOLVER_MAX_CONTAINMENT_DEPTH}]->(matchedCandidate:Entity)
  WHERE candidateRoot.id IN $authorizedProjectIds
    AND (candidateRoot.tenant_id = $tenantId
      OR (candidateRoot.tenant_id IS NULL AND $tenantId = $defaultTenant))
    AND all(scopedNode IN nodes(candidatePath) WHERE
      (scopedNode.tenant_id IS NULL OR scopedNode.tenant_id = $tenantId)
      AND (scopedNode.type <> 'project' OR scopedNode.id IN $authorizedProjectIds))
  WITH requestedId, matchedCandidate
  WHERE matchedCandidate.id = requestedId
  WITH DISTINCT matchedCandidate
  LIMIT 2
  RETURN collect(matchedCandidate) AS candidates
}
WITH ordinal, requestedId, candidates,
     CASE WHEN size(candidates) = 1 THEN candidates[0] ELSE null END AS candidate
CALL {
  WITH ordinal, requestedId, candidate
  OPTIONAL MATCH acceptedPath = (root:Entity {type: 'project'})-[:CONTAINS*0..${SCOPED_ENTITY_RESOLVER_MAX_CONTAINMENT_DEPTH}]->(candidate)
  WHERE candidate IS NOT NULL
    AND root.id IN $authorizedProjectIds
    AND (root.tenant_id = $tenantId
      OR (root.tenant_id IS NULL AND $tenantId = $defaultTenant))
    AND all(scopedNode IN nodes(acceptedPath) WHERE
      (scopedNode.tenant_id IS NULL OR scopedNode.tenant_id = $tenantId)
      AND (scopedNode.type <> 'project' OR scopedNode.id IN $authorizedProjectIds))
  WITH acceptedPath
  LIMIT 3
  RETURN collect(DISTINCT acceptedPath) AS acceptedPaths
}
CALL {
  WITH ordinal, requestedId
  UNWIND $authorizedProjectIds AS projectId
  MATCH (multiRoot:Entity {type: 'project', id: projectId})
  WHERE EXISTS {
      MATCH multiPath = (multiRoot)-[:CONTAINS*0..${SCOPED_ENTITY_RESOLVER_MAX_CONTAINMENT_DEPTH}]->(:Entity {id: requestedId})
      WHERE all(scopedNode IN nodes(multiPath) WHERE
        (scopedNode.tenant_id IS NULL OR scopedNode.tenant_id = $tenantId)
        AND (scopedNode.type <> 'project' OR scopedNode.id IN $authorizedProjectIds))
    }
    AND (multiRoot.tenant_id = $tenantId
      OR (multiRoot.tenant_id IS NULL AND $tenantId = $defaultTenant))
  WITH DISTINCT projectId
  LIMIT 2
  RETURN count(projectId) > 1 AS multiProject
}
WITH ordinal, requestedId, acceptedPaths, candidates, candidate, multiProject,
     EXISTS {
       MATCH overflowPath = (overflowRoot:Entity {type: 'project'})-[:CONTAINS*${SCOPED_ENTITY_RESOLVER_MAX_CONTAINMENT_DEPTH + 1}..${SCOPED_ENTITY_RESOLVER_MAX_CONTAINMENT_DEPTH + 1}]->(:Entity {id: requestedId})
       WHERE overflowRoot.id IN $authorizedProjectIds
         AND (overflowRoot.tenant_id = $tenantId
           OR (overflowRoot.tenant_id IS NULL AND $tenantId = $defaultTenant))
         AND all(scopedNode IN nodes(overflowPath) WHERE
           (scopedNode.tenant_id IS NULL OR scopedNode.tenant_id = $tenantId)
           AND (scopedNode.type <> 'project' OR scopedNode.id IN $authorizedProjectIds))
     } AS fixedDepthOverflow,
     EXISTS {
       MATCH longPath = (longRoot:Entity {type: 'project'})-[:CONTAINS*${SCOPED_ENTITY_RESOLVER_MAX_CONTAINMENT_DEPTH + 1}..${SCOPED_ENTITY_RESOLVER_MAX_AUTHORITATIVE_DEPTH}]->(longCandidate:Entity {id: requestedId})
       WHERE longRoot.id IN $authorizedProjectIds
         AND (longRoot.tenant_id = $tenantId
           OR (longRoot.tenant_id IS NULL AND $tenantId = $defaultTenant))
         AND all(scopedNode IN nodes(longPath) WHERE
           (scopedNode.tenant_id IS NULL OR scopedNode.tenant_id = $tenantId)
           AND (scopedNode.type <> 'project' OR scopedNode.id IN $authorizedProjectIds))
     } AS longPathOverflow
WITH ordinal, requestedId, acceptedPaths, candidates, candidate, multiProject,
     fixedDepthOverflow, longPathOverflow,
     reduce(pathNodes = [], path IN acceptedPaths | pathNodes + nodes(path)) AS authorizedPathNodes
UNWIND CASE WHEN size(acceptedPaths) = 0 THEN [null] ELSE acceptedPaths END AS acceptedPath
UNWIND CASE WHEN acceptedPath IS NULL THEN [null] ELSE nodes(acceptedPath) END AS pathNode
WITH ordinal, requestedId, acceptedPaths, candidates, candidate, multiProject,
     fixedDepthOverflow, longPathOverflow, authorizedPathNodes,
     EXISTS {
       MATCH containmentCycle = (pathNode)-[:CONTAINS*1..${SCOPED_ENTITY_RESOLVER_MAX_CONTAINMENT_DEPTH + 1}]->(pathNode)
       WHERE all(node IN nodes(containmentCycle) WHERE node IN authorizedPathNodes)
     } AS pathNodeCycle
WITH ordinal, requestedId, acceptedPaths, candidates, candidate, multiProject,
     fixedDepthOverflow, longPathOverflow,
     max(CASE WHEN pathNodeCycle THEN 1 ELSE 0 END) > 0 AS hasContainmentCycle
RETURN right('00' + toString(ordinal), 2) AS ordinal,
       requestedId,
       size(candidates) > 0
         OR fixedDepthOverflow
         OR longPathOverflow AS found,
       size(candidates) = 1
         AND size(acceptedPaths) = 1
         AND all(path IN acceptedPaths WHERE size(relationships(path)) <= ${SCOPED_ENTITY_RESOLVER_MAX_CONTAINMENT_DEPTH})
         AS uniqueAuthorizedPath,
       multiProject,
       fixedDepthOverflow OR longPathOverflow AS depthOverflow,
       hasContainmentCycle AS containmentCycle,
       CASE
         WHEN size(candidates) = 1
           AND size(acceptedPaths) = 1
         THEN candidates[0].id
         ELSE null
       END AS candidateId
ORDER BY ordinal`;

/*
 * Detected text is candidate material only. The query starts from authorized
 * project roots and never falls back to a global result. Exact IDs and names
 * use their indexes before the contained-path proof; the path-first scan remains
 * only as the case-insensitive/alias fallback. A canonical ID remains only a
 * hint here: it must resolve through the same authorized project path as names
 * and aliases. Collisions are returned to the caller and become an explicit
 * ambiguous resolution, never a LIMIT 1 guess.
 */
const HINT_ENTITY_QUERY = `
CALL {
  UNWIND $entityHints AS hint
  CALL {
    WITH hint
    OPTIONAL MATCH idCandidatePath = (idRoot:Entity {type: 'project'})-[:CONTAINS*0..${SCOPED_ENTITY_RESOLVER_MAX_CONTAINMENT_DEPTH}]->(idCandidate:Entity {id: hint})
    WHERE idRoot.id IN $authorizedProjectIds
      AND (idRoot.tenant_id = $tenantId
        OR (idRoot.tenant_id IS NULL AND $tenantId = $defaultTenant))
      AND all(scopedNode IN nodes(idCandidatePath) WHERE
        (scopedNode.tenant_id IS NULL OR scopedNode.tenant_id = $tenantId)
        AND (scopedNode.type <> 'project' OR scopedNode.id IN $authorizedProjectIds))
    RETURN idCandidate AS candidate
    UNION
    WITH hint
    OPTIONAL MATCH nameCandidatePath = (nameRoot:Entity {type: 'project'})-[:CONTAINS*0..${SCOPED_ENTITY_RESOLVER_MAX_CONTAINMENT_DEPTH}]->(nameCandidate:Entity {name: hint})
    WHERE nameRoot.id IN $authorizedProjectIds
      AND (nameRoot.tenant_id = $tenantId
        OR (nameRoot.tenant_id IS NULL AND $tenantId = $defaultTenant))
      AND all(scopedNode IN nodes(nameCandidatePath) WHERE
        (scopedNode.tenant_id IS NULL OR scopedNode.tenant_id = $tenantId)
        AND (scopedNode.type <> 'project' OR scopedNode.id IN $authorizedProjectIds))
    RETURN nameCandidate AS candidate
  }
  WITH hint, [candidate IN collect(DISTINCT candidate) WHERE candidate IS NOT NULL] AS exactCandidates
  CALL {
    WITH hint, exactCandidates
    UNWIND exactCandidates AS candidate
    RETURN candidate
    UNION
    WITH hint, exactCandidates
    WITH hint WHERE size(exactCandidates) = 0
    MATCH candidatePath = (candidateRoot:Entity {type: 'project'})-[:CONTAINS*0..${SCOPED_ENTITY_RESOLVER_MAX_CONTAINMENT_DEPTH}]->(candidate:Entity)
    WHERE candidateRoot.id IN $authorizedProjectIds
      AND (candidateRoot.tenant_id = $tenantId
        OR (candidateRoot.tenant_id IS NULL AND $tenantId = $defaultTenant))
      AND all(scopedNode IN nodes(candidatePath) WHERE
        (scopedNode.tenant_id IS NULL OR scopedNode.tenant_id = $tenantId)
        AND (scopedNode.type <> 'project' OR scopedNode.id IN $authorizedProjectIds))
      AND (toLower(candidate.name) = toLower(hint)
        OR any(alias IN coalesce(candidate.aliases, []) WHERE toLower(alias) = toLower(hint)))
    RETURN candidate
  }
  WITH DISTINCT hint, candidate
  WHERE size($explicitEntityIds) = 0 OR candidate.id IN $explicitEntityIds
  LIMIT $resultCapPlusOne
  RETURN hint, candidate
}
CALL {
  WITH hint, candidate
  MATCH acceptedPath = (root:Entity {type: 'project'})-[:CONTAINS*0..${SCOPED_ENTITY_RESOLVER_MAX_CONTAINMENT_DEPTH}]->(candidate)
  WHERE root.id IN $authorizedProjectIds
    AND (root.tenant_id = $tenantId
      OR (root.tenant_id IS NULL AND $tenantId = $defaultTenant))
    AND all(scopedNode IN nodes(acceptedPath) WHERE
      (scopedNode.tenant_id IS NULL OR scopedNode.tenant_id = $tenantId)
      AND (scopedNode.type <> 'project' OR scopedNode.id IN $authorizedProjectIds))
  WITH root, acceptedPath
  LIMIT 3
  RETURN collect(acceptedPath) AS acceptedPaths
}
CALL {
  WITH hint, candidate
  UNWIND $authorizedProjectIds AS projectId
  MATCH (multiRoot:Entity {type: 'project', id: projectId})
  WHERE EXISTS {
      MATCH multiPath = (multiRoot)-[:CONTAINS*0..${SCOPED_ENTITY_RESOLVER_MAX_CONTAINMENT_DEPTH}]->(candidate)
      WHERE all(scopedNode IN nodes(multiPath) WHERE
        (scopedNode.tenant_id IS NULL OR scopedNode.tenant_id = $tenantId)
        AND (scopedNode.type <> 'project' OR scopedNode.id IN $authorizedProjectIds))
    }
    AND (multiRoot.tenant_id = $tenantId
      OR (multiRoot.tenant_id IS NULL AND $tenantId = $defaultTenant))
  WITH DISTINCT projectId
  LIMIT 2
  RETURN count(projectId) > 1 AS multiProject
}
WITH hint, candidate, acceptedPaths, multiProject,
     EXISTS {
       MATCH overflowPath = (overflowRoot:Entity {type: 'project'})-[:CONTAINS*${SCOPED_ENTITY_RESOLVER_MAX_CONTAINMENT_DEPTH + 1}..${SCOPED_ENTITY_RESOLVER_MAX_CONTAINMENT_DEPTH + 1}]->(candidate)
       WHERE overflowRoot.id IN $authorizedProjectIds
         AND (overflowRoot.tenant_id = $tenantId
           OR (overflowRoot.tenant_id IS NULL AND $tenantId = $defaultTenant))
         AND all(scopedNode IN nodes(overflowPath) WHERE
           (scopedNode.tenant_id IS NULL OR scopedNode.tenant_id = $tenantId)
           AND (scopedNode.type <> 'project' OR scopedNode.id IN $authorizedProjectIds))
     } AS fixedDepthOverflow,
     EXISTS {
       MATCH longPath = (longRoot:Entity {type: 'project'})-[:CONTAINS*${SCOPED_ENTITY_RESOLVER_MAX_CONTAINMENT_DEPTH + 1}..${SCOPED_ENTITY_RESOLVER_MAX_AUTHORITATIVE_DEPTH}]->(candidate)
       WHERE longRoot.id IN $authorizedProjectIds
         AND (longRoot.tenant_id = $tenantId
           OR (longRoot.tenant_id IS NULL AND $tenantId = $defaultTenant))
         AND all(scopedNode IN nodes(longPath) WHERE
           (scopedNode.tenant_id IS NULL OR scopedNode.tenant_id = $tenantId)
           AND (scopedNode.type <> 'project' OR scopedNode.id IN $authorizedProjectIds))
     } AS longPathOverflow
WITH hint, candidate, acceptedPaths, multiProject, fixedDepthOverflow, longPathOverflow,
     reduce(pathNodes = [], path IN acceptedPaths | pathNodes + nodes(path)) AS authorizedPathNodes
UNWIND acceptedPaths AS acceptedPath
UNWIND nodes(acceptedPath) AS pathNode
WITH hint, candidate, acceptedPaths, multiProject, fixedDepthOverflow, longPathOverflow, authorizedPathNodes,
     EXISTS {
       MATCH containmentCycle = (pathNode)-[:CONTAINS*1..${SCOPED_ENTITY_RESOLVER_MAX_CONTAINMENT_DEPTH + 1}]->(pathNode)
       WHERE all(node IN nodes(containmentCycle) WHERE node IN authorizedPathNodes)
     } AS pathNodeCycle
WITH hint, candidate, acceptedPaths, multiProject, fixedDepthOverflow, longPathOverflow,
     max(CASE WHEN pathNodeCycle THEN 1 ELSE 0 END) > 0 AS hasContainmentCycle
RETURN hint,
       size(acceptedPaths) = 1
         AND all(path IN acceptedPaths WHERE size(relationships(path)) <= ${SCOPED_ENTITY_RESOLVER_MAX_CONTAINMENT_DEPTH})
         AS uniqueAuthorizedPath,
       multiProject,
       fixedDepthOverflow OR longPathOverflow AS depthOverflow,
       hasContainmentCycle AS containmentCycle,
       candidate.id AS candidateId
ORDER BY hint, candidate.id`;

function fixedResult(
  state: QueryPlanResolutionV1['state'],
  canonicalEntityIds: readonly string[],
  diagnostics: readonly ScopedEntityResolverDiagnosticCode[],
): ScopedEntityResolutionResultV1 {
  const ids = Object.freeze([...canonicalEntityIds]);
  const resolution = Object.freeze({ state, canonicalEntityIds: ids }) as QueryPlanResolutionV1;
  return Object.freeze({ resolution, diagnostics: Object.freeze([...diagnostics]) });
}

async function withinDeadline<T>(
  operation: () => T | Promise<T>,
  deadline: number,
  onTimeout?: () => void,
): Promise<T> {
  let pending: Promise<T>;
  try {
    pending = Promise.resolve(operation());
  } catch (error) {
    return Promise.reject(error);
  }
  const remaining = deadline - Date.now();
  if (remaining <= 0) {
    onTimeout?.();
    void pending.catch(() => undefined);
    throw new ScopedEntityResolverError('query_failed');
  }
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => {
        onTimeout?.();
        reject(new ScopedEntityResolverError('query_failed'));
      },
      remaining,
    );
    pending.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

class GuardedReadQueryRunner implements ReadQueryRunner {
  private cancelled = false;

  constructor(private readonly transaction: ReadQueryRunner) {}

  cancel(): void {
    this.cancelled = true;
  }

  run: ManagedTransaction['run'] = (query, parameters) => {
    if (this.cancelled) {
      throw new ScopedEntityResolverError('query_failed');
    }
    return this.transaction.run(query, parameters);
  };
}

function requireValidatedPlan(plan: QueryPlanV1): QueryPlanV1 {
  try {
    // RET-002A performs proxy detection and descriptor-only cloning before any
    // field read. Revalidate first so Object.isFrozen or ordinary property
    // access can never invoke a hostile input trap.
    const validated = parseQueryPlanV1(plan);
    const parsedShape = Object.isFrozen(plan)
      && plan.contractId === QUERY_PLAN_CONTRACT_ID
      && plan.contractVersion === QUERY_PLAN_CONTRACT_VERSION
      && Object.isFrozen(plan.authority)
      && Object.isFrozen(plan.authority.callerScopes)
      && Object.isFrozen(plan.authority.callerScopes.projects)
      && Object.isFrozen(plan.authority.callerScopes.repositories)
      && Object.isFrozen(plan.authority.callerScopes.entities)
      && Object.isFrozen(plan.authority.callerScopes.symbols)
      && Object.isFrozen(plan.temporalFrame)
      && Object.isFrozen(plan.evidenceNeeds)
      && Object.isFrozen(plan.hints)
      && Object.isFrozen(plan.hints.repositories)
      && Object.isFrozen(plan.hints.entities)
      && Object.isFrozen(plan.hints.symbols)
      && Object.isFrozen(plan.resolution)
      && Object.isFrozen(plan.resolution.canonicalEntityIds);
    if (!parsedShape) throw new ScopedEntityResolverError('invalid_plan');
    if (validated.resolution.state !== 'unresolved'
      || validated.resolution.canonicalEntityIds.length !== 0) {
      throw new ScopedEntityResolverError('invalid_plan_state');
    }
    return validated;
  } catch (error) {
    if (error instanceof ScopedEntityResolverError) throw error;
    throw new ScopedEntityResolverError('invalid_plan');
  }
}

function denseDataArray(input: unknown, maxItems: number): readonly unknown[] {
  if (typeof input !== 'object' || input === null || nodeUtilTypes.isProxy(input) || !Array.isArray(input)) {
    throw new ScopedEntityResolverError('invalid_record');
  }
  if (Object.getPrototypeOf(input) !== Array.prototype) {
    throw new ScopedEntityResolverError('invalid_record');
  }
  const lengthDescriptor = Object.getOwnPropertyDescriptor(input, 'length');
  if (lengthDescriptor === undefined
    || !Object.prototype.hasOwnProperty.call(lengthDescriptor, 'value')
    || !Number.isSafeInteger(lengthDescriptor.value)
    || (lengthDescriptor.value as number) < 0
    || (lengthDescriptor.value as number) > maxItems) {
    throw new ScopedEntityResolverError('invalid_record');
  }
  const length = lengthDescriptor.value as number;
  const keys = Reflect.ownKeys(input);
  if (keys.length !== length + 1) throw new ScopedEntityResolverError('invalid_record');
  const snapshot: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(input, String(index));
    if (descriptor === undefined
      || !Object.prototype.hasOwnProperty.call(descriptor, 'value')
      || descriptor.enumerable !== true) {
      throw new ScopedEntityResolverError('invalid_record');
    }
    snapshot.push(descriptor.value);
  }
  for (const key of keys) {
    if (key === 'length') continue;
    if (typeof key !== 'string' || !/^(0|[1-9]\d*)$/.test(key) || Number(key) >= length) {
      throw new ScopedEntityResolverError('invalid_record');
    }
  }
  return Object.freeze(snapshot);
}

function ownDataValue(input: object, key: PropertyKey): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(input, key);
  if (descriptor === undefined || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
    throw new ScopedEntityResolverError('invalid_record');
  }
  return descriptor.value;
}

function snapshotRecord(input: unknown, expectedKeys: readonly string[]): SnapshotRecord {
  if (typeof input !== 'object' || input === null || nodeUtilTypes.isProxy(input)) {
    throw new ScopedEntityResolverError('invalid_record');
  }
  if (Object.getPrototypeOf(input) !== neo4j.Record.prototype) {
    throw new ScopedEntityResolverError('invalid_record');
  }
  const ownKeys = Reflect.ownKeys(input);
  const requiredKeys = ['keys', 'length', '_fields', '_fieldLookup'];
  if (ownKeys.length !== requiredKeys.length
    || ownKeys.some((key) => typeof key !== 'string' || !requiredKeys.includes(key))) {
    throw new ScopedEntityResolverError('invalid_record');
  }
  const keys = denseDataArray(ownDataValue(input, 'keys'), expectedKeys.length);
  const fields = denseDataArray(ownDataValue(input, '_fields'), expectedKeys.length);
  const length = ownDataValue(input, 'length');
  const lookup = ownDataValue(input, '_fieldLookup');
  if (length !== expectedKeys.length
    || keys.length !== expectedKeys.length
    || fields.length !== expectedKeys.length
    || typeof lookup !== 'object'
    || lookup === null
    || nodeUtilTypes.isProxy(lookup)
    || Object.getPrototypeOf(lookup) !== Object.prototype) {
    throw new ScopedEntityResolverError('invalid_record');
  }
  const lookupKeys = Reflect.ownKeys(lookup);
  if (lookupKeys.length !== expectedKeys.length) throw new ScopedEntityResolverError('invalid_record');
  const snapshot = new Map<string, unknown>();
  for (let index = 0; index < expectedKeys.length; index += 1) {
    const expected = expectedKeys[index]!;
    if (keys[index] !== expected) throw new ScopedEntityResolverError('invalid_record');
    const lookupDescriptor = Object.getOwnPropertyDescriptor(lookup, expected);
    if (lookupDescriptor === undefined
      || !Object.prototype.hasOwnProperty.call(lookupDescriptor, 'value')
      || lookupDescriptor.enumerable !== true
      || lookupDescriptor.value !== index) {
      throw new ScopedEntityResolverError('invalid_record');
    }
    snapshot.set(expected, fields[index]);
  }
  return snapshot;
}

function snapshotRecords(
  result: unknown,
  maxRecords: number,
  expectedKeys: readonly string[],
): readonly SnapshotRecord[] {
  if (typeof result !== 'object' || result === null || nodeUtilTypes.isProxy(result)) {
    throw new ScopedEntityResolverError('invalid_record');
  }
  const rawRecords = ownDataValue(result, 'records');
  const recordValues = denseDataArray(rawRecords, maxRecords);
  return Object.freeze(recordValues.map((record) => snapshotRecord(record, expectedKeys)));
}

function field(record: SnapshotRecord, key: string): unknown {
  if (!record.has(key)) throw new ScopedEntityResolverError('invalid_record');
  return record.get(key);
}

function booleanField(record: SnapshotRecord, key: string): boolean {
  const value = field(record, key);
  if (typeof value !== 'boolean') throw new ScopedEntityResolverError('invalid_record');
  return value;
}

function requiredString(record: SnapshotRecord, key: string): string {
  const value = field(record, key);
  if (typeof value !== 'string') throw new ScopedEntityResolverError('invalid_record');
  return value;
}

function optionalCanonicalId(record: SnapshotRecord, key: string): string | null {
  const value = field(record, key);
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string'
    || value.length < 1
    || value.length > MAX_CANONICAL_ID_LENGTH
    || !SAFE_CANONICAL_ID.test(value)) {
    throw new ScopedEntityResolverError('invalid_record');
  }
  return value;
}

function safeOrdinal(record: SnapshotRecord): number {
  const value = field(record, 'ordinal');
  if (typeof value !== 'string' || !/^\d{2}$/.test(value)) {
    throw new ScopedEntityResolverError('invalid_record');
  }
  const numeric = Number(value);
  if (Number.isSafeInteger(numeric) && numeric >= 0) return numeric;
  throw new ScopedEntityResolverError('invalid_record');
}

interface ExplicitStatus {
  readonly ordinal: number;
  readonly requestedId: string;
  readonly found: boolean;
  readonly uniqueAuthorizedPath: boolean;
  readonly multiProject: boolean;
  readonly depthOverflow: boolean;
  readonly containmentCycle: boolean;
  readonly candidateId: string | null;
}

function mapExplicit(record: SnapshotRecord): ExplicitStatus {
  return {
    ordinal: safeOrdinal(record),
    requestedId: requiredString(record, 'requestedId'),
    found: booleanField(record, 'found'),
    uniqueAuthorizedPath: booleanField(record, 'uniqueAuthorizedPath'),
    multiProject: booleanField(record, 'multiProject'),
    depthOverflow: booleanField(record, 'depthOverflow'),
    containmentCycle: booleanField(record, 'containmentCycle'),
    candidateId: optionalCanonicalId(record, 'candidateId'),
  };
}

/**
 * Read-only, fail-closed bridge from a validated QueryPlanV1 to stable Entity
 * IDs. The separate authority argument is structurally checked here but must be
 * created from authenticated request context by RET-002C. This resolver is not
 * wired into runtime retrieval until that authenticated binding exists.
 */
export class ScopedEntityResolver {
  private readonly trustedAuthority: ScopedEntityTrustedAuthorityV1;

  constructor(
    private readonly driver: Driver,
    trustedAuthority: ScopedEntityTrustedAuthorityV1,
  ) {
    this.trustedAuthority = requireTrustedAuthority(trustedAuthority);
  }

  async resolve(plan: QueryPlanV1): Promise<ScopedEntityResolutionResultV1> {
    const validatedPlan = requireValidatedPlan(plan);
    if (validatedPlan.authority.tenantId !== this.trustedAuthority.tenantId
      || validatedPlan.authority.callerScopes.projects.length !== this.trustedAuthority.projectScopes.length
      || validatedPlan.authority.callerScopes.projects.some(
        (scope, index) => scope !== this.trustedAuthority.projectScopes[index],
      )) {
      return fixedResult('denied', [], ['authority_mismatch']);
    }

    const deadline = Date.now() + SCOPED_ENTITY_RESOLVER_TIMEOUT_MS;
    let session: ReturnType<Driver['session']>;
    try {
      session = this.driver.session({ defaultAccessMode: neo4j.session.READ });
    } catch {
      throw new ScopedEntityResolverError('query_failed');
    }
    let transaction: ReturnType<typeof session.beginTransaction> | undefined;
    let guardedTransaction: GuardedReadQueryRunner | undefined;
    let result: ScopedEntityResolutionResultV1 | undefined;
    let failure: ScopedEntityResolverError | undefined;
    try {
      transaction = session.beginTransaction({ timeout: SCOPED_ENTITY_RESOLVER_TIMEOUT_MS });
      guardedTransaction = new GuardedReadQueryRunner(transaction);
      result = await withinDeadline(
        () => this.resolveInTransaction(guardedTransaction!, validatedPlan),
        deadline,
        () => guardedTransaction!.cancel(),
      );
      await withinDeadline(
        () => transaction!.commit(),
        deadline,
        () => guardedTransaction!.cancel(),
      );
    } catch (error) {
      guardedTransaction?.cancel();
      failure = error instanceof ScopedEntityResolverError
        ? error
        : new ScopedEntityResolverError('query_failed');
      if (transaction !== undefined) {
        try {
          await withinDeadline(() => transaction!.rollback(), deadline);
        } catch {
          // Preserve the first fixed failure while still attempting rollback.
        }
      }
    }
    if (transaction !== undefined) {
      try {
        await withinDeadline(() => transaction!.close(), deadline);
      } catch {
        failure ??= new ScopedEntityResolverError('query_failed');
      }
    }
    try {
      await withinDeadline(() => session.close(), deadline, () => guardedTransaction?.cancel());
    } catch {
      failure ??= new ScopedEntityResolverError('query_failed');
    }
    if (failure !== undefined) throw failure;
    if (result === undefined) throw new ScopedEntityResolverError('query_failed');
    return result;
  }

  private async resolveInTransaction(
    tx: ReadQueryRunner,
    plan: QueryPlanV1,
  ): Promise<ScopedEntityResolutionResultV1> {
    const projectResult = await tx.run(PROJECT_AUTHORITY_QUERY, {
      projectScopes: [...plan.authority.callerScopes.projects],
      tenantId: plan.authority.tenantId,
      defaultTenant: DEFAULT_TENANT,
      projectCap: neo4j.int(QUERY_PLAN_MAX_PROJECT_SCOPES + 1),
    });
    const projectRecords = snapshotRecords(
      projectResult,
      QUERY_PLAN_MAX_PROJECT_SCOPES,
      ['projectScope', 'missing', 'duplicate', 'tenantOwned', 'projectId'],
    );
    if (projectRecords.length !== plan.authority.callerScopes.projects.length
      || projectRecords.length > QUERY_PLAN_MAX_PROJECT_SCOPES) {
      throw new ScopedEntityResolverError('invalid_record');
    }

    const projectState = projectRecords.map((record) => ({
      projectScope: requiredString(record, 'projectScope'),
      missing: booleanField(record, 'missing'),
      duplicate: booleanField(record, 'duplicate'),
      tenantOwned: booleanField(record, 'tenantOwned'),
      projectId: optionalCanonicalId(record, 'projectId'),
    }));
    if (projectState.some((row, index) => row.projectScope !== plan.authority.callerScopes.projects[index])) {
      throw new ScopedEntityResolverError('invalid_record');
    }
    if (projectState.some((row) => row.duplicate)) {
      return fixedResult('denied', [], ['project_denied']);
    }
    if (projectState.some((row) => row.missing || !row.tenantOwned)) {
      return fixedResult('denied', [], ['project_denied']);
    }

    const authorizedProjectIds = projectState.map((row) => {
      if (row.projectId === null) throw new ScopedEntityResolverError('invalid_record');
      return row.projectId;
    });
    if (new Set(authorizedProjectIds).size !== authorizedProjectIds.length) {
      return fixedResult('denied', [], ['project_denied']);
    }

    const explicitIds = plan.authority.callerScopes.entities;
    let explicitStatuses: ExplicitStatus[] = [];
    if (explicitIds.length > 0) {
      const explicitResult = await tx.run(EXPLICIT_ENTITY_QUERY, {
        explicitEntityIds: [...explicitIds],
        authorizedProjectIds,
        tenantId: plan.authority.tenantId,
        defaultTenant: DEFAULT_TENANT,
      });
      const explicitRecords = snapshotRecords(
        explicitResult,
        explicitIds.length,
        [
          'ordinal',
          'requestedId',
          'found',
          'uniqueAuthorizedPath',
          'multiProject',
          'depthOverflow',
          'containmentCycle',
          'candidateId',
        ],
      );
      if (explicitRecords.length !== explicitIds.length) {
        throw new ScopedEntityResolverError('invalid_record');
      }
      explicitStatuses = explicitRecords.map(mapExplicit);
      if (explicitStatuses.some((row, index) => row.ordinal !== index
        || row.requestedId !== explicitIds[index])) {
        throw new ScopedEntityResolverError('invalid_record');
      }
      if (explicitStatuses.some((row) => !row.found)) {
        return fixedResult('denied', [], ['entity_id_denied']);
      }
      if (explicitStatuses.some((row) => row.depthOverflow)) {
        return fixedResult('denied', [], ['entity_scope_overflow']);
      }
      if (explicitStatuses.some((row) => row.containmentCycle)) {
        return fixedResult('denied', [], ['entity_containment_cycle']);
      }
      if (explicitStatuses.some((row) => row.multiProject)) {
        return fixedResult('denied', [], ['entity_multi_project']);
      }
      if (explicitStatuses.some((row) => row.found && !row.uniqueAuthorizedPath)) {
        return fixedResult('denied', [], ['entity_path_ambiguous']);
      }
      if (explicitStatuses.some((row) => !row.uniqueAuthorizedPath
        || row.candidateId === null
        || row.candidateId !== row.requestedId)) {
        return fixedResult('denied', [], ['entity_id_denied']);
      }
    }

    const hintIds: string[] = [];
    if (plan.hints.entities.length > 0) {
      const hintResult = await tx.run(HINT_ENTITY_QUERY, {
        entityHints: [...plan.hints.entities],
        explicitEntityIds: [...explicitIds],
        authorizedProjectIds,
        tenantId: plan.authority.tenantId,
        defaultTenant: DEFAULT_TENANT,
        resultCapPlusOne: neo4j.int(SCOPED_ENTITY_RESOLVER_MAX_RESULTS + 1),
      });
      const hintRecords = snapshotRecords(
        hintResult,
        SCOPED_ENTITY_RESOLVER_MAX_RESULTS + 1,
        [
          'hint',
          'uniqueAuthorizedPath',
          'multiProject',
          'depthOverflow',
          'containmentCycle',
          'candidateId',
        ],
      );
      if (hintRecords.length > SCOPED_ENTITY_RESOLVER_MAX_RESULTS) {
        throw new ScopedEntityResolverError('result_over_cap');
      }
      let previousKey: string | undefined;
      for (const record of hintRecords) {
        const hint = requiredString(record, 'hint');
        if (!plan.hints.entities.includes(hint)) throw new ScopedEntityResolverError('invalid_record');
        const id = optionalCanonicalId(record, 'candidateId');
        if (id === null) throw new ScopedEntityResolverError('invalid_record');
        const orderKey = `${hint}\u0000${id}`;
        if (previousKey !== undefined && orderKey <= previousKey) {
          throw new ScopedEntityResolverError('invalid_record');
        }
        previousKey = orderKey;
        if (explicitIds.length > 0 && !explicitIds.includes(id)) {
          throw new ScopedEntityResolverError('invalid_record');
        }
        if (booleanField(record, 'depthOverflow')) {
          return fixedResult('denied', [], ['entity_scope_overflow']);
        }
        if (booleanField(record, 'containmentCycle')) {
          return fixedResult('denied', [], ['entity_containment_cycle']);
        }
        if (booleanField(record, 'multiProject')) {
          return fixedResult('denied', [], ['entity_multi_project']);
        }
        if (!booleanField(record, 'uniqueAuthorizedPath')) {
          return fixedResult('denied', [], ['entity_path_ambiguous']);
        }
        hintIds.push(id);
      }
    }

    const candidateIds = plan.hints.entities.length > 0
      ? hintIds
      : explicitStatuses.map((row) => row.candidateId).filter((id): id is string => id !== null);
    const canonicalEntityIds = [...new Set(candidateIds)].sort();
    if (canonicalEntityIds.length > SCOPED_ENTITY_RESOLVER_MAX_RESULTS) {
      throw new ScopedEntityResolverError('result_over_cap');
    }
    if (canonicalEntityIds.length === 0) {
      return fixedResult('not-found', [], ['entity_not_found']);
    }
    if (canonicalEntityIds.length === 1) {
      return fixedResult('resolved', canonicalEntityIds, []);
    }
    return fixedResult('ambiguous', canonicalEntityIds, ['entity_ambiguous']);
  }
}
