// RET-007 v3 — LOCAL, NON-AUTHORITATIVE difficulty calibration over the CALIB
// split only (spec "Calibration procedure (D2, local, non-authoritative)").
//
// Runs the v2-identical control adapter identity (memberry-retrieval-core-v1,
// fixture execution mode) over a calib split generated in-memory from the
// current (or CLI-supplied trial) knob values, scores
// strict-multi-hop-task-success-v3 per density stratum, and prints closed
// aggregate rates. Iterations and their knob values are recorded in
// bench/lab/multihop/CALIBRATION-V3.md.
//
// This script NEVER reads or writes dev/holdout bytes and produces no receipt;
// calib results are adjudication-forbidden by policy.
//
// Usage:
//   npx tsx bench/lab/multihop/calibrate-v3.ts            # frozen MULTIHOP_V3_KNOBS
//   npx tsx bench/lab/multihop/calibrate-v3.ts '<json>'   # trial knobs (bounds-checked)

import type { LabScenario, LabScenarioInput, LabScenarioOracle } from '../contracts/scenario.js';
import { MemBerryRetrievalCoreAdapter } from '../adapters/memberry-retrieval-core.js';
import { runAdapter } from '../runner.js';
import {
  MULTIHOP_V3_CALIB_DENSITY_COUNTS,
  MULTIHOP_V3_CONTROL_ADAPTER_ID,
  MULTIHOP_V3_CONTROL_EXECUTION_MODE,
  MULTIHOP_V3_CONTROL_HEADROOM,
  MULTIHOP_V3_K,
  MULTIHOP_V3_KNOBS,
  validateMultiHopV3Knobs,
  type MultiHopV3Density,
  type MultiHopV3Knobs,
} from './policy-v3.js';
import { generateMultiHopV3Split } from './generate-v3.js';

const DENSITIES = Object.freeze(['low', 'medium', 'high'] as const satisfies readonly MultiHopV3Density[]);

function parseJsonLines(text: string): unknown[] {
  return text.split('\n').filter((line) => line.trim()).map((line) => JSON.parse(line) as unknown);
}

function densityOf(input: LabScenarioInput): MultiHopV3Density {
  const tags = input.tags?.filter((tag) => tag.startsWith('density:')) ?? [];
  const density = tags.length === 1 ? tags[0]!.slice('density:'.length) : '';
  if (!DENSITIES.includes(density as MultiHopV3Density)) throw new Error(`${input.id}: invalid density`);
  return density as MultiHopV3Density;
}

async function main(): Promise<void> {
  const trial = process.argv[2];
  const knobs: MultiHopV3Knobs = trial ? JSON.parse(trial) as MultiHopV3Knobs : MULTIHOP_V3_KNOBS;
  validateMultiHopV3Knobs(knobs);

  const generated = generateMultiHopV3Split('calib', knobs);
  const inputs = parseJsonLines(generated.input) as LabScenarioInput[];
  const oracles = parseJsonLines(generated.oracle) as LabScenarioOracle[];
  const scenarios: LabScenario[] = inputs.map((input, index) => {
    const oracle = oracles[index];
    if (!oracle || oracle.scenarioId !== input.id) throw new Error(`${input.id}: oracle order mismatch`);
    return { input, oracle };
  });

  const adapter = new MemBerryRetrievalCoreAdapter();
  if (adapter.id !== MULTIHOP_V3_CONTROL_ADAPTER_ID || adapter.executionMode !== MULTIHOP_V3_CONTROL_EXECUTION_MODE) {
    throw new Error('calibration must run the v2-identical control adapter identity');
  }
  const report = await runAdapter({
    runId: 'ret007v3-local-calibration',
    adapter,
    scenarios,
    splits: ['calib'] as never,
  });
  if (report.outcome !== 'scored' || report.scenarioReports.length !== scenarios.length) {
    throw new Error(`calibration control run did not score: ${report.outcome}`);
  }

  const strata = {
    low: { n: 0, successes: 0, failures: 0 },
    medium: { n: 0, successes: 0, failures: 0 },
    high: { n: 0, successes: 0, failures: 0 },
  } satisfies Record<MultiHopV3Density, { n: number; successes: number; failures: number }>;
  let successes = 0;
  for (const [index, scenario] of scenarios.entries()) {
    const scenarioReport = report.scenarioReports[index]!;
    if (scenarioReport.scenarioId !== scenario.input.id || scenarioReport.probes.length !== 1) {
      throw new Error(`${scenario.input.id}: control report mismatch`);
    }
    const required = scenario.oracle.probes[0]!.required!;
    const top = new Set(scenarioReport.probes[0]!.resultIds.slice(0, MULTIHOP_V3_K));
    const success = required.every((id) => top.has(id));
    const density = densityOf(scenario.input);
    strata[density].n += 1;
    strata[density][success ? 'successes' : 'failures'] += 1;
    if (success) successes += 1;
  }
  for (const density of DENSITIES) {
    if (strata[density].n !== MULTIHOP_V3_CALIB_DENSITY_COUNTS[density]) {
      throw new Error(`calib ${density} stratum count mismatch`);
    }
  }
  const rate = successes / scenarios.length;
  const inBand = rate >= MULTIHOP_V3_CONTROL_HEADROOM.minimumSuccessRateInclusive
    && rate <= MULTIHOP_V3_CONTROL_HEADROOM.maximumSuccessRateInclusive
    && DENSITIES.every((density) => (
      strata[density].successes >= MULTIHOP_V3_CONTROL_HEADROOM.minimumSuccessesPerStratumInclusive
      && strata[density].failures >= MULTIHOP_V3_CONTROL_HEADROOM.minimumFailuresPerStratumInclusive
    ));
  process.stdout.write(`${JSON.stringify({
    metric: 'strict-multi-hop-task-success-v3',
    split: 'calib',
    knobs,
    n: scenarios.length,
    successes,
    successRate: rate,
    strata,
    inBand,
  }, null, 2)}\n`);
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
