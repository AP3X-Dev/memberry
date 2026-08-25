// RET-007 v4 — exchangeability check (C5, D2 verifier item).
//
// Builds a deterministic markdown report from the FROZEN v4 bytes:
//   - knob-marginal histograms per split (domain, family, density, corpus
//     size, distractor-probe overlap band) computed from adapter-visible
//     inputs only;
//   - the calib-only control success (funnel control over the committed calib
//     bytes, permitted on calib and nowhere else) with its headroom H;
//   - a two-proportion z-test helper. Per custody, dev/holdout/twin control
//     success is NOT computed locally (that is the hosted one-shot's job), so
//     the control comparison in this report is CALIB-ONLY and the dev/holdout
//     marginals are structural. The calib-vs-dev two-proportion test is to be
//     run at D3 from the receipt's closed aggregate (successes / n) against the
//     calib figures published here.
//
// Usage: npx tsx bench/lab/multihop/exchangeability-v4.ts  (rewrites EXCHANGEABILITY-V4.md)

import { writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import type { LabScenarioInput } from '../contracts/scenario.js';
import { MemBerryRetrievalCoreFunnelAdapter } from '../adapters/memberry-retrieval-core-funnel.js';
import {
  loadMultiHopV4CalibScenariosForCalibration,
  loadMultiHopV4ScenarioInputs,
} from '../datasets/load-multihop-v4.js';
import { runAdapter } from '../runner.js';
import { computeMultiHopV4CalibDiagnostics, type MultiHopV4CalibDiagnostics } from './calibrate-v4.js';
import { multiHopV4Tokenize } from './generate-v4.js';
import {
  MULTIHOP_V4_DENSITIES,
  MULTIHOP_V4_DISTRACTOR_PROBE_OVERLAP_BAND,
  MULTIHOP_V4_FAMILIES,
  MULTIHOP_V4_FREEZE,
  MULTIHOP_V4_KNOBS,
  MULTIHOP_V4_SPLITS,
  type MultiHopV4Split,
} from './policy-v4.js';

const OVERLAP_BUCKETS = Object.freeze([0, 0.1, 0.2, 0.3, 0.4, 0.5] as const);

export interface TwoProportionTest {
  readonly p1: number;
  readonly p2: number;
  readonly pooled: number;
  readonly z: number;
  /** Two-sided p-value under the normal approximation. */
  readonly pValue: number;
}

function erfc(x: number): number {
  // Numerical Recipes erfc approximation (fractional error < 1.2e-7).
  const z = Math.abs(x);
  const t = 1 / (1 + 0.5 * z);
  const r = t * Math.exp(-z * z - 1.26551223 + t * (1.00002368 + t * (0.37409196 + t * (0.09678418
    + t * (-0.18628806 + t * (0.27886807 + t * (-1.13520398 + t * (1.48851587
    + t * (-0.82215223 + t * 0.17087277)))))))));
  return x >= 0 ? r : 2 - r;
}

/** Two-proportion z-test (pooled), two-sided. */
export function twoProportionTest(successes1: number, n1: number, successes2: number, n2: number): TwoProportionTest {
  if (n1 <= 0 || n2 <= 0) throw new Error('two-proportion test requires positive sample sizes');
  const p1 = successes1 / n1;
  const p2 = successes2 / n2;
  const pooled = (successes1 + successes2) / (n1 + n2);
  const standardError = Math.sqrt(pooled * (1 - pooled) * (1 / n1 + 1 / n2));
  const z = standardError === 0 ? 0 : (p1 - p2) / standardError;
  const pValue = Math.min(1, erfc(Math.abs(z) / Math.SQRT2));
  return { p1, p2, pooled, z, pValue };
}

function jaccard(left: readonly string[], right: readonly string[]): number {
  const a = new Set(left);
  const b = new Set(right);
  let intersection = 0;
  for (const token of a) if (b.has(token)) intersection += 1;
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

function tagValue(input: LabScenarioInput, prefix: string): string {
  return input.tags!.find((tag) => tag.startsWith(prefix))!.slice(prefix.length);
}

function histogram(values: readonly string[], order?: readonly string[]): Array<[string, number]> {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  const keys = order ? [...order] : [...counts.keys()].sort();
  return keys.map((key) => [key, counts.get(key) ?? 0]);
}

function overlapBucket(value: number): string {
  for (let index = OVERLAP_BUCKETS.length - 1; index >= 0; index -= 1) {
    if (value >= OVERLAP_BUCKETS[index]!) {
      const upper = OVERLAP_BUCKETS[index + 1];
      return upper === undefined ? `[${OVERLAP_BUCKETS[index]!.toFixed(1)}, 1.0]` : `[${OVERLAP_BUCKETS[index]!.toFixed(1)}, ${upper.toFixed(1)})`;
    }
  }
  return '[0.0, 0.1)';
}

function table(rows: ReadonlyArray<[string, number]>, header: string): string {
  const lines = [`| ${header} | count |`, '|---|---|'];
  for (const [key, count] of rows) lines.push(`| ${key} | ${count} |`);
  return lines.join('\n');
}

export interface SplitMarginals {
  readonly split: MultiHopV4Split;
  readonly n: number;
  readonly domain: ReadonlyArray<[string, number]>;
  readonly family: ReadonlyArray<[string, number]>;
  readonly density: ReadonlyArray<[string, number]>;
  readonly corpusSize: ReadonlyArray<[string, number]>;
  readonly maxDistractorOverlap: ReadonlyArray<[string, number]>;
  readonly meanDistractorOverlap: number;
}

/** Marginals from adapter-visible inputs only: no oracle is opened, so "distractor" means every memory that is not the top-scored... */
export function computeSplitMarginals(inputs: readonly LabScenarioInput[], split: MultiHopV4Split): SplitMarginals {
  const selected = inputs.filter((input) => (input.split as string) === split);
  const overlapMax: number[] = [];
  let overlapSum = 0;
  let overlapCount = 0;
  for (const input of selected) {
    const probe = multiHopV4Tokenize(input.queries[0]!.query);
    const overlaps = input.memories.map((memory) => jaccard(multiHopV4Tokenize(memory.content), probe));
    // The two required hops are unknown here (no oracle); the two highest
    // overlaps are excluded as a conservative proxy so the band reflects distractors.
    const sorted = [...overlaps].sort((left, right) => right - left).slice(2);
    overlapMax.push(sorted[0] ?? 0);
    for (const value of sorted) { overlapSum += value; overlapCount += 1; }
  }
  const bucketOrder = OVERLAP_BUCKETS.map((_, index) => overlapBucket(OVERLAP_BUCKETS[index]!));
  return {
    split,
    n: selected.length,
    domain: histogram(selected.map((input) => tagValue(input, 'domain:'))),
    family: histogram(selected.map((input) => tagValue(input, 'family:')), MULTIHOP_V4_FAMILIES),
    density: histogram(selected.map((input) => tagValue(input, 'density:')), MULTIHOP_V4_DENSITIES),
    corpusSize: histogram(selected.map((input) => String(input.memories.length))),
    maxDistractorOverlap: histogram(overlapMax.map(overlapBucket), bucketOrder),
    meanDistractorOverlap: overlapCount === 0 ? 0 : overlapSum / overlapCount,
  };
}

/** Pure report body from marginals + calib diagnostics (no I/O, no clock). */
export function buildMultiHopV4ExchangeabilityReport(
  marginals: readonly SplitMarginals[],
  calib: MultiHopV4CalibDiagnostics,
): string {
  const lines: string[] = [];
  lines.push('# RET-007 v4 — exchangeability report (C5)');
  lines.push('');
  lines.push(`Instrument ${MULTIHOP_V4_FREEZE.instrument} ${MULTIHOP_V4_FREEZE.version}; frozen knobs ${JSON.stringify(MULTIHOP_V4_KNOBS)}.`);
  lines.push('Generated deterministically by `bench/lab/multihop/exchangeability-v4.ts` from the frozen bytes.');
  lines.push('');
  lines.push('## Custody statement (read first)');
  lines.push('');
  lines.push('- Per custody, control success on dev, holdout and twin is NOT computed locally: it is the hosted');
  lines.push('  one-shot\'s job (D3). The control comparison below is therefore CALIB-ONLY; the dev/holdout/twin');
  lines.push('  marginals are STRUCTURAL (adapter-visible inputs only; no oracle opened; no scenario outcome).');
  lines.push('- The calib-vs-dev two-proportion test (`twoProportionTest`) is to be run at D3 from the receipt\'s');
  lines.push('  closed aggregate (dev successes / 60) against the calib figure published here.');
  lines.push(`- Distractor-probe overlap = Jaccard over the funnel tokenizer; pre-registered band [${MULTIHOP_V4_DISTRACTOR_PROBE_OVERLAP_BAND.min}, ${MULTIHOP_V4_DISTRACTOR_PROBE_OVERLAP_BAND.max}]`);
  lines.push('  (asserted per scenario by the generator, C2 iv). The structural overlap proxy below excludes the two');
  lines.push('  highest-overlap memories per scenario because the oracle is not opened for this report.');
  lines.push('');
  lines.push('## Knob-marginal histograms per split (structural)');
  for (const m of marginals) {
    lines.push('');
    lines.push(`### ${m.split} (n = ${m.n})`);
    lines.push('');
    lines.push(table(m.density, 'density'));
    lines.push('');
    lines.push(table(m.family, 'family'));
    lines.push('');
    lines.push(table(m.corpusSize, 'corpus size'));
    lines.push('');
    lines.push(table(m.maxDistractorOverlap, 'max distractor-probe overlap (proxy)'));
    lines.push('');
    lines.push(`Mean distractor-probe overlap (proxy): ${m.meanDistractorOverlap.toFixed(4)}`);
    lines.push('');
    lines.push(table(m.domain, 'domain'));
  }
  lines.push('');
  lines.push('## Calib-only control success (funnel control, committed calib bytes)');
  lines.push('');
  lines.push(`- n = ${calib.n}; successes = ${calib.successes}; rate = ${calib.successRate.toFixed(4)}`);
  for (const density of MULTIHOP_V4_DENSITIES) {
    const s = calib.strata[density];
    lines.push(`- ${density}: ${s.successes}/${s.failures} (n = ${s.n})`);
  }
  lines.push(`- headroom H = ${calib.bWithheld}/${calib.n} = ${calib.headroom.toFixed(4)}; score-driven share = ${calib.scoreDrivenShare === null ? 'n/a' : calib.scoreDrivenShare.toFixed(4)}`);
  lines.push(`- tie summary: scenarios with a boundary straddle = ${calib.tieSummary.scenariosWithStraddle}; max tied at boundary = ${calib.tieSummary.maxTiedAtBoundary}; mean tied at boundary = ${calib.tieSummary.meanTiedAtBoundary.toFixed(4)}`);
  lines.push('');
  lines.push('## Two-proportion test (calib vs dev) — DEFERRED to D3');
  lines.push('');
  lines.push(`At D3, compute \`twoProportionTest(${calib.successes}, ${calib.n}, devSuccesses, 60)\` from the hosted receipt's`);
  lines.push('closed dev aggregate. Pre-registered reading: |z| < 1.96 is consistent with exchangeability of calib');
  lines.push('and dev under the shared-pool draw; |z| >= 1.96 is flagged in the D3 record (it does not change the');
  lines.push('D3 verdict, which is the pre-registered band on dev and holdout).');
  lines.push('');
  return `${lines.join('\n')}\n`;
}

const HERE = dirname(fileURLToPath(import.meta.url));
const REPORT_PATH = resolve(HERE, 'EXCHANGEABILITY-V4.md');

export async function computeMultiHopV4ExchangeabilityReport(repoRoot?: string): Promise<string> {
  const inputs = await loadMultiHopV4ScenarioInputs(repoRoot);
  const marginals = MULTIHOP_V4_SPLITS.map((split) => computeSplitMarginals(inputs, split));
  const calibScenarios = await loadMultiHopV4CalibScenariosForCalibration(repoRoot);
  const report = await runAdapter({
    runId: 'ret007v4-exchangeability-calib',
    adapter: new MemBerryRetrievalCoreFunnelAdapter(),
    scenarios: calibScenarios,
    splits: ['calib'] as never,
  });
  const calib = computeMultiHopV4CalibDiagnostics(calibScenarios, report);
  return buildMultiHopV4ExchangeabilityReport(marginals, calib);
}

async function main(): Promise<void> {
  const report = await computeMultiHopV4ExchangeabilityReport();
  await writeFile(REPORT_PATH, report, 'utf8');
  process.stdout.write(`${REPORT_PATH}: ${report.length} bytes\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => { console.error(error); process.exitCode = 1; });
}
