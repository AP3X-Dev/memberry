import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import neo4j, { type Driver } from 'neo4j-driver';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  EVIDENCE_SOURCE_FACT_STATE_VERSION,
  createEvidenceSourceFactState,
  type EvidenceSourceFactStateResultV1,
} from '../evidence-source-fact-state.js';

const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const MODULE_PATH = resolve(REPO_ROOT, 'packages/neo4j/src/evidence-source-fact-state.ts');
const CONTRACT_PATH = resolve(REPO_ROOT, 'packages/core/src/evidence-eligibility-authority.ts');
const moduleSource = readFileSync(MODULE_PATH, 'utf8');
const contractSource = readFileSync(CONTRACT_PATH, 'utf8');

const FIXED_NOW = '2026-08-19T03:00:00.000Z';
const SCOPE = Object.freeze({
  tenantId: 'tenant-acme',
  projectScope: 'project:memberry',
  resolvedEntityId: 'entity-acme-001',
});

type Props = Record<string, unknown>;

function record(values: Props) {
  return { get: (key: string) => values[key] };
}

function factRow(input: {
  evidenceId: string;
  status?: unknown;
  validAt?: unknown;
  invalidAt?: unknown;
  supersedingCount?: unknown;
}) {
  return record({
    evidenceId: input.evidenceId,
    status: 'status' in input ? input.status : 'active',
    validAt: 'validAt' in input ? input.validAt : '2026-08-01T00:00:00.000Z',
    invalidAt: 'invalidAt' in input ? input.invalidAt : null,
    supersedingCount: 'supersedingCount' in input ? input.supersedingCount : neo4j.int(0),
  });
}

interface Harness {
  driver: Driver;
  runs: Array<{ query: string; params: Props }>;
  sessionConfigs: unknown[];
  closes: number;
}

function harness(behavior: {
  records?: unknown;
  runThrows?: boolean;
  sessionThrows?: boolean;
  closeThrows?: boolean;
} = {}): Harness {
  const runs: Array<{ query: string; params: Props }> = [];
  const sessionConfigs: unknown[] = [];
  const state = { closes: 0 };
  const driver = {
    session: (config?: unknown) => {
      if (behavior.sessionThrows) throw new Error('session-unavailable');
      sessionConfigs.push(config);
      return {
        run: async (query: string, params: Props) => {
          runs.push({ query, params });
          if (behavior.runThrows) throw new Error('run-failed');
          return { records: behavior.records ?? [] };
        },
        close: async () => {
          state.closes += 1;
          if (behavior.closeThrows) throw new Error('close-failed');
        },
      };
    },
  } as unknown as Driver;
  return {
    driver,
    runs,
    sessionConfigs,
    get closes() { return state.closes; },
  } as Harness;
}

async function observe(
  behavior: Parameters<typeof harness>[0],
  request: unknown,
  scope: unknown = SCOPE,
): Promise<{ result: EvidenceSourceFactStateResultV1; harness: Harness }> {
  const fake = harness(behavior);
  const surface = createEvidenceSourceFactState(fake.driver, scope);
  const result = await surface.observeFactState(request);
  return { result, harness: fake };
}

function unsupported(code: string) {
  return {
    contractVersion: EVIDENCE_SOURCE_FACT_STATE_VERSION,
    outcome: 'unsupported',
    code,
  };
}

function importSpecifiers(source: string): string[] {
  return [
    ...source.matchAll(/from '([^']+)'/g),
    ...source.matchAll(/import '([^']+)'/g),
    ...source.matchAll(/import\('([^']+)'\)/g),
    ...source.matchAll(/require\('([^']+)'\)/g),
  ].map((match) => match[1]!);
}

describe('EvidenceSourceFactState V1 (RET-005B-AUTH-001B5, module 1)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(FIXED_NOW));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('freezes the version constant and the factory surface (T1)', () => {
    expect(EVIDENCE_SOURCE_FACT_STATE_VERSION).toBe('memberry.evidence-source-fact-state/1.0.0');
    const surface = createEvidenceSourceFactState(harness().driver, SCOPE);
    expect(surface.contractVersion).toBe(EVIDENCE_SOURCE_FACT_STATE_VERSION);
    expect(Object.isFrozen(surface)).toBe(true);
    expect(Object.getPrototypeOf(surface)).toBeNull();
    expect(typeof surface.observeFactState).toBe('function');
  });

  it('binds the scope triple once at construction and refuses a hostile corpus (T2)', async () => {
    const hostile: unknown[] = [
      null,
      'scope',
      42,
      [],
      new Proxy({ ...SCOPE }, {}),
      Object.assign(Object.create({ inherited: true }), SCOPE),
      { tenantId: SCOPE.tenantId, projectScope: SCOPE.projectScope },
      { ...SCOPE, extra: 'x' },
      { ...SCOPE, projectScope: 'memberry' },
      { ...SCOPE, projectScope: 'project:Memberry' },
      { ...SCOPE, tenantId: '' },
      { ...SCOPE, tenantId: 'a'.repeat(501) },
      { ...SCOPE, resolvedEntityId: 'entity acme' },
      { ...SCOPE, resolvedEntityId: 7 },
    ];
    for (const scope of hostile) {
      expect(() => createEvidenceSourceFactState(harness().driver, scope))
        .toThrowError(/evidence_source_fact_state:invalid_scope/);
    }
    // The bound triple is a frozen copy: mutating the caller's object after
    // construction can never move the query's scope.
    const mutable = { ...SCOPE };
    const fake = harness({ records: [] });
    const surface = createEvidenceSourceFactState(fake.driver, mutable);
    mutable.resolvedEntityId = 'entity-somewhere-else';
    await surface.observeFactState({ mode: 'current', evidenceIds: ['fact-a'] });
    expect(fake.runs[0]!.params.resolvedEntityId).toBe(SCOPE.resolvedEntityId);
    expect(fake.runs[0]!.params.tenantId).toBe(SCOPE.tenantId);
  });

  it('throws on every malformed request shape, including duplicate ids (T3)', async () => {
    const surface = createEvidenceSourceFactState(harness().driver, SCOPE);
    const hostile: unknown[] = [
      null,
      'current',
      [],
      new Proxy({ mode: 'current', evidenceIds: [] }, {}),
      { mode: 'current' },
      { mode: 'current', evidenceIds: [], extra: 1 },
      { mode: 'historical', evidenceIds: [] },
      { mode: 'current', evidenceIds: 'fact-a' },
      { mode: 'current', evidenceIds: [1] },
      { mode: 'current', evidenceIds: [''] },
      { mode: 'current', evidenceIds: ['bad id'] },
      { mode: 'current', evidenceIds: ['a'.repeat(201)] },
      { mode: 'current', evidenceIds: Object.assign(new Array(2), { 0: 'fact-a' }) },
      { mode: 'current', evidenceIds: ['fact-a', 'fact-a'] },
    ];
    for (const request of hostile) {
      await expect(surface.observeFactState(request))
        .rejects.toThrowError(/evidence_source_fact_state:invalid_command/);
    }
  });

  it('refuses a historical frame with zero driver interaction (T4)', async () => {
    const { result, harness: fake } = await observe({}, { mode: 'as-of', evidenceIds: ['fact-a'] });
    expect(result).toEqual(unsupported('fact-state-frame-unsupported'));
    expect(fake.runs).toHaveLength(0);
    expect(fake.sessionConfigs).toHaveLength(0);
    expect(fake.closes).toBe(0);
  });

  it('observes a zero-length batch as a canonical, empty observation (T5)', async () => {
    const { result } = await observe({ records: [] }, { mode: 'current', evidenceIds: [] });
    expect(result).toEqual({
      contractVersion: EVIDENCE_SOURCE_FACT_STATE_VERSION,
      outcome: 'observed',
      observedAt: FIXED_NOW,
      entries: [],
    });
  });

  it('derives raw source state for three rows in request order, deeply frozen (T6)', async () => {
    const { result } = await observe({
      records: [
        factRow({ evidenceId: 'fact-a', status: 'active' }),
        factRow({
          evidenceId: 'fact-b',
          status: 'disputed',
          supersedingCount: neo4j.int(1),
        }),
        factRow({
          evidenceId: 'fact-c',
          status: 'invalidated',
          invalidAt: '2026-08-02T00:00:00.000Z',
        }),
      ],
    }, { mode: 'current', evidenceIds: ['fact-a', 'fact-b', 'fact-c'] });

    expect(result).toEqual({
      contractVersion: EVIDENCE_SOURCE_FACT_STATE_VERSION,
      outcome: 'observed',
      observedAt: FIXED_NOW,
      entries: [
        { evidenceId: 'fact-a', status: 'active', withinValidTime: true, superseded: false },
        { evidenceId: 'fact-b', status: 'disputed', withinValidTime: true, superseded: true },
        { evidenceId: 'fact-c', status: 'invalidated', withinValidTime: false, superseded: false },
      ],
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.getPrototypeOf(result)).toBeNull();
    const observed = result as { entries: readonly unknown[] };
    expect(Object.isFrozen(observed.entries)).toBe(true);
    for (const entry of observed.entries) {
      expect(Object.isFrozen(entry)).toBe(true);
      expect(Object.getPrototypeOf(entry as object)).toBeNull();
    }
    // No axis vocabulary is minted here: the entry carries the source's own
    // status token and two booleans, and nothing else.
    expect(Object.keys(observed.entries[0] as object).sort())
      .toEqual(['evidenceId', 'status', 'superseded', 'withinValidTime']);
  });

  it('pins the candidate cap to the contract literal and refuses 129 ids (T7)', async () => {
    expect(moduleSource).toContain('const MAX_OBSERVED_CANDIDATES = 128;');
    expect(contractSource)
      .toContain('export const EVIDENCE_ELIGIBILITY_AUTHORITY_MAX_CANDIDATES = 128 as const;');
    const surface = createEvidenceSourceFactState(harness().driver, SCOPE);
    const ids = Array.from({ length: 129 }, (_, index) => `fact-${index}`);
    await expect(surface.observeFactState({ mode: 'current', evidenceIds: ids }))
      .rejects.toThrowError(/evidence_source_fact_state:invalid_command/);
  });

  it('pins the canonical-instant and evidence-id hand copies to the contract literals (T8)', () => {
    const pin = (source: string, name: string): string | undefined =>
      source.match(new RegExp(`const ${name} = (/.*/);`))?.[1];
    expect(pin(moduleSource, 'CANONICAL_INSTANT')).toBe(pin(contractSource, 'CANONICAL_INSTANT'));
    expect(pin(moduleSource, 'CANONICAL_INSTANT')).toBeDefined();
    expect(pin(moduleSource, 'SAFE_EVIDENCE_ID')).toBe(pin(contractSource, 'SAFE_EVIDENCE_ID'));
    expect(pin(moduleSource, 'SAFE_EVIDENCE_ID')).toBeDefined();
    expect(moduleSource).toContain('const MAX_EVIDENCE_ID_LENGTH = 200;');
    expect(contractSource)
      .toContain('export const EVIDENCE_ELIGIBILITY_AUTHORITY_MAX_EVIDENCE_ID_BYTES = 200 as const;');
  });

  it('refuses the whole batch when any candidate is absent in scope (T9)', async () => {
    const { result } = await observe({
      records: [
        factRow({ evidenceId: 'fact-a' }),
        record({
          evidenceId: 'fact-b',
          status: null,
          validAt: null,
          invalidAt: null,
          supersedingCount: neo4j.int(0),
        }),
      ],
    }, { mode: 'current', evidenceIds: ['fact-a', 'fact-b'] });
    expect(result).toEqual(unsupported('fact-state-candidate-missing'));
  });

  it('refuses every status outside the three-member positive whitelist (T10)', async () => {
    for (const status of ['tentative', 'quarantined', 'ACTIVE', '', 7, null]) {
      const { result } = await observe({
        records: [factRow({ evidenceId: 'fact-a', status })],
      }, { mode: 'current', evidenceIds: ['fact-a'] });
      expect(result).toEqual(unsupported('fact-state-status-unrecognized'));
    }
  });

  it('refuses null and near-miss instant formats without coercion (T11)', async () => {
    const badTimes = [
      null,
      undefined,
      '2026-08-19T03:00:13Z',
      '2026-08-19T03:00:13.123456789Z',
      '2026-08-19T03:00:13.123+00:00',
      '2026-13-19T03:00:13.123Z',
      1755571200000,
    ];
    for (const validAt of badTimes) {
      const { result } = await observe({
        records: [factRow({ evidenceId: 'fact-a', validAt, invalidAt: null })],
      }, { mode: 'current', evidenceIds: ['fact-a'] });
      expect(result).toEqual(unsupported('fact-state-time-unusable'));
    }
    for (const invalidAt of badTimes.filter((value) => value !== null && value !== undefined)) {
      const { result } = await observe({
        records: [factRow({ evidenceId: 'fact-a', invalidAt })],
      }, { mode: 'current', evidenceIds: ['fact-a'] });
      expect(result).toEqual(unsupported('fact-state-time-unusable'));
    }
  });

  it('closes valid time inclusively at the open bound and strictly at the close bound (T12)', async () => {
    const arms: Array<[unknown, unknown, boolean]> = [
      ['2026-08-01T00:00:00.000Z', null, true],
      [FIXED_NOW, null, true],
      ['2026-08-20T00:00:00.000Z', null, false],
      ['2026-08-01T00:00:00.000Z', '2026-08-20T00:00:00.000Z', true],
      ['2026-08-01T00:00:00.000Z', FIXED_NOW, false],
      ['2026-08-01T00:00:00.000Z', '2026-08-02T00:00:00.000Z', false],
    ];
    for (const [validAt, invalidAt, expected] of arms) {
      const { result } = await observe({
        records: [factRow({ evidenceId: 'fact-a', validAt, invalidAt })],
      }, { mode: 'current', evidenceIds: ['fact-a'] });
      expect((result as { entries: Array<{ withinValidTime: boolean }> }).entries[0]!.withinValidTime)
        .toBe(expected);
    }
  });

  it('normalizes the supersession count across number, bigint and driver Integer (T13)', async () => {
    const arms: Array<[unknown, boolean]> = [
      [neo4j.int(0), false],
      [neo4j.int(1), true],
      [neo4j.int(9), true],
      [0, false],
      [3, true],
      [2n, true],
    ];
    for (const [supersedingCount, expected] of arms) {
      const { result } = await observe({
        records: [factRow({ evidenceId: 'fact-a', supersedingCount })],
      }, { mode: 'current', evidenceIds: ['fact-a'] });
      expect((result as { entries: Array<{ superseded: boolean }> }).entries[0]!.superseded)
        .toBe(expected);
    }
    for (const supersedingCount of [null, -1, 'two', {}, Number.NaN, 1.5]) {
      const { result } = await observe({
        records: [factRow({ evidenceId: 'fact-a', supersedingCount })],
      }, { mode: 'current', evidenceIds: ['fact-a'] });
      expect(result).toEqual(unsupported('fact-state-source-unavailable'));
    }
  });

  it('asserts row count and row order rather than assuming them (T14)', async () => {
    const short = await observe({
      records: [factRow({ evidenceId: 'fact-a' })],
    }, { mode: 'current', evidenceIds: ['fact-a', 'fact-b'] });
    expect(short.result).toEqual(unsupported('fact-state-source-unavailable'));

    const long = await observe({
      records: [factRow({ evidenceId: 'fact-a' }), factRow({ evidenceId: 'fact-b' })],
    }, { mode: 'current', evidenceIds: ['fact-a'] });
    expect(long.result).toEqual(unsupported('fact-state-source-unavailable'));

    // Mutation arm: the rows are individually valid and complete; only their
    // order is wrong. Dropping the order assertion would silently attribute
    // fact-b's state to fact-a.
    const shuffled = await observe({
      records: [factRow({ evidenceId: 'fact-b' }), factRow({ evidenceId: 'fact-a' })],
    }, { mode: 'current', evidenceIds: ['fact-a', 'fact-b'] });
    expect(shuffled.result).toEqual(unsupported('fact-state-source-unavailable'));

    const ordered = await observe({
      records: [factRow({ evidenceId: 'fact-a' }), factRow({ evidenceId: 'fact-b' })],
    }, { mode: 'current', evidenceIds: ['fact-a', 'fact-b'] });
    expect((ordered.result as { outcome: string }).outcome).toBe('observed');
  });

  it('refuses every wire failure and always closes the session (T15)', async () => {
    const thrown = await observe({ runThrows: true }, { mode: 'current', evidenceIds: ['fact-a'] });
    expect(thrown.result).toEqual(unsupported('fact-state-source-unavailable'));
    expect(thrown.harness.closes).toBe(1);

    const shaped = await observe(
      { records: 'not-an-array' as unknown as unknown[] },
      { mode: 'current', evidenceIds: ['fact-a'] },
    );
    expect(shaped.result).toEqual(unsupported('fact-state-source-unavailable'));
    expect(shaped.harness.closes).toBe(1);

    const healthy = await observe({
      records: [factRow({ evidenceId: 'fact-a' })],
    }, { mode: 'current', evidenceIds: ['fact-a'] });
    expect((healthy.result as { outcome: string }).outcome).toBe('observed');
    expect(healthy.harness.closes).toBe(1);

    const unopenable = await observe({ sessionThrows: true }, { mode: 'current', evidenceIds: ['fact-a'] });
    expect(unopenable.result).toEqual(unsupported('fact-state-source-unavailable'));

    // A close failure never manufactures nor replaces an observation.
    const closeFailed = await observe({
      records: [factRow({ evidenceId: 'fact-a' })],
      closeThrows: true,
    }, { mode: 'current', evidenceIds: ['fact-a'] });
    expect((closeFailed.result as { outcome: string }).outcome).toBe('observed');
    expect(closeFailed.harness.closes).toBe(1);
  });

  it('sends exactly the bound statement on a READ session (T16)', async () => {
    const { harness: fake } = await observe({
      records: [factRow({ evidenceId: 'fact-a' })],
    }, { mode: 'current', evidenceIds: ['fact-a'] });
    expect(fake.runs).toHaveLength(1);
    expect(fake.sessionConfigs).toEqual([{ defaultAccessMode: neo4j.session.READ }]);
    const { query, params } = fake.runs[0]!;
    expect(query).toContain('UNWIND range(0, size($evidenceIds) - 1) AS idx');
    expect(query).toContain('WITH idx, $evidenceIds[idx] AS eid');
    expect(query).toContain('OPTIONAL MATCH (f:Fact {id: eid})');
    expect(query).toContain('OPTIONAL MATCH (s:Fact)-[:SUPERSEDES_FACT]->(f)');
    expect(query).toContain('f.entity_id = $resolvedEntityId');
    expect(query).toContain('f.tenant_id = $tenantId');
    expect(query).toContain('s.tenant_id = $tenantId');
    expect(query).toContain('WITH idx, eid, f, count(s) AS supersedingCount');
    expect(query.trimEnd().endsWith('ORDER BY idx')).toBe(true);
    expect(query).not.toMatch(/\bLIMIT\b/);
    expect(query).not.toMatch(/\bSET\b|\bCREATE\b|\bMERGE\b|\bDELETE\b|\bREMOVE\b|\bDETACH\b/);
    expect(params).toEqual({
      evidenceIds: ['fact-a'],
      resolvedEntityId: SCOPE.resolvedEntityId,
      tenantId: SCOPE.tenantId,
    });
  });

  it('passes every module-1 ban individually and stays off the root export (T17)', () => {
    // (1) write and adjacency set.
    expect(moduleSource).not.toMatch(/CREATE\s*\(/);
    expect(moduleSource).not.toMatch(/MERGE\s*\(/);
    expect(moduleSource).not.toMatch(/\bSET\b/);
    expect(moduleSource).not.toMatch(/\bDELETE\b/);
    expect(moduleSource).not.toMatch(/\bREMOVE\b/);
    expect(moduleSource).not.toMatch(/\bDETACH\b/);
    expect(moduleSource).not.toMatch(/executeWrite/);
    // (2) no transport bound on an authority read.
    expect(moduleSource).not.toMatch(/\bLIMIT\b/);
    // (3) lock bans.
    expect(moduleSource).not.toMatch(/evidence-authority:lock/);
    expect(moduleSource).not.toMatch(/ledger\.locked/);
    // (4) no contract package import of any kind, including type-only.
    expect(moduleSource).not.toMatch(/@memberry\/core|packages\/core/);
    // (5) structural proof that B5 does not consume B4.
    expect(moduleSource).not.toMatch(/clearance-/);
    expect(moduleSource).not.toMatch(/EvidenceAuthorityClearance/);
    expect(moduleSource).not.toMatch(/createEvidenceAuthorityClearance/);
    // (6) Core-axis-exclusive vocabulary, quoted forms, zero occurrences. The
    // three fact status literals are lawful here and deliberately unbanned.
    expect(moduleSource).not.toMatch(/'in-frame'/);
    expect(moduleSource).not.toMatch(/'out-of-frame'/);
    expect(moduleSource).not.toMatch(/'inactive'/);
    expect(moduleSource).not.toMatch(/'withheld'/);
    expect(moduleSource).not.toMatch(/'clear'/);
    expect(moduleSource).not.toMatch(/'superseded'/);
    // The quoted binding is load-bearing: the bare field name is expected.
    expect(moduleSource).toMatch(/superseded/);
    // (7) the contract's codes belong to the composition, never to a source.
    expect(moduleSource).not.toMatch(/adjudication-pending/);
    expect(moduleSource).not.toMatch(/adjudication-coverage-gap/);
    expect(moduleSource).not.toMatch(/source-policy-unavailable/);
    expect(moduleSource).not.toMatch(/record-time-unavailable/);
    expect(moduleSource).not.toMatch(/temporal-history-unavailable/);
    // (8) infrastructure set.
    expect(moduleSource).not.toMatch(/process\.env|MEMBERRY_/);
    expect(moduleSource).not.toMatch(/console\./);
    expect(moduleSource).not.toMatch(/Redis|ProposalStore|Consolidation|Retrieval|MCP/);
    expect(moduleSource).not.toContain('node:fs');
    // (9) exactly one application-clock read, in the named function.
    expect(moduleSource).not.toMatch(/Date\.now\(/);
    expect([...moduleSource.matchAll(/new Date\(/g)]).toHaveLength(1);
    expect([...moduleSource.matchAll(/new Date\(\s*\)/g)]).toHaveLength(1);
    expect(moduleSource).toMatch(
      /function observationInstant\(\): string \| null \{\n\s+const instant = new Date\(\)\.toISOString\(\);/,
    );
    // (10) honesty set.
    expect(moduleSource).not.toMatch(/authenticated|non-repudiation|verified reviewer/i);
    // (11) delivery and wiring verb sets.
    expect(moduleSource).not.toMatch(/\backRow|acknowledge|nack\(|markDelivered|deadLetter|redeliver|inflight/i);
    expect(moduleSource).not.toMatch(/createSink|deliverTo|pushOutbox|pushTo|saveCheckpoint|checkpointCursor/i);
    // Structural regime: const-only module scope, no cache of any kind.
    expect(moduleSource).not.toMatch(/^(let|var)\s/m);
    expect(moduleSource).not.toMatch(/new (Map|Set)\b/);
    for (const name of ['SCOPE_KEYS', 'REQUEST_KEYS', 'FACT_STATUS_WHITELIST']) {
      expect(moduleSource).toMatch(new RegExp(`const ${name}[^=]*= Object\\.freeze\\(`));
    }
    for (const name of [
      'SOURCE_UNAVAILABLE', 'FRAME_UNSUPPORTED', 'CANDIDATE_MISSING',
      'STATUS_UNRECOGNIZED', 'TIME_UNUSABLE',
    ]) {
      expect(moduleSource).toMatch(new RegExp(
        `const ${name}[^=]*= Object\\.freeze\\(Object\\.assign\\(Object\\.create\\(null\\)`,
      ));
    }
    // Import allowlist, exact.
    expect([...new Set(importSpecifiers(moduleSource))].sort())
      .toEqual(['./tenant.js', 'neo4j-driver', 'node:util/types']);
    // Export visibility: neither index carries a B5 name, and B4's three names
    // are still absent from the neo4j root.
    const neo4jIndex = readFileSync(resolve(REPO_ROOT, 'packages/neo4j/src/index.ts'), 'utf8');
    const coreIndex = readFileSync(resolve(REPO_ROOT, 'packages/core/src/index.ts'), 'utf8');
    for (const name of [
      'evidence-source-fact-state', 'createEvidenceSourceFactState',
      'EVIDENCE_SOURCE_FACT_STATE_VERSION', 'evidence-eligibility-composition',
      'createEvidenceEligibilityComposition', 'EVIDENCE_ELIGIBILITY_COMPOSITION_VERSION',
    ]) {
      expect(neo4jIndex).not.toContain(name);
      expect(coreIndex).not.toContain(name);
    }
    for (const name of [
      'evidence-authority-clearance', 'createEvidenceAuthorityClearance',
      'EVIDENCE_AUTHORITY_CLEARANCE_VERSION',
    ]) {
      expect(neo4jIndex).not.toContain(name);
    }
  });
});
