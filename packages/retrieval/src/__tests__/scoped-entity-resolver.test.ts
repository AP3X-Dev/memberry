import neo4j from 'neo4j-driver';
import { describe, expect, it, vi } from 'vitest';
import {
  QUERY_PLAN_MAX_PROJECT_SCOPES,
  parseQueryPlanV1,
  type QueryPlanV1,
} from '../query-plan.js';
import {
  SCOPED_ENTITY_RESOLVER_MAX_RESULTS,
  SCOPED_ENTITY_RESOLVER_TIMEOUT_MS,
  ScopedEntityResolver as ScopedEntityResolverImplementation,
  ScopedEntityResolverError,
} from '../scoped-entity-resolver.js';

type Row = Readonly<Record<string, unknown>>;

function trustedAuthority(options: { tenantId?: string; projects?: string[] } = {}) {
  return Object.freeze({
    tenantId: options.tenantId ?? 'tenant-alpha',
    projectScopes: Object.freeze([...(options.projects ?? ['project:memberry'])]),
  });
}

const ScopedEntityResolver = (function TestScopedEntityResolver(
  driver: never,
  authority = trustedAuthority(),
): InstanceType<typeof ScopedEntityResolverImplementation> {
  const Constructor = ScopedEntityResolverImplementation as unknown as new (
    driver: never,
    trusted: ReturnType<typeof trustedAuthority>,
  ) => InstanceType<typeof ScopedEntityResolverImplementation>;
  return new Constructor(driver, authority);
}) as unknown as new (
  driver: never,
  authority?: ReturnType<typeof trustedAuthority>,
) => InstanceType<typeof ScopedEntityResolverImplementation>;

function record(row: Row) {
  const keys = Object.keys(row);
  return new neo4j.Record(keys, keys.map((key) => row[key]));
}

function fakeDriver(responses: readonly (readonly Row[])[]) {
  let call = 0;
  const run = vi.fn(async () => ({ records: (responses[call++] ?? []).map(record) }));
  const executeRead = vi.fn(async (work: (tx: { run: typeof run }) => unknown) => work({ run }));
  const commit = vi.fn(async () => undefined);
  const rollback = vi.fn(async () => undefined);
  const transactionClose = vi.fn(async () => undefined);
  const beginTransaction = vi.fn(() => ({ run, commit, rollback, close: transactionClose }));
  const close = vi.fn(async () => undefined);
  const session = vi.fn(() => ({ executeRead, beginTransaction, close }));
  return {
    driver: { session } as never,
    session,
    executeRead,
    beginTransaction,
    run,
    commit,
    rollback,
    transactionClose,
    close,
  };
}

function singleRunDriver(run: ReturnType<typeof vi.fn>) {
  const commit = vi.fn(async () => undefined);
  const rollback = vi.fn(async () => undefined);
  const transactionClose = vi.fn(async () => undefined);
  const beginTransaction = vi.fn(() => ({ run, commit, rollback, close: transactionClose }));
  const close = vi.fn(async () => undefined);
  const session = vi.fn(() => ({ beginTransaction, close }));
  return { driver: { session } as never, close };
}

function projectRow(overrides: Partial<Row> = {}, projectScope = 'project:memberry'): Row {
  return {
    projectScope,
    missing: false,
    duplicate: false,
    tenantOwned: true,
    projectId: 'project-id-memberry',
    ...overrides,
  };
}

function explicitRow(requestedId = 'entity-id-1', overrides: Partial<Row> = {}, ordinal = 0): Row {
  return {
    ordinal: String(ordinal).padStart(2, '0'),
    requestedId,
    found: true,
    uniqueAuthorizedPath: true,
    multiProject: false,
    depthOverflow: false,
    containmentCycle: false,
    candidateId: requestedId,
    ...overrides,
  };
}

function hintRow(hint: string, id: string, overrides: Partial<Row> = {}): Row {
  return {
    hint,
    uniqueAuthorizedPath: true,
    multiProject: false,
    depthOverflow: false,
    containmentCycle: false,
    candidateId: id,
    ...overrides,
  };
}

function plan(options: {
  tenantId?: string;
  projects?: string[];
  explicitIds?: string[];
  hints?: string[];
  state?: 'unresolved' | 'resolved';
} = {}): QueryPlanV1 {
  const state = options.state ?? 'unresolved';
  return parseQueryPlanV1({
    contractId: 'memberry.query-plan',
    contractVersion: '1.0.0',
    authority: {
      tenantId: options.tenantId ?? 'tenant-alpha',
      callerScopes: {
        projects: options.projects ?? ['project:memberry'],
        repositories: [],
        entities: options.explicitIds ?? [],
        symbols: [],
      },
    },
    intent: 'IDENTIFIER',
    temporalFrame: { mode: 'current' },
    evidenceNeeds: ['graph'],
    hints: {
      source: 'task',
      repositories: [],
      entities: options.hints ?? [],
      symbols: [],
    },
    resolution: state === 'resolved'
      ? { state: 'resolved', canonicalEntityIds: ['already-resolved'] }
      : { state: 'unresolved', canonicalEntityIds: [] },
  });
}

function expectResolverError(code: string) {
  return (error: unknown) => {
    expect(error).toBeInstanceOf(ScopedEntityResolverError);
    expect((error as ScopedEntityResolverError).code).toBe(code);
    expect((error as Error).message).toBe(`scoped_entity_resolver:${code}`);
    return true;
  };
}

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

describe('ScopedEntityResolver', () => {
  it('uses one bounded read transaction and bound parameters without interpolating authority or hints', async () => {
    const fake = fakeDriver([
      [projectRow()],
      [explicitRow()],
      [hintRow('MemoryEngine', 'entity-id-1')],
    ]);
    const resolver = new ScopedEntityResolver(fake.driver);

    const result = await resolver.resolve(plan({
      explicitIds: ['entity-id-1'],
      hints: ['MemoryEngine'],
    }));

    expect(result).toEqual({
      resolution: { state: 'resolved', canonicalEntityIds: ['entity-id-1'] },
      diagnostics: [],
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.resolution.canonicalEntityIds)).toBe(true);
    expect(fake.session).toHaveBeenCalledWith({ defaultAccessMode: neo4j.session.READ });
    expect(fake.executeRead).not.toHaveBeenCalled();
    expect(fake.beginTransaction).toHaveBeenCalledTimes(1);
    expect(fake.beginTransaction).toHaveBeenCalledWith({ timeout: SCOPED_ENTITY_RESOLVER_TIMEOUT_MS });
    expect(fake.commit).toHaveBeenCalledTimes(1);
    expect(fake.rollback).not.toHaveBeenCalled();
    expect(fake.transactionClose).toHaveBeenCalledTimes(1);
    expect(fake.run).toHaveBeenCalledTimes(3);
    expect(fake.close).toHaveBeenCalledTimes(1);

    const calls = fake.run.mock.calls as unknown as Array<[string, Record<string, unknown>]>;
    expect(calls[0]![1]).toMatchObject({
      projectScopes: ['project:memberry'],
      tenantId: 'tenant-alpha',
      defaultTenant: 'default',
    });
    expect(neo4j.isInt(calls[0]![1].projectCap)).toBe(true);
    expect((calls[0]![1].projectCap as neo4j.Integer).toNumber())
      .toBe(QUERY_PLAN_MAX_PROJECT_SCOPES + 1);
    expect(calls[1]![1]).toEqual({
      explicitEntityIds: ['entity-id-1'],
      authorizedProjectIds: ['project-id-memberry'],
      tenantId: 'tenant-alpha',
      defaultTenant: 'default',
    });
    expect(calls[2]![1]).toMatchObject({
      entityHints: ['MemoryEngine'],
      explicitEntityIds: ['entity-id-1'],
      authorizedProjectIds: ['project-id-memberry'],
      tenantId: 'tenant-alpha',
      defaultTenant: 'default',
    });
    expect(neo4j.isInt(calls[2]![1].resultCapPlusOne)).toBe(true);
    expect((calls[2]![1].resultCapPlusOne as neo4j.Integer).toNumber())
      .toBe(SCOPED_ENTITY_RESOLVER_MAX_RESULTS + 1);
    for (const [query] of calls) {
      expect(query).not.toContain('tenant-alpha');
      expect(query).not.toContain('entity-id-1');
      expect(query).not.toContain('MemoryEngine');
      expect(query).not.toMatch(/\b(?:CREATE|MERGE|SET|DELETE|DETACH|REMOVE|DROP)\b/i);
      expect(query).not.toMatch(/\bLIMIT\s+1\b/i);
    }
    expect(calls[0]![0]).toContain('lowerProjectName = substring(projectScope, 8)');
    expect(calls[0]![0]).toContain('project.project_scope = projectScope');
    expect(calls[0]![0]).toContain("character =~ '[a-z0-9]'");
    expect(calls[0]![0]).toContain('projectSlug = substring(projectScope, 8)');
    expect(calls[2]![0]).toContain('idCandidate:Entity {id: hint}');
    expect(calls[2]![0]).toContain('nameCandidate:Entity {name: hint}');
    expect(calls[2]![0]).toContain('WITH hint WHERE size(exactCandidates) = 0');
    expect(calls[0]![0]).not.toMatch(/owned:(?:Semantic|Episodic|Fact)/);
    expect(calls[0]![0]).toContain('MATCH (tenantProject:Entity {tenant_id: $tenantId})');
    expect(calls[0]![0]).toContain('$tenantId = $defaultTenant');
    expect(calls[0]![0]).toContain('legacyProject.tenant_id IS NULL');
    expect(calls[0]![0].indexOf('MATCH (tenantProject:Entity {tenant_id: $tenantId})'))
      .toBeLessThan(calls[0]![0].indexOf('collect(project)'));
    expect(calls[0]![0]).toContain('LIMIT $projectCap');
    expect(calls[0]![0]).not.toMatch(
      /OPTIONAL MATCH \(project:Entity \{type: 'project'\}\)\s+WHERE toLower\(project\.name\)/,
    );
    expect(calls[0]![0]).not.toMatch(/MATCH \([^)]*Project:Entity \{type: 'project'\}\)/);
    expect(calls[0]![0].indexOf('MATCH (tenantProject:Entity {tenant_id: $tenantId})'))
      .toBeLessThan(calls[0]![0].indexOf('toLower(project.name)'));
    expect(calls[0]![0].indexOf('LIMIT 2'))
      .toBeLessThan(calls[0]![0].indexOf('collect(project)'));
    expect(calls[1]![0]).toContain('CONTAINS*0..16');
    expect(calls[1]![0]).toContain('CONTAINS*17..17');
    expect(calls[1]![0]).toContain('acceptedPath');
    expect(calls[1]![0]).toContain('relationships(path)');
    expect(calls[1]![0]).toContain('nodes(acceptedPath)');
    expect(calls[1]![0]).toContain('CONTAINS*1..17');
    expect(calls[1]![0]).toContain('longPath');
    expect(calls[1]![0]).toContain('CONTAINS*17..64');
    expect(calls[1]![0]).not.toContain('proofTail');
    expect(calls[1]![0]).not.toContain('beyondProofBoundary');
    for (const [query] of calls.slice(1)) {
      expect(query).not.toMatch(/CONTAINS\*\d+\.\.(?=\])/);
    }
    expect(calls[1]![0]).toContain('(longCandidate:Entity {id: requestedId})');
    expect(calls[1]![0]).toContain('LIMIT 3');
    expect(calls[1]![0]).not.toContain('anyRoot');
    expect(calls[1]![0]).toContain('overflowRoot.id IN $authorizedProjectIds');
    expect(calls[1]![0]).toContain('root.tenant_id = $tenantId');
    expect(calls[1]![0]).toContain('longRoot.tenant_id = $tenantId');
    expect(calls[1]![0]).toContain('all(scopedNode IN nodes(acceptedPath)');
    expect(calls[1]![0]).toContain('all(scopedNode IN nodes(longPath)');
    expect(calls[1]![0]).toContain("scopedNode.type <> 'project'");
    expect(calls[1]![0]).toContain('node IN authorizedPathNodes');
    expect(calls[1]![0]).toContain('range(0, size($explicitEntityIds) - 1) AS ordinal');
    expect(calls[1]![0]).toContain('ORDER BY ordinal');
    expect(calls[1]![0]).toContain("right('00' + toString(ordinal), 2) AS ordinal");
    expect(calls[1]![0]).not.toContain('OPTIONAL MATCH (candidate:Entity {id: requestedId})');
    expect(calls[1]![0]).not.toMatch(/^\s*MATCH \((?:candidate|matchedCandidate):Entity/m);
    expect(calls[2]![0]).not.toMatch(/^\s*MATCH \((?:candidate|matchedCandidate):Entity/m);
    expect(calls[1]![0]).toContain('MATCH candidatePath = (candidateRoot:Entity');
    expect(calls[2]![0]).toContain('MATCH candidatePath = (candidateRoot:Entity');
    expect(calls[1]![0]).not.toMatch(/\b(?:stale|foreign)\b/);
    expect(calls[2]![0]).toContain('LIMIT $resultCapPlusOne');
    expect(calls[2]![0].indexOf('LIMIT $resultCapPlusOne'))
      .toBeLessThan(calls[2]![0].indexOf('collect(acceptedPath)'));
    expect(calls[2]![0]).toContain('candidate.id IN $explicitEntityIds');
    expect(calls[2]![0]).toContain('CONTAINS*17..17');
  });

  it('distinguishes zero, one, and multiple in-scope matches deterministically', async () => {
    const zero = fakeDriver([[projectRow()], []]);
    await expect(new ScopedEntityResolver(zero.driver).resolve(plan({ hints: ['missing'] })))
      .resolves.toEqual({
        resolution: { state: 'not-found', canonicalEntityIds: [] },
        diagnostics: ['entity_not_found'],
      });

    const one = fakeDriver([[projectRow()], [hintRow('one', 'entity-b')]]);
    await expect(new ScopedEntityResolver(one.driver).resolve(plan({ hints: ['one'] })))
      .resolves.toEqual({
        resolution: { state: 'resolved', canonicalEntityIds: ['entity-b'] },
        diagnostics: [],
      });

    const many = fakeDriver([[
      projectRow(),
    ], [hintRow('collision', 'entity-a'), hintRow('collision', 'entity-z')]]);
    await expect(new ScopedEntityResolver(many.driver).resolve(plan({ hints: ['collision'] })))
      .resolves.toEqual({
        resolution: { state: 'ambiguous', canonicalEntityIds: ['entity-a', 'entity-z'] },
        diagnostics: ['entity_ambiguous'],
      });
  });

  it.each([
    ['missing project', projectRow({ missing: true, tenantOwned: false, projectId: null }), 'denied', 'project_denied'],
    ['duplicate project identity', projectRow({ duplicate: true, tenantOwned: false, projectId: null }), 'denied', 'project_denied'],
    ['project not owned by tenant', projectRow({ tenantOwned: false, projectId: null }), 'denied', 'project_denied'],
  ])('fails closed for %s before querying entity IDs', async (_label, row, state, diagnostic) => {
    const fake = fakeDriver([[row]]);
    const result = await new ScopedEntityResolver(fake.driver).resolve(plan({
      explicitIds: ['possibly-foreign-id'],
      hints: ['possibly-foreign-name'],
    }));

    expect(result).toEqual({
      resolution: { state, canonicalEntityIds: [] },
      diagnostics: [diagnostic],
    });
    expect(fake.run).toHaveBeenCalledTimes(1);
  });

  it('requires independently trusted tenant and project authority before opening a session', async () => {
    const fake = fakeDriver([]);
    const resolver = new ScopedEntityResolver(fake.driver, trustedAuthority({
      tenantId: 'tenant-trusted',
      projects: ['project:trusted'],
    }));

    await expect(resolver.resolve(plan({
      tenantId: 'tenant-structural-only',
      projects: ['project:untrusted'],
    }))).resolves.toEqual({
      resolution: { state: 'denied', canonicalEntityIds: [] },
      diagnostics: ['authority_mismatch'],
    });
    expect(fake.session).not.toHaveBeenCalled();
  });

  it('denies an explicit foreign ID without returning a partial authorized match', async () => {
    const fake = fakeDriver([
      [projectRow()],
      [explicitRow('entity-id-1'), explicitRow('foreign-id', {
        found: false,
        uniqueAuthorizedPath: false,
        candidateId: null,
      }, 1)],
    ]);

    await expect(new ScopedEntityResolver(fake.driver).resolve(plan({
      explicitIds: ['entity-id-1', 'foreign-id'],
    }))).resolves.toEqual({
      resolution: { state: 'denied', canonicalEntityIds: [] },
      diagnostics: ['entity_id_denied'],
    });
  });

  it('denies an unavailable explicit ID identically without revealing stale versus foreign', async () => {
    const fake = fakeDriver([
      [projectRow()],
      [explicitRow('stale-id', { found: false, uniqueAuthorizedPath: false, candidateId: null })],
    ]);

    await expect(new ScopedEntityResolver(fake.driver).resolve(plan({
      explicitIds: ['stale-id'],
      hints: ['different-name'],
    }))).resolves.toEqual({
      resolution: { state: 'denied', canonicalEntityIds: [] },
      diagnostics: ['entity_id_denied'],
    });

    const foreignDepth17 = fakeDriver([
      [projectRow()],
      [explicitRow('foreign-depth-17', {
        found: false,
        uniqueAuthorizedPath: false,
        depthOverflow: true,
        candidateId: null,
      })],
    ]);
    await expect(new ScopedEntityResolver(foreignDepth17.driver).resolve(plan({
      explicitIds: ['foreign-depth-17'],
    }))).resolves.toEqual({
      resolution: { state: 'denied', canonicalEntityIds: [] },
      diagnostics: ['entity_id_denied'],
    });
  });

  it('rejects duplicate stable IDs and multi-project containment without exposing candidates', async () => {
    const duplicate = fakeDriver([
      [projectRow()],
      [explicitRow('duplicate-id', { found: false, uniqueAuthorizedPath: false, candidateId: null })],
    ]);
    await expect(new ScopedEntityResolver(duplicate.driver).resolve(plan({ explicitIds: ['duplicate-id'] })))
      .resolves.toEqual({
        resolution: { state: 'denied', canonicalEntityIds: [] },
        diagnostics: ['entity_id_denied'],
      });

    const multiParent = fakeDriver([
      [projectRow()],
      [hintRow('shared', 'shared-entity', { multiProject: true })],
    ]);
    await expect(new ScopedEntityResolver(multiParent.driver).resolve(plan({ hints: ['shared'] })))
      .resolves.toEqual({
        resolution: { state: 'denied', canonicalEntityIds: [] },
        diagnostics: ['entity_multi_project'],
      });
  });

  it('uses detected names and aliases only as candidates under authorized project IDs', async () => {
    const fake = fakeDriver([[projectRow({ projectId: 'authorized-root' })], []]);
    const result = await new ScopedEntityResolver(fake.driver).resolve(plan({ hints: ['foreign-alias'] }));

    expect(result.resolution.state).toBe('not-found');
    const hintCall = fake.run.mock.calls[1] as unknown as [string, Record<string, unknown>];
    expect(hintCall[0]).toContain('root.id IN $authorizedProjectIds');
    expect(hintCall[1].authorizedProjectIds).toEqual(['authorized-root']);
    expect(hintCall[1]).toMatchObject({ tenantId: 'tenant-alpha', defaultTenant: 'default' });
  });

  it('intersects task hints with explicit Entity-ID authority instead of unioning them', async () => {
    const fake = fakeDriver([
      [projectRow()],
      [explicitRow('entity-a')],
      [hintRow('detected-b', 'entity-b')],
    ]);

    await expect(new ScopedEntityResolver(fake.driver).resolve(plan({
      explicitIds: ['entity-a'],
      hints: ['detected-b'],
    }))).rejects.toSatisfy(expectResolverError('invalid_record'));
  });

  it('rejects duplicate hint echoes before candidate de-duplication', async () => {
    const fake = fakeDriver([
      [projectRow()],
      [hintRow('duplicate', 'entity-a'), hintRow('duplicate', 'entity-a')],
    ]);

    await expect(new ScopedEntityResolver(fake.driver).resolve(plan({ hints: ['duplicate'] })))
      .rejects.toSatisfy(expectResolverError('invalid_record'));
  });

  it('verifies project and explicit request echoes one-to-one in canonical order', async () => {
    const projectReorder = fakeDriver([[
      projectRow({}, 'project:memberry'),
      projectRow({ projectId: 'project-id-api' }, 'project:api'),
    ]]);
    await expect(new ScopedEntityResolver(
      projectReorder.driver,
      trustedAuthority({ projects: ['project:api', 'project:memberry'] }),
    ).resolve(plan({
      projects: ['project:api', 'project:memberry'],
    }))).rejects.toSatisfy(expectResolverError('invalid_record'));

    const explicitReorder = fakeDriver([
      [projectRow()],
      [explicitRow('entity-b', {}, 1), explicitRow('entity-a', {}, 0)],
    ]);
    await expect(new ScopedEntityResolver(explicitReorder.driver).resolve(plan({
      explicitIds: ['entity-a', 'entity-b'],
    }))).rejects.toSatisfy(expectResolverError('invalid_record'));

    const duplicateOrdinal = fakeDriver([
      [projectRow()],
      [explicitRow('entity-a'), explicitRow('entity-b')],
    ]);
    await expect(new ScopedEntityResolver(duplicateOrdinal.driver).resolve(plan({
      explicitIds: ['entity-a', 'entity-b'],
    }))).rejects.toSatisfy(expectResolverError('invalid_record'));
  });

  it('denies multi-project ancestry and any containment depth overflow', async () => {
    const deep = fakeDriver([
      [projectRow()],
      [hintRow('deep', 'deep-entity', { depthOverflow: true })],
    ]);
    await expect(new ScopedEntityResolver(deep.driver).resolve(plan({ hints: ['deep'] })))
      .resolves.toEqual({
        resolution: { state: 'denied', canonicalEntityIds: [] },
        diagnostics: ['entity_scope_overflow'],
      });

    const explicitDeep = fakeDriver([
      [projectRow()],
      [explicitRow('deep-id', { depthOverflow: true })],
    ]);
    await expect(new ScopedEntityResolver(explicitDeep.driver).resolve(plan({ explicitIds: ['deep-id'] })))
      .resolves.toEqual({
        resolution: { state: 'denied', canonicalEntityIds: [] },
        diagnostics: ['entity_scope_overflow'],
      });

    const longOnly = fakeDriver([
      [projectRow()],
      [explicitRow('long-only-id', {
        found: true,
        uniqueAuthorizedPath: false,
        depthOverflow: true,
        candidateId: null,
      })],
    ]);
    await expect(new ScopedEntityResolver(longOnly.driver).resolve(plan({ explicitIds: ['long-only-id'] })))
      .resolves.toEqual({
        resolution: { state: 'denied', canonicalEntityIds: [] },
        diagnostics: ['entity_scope_overflow'],
      });
  });

  it('fails closed on same-root path ambiguity and ancestor or candidate containment cycles', async () => {
    for (const [row, diagnostic] of [
      [hintRow('path', 'path-id', { uniqueAuthorizedPath: false }), 'entity_path_ambiguous'],
      [hintRow('cycle', 'cycle-id', { containmentCycle: true }), 'entity_containment_cycle'],
    ] as const) {
      const fake = fakeDriver([[projectRow()], [row]]);
      await expect(new ScopedEntityResolver(fake.driver).resolve(plan({ hints: [String(row.hint)] })))
        .resolves.toEqual({
          resolution: { state: 'denied', canonicalEntityIds: [] },
          diagnostics: [diagnostic],
        });
    }
  });

  it('reports genuine multi-root containment before generic path ambiguity', async () => {
    const fake = fakeDriver([
      [projectRow()],
      [hintRow('shared', 'shared-id', { uniqueAuthorizedPath: false, multiProject: true })],
    ]);
    await expect(new ScopedEntityResolver(fake.driver).resolve(plan({ hints: ['shared'] })))
      .resolves.toEqual({
        resolution: { state: 'denied', canonicalEntityIds: [] },
        diagnostics: ['entity_multi_project'],
      });
  });

  it('rejects result sets over the cap instead of truncating or guessing', async () => {
    const rows = Array.from(
      { length: SCOPED_ENTITY_RESOLVER_MAX_RESULTS + 1 },
      (_, index) => hintRow('popular-name', `entity-${String(index).padStart(2, '0')}`),
    );
    const fake = fakeDriver([[projectRow()], rows]);

    await expect(new ScopedEntityResolver(fake.driver).resolve(plan({ hints: ['popular-name'] })))
      .rejects.toSatisfy(expectResolverError('result_over_cap'));
  });

  it('rejects forged and pre-resolved plans before opening a session', async () => {
    const fake = fakeDriver([]);
    const resolver = new ScopedEntityResolver(fake.driver);
    const forged = { ...plan() } as QueryPlanV1;
    const unbounded = JSON.parse(JSON.stringify(plan())) as {
      authority: { callerScopes: { projects: string[] } };
    };
    unbounded.authority.callerScopes.projects = Array.from(
      { length: 17 },
      (_, index) => `project:p${String(index).padStart(2, '0')}`,
    );

    await expect(resolver.resolve(forged)).rejects.toSatisfy(expectResolverError('invalid_plan'));
    await expect(resolver.resolve(deepFreeze(unbounded) as unknown as QueryPlanV1))
      .rejects.toSatisfy(expectResolverError('invalid_plan'));
    await expect(resolver.resolve(plan({ state: 'resolved' })))
      .rejects.toSatisfy(expectResolverError('invalid_plan_state'));
    expect(fake.session).not.toHaveBeenCalled();
  });

  it('rejects frozen accessors and hostile proxies without invoking a trap', async () => {
    const fake = fakeDriver([]);
    const resolver = new ScopedEntityResolver(fake.driver);
    const accessorPlan = JSON.parse(JSON.stringify(plan())) as Record<string, unknown>;
    const authority = accessorPlan.authority;
    let accessorCalls = 0;
    Object.defineProperty(accessorPlan, 'authority', {
      enumerable: true,
      configurable: false,
      get() {
        accessorCalls += 1;
        return authority;
      },
    });
    Object.freeze(accessorPlan);

    let proxyTraps = 0;
    const proxyPlan = new Proxy(JSON.parse(JSON.stringify(plan())) as QueryPlanV1, {
      get(target, key, receiver) {
        proxyTraps += 1;
        return Reflect.get(target, key, receiver);
      },
      ownKeys(target) {
        proxyTraps += 1;
        return Reflect.ownKeys(target);
      },
      getOwnPropertyDescriptor(target, key) {
        proxyTraps += 1;
        return Reflect.getOwnPropertyDescriptor(target, key);
      },
      isExtensible(target) {
        proxyTraps += 1;
        return Reflect.isExtensible(target);
      },
    });

    await expect(resolver.resolve(accessorPlan as unknown as QueryPlanV1))
      .rejects.toSatisfy(expectResolverError('invalid_plan'));
    await expect(resolver.resolve(proxyPlan))
      .rejects.toSatisfy(expectResolverError('invalid_plan'));
    expect(accessorCalls).toBe(0);
    expect(proxyTraps).toBe(0);
    expect(fake.session).not.toHaveBeenCalled();
  });

  it('descriptor-snapshots trusted authority without invoking accessors or proxy traps', () => {
    const fake = fakeDriver([]);
    let accessorCalls = 0;
    const accessorAuthority = { projectScopes: ['project:memberry'] } as Record<string, unknown>;
    Object.defineProperty(accessorAuthority, 'tenantId', {
      enumerable: true,
      get() {
        accessorCalls += 1;
        return 'tenant-alpha';
      },
    });
    expect(() => new ScopedEntityResolver(
      fake.driver,
      accessorAuthority as ReturnType<typeof trustedAuthority>,
    )).toThrowError('scoped_entity_resolver:invalid_authority');
    expect(accessorCalls).toBe(0);

    let proxyTraps = 0;
    const proxyAuthority = new Proxy(trustedAuthority(), {
      get(target, key, receiver) {
        proxyTraps += 1;
        return Reflect.get(target, key, receiver);
      },
      ownKeys(target) {
        proxyTraps += 1;
        return Reflect.ownKeys(target);
      },
    });
    expect(() => new ScopedEntityResolver(fake.driver, proxyAuthority))
      .toThrowError('scoped_entity_resolver:invalid_authority');
    expect(proxyTraps).toBe(0);
    expect(fake.session).not.toHaveBeenCalled();
  });

  it('descriptor-snapshots results and official records without invoking hostile accessors or proxies', async () => {
    let resultAccessorCalls = 0;
    const accessorResult = {};
    Object.defineProperty(accessorResult, 'records', {
      enumerable: true,
      get() {
        resultAccessorCalls += 1;
        return [record(projectRow())];
      },
    });
    const accessorRun = vi.fn(async () => accessorResult);
    const accessorDriver = singleRunDriver(accessorRun);
    await expect(new ScopedEntityResolver(accessorDriver.driver).resolve(plan()))
      .rejects.toSatisfy(expectResolverError('invalid_record'));
    expect(resultAccessorCalls).toBe(0);

    let recordProxyTraps = 0;
    const proxiedRecord = new Proxy(record(projectRow()), {
      get(target, key, receiver) {
        recordProxyTraps += 1;
        return Reflect.get(target, key, receiver);
      },
    });
    const proxyRun = vi.fn(async () => ({ records: [proxiedRecord] }));
    const proxyDriver = singleRunDriver(proxyRun);
    await expect(new ScopedEntityResolver(proxyDriver.driver).resolve(plan()))
      .rejects.toSatisfy(expectResolverError('invalid_record'));
    expect(recordProxyTraps).toBe(0);
  });

  it('rejects hostile or forged ordinal markers without invoking hooks', async () => {
    let hooks = 0;
    const forged = {
      __isInteger__: true,
      inSafeRange() { hooks += 1; return true; },
      toNumber() { hooks += 1; return 0; },
    };
    const hostileProxy = new Proxy({}, {
      get() { hooks += 1; throw new Error('ordinal getter invoked'); },
      getOwnPropertyDescriptor() { hooks += 1; throw new Error('ordinal descriptor invoked'); },
    });
    const target = {};
    const revoked = Proxy.revocable(target, {});
    revoked.revoke();
    const accessor = Object.defineProperty({}, 'value', {
      get() { hooks += 1; throw new Error('ordinal accessor invoked'); },
    });

    for (const ordinal of [forged, hostileProxy, revoked.proxy, accessor]) {
      const fake = fakeDriver([[projectRow()], [explicitRow('entity-id-1', { ordinal })]]);
      await expect(new ScopedEntityResolver(fake.driver).resolve(plan({ explicitIds: ['entity-id-1'] })))
        .rejects.toSatisfy(expectResolverError('invalid_record'));
    }
    expect(hooks).toBe(0);
  });

  it('rejects accessor-backed, sparse, oversized, and stateful record containers', async () => {
    let fieldAccessorCalls = 0;
    const accessorRecord = Object.create(neo4j.Record.prototype) as Record<string, unknown>;
    Object.defineProperty(accessorRecord, 'keys', {
      enumerable: true,
      get() {
        fieldAccessorCalls += 1;
        return ['projectScope'];
      },
    });
    Object.defineProperties(accessorRecord, {
      length: { enumerable: true, value: 1 },
      _fields: { enumerable: true, value: ['project:memberry'] },
      _fieldLookup: { enumerable: true, value: { projectScope: 0 } },
    });
    const accessorFake = fakeDriver([[]]);
    accessorFake.run.mockResolvedValueOnce({ records: [accessorRecord] } as never);
    await expect(new ScopedEntityResolver(accessorFake.driver).resolve(plan()))
      .rejects.toSatisfy(expectResolverError('invalid_record'));
    expect(fieldAccessorCalls).toBe(0);

    const sparse = fakeDriver([[]]);
    sparse.run.mockResolvedValueOnce({ records: new Array(2) } as never);
    await expect(new ScopedEntityResolver(sparse.driver).resolve(plan()))
      .rejects.toSatisfy(expectResolverError('invalid_record'));

    const oversized = fakeDriver([[]]);
    oversized.run.mockResolvedValueOnce({
      records: Array.from({ length: SCOPED_ENTITY_RESOLVER_MAX_RESULTS + 2 }, () => record(projectRow())),
    } as never);
    await expect(new ScopedEntityResolver(oversized.driver).resolve(plan()))
      .rejects.toSatisfy(expectResolverError('invalid_record'));

    let reads = 0;
    const stateful = { get: () => { reads += 1; return reads % 2 === 0; } };
    const statefulFake = fakeDriver([[]]);
    statefulFake.run.mockResolvedValueOnce({ records: [stateful] } as never);
    await expect(new ScopedEntityResolver(statefulFake.driver).resolve(plan()))
      .rejects.toSatisfy(expectResolverError('invalid_record'));
    expect(reads).toBe(0);
  });

  it('maps malformed driver records and query failures to fixed value-free errors', async () => {
    const malformed = fakeDriver([[projectRow({ tenantOwned: 'yes' })]]);
    await expect(new ScopedEntityResolver(malformed.driver).resolve(plan()))
      .rejects.toSatisfy(expectResolverError('invalid_record'));

    const secret = 'driver leaked supplied-secret';
    const run = vi.fn(async () => { throw new Error(secret); });
    const queryFailure = singleRunDriver(run);
    let caught: unknown;
    try {
      await new ScopedEntityResolver(queryFailure.driver).resolve(plan());
    } catch (error) {
      caught = error;
    }
    expectResolverError('query_failed')(caught);
    expect((caught as Error).message).not.toContain(secret);
    expect(queryFailure.close).toHaveBeenCalledTimes(1);
  });

  it('uses one explicit attempt for retryable failures and closes the failed transaction', async () => {
    const fake = fakeDriver([[projectRow()]]);
    fake.run.mockRejectedValueOnce(Object.assign(new Error('retry me'), {
      code: 'Neo.TransientError.Transaction.DeadlockDetected',
    }));

    await expect(new ScopedEntityResolver(fake.driver).resolve(plan()))
      .rejects.toSatisfy(expectResolverError('query_failed'));
    expect(fake.beginTransaction).toHaveBeenCalledTimes(1);
    expect(fake.run).toHaveBeenCalledTimes(1);
    expect(fake.commit).not.toHaveBeenCalled();
    expect(fake.rollback).toHaveBeenCalledTimes(1);
    expect(fake.transactionClose).toHaveBeenCalledTimes(1);
    expect(fake.close).toHaveBeenCalledTimes(1);
  });

  it('maps transaction close failure after otherwise successful work to query_failed', async () => {
    const fake = fakeDriver([[projectRow()]]);
    fake.transactionClose.mockRejectedValueOnce(new Error('secret transaction close failure'));

    await expect(new ScopedEntityResolver(fake.driver).resolve(plan()))
      .rejects.toSatisfy(expectResolverError('query_failed'));
    expect(fake.commit).toHaveBeenCalledTimes(1);
    expect(fake.transactionClose).toHaveBeenCalledTimes(1);
    expect(fake.close).toHaveBeenCalledTimes(1);
  });

  it('bounds a hanging query by one wall-clock deadline while attempting every close path', async () => {
    vi.useFakeTimers();
    try {
      const fake = fakeDriver([]);
      fake.run.mockImplementationOnce(() => new Promise(() => undefined));
      const pending = new ScopedEntityResolver(fake.driver).resolve(plan());
      const rejection = expect(pending).rejects.toSatisfy(expectResolverError('query_failed'));

      await vi.advanceTimersByTimeAsync(SCOPED_ENTITY_RESOLVER_TIMEOUT_MS + 1);
      await rejection;
      expect(fake.beginTransaction).toHaveBeenCalledTimes(1);
      expect(fake.run).toHaveBeenCalledTimes(1);
      expect(fake.rollback).toHaveBeenCalledTimes(1);
      expect(fake.transactionClose).toHaveBeenCalledTimes(1);
      expect(fake.close).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('prevents a timed-out query from issuing any later query after late settlement', async () => {
    vi.useFakeTimers();
    try {
      const fake = fakeDriver([[], []]);
      let settle!: (value: { records: neo4j.Record[] }) => void;
      fake.run.mockImplementationOnce(() => new Promise((resolve) => { settle = resolve; }));
      const pending = new ScopedEntityResolver(fake.driver).resolve(plan({ hints: ['late'] }));
      const rejection = expect(pending).rejects.toSatisfy(expectResolverError('query_failed'));

      await vi.advanceTimersByTimeAsync(SCOPED_ENTITY_RESOLVER_TIMEOUT_MS + 1);
      await rejection;
      settle({ records: [record(projectRow())] });
      await Promise.resolve();
      await Promise.resolve();
      expect(fake.run).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not hang when session.close never settles', async () => {
    vi.useFakeTimers();
    try {
      const fake = fakeDriver([[projectRow()]]);
      fake.close.mockImplementationOnce(() => new Promise(() => undefined));
      const pending = new ScopedEntityResolver(fake.driver).resolve(plan());
      const rejection = expect(pending).rejects.toSatisfy(expectResolverError('query_failed'));

      await vi.advanceTimersByTimeAsync(SCOPED_ENTITY_RESOLVER_TIMEOUT_MS + 1);
      await rejection;
      expect(fake.close).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('maps a session close failure after successful resolution to fixed query_failed', async () => {
    const fake = fakeDriver([[projectRow()]]);
    fake.close.mockRejectedValueOnce(new Error('secret close failure'));

    await expect(new ScopedEntityResolver(fake.driver).resolve(plan()))
      .rejects.toSatisfy(expectResolverError('query_failed'));
  });

  it('rejects malformed or unsafe canonical IDs returned by the driver', async () => {
    const fake = fakeDriver([[projectRow()], [hintRow('candidate', 'not safe!')]]);
    await expect(new ScopedEntityResolver(fake.driver).resolve(plan({ hints: ['candidate'] })))
      .rejects.toSatisfy(expectResolverError('invalid_record'));
  });
});
