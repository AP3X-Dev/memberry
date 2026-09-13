import neo4j, { type Driver } from 'neo4j-driver';

export const UNSCOPED_KNOWLEDGE_PROJECT = '_unscoped' as const;

export interface KnowledgeEpochScope {
  readonly tenantId: string;
  readonly projectScope: string | null;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}

type QueryRunner = {
  run(query: string, parameters?: Record<string, unknown>): Promise<{
    records: Array<{ get(key: string): unknown }>;
  }>;
};

const TENANT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const PROJECT_SCOPE = /^project:[a-z0-9][a-z0-9._-]{0,127}$/;
const DECIMAL_EPOCH = /^(0|[1-9][0-9]*)$/;

/** Map a writer's domain-specific scope to the exact project authority lane. */
export function projectKnowledgeScope(scope: string | null | undefined): string | null {
  if (scope == null || !scope.toLowerCase().startsWith('project:')) return null;
  const canonical = scope.toLowerCase();
  if (!PROJECT_SCOPE.test(canonical) || canonical.includes('*')) {
    throw new Error('knowledge_epoch:canonical_project_scope_required');
  }
  return canonical;
}

export const KNOWLEDGE_EPOCH_INCREMENT_CYPHER = `
MERGE (epoch:KnowledgeEpoch {tenant_id: $epochTenantId, project_scope: $epochProjectScope})
ON CREATE SET epoch.value = 0
SET epoch.value = epoch.value + 1
RETURN toString(epoch.value) AS knowledgeEpoch`;

function normalizeScope(scope: KnowledgeEpochScope): {
  epochTenantId: string;
  epochProjectScope: string;
} {
  const tenantId = scope.tenantId.trim();
  if (!TENANT_ID.test(tenantId) || tenantId.includes('*')) {
    throw new Error('knowledge_epoch:concrete_tenant_required');
  }
  if (scope.projectScope === null) {
    return { epochTenantId: tenantId, epochProjectScope: UNSCOPED_KNOWLEDGE_PROJECT };
  }
  const projectScope = scope.projectScope.toLowerCase();
  if (!PROJECT_SCOPE.test(projectScope) || projectScope.includes('*')) {
    throw new Error('knowledge_epoch:canonical_project_scope_required');
  }
  return { epochTenantId: tenantId, epochProjectScope: projectScope };
}

function exactEpoch(record: { get(key: string): unknown } | undefined): string {
  const value = record?.get('knowledgeEpoch');
  if (typeof value !== 'string' || !DECIMAL_EPOCH.test(value)) {
    throw new Error('knowledge_epoch:invalid_authority_value');
  }
  return value;
}

/** Increment authority using the caller's existing transaction. */
export async function bumpKnowledgeEpoch(
  tx: QueryRunner,
  scope: KnowledgeEpochScope,
): Promise<string> {
  const params = normalizeScope(scope);
  const result = await tx.run(KNOWLEDGE_EPOCH_INCREMENT_CYPHER, params);
  const projectEpoch = exactEpoch(result.records[0]);
  if (params.epochProjectScope !== UNSCOPED_KNOWLEDGE_PROJECT) {
    const tenantResult = await tx.run(KNOWLEDGE_EPOCH_INCREMENT_CYPHER, {
      ...params,
      epochProjectScope: UNSCOPED_KNOWLEDGE_PROJECT,
    });
    exactEpoch(tenantResult.records[0]);
  }
  return projectEpoch;
}

export class KnowledgeEpochStore {
  constructor(private readonly driver: Driver) {}

  async read(scope: KnowledgeEpochScope): Promise<{ knowledgeEpoch: string }> {
    if (scope.signal?.aborted) throw new Error('knowledge_epoch:aborted');
    const timeoutMs = scope.timeoutMs ?? 1_000;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) {
      throw new Error('knowledge_epoch:invalid_timeout');
    }
    const params = normalizeScope(scope);
    const session = this.driver.session();
    let abortHandler: (() => void) | undefined;
    try {
      const query = session.run(
        `OPTIONAL MATCH (epoch:KnowledgeEpoch {
           tenant_id: $epochTenantId, project_scope: $epochProjectScope
         })
         RETURN coalesce(toString(epoch.value), '0') AS knowledgeEpoch`,
        params,
        { timeout: neo4j.int(timeoutMs) },
      );
      const result = scope.signal
        ? await Promise.race([
          query,
          new Promise<never>((_resolve, reject) => {
            abortHandler = () => reject(new Error('knowledge_epoch:aborted'));
            if (scope.signal!.aborted) abortHandler();
            else scope.signal!.addEventListener('abort', abortHandler, { once: true });
          }),
        ])
        : await query;
      return { knowledgeEpoch: exactEpoch(result.records[0]) };
    } finally {
      if (abortHandler) scope.signal?.removeEventListener('abort', abortHandler);
      await session.close();
    }
  }
}
