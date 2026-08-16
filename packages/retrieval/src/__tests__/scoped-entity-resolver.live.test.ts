import { Buffer } from 'node:buffer';
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, it } from 'vitest';
import neo4j, {
  type Driver,
  type ManagedTransaction,
  type Record as Neo4jRecord,
  type Session,
  type Transaction,
} from 'neo4j-driver';
import { parseQueryPlanV1 } from '../query-plan.js';
import { ScopedEntityResolver, ScopedEntityResolverError } from '../scoped-entity-resolver.js';

type LiveMode = 'off' | 'optional' | 'required';
interface NodeManifestEntry {
  readonly id: string;
  readonly name: unknown;
  readonly type: 'project' | 'module';
  readonly tenantId: string | null;
  readonly aliases?: unknown;
  readonly lateSeed?: true;
}
interface RelationshipManifestEntry {
  readonly id: string;
  readonly type: 'CONTAINS';
  readonly from: string;
  readonly to: string;
  readonly lateSeed?: true;
}
interface ProjectFixture {
  readonly id: string;
  readonly name: string;
  readonly scope: string;
}
type QueryRunner = Pick<ManagedTransaction, 'run'>;

const modeValue = process.env['MEMBERRY_RET002B_LIVE_MODE'] ?? 'off';
if (modeValue !== 'off' && modeValue !== 'optional' && modeValue !== 'required') {
  throw new Error('ret002b_live:invalid_mode');
}
const LIVE_MODE: LiveMode = modeValue;
const DISPOSABLE_OPT_IN = process.env['MEMBERRY_RET002B_DISPOSABLE_OPT_IN'] === '1';
const NEO4J_URI = process.env['NEO4J_URI'] || 'bolt://localhost:7687';
const NEO4J_USER = process.env['NEO4J_USER'] || 'neo4j';
const NEO4J_PASSWORD = process.env['NEO4J_PASSWORD'] || 'password';
const OWNER = randomBytes(16).toString('hex');
const RUN = `ret002b${OWNER}`;
const TENANT = 'tenant-alpha';
const FOREIGN_TENANT = 'tenant-beta';
const WRITER_LOCK_TIMEOUT_MS = 750;
const HOSTILE_NAME_BOUND = 200;
const HOSTILE_NAME_PAYLOAD_LENGTH = 2_000;
const HOSTILE_FIXTURE_NAME_BYTE_BUDGET = 4_096;

const nodeManifest: NodeManifestEntry[] = [];
const relationshipManifest: RelationshipManifestEntry[] = [];
let relationshipSequence = 0;

function addNode(id: string, type: NodeManifestEntry['type'], tenantId: string | null = null): string {
  nodeManifest.push({ id, name: id, type, tenantId });
  return id;
}

function addProject(label: string, tenantId = TENANT): ProjectFixture {
  const name = `${RUN}${label}`;
  const id = addNode(`${RUN}-${label}-project`, 'project', tenantId);
  nodeManifest[nodeManifest.length - 1] = { id, name, type: 'project', tenantId };
  return Object.freeze({ id, name, scope: `project:${name}` });
}

function addRelationship(from: string, to: string): void {
  relationshipSequence += 1;
  relationshipManifest.push({
    id: `${RUN}-relationship-${String(relationshipSequence).padStart(4, '0')}`,
    type: 'CONTAINS',
    from,
    to,
  });
}

function addLateForeignNode(
  root: string,
  id: string,
  name: unknown,
  aliases: unknown,
): void {
  nodeManifest.push({ id, name, type: 'module', tenantId: FOREIGN_TENANT, aliases, lateSeed: true });
  relationshipSequence += 1;
  relationshipManifest.push({
    id: `${RUN}-relationship-${String(relationshipSequence).padStart(4, '0')}`,
    type: 'CONTAINS',
    from: root,
    to: id,
    lateSeed: true,
  });
}

function addChain(
  root: string,
  label: string,
  length: number,
  tenantId: string | null = null,
): readonly string[] {
  const ids = Array.from(
    { length },
    (_, index) => addNode(
      `${RUN}-${label}-${String(index + 1).padStart(3, '0')}`,
      'module',
      tenantId,
    ),
  );
  let from = root;
  for (const id of ids) {
    addRelationship(from, id);
    from = id;
  }
  return Object.freeze(ids);
}

const DEPTH_16 = addProject('depth16');
const DEPTH_16_IDS = addChain(DEPTH_16.id, 'depth16', 16);
addChain(DEPTH_16.id, 'depth16-unrelated', 17);
const DEPTH_17 = addProject('depth17');
const DEPTH_17_IDS = addChain(DEPTH_17.id, 'depth17', 17);

const CYCLE_17 = addProject('cycle17');
const CYCLE_17_IDS = addChain(CYCLE_17.id, 'cycle17', 16);
addRelationship(CYCLE_17_IDS[15]!, CYCLE_17.id);

const SELF_CYCLE = addProject('selfcycle');
const SELF_CYCLE_ID = addNode(`${RUN}-selfcycle-candidate`, 'module');
addRelationship(SELF_CYCLE.id, SELF_CYCLE_ID);
addRelationship(SELF_CYCLE_ID, SELF_CYCLE_ID);

const AMBIGUITY = addProject('ambiguity');
const AMBIGUITY_LEFT = addNode(`${RUN}-ambiguity-left`, 'module');
const AMBIGUITY_RIGHT = addNode(`${RUN}-ambiguity-right`, 'module');
const AMBIGUITY_CANDIDATE = addNode(`${RUN}-ambiguity-candidate`, 'module');
addRelationship(AMBIGUITY.id, AMBIGUITY_LEFT);
addRelationship(AMBIGUITY.id, AMBIGUITY_RIGHT);
addRelationship(AMBIGUITY_LEFT, AMBIGUITY_CANDIDATE);
addRelationship(AMBIGUITY_RIGHT, AMBIGUITY_CANDIDATE);

const FOREIGN_SAFE = addProject('foreignsafe');
const FOREIGN_ROOT = addProject('foreignroot', FOREIGN_TENANT);
nodeManifest[nodeManifest.length - 1] = {
  id: FOREIGN_ROOT.id,
  name: FOREIGN_SAFE.name,
  type: 'project',
  tenantId: FOREIGN_TENANT,
};
const FOREIGN_MALFORMED_PROJECT = addNode(`${RUN}-foreign-malformed-project`, 'project', FOREIGN_TENANT);
nodeManifest[nodeManifest.length - 1] = {
  id: FOREIGN_MALFORMED_PROJECT,
  name: [`${RUN}-malformed-project-name`],
  type: 'project',
  tenantId: FOREIGN_TENANT,
};
const FOREIGN_OVERSIZED_PROJECT = addNode(`${RUN}-foreign-oversized-project`, 'project', FOREIGN_TENANT);
nodeManifest[nodeManifest.length - 1] = {
  id: FOREIGN_OVERSIZED_PROJECT,
  name: `${RUN}-${'y'.repeat(HOSTILE_NAME_PAYLOAD_LENGTH)}`,
  type: 'project',
  tenantId: FOREIGN_TENANT,
};
const FOREIGN_SAFE_CANDIDATE = addNode(`${RUN}-foreignsafe-candidate`, 'module');
const FOREIGN_ONLY_CANDIDATE = addNode(`${RUN}-foreignonly-candidate`, 'module');
const FOREIGN_LONG_IDS = addChain(FOREIGN_ROOT.id, 'foreignlong', 65);
addRelationship(FOREIGN_LONG_IDS[64]!, FOREIGN_SAFE_CANDIDATE);
addRelationship(FOREIGN_LONG_IDS[64]!, FOREIGN_ONLY_CANDIDATE);
addRelationship(FOREIGN_SAFE_CANDIDATE, FOREIGN_ROOT.id);
addRelationship(FOREIGN_SAFE.id, FOREIGN_SAFE_CANDIDATE);
addLateForeignNode(
  FOREIGN_ROOT.id,
  `${RUN}-foreign-malformed-candidate`,
  [`${RUN}-malformed-name`],
  `${RUN}-malformed-aliases`,
);
addLateForeignNode(
  FOREIGN_ROOT.id,
  `${RUN}-foreign-oversized-candidate`,
  `${RUN}-${'x'.repeat(HOSTILE_NAME_PAYLOAD_LENGTH)}`,
  Array.from({ length: 512 }, (_, index) => `${RUN}-alias-${index}`),
);
const FOREIGN_CONTINUATION_IDS = addChain(FOREIGN_SAFE.id, 'foreign-continuation', 16);
const FOREIGN_CONTINUATION = addNode(`${RUN}-foreign-continuation-terminal`, 'module', FOREIGN_TENANT);
addRelationship(FOREIGN_CONTINUATION_IDS[15]!, FOREIGN_CONTINUATION);

const LONG_PATH = addProject('longpath');
const LONG_PATH_CANDIDATE = addNode(`${RUN}-longpath-candidate`, 'module');
const LONG_PATH_IDS = addChain(LONG_PATH.id, 'longpath', 17);
addRelationship(LONG_PATH_IDS[16]!, LONG_PATH_CANDIDATE);
addRelationship(LONG_PATH.id, LONG_PATH_CANDIDATE);

const LONG_CYCLE = addProject('longcycle');
const LONG_CYCLE_CANDIDATE = addNode(`${RUN}-longcycle-candidate`, 'module');
addRelationship(LONG_CYCLE.id, LONG_CYCLE_CANDIDATE);
const LONG_CYCLE_IDS = addChain(LONG_CYCLE_CANDIDATE, 'longcycle', 17);
addRelationship(LONG_CYCLE_IDS[16]!, LONG_CYCLE_CANDIDATE);

const BEYOND_AUTHORITY = addProject('beyondauthority');
const BEYOND_AUTHORITY_SAFE = addNode(`${RUN}-beyondauthority-safe`, 'module');
const BEYOND_AUTHORITY_ONLY = addNode(`${RUN}-beyondauthority-only`, 'module');
addRelationship(BEYOND_AUTHORITY.id, BEYOND_AUTHORITY_SAFE);
const BEYOND_AUTHORITY_IDS = addChain(BEYOND_AUTHORITY.id, 'beyondauthority', 65);
addRelationship(BEYOND_AUTHORITY_IDS[64]!, BEYOND_AUTHORITY_SAFE);
addRelationship(BEYOND_AUTHORITY_IDS[64]!, BEYOND_AUTHORITY_ONLY);

const HIGH_DEGREE = addProject('highdegree');
const HIGH_DEGREE_CANDIDATE = addNode(`${RUN}-highdegree-candidate`, 'module');
addRelationship(HIGH_DEGREE.id, HIGH_DEGREE_CANDIDATE);
for (let index = 0; index < 128; index += 1) {
  addRelationship(
    HIGH_DEGREE.id,
    addNode(`${RUN}-highdegree-distractor-${String(index).padStart(3, '0')}`, 'module'),
  );
}

const CONVERGENT = addProject('convergent');
const CONVERGENT_CANDIDATE = addNode(`${RUN}-convergent-candidate`, 'module');
for (let index = 0; index < 32; index += 1) {
  const branch = addChain(CONVERGENT.id, `convergent-${String(index).padStart(2, '0')}`, 16);
  addRelationship(branch[15]!, CONVERGENT_CANDIDATE);
}

const MULTI_A = addProject('multia');
const MULTI_B = addProject('multib');
const MULTI_CANDIDATE = addNode(`${RUN}-multi-candidate`, 'module');
addRelationship(MULTI_A.id, MULTI_CANDIDATE);
addRelationship(MULTI_B.id, MULTI_CANDIDATE);

const NODES = Object.freeze([...nodeManifest].sort((left, right) => left.id.localeCompare(right.id)));
const RELATIONSHIPS = Object.freeze(
  [...relationshipManifest].sort((left, right) => left.id.localeCompare(right.id)),
);
const NODE_IDS = Object.freeze(NODES.map((node) => node.id));
const RELATIONSHIP_IDS = Object.freeze(RELATIONSHIPS.map((relationship) => relationship.id));

function fixedFailure(code: string): Error {
  return new Error(`ret002b_live:${code}`);
}

async function withinLiveDeadline<T>(
  operation: () => T | Promise<T>,
  timeoutMs: number,
  code: string,
): Promise<T> {
  let pending: Promise<T>;
  try {
    pending = Promise.resolve(operation());
  } catch (error) {
    throw error;
  }
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      void pending.catch(() => undefined);
      reject(fixedFailure(code));
    }, timeoutMs);
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

function exactPropertyKeys(value: unknown, expected: readonly string[]): boolean {
  if (!Array.isArray(value)
    || value.length !== expected.length
    || value.some((key) => typeof key !== 'string')) return false;
  const actual = [...value].sort();
  const canonical = [...expected].sort();
  return actual.every((key, index) => key === canonical[index]);
}

interface SetupSessionLike {
  close(): Promise<void>;
}

async function setupWithFreshFailureAudit<TSession extends SetupSessionLike>(
  setupSession: TSession,
  openFreshSession: () => TSession,
  seed: (session: TSession) => Promise<void>,
  cleanup: (session: TSession) => Promise<void>,
): Promise<void> {
  let failed = false;
  try {
    try {
      await seed(setupSession);
    } catch {
      failed = true;
    }
  } finally {
    try {
      await setupSession.close();
    } catch {
      failed = true;
    }
    if (failed) {
      let freshSession: TSession | undefined;
      try {
        freshSession = openFreshSession();
        await cleanup(freshSession);
      } catch {
        // Preserve a single value-free setup failure after the cleanup attempt.
      } finally {
        if (freshSession !== undefined) {
          try {
            await freshSession.close();
          } catch {
            // Preserve a single value-free setup failure after the close attempt.
          }
        }
      }
    }
  }
  if (failed) throw fixedFailure('setup_failed');
}

async function cleanupWithFreshAudit<TSession extends SetupSessionLike>(
  initialSession: TSession,
  openFreshSession: () => TSession,
  attemptCleanup: (session: TSession) => Promise<void>,
  auditResidual: (session: TSession) => Promise<boolean>,
  cleanupResidual: (session: TSession) => Promise<void>,
): Promise<void> {
  let failure: Error | undefined;
  try {
    await attemptCleanup(initialSession);
  } catch (error) {
    failure = error instanceof Error ? error : fixedFailure('cleanup_failed');
  } finally {
    try {
      await initialSession.close();
    } catch {
      failure ??= fixedFailure('cleanup_failed');
    }
  }

  let freshSession: TSession | undefined;
  let repairAttempted = false;
  try {
    freshSession = openFreshSession();
    if (await auditResidual(freshSession)) {
      repairAttempted = true;
      await cleanupResidual(freshSession);
    }
  } catch (error) {
    failure ??= error instanceof Error ? error : fixedFailure('cleanup_failed');
  } finally {
    if (freshSession !== undefined) {
      try {
        await freshSession.close();
      } catch {
        failure ??= fixedFailure('cleanup_failed');
      }
    }
  }
  if (repairAttempted) {
    let verificationSession: TSession | undefined;
    try {
      verificationSession = openFreshSession();
      if (await auditResidual(verificationSession)) throw fixedFailure('cleanup_residual');
    } catch (error) {
      failure ??= error instanceof Error ? error : fixedFailure('cleanup_failed');
    } finally {
      if (verificationSession !== undefined) {
        try {
          await verificationSession.close();
        } catch {
          failure ??= fixedFailure('cleanup_failed');
        }
      }
    }
  }
  if (failure !== undefined) throw failure;
}

function plan(projectScopes: readonly string[], explicitId: string) {
  return parseQueryPlanV1({
    contractId: 'memberry.query-plan',
    contractVersion: '1.0.0',
    authority: {
      tenantId: TENANT,
      callerScopes: {
        projects: [...projectScopes],
        repositories: [],
        entities: [explicitId],
        symbols: [],
      },
    },
    intent: 'IDENTIFIER',
    temporalFrame: { mode: 'current' },
    evidenceNeeds: ['graph'],
    hints: { source: 'task', repositories: [], entities: [], symbols: [] },
    resolution: { state: 'unresolved', canonicalEntityIds: [] },
  });
}

function hintPlan(projectScopes: readonly string[], hint: string) {
  return parseQueryPlanV1({
    contractId: 'memberry.query-plan',
    contractVersion: '1.0.0',
    authority: {
      tenantId: TENANT,
      callerScopes: {
        projects: [...projectScopes],
        repositories: [],
        entities: [],
        symbols: [],
      },
    },
    intent: 'IDENTIFIER',
    temporalFrame: { mode: 'current' },
    evidenceNeeds: ['graph'],
    hints: { source: 'task', repositories: [], entities: [hint], symbols: [] },
    resolution: { state: 'unresolved', canonicalEntityIds: [] },
  });
}

function resolver(driver: Driver, projectScopes: readonly string[]) {
  return new ScopedEntityResolver(driver, Object.freeze({
    tenantId: TENANT,
    projectScopes: Object.freeze([...projectScopes]),
  }));
}

function numberField(record: Neo4jRecord, key: string): number {
  const value = record.get(key) as unknown;
  if (typeof value === 'number' && Number.isSafeInteger(value)) return value;
  if (neo4j.isInt(value) && value.inSafeRange()) return value.toNumber();
  throw fixedFailure('invalid_count');
}

function stringField(record: Neo4jRecord, key: string, nullable = false): string | null {
  const value = record.get(key) as unknown;
  if (nullable && (value === null || value === undefined)) return null;
  if (typeof value !== 'string') throw fixedFailure('invalid_manifest');
  return value;
}

async function nodeRecords(runner: QueryRunner): Promise<readonly Neo4jRecord[]> {
  const result = await runner.run(
    `MATCH (node)
     WHERE node.id IN $nodeIds OR node.ret002b_owner = $owner
     RETURN node.id AS id, node.name AS name, node.aliases AS aliases, node.type AS type,
            node.tenant_id AS tenantId, node.ret002b_owner AS owner,
            labels(node) AS labels, keys(node) AS propertyKeys,
            node.ret002b_cleanup_lock AS cleanupLock
     ORDER BY id`,
    { nodeIds: [...NODE_IDS], owner: OWNER },
  );
  return result.records;
}

async function relationshipRecords(runner: QueryRunner): Promise<readonly Neo4jRecord[]> {
  const result = await runner.run(
    `MATCH (from)-[relationship]->(to)
     WHERE relationship.ret002b_relationship_id IN $relationshipIds
        OR relationship.ret002b_owner = $owner
        OR from.id IN $nodeIds
        OR to.id IN $nodeIds
     RETURN relationship.ret002b_relationship_id AS id,
            type(relationship) AS type,
            from.id AS from,
            to.id AS to,
            relationship.ret002b_owner AS owner,
            keys(relationship) AS propertyKeys,
            relationship.ret002b_cleanup_lock AS cleanupLock
     ORDER BY id, type, from, to`,
    { relationshipIds: [...RELATIONSHIP_IDS], nodeIds: [...NODE_IDS], owner: OWNER },
  );
  return result.records;
}

async function verifyExactManifest(runner: QueryRunner, cleanupLock: string | null = null): Promise<void> {
  const nodes = await nodeRecords(runner);
  if (nodes.length !== NODES.length) throw fixedFailure('node_manifest_mismatch');
  const expectedNodes = NODES.map((expected) => JSON.stringify({
    id: expected.id,
    name: expected.name,
    aliases: expected.aliases ?? null,
    type: expected.type,
    tenantId: expected.tenantId,
    owner: OWNER,
    labels: ['Entity'],
    cleanupLock,
    propertyKeys: [
      'id',
      'name',
      'type',
      ...(expected.aliases === undefined ? [] : ['aliases']),
      ...(expected.tenantId === null ? [] : ['tenant_id']),
      'ret002b_owner',
      ...(cleanupLock === null ? [] : ['ret002b_cleanup_lock']),
    ].sort(),
  })).sort();
  const actualNodes = nodes.map((actual) => {
    const labels = actual.get('labels') as unknown;
    const propertyKeys = actual.get('propertyKeys') as unknown;
    if (!Array.isArray(labels)
      || labels.some((label) => typeof label !== 'string')
      || !Array.isArray(propertyKeys)
      || propertyKeys.some((key) => typeof key !== 'string')) throw fixedFailure('node_manifest_mismatch');
    return JSON.stringify({
      id: actual.get('id') as unknown,
      name: actual.get('name') as unknown,
      aliases: actual.get('aliases') as unknown,
      type: actual.get('type') as unknown,
      tenantId: actual.get('tenantId') as unknown,
      owner: actual.get('owner') as unknown,
      labels: [...labels].sort(),
      cleanupLock: actual.get('cleanupLock') as unknown,
      propertyKeys: [...propertyKeys].sort(),
    });
  }).sort();
  if (actualNodes.some((actual, index) => actual !== expectedNodes[index])) {
    throw fixedFailure('node_manifest_mismatch');
  }

  const relationships = await relationshipRecords(runner);
  if (relationships.length !== RELATIONSHIPS.length) {
    throw fixedFailure('relationship_manifest_mismatch');
  }
  for (let index = 0; index < RELATIONSHIPS.length; index += 1) {
    const expected = RELATIONSHIPS[index]!;
    const actual = relationships[index]!;
    if (stringField(actual, 'id') !== expected.id
      || stringField(actual, 'type') !== expected.type
      || stringField(actual, 'from') !== expected.from
      || stringField(actual, 'to') !== expected.to
      || stringField(actual, 'owner') !== OWNER
      || stringField(actual, 'cleanupLock', true) !== cleanupLock
      || !exactPropertyKeys(actual.get('propertyKeys') as unknown, [
        'ret002b_relationship_id',
        'ret002b_owner',
        ...(cleanupLock === null ? [] : ['ret002b_cleanup_lock']),
      ])) {
      throw fixedFailure('relationship_manifest_mismatch');
    }
  }
}

async function residualCounts(runner: QueryRunner): Promise<Readonly<{ nodes: number; relationships: number }>> {
  const nodeResult = await runner.run(
    `MATCH (node)
     WHERE node.id IN $nodeIds OR node.ret002b_owner = $owner
     RETURN count(node) AS count`,
    { nodeIds: [...NODE_IDS], owner: OWNER },
  );
  const relationshipResult = await runner.run(
    `MATCH (from)-[relationship]->(to)
     WHERE relationship.ret002b_relationship_id IN $relationshipIds
        OR relationship.ret002b_owner = $owner
        OR from.id IN $nodeIds
        OR to.id IN $nodeIds
     RETURN count(relationship) AS count`,
    { relationshipIds: [...RELATIONSHIP_IDS], nodeIds: [...NODE_IDS], owner: OWNER },
  );
  if (nodeResult.records.length !== 1 || relationshipResult.records.length !== 1) {
    throw fixedFailure('invalid_residual_audit');
  }
  return Object.freeze({
    nodes: numberField(nodeResult.records[0]!, 'count'),
    relationships: numberField(relationshipResult.records[0]!, 'count'),
  });
}

async function seedFixtures(tx: ManagedTransaction): Promise<void> {
  const unused = await residualCounts(tx);
  if (unused.nodes !== 0 || unused.relationships !== 0) {
    throw fixedFailure('namespace_not_unused');
  }
  await tx.run(
    `UNWIND $nodes AS entry
     CREATE (node:Entity {
       id: entry.id,
       name: entry.name,
       type: entry.type,
       tenant_id: entry.tenantId,
       ret002b_owner: $owner
     })`,
    {
      nodes: NODES.filter((node) => node.lateSeed !== true).map((node) => ({
        id: node.id,
        name: node.name,
        type: node.type,
        tenantId: node.tenantId,
      })),
      owner: OWNER,
    },
  );
  await tx.run(
    `UNWIND $relationships AS entry
     MATCH (from:Entity {id: entry.from, ret002b_owner: $owner})
     MATCH (to:Entity {id: entry.to, ret002b_owner: $owner})
     CREATE (from)-[:CONTAINS {
       ret002b_relationship_id: entry.id,
       ret002b_owner: $owner
     }]->(to)`,
    {
      relationships: RELATIONSHIPS.filter((relationship) => relationship.lateSeed !== true)
        .map((relationship) => ({
          id: relationship.id,
          from: relationship.from,
          to: relationship.to,
        })),
      owner: OWNER,
    },
  );
  const lateNodes = NODES.filter((node) => node.lateSeed === true);
  const lateRelationships = RELATIONSHIPS.filter((relationship) => relationship.lateSeed === true);
  if (lateNodes.length !== lateRelationships.length) throw fixedFailure('late_manifest_mismatch');
  for (const node of lateNodes) {
    const matchingRelationships = lateRelationships.filter(
      (relationship) => relationship.to === node.id,
    );
    if (matchingRelationships.length !== 1) throw fixedFailure('late_manifest_mismatch');
    const relationship = matchingRelationships[0]!;
    await tx.run(
      `MATCH (root:Entity {id: $rootId, ret002b_owner: $owner})
       CREATE (candidate:Entity {
         id: $id,
         name: $name,
         aliases: $aliases,
         type: $type,
         tenant_id: $tenantId,
         ret002b_owner: $owner
       })
       CREATE (root)-[:CONTAINS {
         ret002b_relationship_id: $relationshipId,
         ret002b_owner: $owner
       }]->(candidate)`,
      {
        rootId: relationship.from,
        id: node.id,
        name: node.name,
        aliases: node.aliases,
        type: node.type,
        tenantId: node.tenantId,
        relationshipId: relationship.id,
        owner: OWNER,
      },
    );
  }
  await verifyExactManifest(tx);
}

async function cleanupOwnedSession(session: Session, afterLocks?: () => Promise<void>): Promise<void> {
  const initial = await session.executeRead(residualCounts, { timeout: 10_000 });
  if (initial.nodes === 0 && initial.relationships === 0) return;

  const deleted = await session.executeWrite(async (tx) => {
    await verifyExactManifest(tx);
    const cleanupLock = randomBytes(16).toString('hex');
    const relationshipLocks = await tx.run(
      `MATCH ()-[relationship]->()
       WHERE relationship.ret002b_relationship_id IN $relationshipIds
         AND relationship.ret002b_owner = $owner
       SET relationship.ret002b_cleanup_lock = $cleanupLock
       RETURN count(relationship) AS count`,
      { relationshipIds: [...RELATIONSHIP_IDS], owner: OWNER, cleanupLock },
    );
    const nodeLocks = await tx.run(
      `MATCH (node)
       WHERE node.id IN $nodeIds AND node.ret002b_owner = $owner
       SET node.ret002b_cleanup_lock = $cleanupLock
       RETURN count(node) AS count`,
      { nodeIds: [...NODE_IDS], owner: OWNER, cleanupLock },
    );
    if (relationshipLocks.records.length !== 1
      || numberField(relationshipLocks.records[0]!, 'count') !== RELATIONSHIPS.length
      || nodeLocks.records.length !== 1
      || numberField(nodeLocks.records[0]!, 'count') !== NODES.length) {
      throw fixedFailure('cleanup_lock_count');
    }
    await verifyExactManifest(tx, cleanupLock);
    if (afterLocks !== undefined) {
      await withinLiveDeadline(afterLocks, 8_500, 'cleanup_barrier_timeout');
    }
    await verifyExactManifest(tx, cleanupLock);
    const relationshipDeletion = await tx.run(
      `MATCH ()-[relationship]->()
       WHERE relationship.ret002b_relationship_id IN $relationshipIds
         AND relationship.ret002b_owner = $owner
         AND relationship.ret002b_cleanup_lock = $cleanupLock
       DELETE relationship
       RETURN count(*) AS count`,
      { relationshipIds: [...RELATIONSHIP_IDS], owner: OWNER, cleanupLock },
    );
    if (relationshipDeletion.records.length !== 1
      || numberField(relationshipDeletion.records[0]!, 'count') !== RELATIONSHIPS.length) {
      throw fixedFailure('relationship_delete_count');
    }

    const nodeDeletion = await tx.run(
      `MATCH (node)
       WHERE node.id IN $nodeIds AND node.ret002b_owner = $owner
         AND node.ret002b_cleanup_lock = $cleanupLock
       DELETE node
       RETURN count(*) AS count`,
      { nodeIds: [...NODE_IDS], owner: OWNER, cleanupLock },
    );
    if (nodeDeletion.records.length !== 1
      || numberField(nodeDeletion.records[0]!, 'count') !== NODES.length) {
      throw fixedFailure('node_delete_count');
    }
    const residual = await residualCounts(tx);
    if (residual.nodes !== 0 || residual.relationships !== 0) {
      throw fixedFailure('cleanup_residual');
    }
    return true;
  }, { timeout: 10_000 });
  if (!deleted) throw fixedFailure('cleanup_failed');
}

async function cleanupIfPresent(driver: Driver, afterLocks?: () => Promise<void>): Promise<void> {
  let initialSession: Session;
  try {
    initialSession = driver.session();
  } catch {
    throw fixedFailure('cleanup_failed');
  }
  await cleanupWithFreshAudit(
    initialSession,
    () => driver.session(),
    (session) => cleanupOwnedSession(session, afterLocks),
    async (session) => {
      const residual = await session.executeRead(residualCounts, { timeout: 10_000 });
      return residual.nodes !== 0 || residual.relationships !== 0;
    },
    cleanupOwnedSession,
  );
}

async function requireResolution(
  driver: Driver,
  projectScope: string | readonly string[],
  entityId: string,
  state: 'resolved' | 'denied',
  diagnostic: string | null,
): Promise<void> {
  const projectScopes = typeof projectScope === 'string' ? [projectScope] : [...projectScope];
  let result: Awaited<ReturnType<ScopedEntityResolver['resolve']>>;
  try {
    result = await resolver(driver, projectScopes).resolve(plan(projectScopes, entityId));
  } catch (error) {
    if (error instanceof ScopedEntityResolverError) {
      throw fixedFailure(`resolver_${error.code}`);
    }
    throw fixedFailure('resolver_failed');
  }
  if (result.resolution.state !== state
    || result.resolution.canonicalEntityIds.length !== (state === 'resolved' ? 1 : 0)
    || (state === 'resolved' && result.resolution.canonicalEntityIds[0] !== entityId)
    || result.diagnostics.length !== (diagnostic === null ? 0 : 1)
    || (diagnostic !== null && result.diagnostics[0] !== diagnostic)) {
    throw fixedFailure('unexpected_resolution');
  }
}

async function requireHintResolution(
  driver: Driver,
  projectScope: string,
  hint: string,
  expectedEntityId: string,
): Promise<void> {
  let result: Awaited<ReturnType<ScopedEntityResolver['resolve']>>;
  try {
    result = await resolver(driver, [projectScope]).resolve(hintPlan([projectScope], hint));
  } catch (error) {
    if (error instanceof ScopedEntityResolverError) {
      throw fixedFailure(`resolver_${error.code}`);
    }
    throw fixedFailure('resolver_failed');
  }
  if (result.resolution.state !== 'resolved'
    || result.resolution.canonicalEntityIds.length !== 1
    || result.resolution.canonicalEntityIds[0] !== expectedEntityId
    || result.diagnostics.length !== 0) {
    throw fixedFailure('unexpected_resolution');
  }
}

describe('ScopedEntityResolver disposable Neo4j containment proof', () => {
  let driver: Driver | undefined;
  let available = false;

  it('keeps hostile oversized names beyond resolver bounds but within the index-safe fixture budget', () => {
    if (new Set(NODE_IDS).size !== NODE_IDS.length) throw fixedFailure('node_id_fixture_collision');
    for (const id of [FOREIGN_OVERSIZED_PROJECT, `${RUN}-foreign-oversized-candidate`]) {
      const fixture = NODES.find((node) => node.id === id);
      if (typeof fixture?.name !== 'string'
        || fixture.name.length <= HOSTILE_NAME_BOUND
        || Buffer.byteLength(fixture.name, 'utf8') > HOSTILE_FIXTURE_NAME_BYTE_BUDGET) {
        throw fixedFailure('hostile_name_fixture_bounds');
      }
    }
  });

  it('rejects extra manifest properties and audits an acknowledged-late setup on a fresh session', async () => {
    if (!exactPropertyKeys(['id', 'name', 'type', 'ret002b_owner'], [
      'id', 'name', 'type', 'ret002b_owner',
    ])) throw fixedFailure('property_key_regression');
    if (exactPropertyKeys(['id', 'name', 'type', 'ret002b_owner', 'extra'], [
      'id', 'name', 'type', 'ret002b_owner',
    ])) throw fixedFailure('property_key_regression');

    let committed = false;
    let cleaned = false;
    const setup = { close: async () => undefined };
    const fresh = { close: async () => undefined };
    let opens = 0;
    await setupWithFreshFailureAudit(
      setup,
      () => { opens += 1; return fresh; },
      async () => {
        committed = true;
        throw fixedFailure('ack_failed');
      },
      async (session) => {
        if (session !== fresh || !committed) throw fixedFailure('fresh_audit_missing');
        cleaned = true;
      },
    ).then(
      () => { throw fixedFailure('setup_failure_not_preserved'); },
      () => undefined,
    );
    if (opens !== 1 || !cleaned) throw fixedFailure('fresh_audit_missing');
  });

  it('fresh-audits final cleanup after an acknowledged-late commit and repairs residual rollback state', async () => {
    for (const commitSucceeded of [true, false]) {
      let residue = 1;
      let opens = 0;
      let audits = 0;
      let repairs = 0;
      const initial = { close: async () => undefined };
      const fresh = { close: async () => undefined };
      let observedFailure = '';
      await cleanupWithFreshAudit(
        initial,
        () => { opens += 1; return fresh; },
        async () => {
          if (commitSucceeded) residue = 0;
          throw fixedFailure('ack_failed');
        },
        async (session) => {
          if (session !== fresh) throw fixedFailure('fresh_audit_missing');
          audits += 1;
          return residue !== 0;
        },
        async (session) => {
          if (session !== fresh) throw fixedFailure('fresh_audit_missing');
          repairs += 1;
          residue = 0;
        },
      ).then(
        () => { throw fixedFailure('cleanup_failure_not_preserved'); },
        (error: unknown) => {
          observedFailure = error instanceof Error ? error.message : '';
        },
      );
      if (opens !== (commitSucceeded ? 1 : 2)
        || audits !== (commitSucceeded ? 1 : 2)
        || repairs !== (commitSucceeded ? 0 : 1)
        || residue !== 0
        || observedFailure !== 'ret002b_live:ack_failed') {
        throw fixedFailure('fresh_cleanup_regression');
      }
    }
  });

  beforeAll(async () => {
    if (LIVE_MODE === 'off') {
      console.warn('[skip] RET-002B live proof disabled; no database connection attempted');
      return;
    }
    if (!DISPOSABLE_OPT_IN) {
      if (LIVE_MODE === 'required') throw fixedFailure('disposable_opt_in_required');
      console.warn('[skip] RET-002B live proof lacks disposable-database opt-in');
      return;
    }
    if (LIVE_MODE === 'required' && !process.env['NEO4J_URI']) {
      throw fixedFailure('required_uri_missing');
    }

    try {
      driver = neo4j.driver(NEO4J_URI, neo4j.auth.basic(NEO4J_USER, NEO4J_PASSWORD), {
        connectionAcquisitionTimeout: 3_000,
        connectionTimeout: 3_000,
        maxConnectionPoolSize: 2,
        maxTransactionRetryTime: 0,
      });
      await driver.getServerInfo();
    } catch {
      if (driver !== undefined) {
        try {
          await driver.close();
        } catch {
          // Connectivity failed before fixture setup; there can be no owned residue.
        }
        driver = undefined;
      }
      if (LIVE_MODE === 'required') throw fixedFailure('required_database_unavailable');
      console.warn('[skip] RET-002B optional disposable Neo4j is unavailable');
      return;
    }
    available = true;
    let session: Session;
    try {
      if (driver === undefined) throw fixedFailure('setup_failed');
      session = driver.session();
    } catch {
      throw fixedFailure('setup_failed');
    }
    await setupWithFreshFailureAudit(
      session,
      () => {
        if (driver === undefined) throw fixedFailure('setup_failed');
        return driver.session();
      },
      async (setupSession) => {
        await setupSession.executeWrite(seedFixtures, { timeout: 10_000 });
      },
      cleanupOwnedSession,
    );
  }, 30_000);

  afterAll(async () => {
    if (driver === undefined) return;
    let cleanupFailed = false;
    try {
      await cleanupIfPresent(driver);
    } catch {
      cleanupFailed = true;
    } finally {
      try {
        await driver.close();
      } catch {
        cleanupFailed = true;
      }
    }
    if (cleanupFailed) throw fixedFailure('cleanup_failed');
  }, 30_000);

  function liveTest(
    name: string,
    work: (liveDriver: Driver) => Promise<void>,
  ): void {
    it(name, async ({ skip }) => {
      if (!available || driver === undefined) {
        skip();
        return;
      }
      await work(driver);
    }, 15_000);
  }

  liveTest('accepts depth 16 and denies depth 17', async (liveDriver) => {
    await requireResolution(liveDriver, DEPTH_16.scope, DEPTH_16_IDS[15]!, 'resolved', null);
    await requireResolution(
      liveDriver,
      DEPTH_17.scope,
      DEPTH_17_IDS[16]!,
      'denied',
      'entity_scope_overflow',
    );
  });

  liveTest('rejects depth-16 back-edge and independent self-cycle fixtures', async (liveDriver) => {
    await requireResolution(
      liveDriver,
      CYCLE_17.scope,
      CYCLE_17_IDS[15]!,
      'denied',
      'entity_containment_cycle',
    );
    await requireResolution(
      liveDriver,
      SELF_CYCLE.scope,
      SELF_CYCLE_ID,
      'denied',
      'entity_containment_cycle',
    );
  });

  liveTest('rejects same-root ambiguity and any authorized continuation beyond the boundary', async (liveDriver) => {
    await requireResolution(
      liveDriver,
      AMBIGUITY.scope,
      AMBIGUITY_CANDIDATE,
      'denied',
      'entity_path_ambiguous',
    );
    await requireResolution(
      liveDriver,
      LONG_PATH.scope,
      LONG_PATH_CANDIDATE,
      'denied',
      'entity_scope_overflow',
    );
    await requireResolution(
      liveDriver,
      LONG_CYCLE.scope,
      LONG_CYCLE_CANDIDATE,
      'denied',
      'entity_scope_overflow',
    );
  });

  liveTest('ignores foreign-root long topology and survives high authorized fan-out', async (liveDriver) => {
    await requireResolution(
      liveDriver,
      FOREIGN_SAFE.scope,
      FOREIGN_SAFE_CANDIDATE,
      'resolved',
      null,
    );
    await requireHintResolution(
      liveDriver,
      FOREIGN_SAFE.scope,
      FOREIGN_SAFE_CANDIDATE,
      FOREIGN_SAFE_CANDIDATE,
    );
    await requireResolution(
      liveDriver,
      FOREIGN_SAFE.scope,
      FOREIGN_ONLY_CANDIDATE,
      'denied',
      'entity_id_denied',
    );
    await requireResolution(
      liveDriver,
      HIGH_DEGREE.scope,
      HIGH_DEGREE_CANDIDATE,
      'resolved',
      null,
    );
    await requireResolution(
      liveDriver,
      CONVERGENT.scope,
      CONVERGENT_CANDIDATE,
      'denied',
      'entity_scope_overflow',
    );
  });

  liveTest('ignores topology deeper than the V1 authoritative boundary', async (liveDriver) => {
    await requireResolution(
      liveDriver,
      BEYOND_AUTHORITY.scope,
      BEYOND_AUTHORITY_SAFE,
      'resolved',
      null,
    );
    await requireResolution(
      liveDriver,
      BEYOND_AUTHORITY.scope,
      BEYOND_AUTHORITY_ONLY,
      'denied',
      'entity_id_denied',
    );
  });

  liveTest('reports genuine authorized multi-root containment deterministically', async (liveDriver) => {
    await requireResolution(
      liveDriver,
      [MULTI_A.scope, MULTI_B.scope].sort(),
      MULTI_CANDIDATE,
      'denied',
      'entity_multi_project',
    );
  });

  liveTest('holds cleanup locks against a concurrent property and label mutation', async (liveDriver) => {
    await cleanupIfPresent(liveDriver, async () => {
      const writerSession = liveDriver.session();
      let writerTransaction: Transaction | undefined;
      let observedTimeout = false;
      try {
        writerTransaction = await withinLiveDeadline(
          () => writerSession.beginTransaction({ timeout: WRITER_LOCK_TIMEOUT_MS }),
          2_000,
          'writer_begin_timeout',
        );
        const ready = await withinLiveDeadline(
          () => writerTransaction!.run('RETURN 1 AS ready'),
          2_000,
          'writer_roundtrip_timeout',
        );
        if (ready.records.length !== 1 || numberField(ready.records[0]!, 'ready') !== 1) {
          throw fixedFailure('writer_roundtrip_failed');
        }
        const blockedAt = Date.now();
        try {
          await withinLiveDeadline(
            () => writerTransaction!.run(
              `MATCH (node:Entity {id: $id, ret002b_owner: $owner})
               SET node.ret002b_race_mutation = true
               SET node:Ret002BRaceMutation
               RETURN count(node) AS count`,
              { id: HIGH_DEGREE_CANDIDATE, owner: OWNER },
            ),
            WRITER_LOCK_TIMEOUT_MS + 3_000,
            'writer_mutation_deadline',
          );
          throw fixedFailure('writer_lock_not_held');
        } catch (error) {
          if (!(error instanceof neo4j.Neo4jError)
            || error.code !== 'Neo.ClientError.Transaction.LockClientStopped') {
            throw fixedFailure('writer_timeout_classification');
          }
          const blockedFor = Date.now() - blockedAt;
          if (blockedFor < WRITER_LOCK_TIMEOUT_MS / 2
            || blockedFor > WRITER_LOCK_TIMEOUT_MS + 4_000) {
            throw fixedFailure('writer_timeout_window');
          }
          observedTimeout = true;
        }
      } finally {
        if (writerTransaction !== undefined) {
          try {
            await withinLiveDeadline(
              () => writerTransaction!.rollback(),
              1_000,
              'writer_rollback_timeout',
            );
          } catch {
            // A server-timed-out transaction may already be closed; rollback was still attempted.
          }
          try {
            await withinLiveDeadline(
              () => writerTransaction!.close(),
              1_000,
              'writer_transaction_close_timeout',
            );
          } catch {
            // A server-timed-out transaction may already be closed; close was still attempted.
          }
        }
        try {
          await withinLiveDeadline(
            () => writerSession.close(),
            1_000,
            'writer_session_close_timeout',
          );
        } catch {
          throw fixedFailure('race_close_failed');
        }
      }
      if (!observedTimeout) throw fixedFailure('writer_timeout_missing');
    });
    const auditSession = liveDriver.session();
    try {
      const residual = await auditSession.executeRead(residualCounts, { timeout: 10_000 });
      if (residual.nodes !== 0 || residual.relationships !== 0) {
        throw fixedFailure('cleanup_residual');
      }
    } finally {
      try {
        await auditSession.close();
      } catch {
        throw fixedFailure('race_close_failed');
      }
    }
  });
});
