// RET-007 v4 funnel control adapter acceptance (spec "Tests (RED first, D2)" #2).

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import type { LabMemory, LabNamespace } from '../contracts/adapter.js';
import { MemBerryRetrievalCoreAdapter } from '../adapters/memberry-retrieval-core.js';
import {
  FUNNEL_TOP_N,
  MemBerryRetrievalCoreFunnelAdapter,
  funnelSelect,
  funnelTokenize,
} from '../adapters/memberry-retrieval-core-funnel.js';
import { MULTIHOP_V4_FUNNEL_TOP_N } from '../multihop/policy-v4.js';
import { auditAdapterDependencies, compareRegisteredAdapters } from '../registered-adapters.js';
import { TEMPORAL_ISOLATION_SCENARIOS } from '../fixtures/temporal-isolation.js';

const REPO_ROOT = resolve(import.meta.dirname, '..', '..', '..');
const ADAPTER_ENTRY = 'bench/lab/adapters/memberry-retrieval-core-funnel.ts';
const NAMESPACE: LabNamespace = { runId: 'ret007v4-funnel', tenant: 'lab-tenant', project: 'lab-project' };

function memory(id: string, content: string, extra: Partial<LabMemory> = {}): LabMemory {
  return { id, content, kind: 'fact', recordedAt: '2026-08-01T00:00:00.000Z', ...extra };
}

/** Two-hop corpus: A (subject -> bridge), B (bridge -> answer), and 18 distractors in a fixed corpus order. */
function twoHopCorpus(): LabMemory[] {
  const rows: LabMemory[] = [];
  rows.push(memory('mem-a', 'Hive frame Alder is warehoused at apiary shed Basalt.'));
  for (let index = 0; index < 9; index += 1) {
    rows.push(memory(`mem-d${index}`, `Hive frame Filler${index} passed its scheduled apiary shed inspection for hive frame work.`));
  }
  rows.push(memory('mem-b', 'Basalt forwards outbound freight to extraction room Cinder.'));
  for (let index = 9; index < 18; index += 1) {
    rows.push(memory(`mem-d${index}`, `Visitor badge Generic${index} was returned to the front desk.`));
  }
  return rows;
}

describe('RET-007 v4 funnel control adapter', () => {
  it('pins the constant funnel top-N to the pre-registered policy value and the K+2 rule', () => {
    expect(FUNNEL_TOP_N).toBe(12);
    expect(FUNNEL_TOP_N).toBe(MULTIHOP_V4_FUNNEL_TOP_N);
    expect(new MemBerryRetrievalCoreFunnelAdapter().funnelTopN).toBe(12);
    expect(() => new MemBerryRetrievalCoreFunnelAdapter(0)).toThrow(/positive integer/);
  });

  it('is registered with a no-argument construction so the injection point is unreachable from the row', async () => {
    const source = await readFile(resolve(REPO_ROOT, 'bench/lab/registered-adapters.ts'), 'utf8');
    const rows = source.match(/new MemBerryRetrievalCoreFunnelAdapter\([^)]*\)/g) ?? [];
    expect(rows).toEqual(['new MemBerryRetrievalCoreFunnelAdapter()']);
    const audit = await auditAdapterDependencies(resolve(REPO_ROOT, ADAPTER_ENTRY), REPO_ROOT);
    expect(audit.violations).toEqual([]);
    const report = await compareRegisteredAdapters({
      runId: 'ret007v4-funnel-registered',
      controlId: 'scope-aware-bm25-control-v1',
      candidateId: 'memberry-retrieval-core-funnel-v1',
      scenarios: TEMPORAL_ISOLATION_SCENARIOS,
      repoRoot: REPO_ROOT,
    });
    expect(report.candidate.adapterId).toBe('memberry-retrieval-core-funnel-v1');
    expect(report.candidate.executionMode).toBe('fixture');
  });

  it('honors scope.task: two tasks select different subsets and a bridge-conditioned scope surfaces B', () => {
    const corpus = twoHopCorpus();
    const plain = funnelSelect(corpus, 'For hive frame Alder, name its apiary shed and the endpoint beyond it.', 12);
    const other = funnelSelect(corpus, 'Which visitor badge was returned to the front desk?', 12);
    expect(plain.selectedIds).toHaveLength(12);
    expect(other.selectedIds).toHaveLength(12);
    expect(plain.selectedIds).not.toEqual(other.selectedIds);
    expect(plain.selectedIds).toContain('mem-a');
    expect(plain.selectedIds).not.toContain('mem-b');
    // Bridge-conditioned text scope (uncovered(q) U {bridge}) reaches B.
    const conditioned = funnelSelect(corpus, 'extraction endpoint Basalt', 12);
    expect(conditioned.selectedIds).toContain('mem-b');
    // Bite: with scope use disabled (the conditioned probe replaced by the plain probe), B stays withheld.
    const scopeDisabled = funnelSelect(corpus, 'For hive frame Alder, name its apiary shed and the endpoint beyond it.', 12);
    expect(scopeDisabled.selectedIds).toEqual(plain.selectedIds);
    expect(scopeDisabled.selectedIds).not.toContain('mem-b');
  });

  it('emits exactly min(N, corpus) memories, in corpus order, deterministically', async () => {
    const corpus = twoHopCorpus();
    for (const size of [5, 12, 20]) {
      const selection = funnelSelect(corpus.slice(0, size), 'hive frame Alder apiary shed', 12);
      expect(selection.selectedIds).toHaveLength(Math.min(12, size));
      const corpusIndex = new Map(corpus.map(({ id }, index) => [id, index]));
      const positions = selection.selectedIds.map((id) => corpusIndex.get(id)!);
      expect([...positions].sort((left, right) => left - right)).toEqual(positions);
    }
    const adapter = new MemBerryRetrievalCoreFunnelAdapter();
    await adapter.ingest({ namespace: NAMESPACE, memories: corpus });
    const request = { namespace: NAMESPACE, query: 'For hive frame Alder, name its apiary shed and the endpoint beyond it.', limit: 20 };
    const first = (await adapter.query(request)).results;
    const second = (await adapter.query(request)).results;
    expect(first.length).toBeGreaterThan(1);
    expect(first.length).toBeLessThanOrEqual(12);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    expect(first.map(({ id }) => id)).not.toContain('mem-b');
  });

  it('unions resolvedEntityIds as seeds and never filters by them', () => {
    const corpus = twoHopCorpus();
    const seeded = funnelSelect(corpus, 'For hive frame Alder, name its apiary shed and the endpoint beyond it.', 12, ['mem-b']);
    expect(seeded.selectedIds).toHaveLength(13);
    expect(seeded.selectedIds).toContain('mem-b');
    expect(seeded.selectedIds).toContain('mem-a');
    const unknownSeed = funnelSelect(corpus, 'For hive frame Alder, name its apiary shed and the endpoint beyond it.', 12, ['not-in-corpus']);
    expect(unknownSeed.selectedIds).toHaveLength(12);
  });

  it('reports the emission boundary and tie count', () => {
    const corpus = twoHopCorpus();
    const selection = funnelSelect(corpus, 'For hive frame Alder, name its apiary shed and the endpoint beyond it.', 12);
    expect(selection.boundaryScore).not.toBeNull();
    expect(selection.tiedAtBoundary).toBeGreaterThanOrEqual(1);
    expect(selection.scores.size).toBe(corpus.length);
    expect(funnelSelect(corpus.slice(0, 12), 'anything', 12).boundaryScore).toBeNull();
    expect(funnelTokenize('A Hive-frame, ALDER! x1 #9')).toEqual(['hive', 'frame', 'alder', 'x1']);
  });

  it('DIFFERENTIAL PARITY: at injected N >= corpus the funnel reproduces memberry-retrieval-core-v1 byte for byte', async () => {
    // Exercises every duplicated helper path: code-row partition, confidenceSuffix
    // (in-range and out-of-range/non-finite), headingSafeId skip (`]`), and
    // neutralizeHeadings (`#`-leading line).
    const corpus: LabMemory[] = [
      memory('parity-1', 'Severity one incidents always page the on-call engineer immediately.', { confidence: 0.9 }),
      memory('parity-2', 'The incident commander keeps the role until they hand it over explicitly.', { confidence: 1.5 }),
      memory('parity-3', 'The incident dashboard was redesigned last quarter.\n# incident heading line\nMore incident notes.', { confidence: Number.NaN }),
      memory('parity-4]', 'This incident id carries a closing bracket and must be skipped by headingSafeId.'),
      memory('parity-code', 'function pageOnCallEngineer(incident: Incident): void', { kind: 'code' }),
      memory('parity-5', 'Quarterly travel policy reimburses economy fares only.', { kind: 'other' }),
      memory('parity-6', 'Incident retrospectives are filed within five working days.'),
    ];
    const core = new MemBerryRetrievalCoreAdapter();
    const funnel = new MemBerryRetrievalCoreFunnelAdapter(100);
    await core.ingest({ namespace: NAMESPACE, memories: corpus });
    await funnel.ingest({ namespace: NAMESPACE, memories: corpus });
    for (const query of ['who pages the on-call engineer for an incident', 'travel policy fares', 'page on call engineer function']) {
      const request = { namespace: NAMESPACE, query, limit: 10 };
      const expected = await core.query(request);
      const actual = await funnel.query(request);
      expect(expected.results.length).toBeGreaterThan(1);
      expect(JSON.stringify(actual)).toBe(JSON.stringify(expected));
    }
    // And the frozen instrument value (12) is what a no-argument construction yields.
    expect(new MemBerryRetrievalCoreFunnelAdapter().funnelTopN).toBe(12);
    expect(funnel.funnelTopN).toBe(100);
  });

  it('never consults ambient nondeterminism and lists the duplicated private symbols in its header', async () => {
    const source = await readFile(resolve(REPO_ROOT, ADAPTER_ENTRY), 'utf8');
    expect(source).not.toMatch(/Math\.random\(|Date\.now\(|new Date\(/);
    expect(source).toContain('DUPLICATED PRIVATE SYMBOLS');
    for (const symbol of [
      'MAX_MEMORY_SOURCES', 'MAX_MEMORY_MARKDOWN_BYTES', 'MAX_ID_BYTES', 'MAX_CODE_RESULTS',
      'MAX_CODE_SIGNATURE_CODE_UNITS', 'DEFAULT_MAX_TOKENS', 'FIXTURE_ASSEMBLED_AT', 'appendOwn',
      'FIXTURE_DRIVER', 'FIXTURE_FEEDBACK_STORE', 'FIXTURE_EMBEDDING', 'headingSafeId',
      'neutralizeHeadings', 'confidenceSuffix', 'memoryMarkdown', 'fixtureLayers',
    ]) expect(source).toContain(symbol);
  });
});
