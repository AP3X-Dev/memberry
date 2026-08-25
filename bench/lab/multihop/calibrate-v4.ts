// RET-007 v4 — LOCAL, NON-AUTHORITATIVE difficulty calibration over the CALIB
// split only (spec "Calibration procedure (D2)").
//
// Runs the FUNNEL control adapter identity (memberry-retrieval-core-funnel-v1,
// fixture execution mode) over a calib split generated in-memory from the
// current (or CLI-supplied trial) knob values, scores
// strict-multi-hop-task-success-v4 per density stratum, and reports the
// headroom diagnostic H = share of calib scenarios in which memory B is NOT in
// the pass-1 funnel emission, plus — per scenario — the count of BM25-tied
// memories straddling the emission boundary and whether B's withholding is
// score-driven (B strictly below the N-th emitted score). Per-scenario outcomes
// are permitted on calib and NOWHERE else.
//
// This script NEVER reads or writes dev/holdout/twin bytes and produces no
// receipt; calib results are adjudication-forbidden by policy. Only DATASET
// knob values are tuned here — the funnel top-N is a constant by rule.
//
// Usage:
//   npx tsx bench/lab/multihop/calibrate-v4.ts            # frozen MULTIHOP_V4_KNOBS
//   npx tsx bench/lab/multihop/calibrate-v4.ts '<json>'   # trial knobs (bounds-checked)

import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

import type { AdapterRunReport } from '../contracts/report.js';
import type { LabScenario, LabScenarioInput, LabScenarioOracle } from '../contracts/scenario.js';
import { MemBerryRetrievalCoreFunnelAdapter, funnelSelect } from '../adapters/memberry-retrieval-core-funnel.js';
import { runAdapter } from '../runner.js';
import {
  MULTIHOP_V4_CALIB_ACCEPTANCE,
  MULTIHOP_V4_CONTROL_ADAPTER_ID,
  MULTIHOP_V4_CONTROL_EXECUTION_MODE,
  MULTIHOP_V4_DENSITIES,
  MULTIHOP_V4_DENSITY_COUNTS,
  MULTIHOP_V4_FUNNEL_TOP_N,
  MULTIHOP_V4_K,
  MULTIHOP_V4_KNOBS,
  validateMultiHopV4Knobs,
  type MultiHopV4Density,
  type MultiHopV4Knobs,
} from './policy-v4.js';
import { generateMultiHopV4Split } from './generate-v4.js';

export interface MultiHopV4CalibScenarioDiagnostic {
  readonly scenarioId: string;
  readonly density: MultiHopV4Density;
  readonly success: boolean;
  readonly bEmitted: boolean;
  /** Memories whose BM25 score equals the N-th ranked score (>= 1). */
  readonly tiedAtBoundary: number;
  /** Among those ties, how many fell OUTSIDE the emission (a straddle). */
  readonly tiesStraddlingBoundary: number;
  /** When B is withheld: B's score is strictly below the boundary (score-driven) vs equal (tie-driven). */
  readonly bWithholdingScoreDriven: boolean | null;
}

export interface MultiHopV4CalibDiagnostics {
  readonly n: number;
  readonly successes: number;
  readonly successRate: number;
  readonly strata: Readonly<Record<MultiHopV4Density, { n: number; successes: number; failures: number }>>;
  readonly headroom: number;
  readonly bWithheld: number;
  readonly scoreDrivenWithheld: number;
  readonly scoreDrivenShare: number | null;
  readonly tieSummary: Readonly<{ scenariosWithStraddle: number; maxTiedAtBoundary: number; meanTiedAtBoundary: number }>;
  readonly accepted: boolean;
  readonly failures: readonly string[];
  readonly scenarios: readonly MultiHopV4CalibScenarioDiagnostic[];
}

function parseJsonLines(text: string): unknown[] {
  return text.split('\n').filter((line) => line.trim()).map((line) => JSON.parse(line) as unknown);
}

function densityOf(input: LabScenarioInput): MultiHopV4Density {
  const tags = input.tags?.filter((tag) => tag.startsWith('density:')) ?? [];
  const density = tags.length === 1 ? tags[0]!.slice('density:'.length) : '';
  if (!MULTIHOP_V4_DENSITIES.includes(density as MultiHopV4Density)) throw new Error(`${input.id}: invalid density`);
  return density as MultiHopV4Density;
}

/** Pure calib diagnostics from scenarios + the control's run report (no I/O). */
export function computeMultiHopV4CalibDiagnostics(
  scenarios: readonly LabScenario[],
  report: AdapterRunReport,
  topN: number = MULTIHOP_V4_FUNNEL_TOP_N,
): MultiHopV4CalibDiagnostics {
  if (report.outcome !== 'scored' || report.scenarioReports.length !== scenarios.length) {
    throw new Error(`calibration control run did not score: ${report.outcome}`);
  }
  const strata = {
    low: { n: 0, successes: 0, failures: 0 },
    medium: { n: 0, successes: 0, failures: 0 },
    high: { n: 0, successes: 0, failures: 0 },
  } satisfies Record<MultiHopV4Density, { n: number; successes: number; failures: number }>;
  const diagnostics: MultiHopV4CalibScenarioDiagnostic[] = [];
  let successes = 0;
  let withheld = 0;
  let scoreDriven = 0;
  let straddles = 0;
  let maxTied = 0;
  let tiedSum = 0;
  for (const [index, scenario] of scenarios.entries()) {
    const scenarioReport = report.scenarioReports[index]!;
    if (scenarioReport.scenarioId !== scenario.input.id || scenarioReport.probes.length !== 1) {
      throw new Error(`${scenario.input.id}: control report mismatch`);
    }
    const required = scenario.oracle.probes[0]!.required!;
    const bId = required[1]!;
    const top = new Set(scenarioReport.probes[0]!.resultIds.slice(0, MULTIHOP_V4_K));
    const success = required.every((id) => top.has(id));
    const density = densityOf(scenario.input);
    strata[density].n += 1;
    strata[density][success ? 'successes' : 'failures'] += 1;
    if (success) successes += 1;
    const selection = funnelSelect(
      scenario.input.memories.filter((memory) => memory.kind !== 'code'),
      scenario.input.queries[0]!.query,
      topN,
    );
    const bEmitted = selection.selectedIds.includes(bId);
    const boundary = selection.boundaryScore;
    const bScore = selection.scores.get(bId);
    if (bScore === undefined) throw new Error(`${scenario.input.id}: B absent from the funnel scores`);
    const emitted = new Set(selection.selectedIds);
    const tiesOutside = boundary === null ? 0 : [...selection.scores.entries()]
      .filter(([id, score]) => score === boundary && !emitted.has(id)).length;
    let bWithholdingScoreDriven: boolean | null = null;
    if (!bEmitted) {
      withheld += 1;
      bWithholdingScoreDriven = boundary !== null && bScore < boundary;
      if (bWithholdingScoreDriven) scoreDriven += 1;
    }
    if (tiesOutside > 0) straddles += 1;
    maxTied = Math.max(maxTied, selection.tiedAtBoundary);
    tiedSum += selection.tiedAtBoundary;
    diagnostics.push({
      scenarioId: scenario.input.id,
      density,
      success,
      bEmitted,
      tiedAtBoundary: selection.tiedAtBoundary,
      tiesStraddlingBoundary: tiesOutside,
      bWithholdingScoreDriven,
    });
  }
  const n = scenarios.length;
  const successRate = successes / n;
  const headroom = withheld / n;
  const scoreDrivenShare = withheld === 0 ? null : scoreDriven / withheld;
  const failures: string[] = [];
  const acceptance = MULTIHOP_V4_CALIB_ACCEPTANCE;
  if (successRate < acceptance.minimumSuccessRateInclusive || successRate > acceptance.maximumSuccessRateInclusive) {
    failures.push('success-rate-outside-calib-acceptance');
  }
  for (const density of MULTIHOP_V4_DENSITIES) {
    if (strata[density].successes < acceptance.minimumSuccessesPerStratumInclusive
      || strata[density].failures < acceptance.minimumFailuresPerStratumInclusive) {
      failures.push(`${density}:stratum-not-mixed`);
    }
  }
  if (headroom < acceptance.minimumHeadroomInclusive) failures.push('headroom-below-floor');
  if (scoreDrivenShare === null || scoreDrivenShare < acceptance.minimumScoreDrivenShareInclusive) {
    failures.push('headroom-not-score-driven');
  }
  return {
    n,
    successes,
    successRate,
    strata,
    headroom,
    bWithheld: withheld,
    scoreDrivenWithheld: scoreDriven,
    scoreDrivenShare,
    tieSummary: { scenariosWithStraddle: straddles, maxTiedAtBoundary: maxTied, meanTiedAtBoundary: n === 0 ? 0 : tiedSum / n },
    accepted: failures.length === 0,
    failures,
    scenarios: diagnostics,
  };
}

export function calibScenariosFromKnobs(knobs: MultiHopV4Knobs): LabScenario[] {
  const generated = generateMultiHopV4Split('calib', knobs);
  const inputs = parseJsonLines(generated.input) as LabScenarioInput[];
  const oracles = parseJsonLines(generated.oracle) as LabScenarioOracle[];
  return inputs.map((input, index) => {
    const oracle = oracles[index];
    if (!oracle || oracle.scenarioId !== input.id) throw new Error(`${input.id}: oracle order mismatch`);
    return { input, oracle };
  });
}

async function main(): Promise<void> {
  const trial = process.argv.slice(2).find((argument) => !argument.startsWith('--'));
  const knobs: MultiHopV4Knobs = trial ? JSON.parse(trial) as MultiHopV4Knobs : MULTIHOP_V4_KNOBS;
  validateMultiHopV4Knobs(knobs);
  const scenarios = calibScenariosFromKnobs(knobs);
  const adapter = new MemBerryRetrievalCoreFunnelAdapter();
  if (adapter.id !== MULTIHOP_V4_CONTROL_ADAPTER_ID || adapter.executionMode !== MULTIHOP_V4_CONTROL_EXECUTION_MODE
    || adapter.funnelTopN !== MULTIHOP_V4_FUNNEL_TOP_N) {
    throw new Error('calibration must run the funnel control adapter identity at the constant top-N');
  }
  const report = await runAdapter({
    runId: 'ret007v4-local-calibration',
    adapter,
    scenarios,
    splits: ['calib'] as never,
  });
  const diagnostics = computeMultiHopV4CalibDiagnostics(scenarios, report);
  for (const density of MULTIHOP_V4_DENSITIES) {
    if (diagnostics.strata[density].n !== MULTIHOP_V4_DENSITY_COUNTS.calib[density]) {
      throw new Error(`calib ${density} stratum count mismatch`);
    }
  }
  const { scenarios: perScenario, ...summary } = diagnostics;
  process.stdout.write(`${JSON.stringify({ metric: 'strict-multi-hop-task-success-v4', split: 'calib', knobs, ...summary }, null, 2)}\n`);
  if (process.argv.includes('--per-scenario')) {
    for (const row of perScenario) process.stdout.write(`${JSON.stringify(row)}\n`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => { console.error(error); process.exitCode = 1; });
}
