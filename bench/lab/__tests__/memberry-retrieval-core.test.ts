// LAB-010 acceptance. A1-A5 of spec-2026-08-20-lab010.md, in order.
//
// The point of the packet is that a required-CI adapter can score PRODUCTION
// retrieval assembly. Two failure modes make that claim hollow and both are
// pinned here: a dead chain (the adapter reaches production only as a type, so
// nothing production does can move the number), and a vacuous corpus (the
// assembler's memory-provider validators reject a malformed fixture, the channel
// catch swallows the throw, and every assertion passes over an empty result set).
// Every behavioural check below therefore asserts a non-empty, multi-id response
// before it asserts anything about ordering.

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import ts from 'typescript';
import { afterEach, describe, expect, it } from 'vitest';

import type { LabMemory, LabNamespace, LabQueryResult } from '../contracts/adapter.js';
import { MemBerryProxyAdapter } from '../adapters/memberry-proxy.js';
import {
  MemBerryRetrievalCoreAdapter,
  MemBerryRetrievalCoreQueryDecompositionAdapter,
} from '../adapters/memberry-retrieval-core.js';
import { loadG2HoldoutScenarioInputs } from '../datasets/load-suite.js';
import { TEMPORAL_ISOLATION_SCENARIOS } from '../fixtures/temporal-isolation.js';
import { auditAdapterDependencies, compareRegisteredAdapters } from '../registered-adapters.js';

const REPO_ROOT = resolve(import.meta.dirname, '..', '..', '..');
const ADAPTER_ENTRY = 'bench/lab/adapters/memberry-retrieval-core.ts';
const ADAPTER_ID = 'memberry-retrieval-core-v1';

const temporaryRoots: string[] = [];
afterEach(async () => {
  for (const root of temporaryRoots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function temporaryRepo(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  temporaryRoots.push(root);
  await mkdir(join(root, 'adapters'), { recursive: true });
  return root;
}

/** Names imported from packages/ as VALUES and then invoked. A type import yields none. */
function productionInvocations(source: string): string[] {
  const file = ts.createSourceFile('adapter.ts', source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
  const valueImports = new Set<string>();
  for (const statement of file.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    if (!statement.moduleSpecifier.text.includes('/packages/')) continue;
    const clause = statement.importClause;
    if (!clause || clause.isTypeOnly || !clause.namedBindings || !ts.isNamedImports(clause.namedBindings)) continue;
    for (const element of clause.namedBindings.elements) {
      if (!element.isTypeOnly) valueImports.add(element.name.text);
    }
  }
  const invoked: string[] = [];
  const visit = (node: ts.Node): void => {
    if ((ts.isCallExpression(node) || ts.isNewExpression(node))
      && ts.isIdentifier(node.expression) && valueImports.has(node.expression.text)) {
      invoked.push(node.expression.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return invoked;
}

const CORPUS: readonly LabMemory[] = [
  {
    id: 'lab-010-mem-1',
    content: 'Severity one incidents always page the on-call engineer immediately.',
    kind: 'fact',
    recordedAt: '2026-02-01T00:00:00.000Z',
    confidence: 0.9,
  },
  {
    id: 'lab-010-mem-2',
    content: 'The incident commander keeps the role until they hand it over explicitly.',
    kind: 'fact',
    recordedAt: '2026-02-02T00:00:00.000Z',
  },
  {
    id: 'lab-010-mem-3',
    content: 'The incident dashboard was redesigned last quarter by the platform team.',
    kind: 'other',
    recordedAt: '2026-02-03T00:00:00.000Z',
  },
  {
    id: 'lab-010-mem-4',
    content: 'Quarterly travel policy reimburses economy fares only.',
    kind: 'other',
    recordedAt: '2026-02-04T00:00:00.000Z',
  },
];

const NAMESPACE: LabNamespace = { runId: 'lab-010', tenant: 'lab-tenant', project: 'lab-project' };

function assertNonVacuous(results: readonly LabQueryResult[]): void {
  expect(results.length).toBeGreaterThan(0);
  expect(new Set(results.map((result) => result.id)).size).toBeGreaterThan(1);
}

describe('LAB-010 production retrieval adapter', () => {
  it('RET-007 registers a distinct candidate over identical fixture persistence', async () => {
    const control = new MemBerryRetrievalCoreAdapter();
    const candidate = new MemBerryRetrievalCoreQueryDecompositionAdapter();
    const memories: readonly LabMemory[] = [
      { id: 'neutral-a', content: 'Alpha marker appears with linktoken.', recordedAt: '2026-01-01T00:00:00.000Z' },
      { id: 'neutral-b', content: 'Omega target appears with linktoken.', recordedAt: '2026-01-01T00:00:00.000Z' },
      { id: 'neutral-c', content: 'Neutral text uses another token.', recordedAt: '2026-01-01T00:00:00.000Z' },
    ];
    for (const adapter of [control, candidate]) {
      expect((await adapter.ingest({ namespace: NAMESPACE, memories })).accepted).toBe(memories.length);
    }
    const request = {
      namespace: NAMESPACE,
      query: 'Locate alpha marker and identify omega target',
      limit: 3,
    };
    const controlResult = await control.query(request);
    const candidateResult = await candidate.query(request);
    expect(control.id).toBe('memberry-retrieval-core-v1');
    expect(candidate.id).toBe('memberry-retrieval-core-query-decomposition-v1');
    expect(candidateResult.results.map(({ id }) => id).sort())
      .toEqual(controlResult.results.map(({ id }) => id).sort());
    expect(candidateResult.results.map(({ score }) => score))
      .not.toEqual(controlResult.results.map(({ score }) => score));
  });

  it('A1 loads through the registered required-CI path', async () => {
    const report = await compareRegisteredAdapters({
      runId: 'lab-010-registered',
      controlId: 'scope-aware-bm25-control-v1',
      candidateId: ADAPTER_ID,
      scenarios: TEMPORAL_ISOLATION_SCENARIOS,
      repoRoot: REPO_ROOT,
    });
    expect(report.candidate.adapterId).toBe(ADAPTER_ID);
    expect(report.evidenceMode).toBe('registered-ci');
  });

  it('A2 audits clean, reaches packages/retrieval, and calls production rather than importing its types', async () => {
    const audit = await auditAdapterDependencies(resolve(REPO_ROOT, ADAPTER_ENTRY), REPO_ROOT);
    expect(audit.violations).toEqual([]);
    const visited = audit.visited.map((path) => path.replace(/\\/g, '/'));
    expect(visited.some((path) => path.includes('/packages/retrieval/'))).toBe(true);
    const source = await readFile(resolve(REPO_ROOT, ADAPTER_ENTRY), 'utf8');
    expect(productionInvocations(source)).toContain('UnifiedAssembler');
  });

  it('A3 still rejects a non-relative specifier reached outside packages/', async () => {
    const root = await temporaryRepo('memberry-lab010-outside-');
    await mkdir(join(root, 'lib'), { recursive: true });
    await writeFile(join(root, 'lib', 'helper.ts'), 'import "neo4j-driver";\nexport const helper = 1;\n', 'utf8');
    await writeFile(
      join(root, 'adapters', 'candidate.ts'),
      'import { helper } from "../lib/helper.js";\nexport default helper;\n',
      'utf8',
    );
    const audit = await auditAdapterDependencies(join(root, 'adapters', 'candidate.ts'), root);
    expect(audit.violations).toEqual([
      expect.stringContaining('non-relative module neo4j-driver is forbidden'),
    ]);
  });

  it('A3 still rejects a scorer-only path even under packages/', async () => {
    const root = await temporaryRepo('memberry-lab010-forbidden-');
    await mkdir(join(root, 'packages', 'retrieval', 'src', '__tests__'), { recursive: true });
    await writeFile(join(root, 'packages', 'retrieval', 'src', '__tests__', 'leak.ts'), 'export const leak = 1;\n', 'utf8');
    await writeFile(
      join(root, 'adapters', 'candidate.ts'),
      'import { leak } from "../packages/retrieval/src/__tests__/leak.js";\nexport default leak;\n',
      'utf8',
    );
    const audit = await auditAdapterDependencies(join(root, 'adapters', 'candidate.ts'), root);
    expect(audit.violations).toEqual([
      expect.stringContaining('scorer-only path is forbidden'),
    ]);
  });

  it('A3 carves out production source and nothing wider', async () => {
    const root = await temporaryRepo('memberry-lab010-carveout-');
    await mkdir(join(root, 'packages', 'retrieval', 'src'), { recursive: true });
    await writeFile(
      join(root, 'packages', 'retrieval', 'src', 'production.ts'),
      'import "neo4j-driver";\nexport const production = 1;\n',
      'utf8',
    );
    await writeFile(
      join(root, 'adapters', 'candidate.ts'),
      'import { production } from "../packages/retrieval/src/production.js";\nexport default production;\n',
      'utf8',
    );
    const audit = await auditAdapterDependencies(join(root, 'adapters', 'candidate.ts'), root);
    expect(audit.violations).toEqual([]);
    expect(audit.visited.some((path) => path.replace(/\\/g, '/').endsWith('packages/retrieval/src/production.ts'))).toBe(true);
  });

  it('A4 orders g2-holdout dev probes differently from the proxy candidate', async () => {
    const inputs = (await loadG2HoldoutScenarioInputs(REPO_ROOT)).filter((input) => input.split === 'dev');
    expect(inputs.length).toBeGreaterThan(0);

    const production = new MemBerryRetrievalCoreAdapter();
    const proxy = new MemBerryProxyAdapter();
    let divergences = 0;
    for (const input of inputs) {
      const namespace: LabNamespace = { runId: 'lab-010-a4', tenant: input.tenant, project: input.project };
      for (const adapter of [production, proxy]) {
        const ingest = await adapter.ingest({ namespace, memories: input.memories });
        expect(ingest.accepted).toBe(input.memories.length);
      }
      for (const probe of input.queries) {
        const request = {
          namespace,
          query: probe.query,
          limit: probe.limit,
          asOf: probe.asOf,
          tokenBudget: probe.tokenBudget,
        };
        const productionResults = (await production.query(request)).results;
        const proxyResults = (await proxy.query(request)).results;
        // Only the production side is guarded: rankProxyCandidates drops zero-score
        // candidates by design, so an empty proxy list is legitimate behaviour, not
        // the silent-empty failure this guard exists to catch.
        assertNonVacuous(productionResults);
        if (productionResults.map((result) => result.id).join(' ')
          !== proxyResults.map((result) => result.id).join(' ')) divergences += 1;
      }
    }
    expect(divergences).toBeGreaterThan(0);
  });

  it('A5 returns byte-identical ids and scores across two identical calls', async () => {
    const adapter = new MemBerryRetrievalCoreAdapter();
    await adapter.ingest({ namespace: NAMESPACE, memories: CORPUS });
    const request = { namespace: NAMESPACE, query: 'who pages the on-call engineer for an incident', limit: 10 };
    const first = (await adapter.query(request)).results;
    const second = (await adapter.query(request)).results;
    assertNonVacuous(first);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });

  it('LAB-011 keeps code retrieval enabled for a named namespace through default-tenant assembly', async () => {
    const source = await readFile(resolve(REPO_ROOT, ADAPTER_ENTRY), 'utf8');
    expect(source).not.toContain('forces the code channel OFF');
    expect(source).not.toContain('every lab scenario names one');
    expect(source).toMatch(/default tenant/);
    expect(source).toMatch(/namespaceKey \+ inRequestedScope/);

    const namespace: LabNamespace = {
      runId: 'lab-011-default-tenant',
      tenant: 'named-tenant',
      project: 'named-project',
    };
    const adapter = new MemBerryRetrievalCoreAdapter();
    const codeId = 'lab-011-code-only';
    const ingest = await adapter.ingest({
      namespace,
      memories: [{
        id: codeId,
        content: 'function selectProductionRetrievalCandidate(): string',
        kind: 'code',
        tenant: namespace.tenant,
        project: namespace.project,
        recordedAt: '2026-08-20T00:00:00.000Z',
      }],
    });
    expect(ingest.accepted).toBe(1);
    const results = (await adapter.query({
      namespace,
      query: 'select production retrieval candidate',
      limit: 5,
    })).results;
    expect(results.map(({ id }) => id)).toContain(codeId);
  });

  it('LAB-011 has no exact production-score tie across any visible holdout k boundary', async () => {
    const inputs = (await loadG2HoldoutScenarioInputs(REPO_ROOT))
      .filter((input) => input.split === 'holdout');
    expect(inputs.length).toBeGreaterThan(0);
    let comparedBoundaries = 0;

    for (const input of inputs) {
      const namespace: LabNamespace = {
        runId: `lab-011-boundary-${input.id}`,
        tenant: input.tenant,
        project: input.project,
      };
      const adapter = new MemBerryRetrievalCoreAdapter();
      const ingest = await adapter.ingest({ namespace, memories: input.memories });
      expect(ingest.accepted).toBe(input.memories.length);

      for (const probe of input.queries) {
        const results = (await adapter.query({
          namespace,
          query: probe.query,
          limit: probe.limit + 1,
          asOf: probe.asOf,
          tokenBudget: probe.tokenBudget,
        })).results;
        const inside = results[probe.limit - 1];
        const outside = results[probe.limit];
        if (!inside || !outside) continue;
        comparedBoundaries += 1;
        expect(
          inside.score,
          `${input.id}/${probe.id} has an exact score tie across k=${probe.limit}`,
        ).not.toBe(outside.score);
      }
    }

    expect(comparedBoundaries).toBeGreaterThan(0);
  });
});
