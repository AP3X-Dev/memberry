import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { loadMultiHopV4ScenariosForScoring } from '../datasets/load-multihop-v4.js';
import { MemBerryRetrievalCoreFunnelAdapter } from '../adapters/memberry-retrieval-core-funnel.js';
import { MemBerryRetrievalCoreFunnelStructuredAdapter } from '../adapters/memberry-retrieval-core-funnel-structured.js';
import { runAdapter } from '../runner.js';
import { pairedBinaryMeanDeltaInterval, type LabPairedBinaryOutcome } from '../stats.js';

export async function measureStructuredDev(repoRoot = process.cwd()) {
  const scenarios = await loadMultiHopV4ScenariosForScoring('dev', repoRoot);
  const [control, candidate] = await Promise.all([
    runAdapter({
      runId: 'idx001bd-frozen-dev-control', adapter: new MemBerryRetrievalCoreFunnelAdapter(),
      scenarios, splits: ['dev'],
    }),
    runAdapter({
      runId: 'idx001bd-frozen-dev-candidate', adapter: new MemBerryRetrievalCoreFunnelStructuredAdapter(),
      scenarios, splits: ['dev'],
    }),
  ]);
  if (control.outcome !== 'scored' || candidate.outcome !== 'scored') {
    throw new Error('idx001bd_measure:arm_not_scored');
  }
  const controlByScenario = new Map(control.scenarioReports.map((row) => [row.scenarioId, row]));
  const candidateByScenario = new Map(candidate.scenarioReports.map((row) => [row.scenarioId, row]));
  const pairs: LabPairedBinaryOutcome[] = scenarios.map((scenario) => {
    const required = scenario.oracle.probes[0]!.required!;
    const controlIds = new Set(controlByScenario.get(scenario.input.id)?.probes[0]?.resultIds ?? []);
    const candidateIds = new Set(candidateByScenario.get(scenario.input.id)?.probes[0]?.resultIds ?? []);
    return {
      scenarioId: scenario.input.id,
      probeId: scenario.input.queries[0]!.id,
      controlOutcome: required.every((id) => controlIds.has(id)) ? 1 : 0,
      candidateOutcome: required.every((id) => candidateIds.has(id)) ? 1 : 0,
    };
  });
  const controlSuccesses = pairs.reduce((sum, pair) => sum + pair.controlOutcome, 0);
  const candidateSuccesses = pairs.reduce((sum, pair) => sum + pair.candidateOutcome, 0);
  const improved = pairs.filter((pair) => pair.controlOutcome === 0 && pair.candidateOutcome === 1).length;
  const regressed = pairs.filter((pair) => pair.controlOutcome === 1 && pair.candidateOutcome === 0).length;
  const interval = pairedBinaryMeanDeltaInterval(pairs);
  return Object.freeze({
    split: 'dev' as const,
    metric: 'strict-multi-hop-task-success-v4' as const,
    k: 10,
    n: pairs.length,
    controlSuccesses,
    candidateSuccesses,
    deltaPoints: ((candidateSuccesses - controlSuccesses) / pairs.length) * 100,
    improved,
    regressed,
    interval: Object.freeze({
      outcome: interval.outcome,
      level: interval.level,
      pointPoints: interval.point === null ? null : interval.point * 100,
      lowerPoints: interval.lower === null ? null : interval.lower * 100,
      upperPoints: interval.upper === null ? null : interval.upper * 100,
      oneSidedLowerPoints: interval.oneSidedLower === null ? null : interval.oneSidedLower * 100,
    }),
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  void measureStructuredDev().then(
    (result) => console.log(JSON.stringify(result, null, 2)),
    (error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    },
  );
}
