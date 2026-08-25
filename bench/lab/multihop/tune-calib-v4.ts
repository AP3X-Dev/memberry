// RET-007 — CALIB-ONLY candidate-vs-control tuning harness (the frozen judge for
// the research/aug25-multihop experiment loop).
//
// Calib is the ONLY split on which per-scenario outcomes may be inspected
// (advisor log, Decision 2c "Tuning surface: calib only"). This script NEVER
// reads or writes dev/holdout/twin bytes, produces no receipt, and its numbers
// are adjudication-forbidden: they motivate mechanism changes, they never
// substitute for a hosted dev evaluation.
//
// It exists because `calibrate-v4.ts` scores the CONTROL only (it is an
// instrument-qualification tool for dataset knobs). Nothing in the repo scored
// the CANDIDATE on calib; the fusion-repair cycle (Decisions 2a-2f) did it by
// hand. This makes that measurement reproducible and greppable.
//
// PRIMARY METRIC (the one the loop optimizes, higher is better):
//
//   mrr_withheld = mean over WITHHELD scenarios of 1 / max(rank_A, rank_B)
//
// where WITHHELD = the calib scenarios in which memory B is NOT emitted by the
// control's pass-1 funnel, and rank is the 1-based position in the candidate's
// result list (0 contributed when either required memory is absent).
//
// Why this metric and not calib success:
//   - It is scored ONLY on scenarios the mechanism can possibly affect. A
//     fusion tweak that reshuffles already-solved scenarios cannot move it, so
//     it is far harder to fit than the 45-scenario success count.
//   - It is continuous. Calib success moves in 2.2-point steps across 45 items;
//     three amendments deep, that resolution is mostly noise.
//   - max(rank_A, rank_B) is the binding rank: the success criterion needs BOTH
//     required memories inside the top K, so the worse-ranked one is the one
//     that decides. mrr_withheld is exactly the continuous relaxation of the
//     metric that is actually adjudicated.
//
// CONSTRAINT (recorded, not optimized): calib_success must not fall below the
// baseline. A mutation that recovers withheld B's by wrecking scenarios that
// already worked is a regression whatever the primary metric says.
//
// OVERFIT DETECTOR: fold_0/1/2 are mrr_withheld restricted to three folds of
// the withheld set. Fold membership is derived from the CONTROL's emission,
// which is frozen, so folds never move as the candidate changes.

import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

import type { AdapterRunReport } from '../contracts/report.js';
import type { LabScenario } from '../contracts/scenario.js';
import type { LabAdapter } from '../contracts/adapter.js';
import { MemBerryRetrievalCoreFunnelAdapter, funnelSelect } from '../adapters/memberry-retrieval-core-funnel.js';
import { MemBerryRetrievalCoreFunnelMultihopEvidenceBridgeAdapter } from '../adapters/memberry-retrieval-core-funnel-multihop.js';
import { runAdapter } from '../runner.js';
import {
  MULTIHOP_V4_FUNNEL_TOP_N,
  MULTIHOP_V4_K,
  MULTIHOP_V4_KNOBS,
} from './policy-v4.js';
import { calibScenariosFromKnobs } from './calibrate-v4.js';

const FOLDS = 3;

interface ScenarioOutcome {
  readonly scenarioId: string;
  /** B absent from the control's pass-1 funnel emission — the only scenarios the mechanism can fix. */
  readonly withheld: boolean;
  readonly controlSuccess: boolean;
  readonly candidateSuccess: boolean;
  /** 1 / max(rank_A, rank_B) in the candidate output; 0 when either is absent. */
  readonly candidateReciprocal: number;
  readonly controlReciprocal: number;
}

export interface TuneCalibResult {
  readonly n: number;
  readonly withheldN: number;
  readonly mrrWithheld: number;
  readonly controlMrrWithheld: number;
  readonly recovery: number;
  readonly calibSuccess: number;
  readonly controlSuccess: number;
  readonly gateFired: number;
  readonly folds: readonly number[];
  readonly outcomes: readonly ScenarioOutcome[];
}

/** 1-based rank of `id` in `resultIds`, or null when absent. */
function rankOf(resultIds: readonly string[], id: string): number | null {
  const index = resultIds.indexOf(id);
  return index < 0 ? null : index + 1;
}

/**
 * Reciprocal of the BINDING rank: the success criterion needs both required
 * memories inside the top K, so the worse-ranked of the two decides. Absent
 * (either one) contributes 0.
 */
function bindingReciprocal(resultIds: readonly string[], required: readonly string[]): number {
  let worst = 0;
  for (const id of required) {
    const rank = rankOf(resultIds, id);
    if (rank === null) return 0;
    worst = Math.max(worst, rank);
  }
  return worst === 0 ? 0 : 1 / worst;
}

function successAtK(resultIds: readonly string[], required: readonly string[]): boolean {
  const top = new Set(resultIds.slice(0, MULTIHOP_V4_K));
  return required.every((id) => top.has(id));
}

function probeResultIds(report: AdapterRunReport, index: number, scenario: LabScenario): readonly string[] {
  const scenarioReport = report.scenarioReports[index];
  if (!scenarioReport || scenarioReport.scenarioId !== scenario.input.id || scenarioReport.probes.length !== 1) {
    throw new Error(`${scenario.input.id}: report mismatch`);
  }
  return scenarioReport.probes[0]!.resultIds;
}

export function computeTuneCalib(
  scenarios: readonly LabScenario[],
  controlReport: AdapterRunReport,
  candidateReport: AdapterRunReport,
  gateFired: number,
): TuneCalibResult {
  if (controlReport.outcome !== 'scored') throw new Error(`control did not score: ${controlReport.outcome}`);
  if (candidateReport.outcome !== 'scored') throw new Error(`candidate did not score: ${candidateReport.outcome}`);

  const outcomes: ScenarioOutcome[] = [];
  for (const [index, scenario] of scenarios.entries()) {
    const required = scenario.oracle.probes[0]!.required!;
    const bId = required[1]!;
    // Withheld-ness is a property of the FROZEN control funnel, never of the
    // candidate — that is what keeps the metric's denominator and the fold
    // assignment stable across every experiment in the loop.
    const selection = funnelSelect(
      scenario.input.memories.filter((memory) => memory.kind !== 'code'),
      scenario.input.queries[0]!.query,
      MULTIHOP_V4_FUNNEL_TOP_N,
    );
    const controlIds = probeResultIds(controlReport, index, scenario);
    const candidateIds = probeResultIds(candidateReport, index, scenario);
    outcomes.push({
      scenarioId: scenario.input.id,
      withheld: !selection.selectedIds.includes(bId),
      controlSuccess: successAtK(controlIds, required),
      candidateSuccess: successAtK(candidateIds, required),
      candidateReciprocal: bindingReciprocal(candidateIds, required),
      controlReciprocal: bindingReciprocal(controlIds, required),
    });
  }

  const withheld = outcomes.filter((outcome) => outcome.withheld);
  const mean = (values: readonly number[]): number =>
    values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;

  // Folds partition the withheld set by lexicographic scenario id — a frozen
  // ordering, so a mutation can never move a scenario between folds.
  const ordered = [...withheld].sort((a, b) => (a.scenarioId < b.scenarioId ? -1 : a.scenarioId > b.scenarioId ? 1 : 0));
  const folds = Array.from({ length: FOLDS }, (_, fold) =>
    mean(ordered.filter((_, position) => position % FOLDS === fold).map((outcome) => outcome.candidateReciprocal)));

  return {
    n: outcomes.length,
    withheldN: withheld.length,
    mrrWithheld: mean(withheld.map((outcome) => outcome.candidateReciprocal)),
    controlMrrWithheld: mean(withheld.map((outcome) => outcome.controlReciprocal)),
    recovery: withheld.filter((outcome) => outcome.candidateSuccess).length,
    calibSuccess: outcomes.filter((outcome) => outcome.candidateSuccess).length,
    controlSuccess: outcomes.filter((outcome) => outcome.controlSuccess).length,
    gateFired,
    folds,
    outcomes,
  };
}

async function run(adapter: LabAdapter, scenarios: readonly LabScenario[], runId: string): Promise<AdapterRunReport> {
  return runAdapter({ runId, adapter, scenarios, splits: ['calib'] as never });
}

/**
 * The calib scenarios ask for `limit: 10`, which is also K — so a result list
 * truncated at 10 cannot distinguish "ranked 11th" from "absent", and every
 * rank-based metric collapses to the success count. Raising the limit exposes
 * the full ranked list (the memory channel emits 12) WITHOUT changing what is
 * retrieved: the adapter passes `limit` only to the final projection, so the
 * assembled order is identical and success is still scored at the top K.
 */
function deepened(scenarios: readonly LabScenario[]): LabScenario[] {
  return scenarios.map((scenario) => ({
    ...scenario,
    input: {
      ...scenario.input,
      queries: scenario.input.queries.map((query) => ({ ...query, limit: RANK_DEPTH })),
    },
  }));
}

const RANK_DEPTH = 500;

async function main(): Promise<void> {
  const scenarios = deepened(calibScenariosFromKnobs(MULTIHOP_V4_KNOBS));
  const control = new MemBerryRetrievalCoreFunnelAdapter();
  const candidate = new MemBerryRetrievalCoreFunnelMultihopEvidenceBridgeAdapter();

  const controlReport = await run(control, scenarios, 'ret007-tune-calib-control');
  const candidateReport = await run(candidate, scenarios, 'ret007-tune-calib-candidate');
  const gateFired = [...candidate.firings.values()].filter(Boolean).length;

  const result = computeTuneCalib(scenarios, controlReport, candidateReport, gateFired);

  // Greppable metric lines — `<name>: <value>`, one per line. The loop reads
  // these; everything else on stdout is for the human reading run.log.
  process.stdout.write(`mrr_withheld: ${result.mrrWithheld.toFixed(6)}\n`);
  process.stdout.write(`recovery: ${result.recovery}\n`);
  process.stdout.write(`calib_success: ${result.calibSuccess}\n`);
  process.stdout.write(`gate_fired: ${result.gateFired}\n`);
  process.stdout.write(`withheld_n: ${result.withheldN}\n`);
  process.stdout.write(`control_success: ${result.controlSuccess}\n`);
  process.stdout.write(`control_mrr_withheld: ${result.controlMrrWithheld.toFixed(6)}\n`);
  result.folds.forEach((value, fold) => process.stdout.write(`fold_${fold}: ${value.toFixed(6)}\n`));

  if (process.argv.includes('--per-scenario')) {
    for (const outcome of result.outcomes) process.stdout.write(`${JSON.stringify(outcome)}\n`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => { console.error(error); process.exitCode = 1; });
}
