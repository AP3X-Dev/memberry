// RET-007 v4 D5 — candidate lab adapters: registration/audit, determinism, and the mechanism at the seam.

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import type { LabMemory, LabNamespace } from '../contracts/adapter.js';
import { MemBerryRetrievalCoreFunnelAdapter } from '../adapters/memberry-retrieval-core-funnel.js';
import {
  MemBerryRetrievalCoreFunnelMultihopEvidenceBridgeAdapter,
  MemBerryRetrievalCoreFunnelMultihopFactLexicalAdapter,
} from '../adapters/memberry-retrieval-core-funnel-multihop.js';
import { MULTIHOP_V4_BRIDGE_DERIVATION } from '../multihop/policy-v4.js';
import { auditAdapterDependencies, compareRegisteredAdapters } from '../registered-adapters.js';
import { TEMPORAL_ISOLATION_SCENARIOS } from '../fixtures/temporal-isolation.js';

const REPO_ROOT = resolve(import.meta.dirname, '..', '..', '..');
const ADAPTER_ENTRY = 'bench/lab/adapters/memberry-retrieval-core-funnel-multihop.ts';
const NAMESPACE: LabNamespace = { runId: 'ret007v4-multihop', tenant: 'lab-tenant', project: 'lab-project' };
const PLAIN = 'For hive frame Alder, name its apiary shed and the endpoint beyond it.';
const IDS = {
  evidence: 'memberry-retrieval-core-funnel-multihop-evidence-bridge-v1',
  lexical: 'memberry-retrieval-core-funnel-multihop-fact-lexical-v1',
};

function memory(id: string, content: string): LabMemory {
  return { id, content, kind: 'fact', recordedAt: '2026-08-01T00:00:00.000Z' };
}

/**
 * Two-hop corpus, 22 rows, built to the SHAPE bench/lab/multihop/generate-v4.ts emits: the two
 * chain hops first (A subject -> bridge, B bridge -> answer), then answer-type and generic
 * distractors, then the subject+bridge domain-vocabulary distractors that crowd B out of the
 * plain probe's top-12.
 *
 * Decision 2c(a) re-record. The previous nine `mem-e*` rows read
 * `Courier endpoint Ledger{i} lists the endpoint beyond the loading dock.` — they carried the
 * QUERY's rarest tokens (`endpoint` twice, `beyond`; df 2 in a 22-row corpus) which the real
 * generator never gives a distractor: those words come from the query FORM, and EXTRA_TEMPLATES /
 * GENERIC_TEMPLATES only ever use domain nouns. The consequence was measured, not assumed: gold
 * hop-1 mem-a fell to BM25 rank 3 behind mem-e0/mem-e1, so `Basalt` became the 4th bridge
 * candidate and was cut by MAX_BRIDGES = 3 — the fixture, not the mechanism, was the failure. On
 * the real calib split bridge derivation reaches the missing hop 14/14.
 *
 * The replacement distractors stay topically plausible (same apiary / hive-frame /
 * extraction-room nouns, EXTRA_TEMPLATES and GENERIC_TEMPLATES wording, fresh names from the
 * generator's own name pool) and carry NONE of the query's rare vocabulary — only domain nouns
 * the gold hop-1 also carries. Corpus ORDER follows the generator too (chain, then the
 * lexically-distant distractors, then the domain-vocabulary ones), which is what gives the
 * bridge-conditioned pass 2 an emission distinct enough from pass 1 for the novelty guard: the
 * funnel breaks score ties by corpus order, so the probe's zero-score tail is the mem-c* block
 * rather than pass 1 over again.
 *
 * Measured on this corpus: gold hop-1 mem-a is BM25 rank 1, bridges are [Basalt, Hive, Zephyr]
 * (Basalt first by Decision 2b(4)'s passage-frequency tie-break, which needs the mem-e* rows to
 * give the sentence-initial `Hive` a frequency above the bridge name's), mem-b is the probe's
 * rank-0 hit by Decision 2c's conditioned-task ranking and enters the module output at index 9.
 */
function twoHopCorpus(): LabMemory[] {
  return [
    // Chain hop 1 (A: subject -> bridge) and hop 2 (B: bridge -> answer).
    memory('mem-a', 'Hive frame Alder is warehoused at apiary shed Basalt.'),
    memory('mem-b', 'Apiary shed Basalt leads to extraction room Cinder.'),
    // Answer-type and generic distractors (EXTRA_TEMPLATES / GENERIC_TEMPLATES wording): they
    // score below B on the plain probe, so they are the pass-2 novelty the guard needs.
    memory('mem-c0', 'Extraction room Dorian remains reserved during apiary training.'),
    memory('mem-c1', 'Seasonal notes describe extraction room Emberly as idle.'),
    memory('mem-c2', 'A bulletin praised extraction room Fjord after a tidiness check.'),
    memory('mem-c3', 'Visitors gathered near extraction room Garnet at dawn.'),
    memory('mem-c4', 'Visitor badge Hollis was returned to a front desk.'),
    memory('mem-c5', 'Courier slip Ingram awaits a countersignature.'),
    memory('mem-c6', 'Umbrella stand Juniper was moved beside a lobby door.'),
    memory('mem-c7', 'Notice board Kestrel lists next month holidays.'),
    // Bridge-type domain distractors: they outrank B on the plain probe, so B stays outside the
    // funnel's top-12 - the headroom the candidate has to recover.
    memory('mem-d0', 'Apiary shed Larkspur completed a routine apiary drill.'),
    memory('mem-d1', 'Apiary shed Meridian was repainted during a quiet apiary morning.'),
    memory('mem-d2', 'Apiary shed Nimbus stores spare parts in an apiary annex.'),
    memory('mem-d3', 'Apiary shed Ochre reopened after an apiary safety review.'),
    memory('mem-d4', 'Inventory lists apiary shed Peregrine beside apiary shed Quartz.'),
    memory('mem-d5', 'Apiary shed Rowan gained a new noticeboard this apiary season.'),
    memory('mem-d6', 'Apiary shed Saffron hosted a quarterly apiary drill review.'),
    memory('mem-d7', 'Apiary shed Tamarind was descaled by an apiary crew.'),
    // Subject + bridge domain distractors. They also give the sentence-initial subject-type word
    // a passage frequency above the bridge name's, so Decision 2b(4) ranks Basalt first.
    memory('mem-e0', 'Hive frame Umberto awaits collection at apiary shed Verbena.'),
    memory('mem-e1', 'Hive frame Wexford was moved beside apiary shed Yarrow.'),
    memory('mem-e2', 'Hive frame Zephyr passed a scheduled apiary shed inspection.'),
    memory('mem-e3', 'Hive frame Aurelia sits inside apiary shed Briony.'),
  ];
}

async function queryIds(adapter: MemBerryRetrievalCoreFunnelAdapter | MemBerryRetrievalCoreFunnelMultihopEvidenceBridgeAdapter, query: string) {
  await adapter.ingest({ namespace: NAMESPACE, memories: twoHopCorpus() });
  return (await adapter.query({ namespace: NAMESPACE, query, limit: 10 })).results;
}

describe('RET-007 v4 candidate lab adapters', () => {
  it('fix the policy by construction, pin the funnel constant, and never read a wall clock', async () => {
    expect(new MemBerryRetrievalCoreFunnelMultihopEvidenceBridgeAdapter().policy).toBe('evidence-bridge');
    expect(new MemBerryRetrievalCoreFunnelMultihopFactLexicalAdapter().policy).toBe('fact-lexical');
    expect(new MemBerryRetrievalCoreFunnelMultihopEvidenceBridgeAdapter().funnelTopN).toBe(12);
    expect([...MULTIHOP_V4_BRIDGE_DERIVATION]).toEqual(['evidence-bridge', 'fact-lexical']);
    const source = await readFile(resolve(REPO_ROOT, ADAPTER_ENTRY), 'utf8');
    expect(source).not.toMatch(/Math\.random\(|Date\.now\(|new Date\(|performance\.now\(/);
    expect(source).toContain('MULTIHOP_LAB_BUDGET_MS');
    expect(source).toContain('DUPLICATED PRIVATE SYMBOLS');
    // Non-relative specifiers are rejected by the required-CI audit.
    expect(source.match(/from '([^']+)'/g)!.every((line) => line.includes("from '."))).toBe(true);
  });

  it('registers both rows with no-argument construction, passes the dependency audit, and loads through the registered path', async () => {
    const source = await readFile(resolve(REPO_ROOT, 'bench/lab/registered-adapters.ts'), 'utf8');
    expect(source.match(/new MemBerryRetrievalCoreFunnelMultihop\w+Adapter\([^)]*\)/g)).toEqual([
      'new MemBerryRetrievalCoreFunnelMultihopEvidenceBridgeAdapter()',
      'new MemBerryRetrievalCoreFunnelMultihopFactLexicalAdapter()',
    ]);
    const audit = await auditAdapterDependencies(resolve(REPO_ROOT, ADAPTER_ENTRY), REPO_ROOT);
    expect(audit.violations).toEqual([]);
    for (const id of [IDS.evidence, IDS.lexical]) {
      const report = await compareRegisteredAdapters({
        runId: `ret007v4-multihop-registered-${id}`,
        controlId: 'memberry-retrieval-core-funnel-v1',
        candidateId: id,
        scenarios: TEMPORAL_ISOLATION_SCENARIOS,
        repoRoot: REPO_ROOT,
      });
      expect(report.candidate.adapterId).toBe(id);
      expect(report.candidate.executionMode).toBe('fixture');
    }
    // Neither id matches the v4 qualification candidate-absence marker.
    expect(/ret-?007-?v4|multi-?hop-v4|multihop-v4/i.test(`${IDS.evidence} ${IDS.lexical}`)).toBe(false);
  });

  it('surfaces memory B through the funnel seam on the two-hop probe while the control does not', async () => {
    const control = await queryIds(new MemBerryRetrievalCoreFunnelAdapter(), PLAIN);
    const candidate = new MemBerryRetrievalCoreFunnelMultihopEvidenceBridgeAdapter();
    const expanded = await queryIds(candidate, PLAIN);
    expect(control.map(({ id }) => id)).not.toContain('mem-b');
    expect(expanded.map(({ id }) => id)).toContain('mem-b');
    expect(expanded.map(({ id }) => id)).toContain('mem-a');
    expect(candidate.firings.get(`${NAMESPACE.project} ${PLAIN}`)).toBe(true);
  });

  it('is byte-identical to the control when the gate does not fire (comparison query)', async () => {
    const comparison = 'Is hive frame Alder warehoused at apiary shed Basalt?';
    const control = await queryIds(new MemBerryRetrievalCoreFunnelAdapter(), comparison);
    const candidate = new MemBerryRetrievalCoreFunnelMultihopEvidenceBridgeAdapter();
    const expanded = await queryIds(candidate, comparison);
    expect(control.length).toBeGreaterThan(1);
    expect(JSON.stringify(expanded)).toBe(JSON.stringify(control));
    expect(candidate.firings.get(`${NAMESPACE.project} ${comparison}`)).toBe(false);
  });

  it('lab determinism: an injected always-timeout clock leaves the output identical (budget is Infinity)', async () => {
    let now = 0;
    const timeout = new MemBerryRetrievalCoreFunnelMultihopEvidenceBridgeAdapter(() => { now += 1_000_000; return now; });
    const plain = new MemBerryRetrievalCoreFunnelMultihopEvidenceBridgeAdapter();
    const first = await queryIds(plain, PLAIN);
    const second = await queryIds(timeout, PLAIN);
    const third = await queryIds(plain, PLAIN);
    expect(first.map(({ id }) => id)).toContain('mem-b');
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    expect(JSON.stringify(third)).toBe(JSON.stringify(first));
  });
});
