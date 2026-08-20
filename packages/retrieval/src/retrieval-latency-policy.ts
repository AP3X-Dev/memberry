// RET-009 — the bounded-latency and degradation policy, as an executable artifact.
//
// It lives in src/ and not in docs/ because docs/ is gitignored, so a markdown
// policy would travel with neither the pull request nor CI.
//
// Every clause below is asserted against real behaviour by
// __tests__/retrieval-fault-policy.test.ts and __tests__/candidate-channel.test.ts.
// A clause no test asserts must not be added here — that is the markdown problem
// wearing a .ts extension.
//
// Dependency direction is one-way: this file imports the executor deadline from the
// sealed executor. No production module imports this file, and it is not re-exported
// from index.ts.
import { CANDIDATE_CHANNEL_EXECUTOR_DEADLINE_MS } from './candidate-channel.js';

export interface RetrievalLatencyHopPolicyV1 {
  /** Wall-clock bound in force for this hop, or null when the hop is explicitly unbounded. */
  readonly boundMs: number | null;
  /** The settlement a fault on this hop is required to produce. */
  readonly faultSettlement: string;
}

export interface RetrievalDegradationPolicyV1 {
  /** The settlement a degraded but non-faulting channel is required to produce. */
  readonly faultSettlement: string;
  /** Trace event kind through which the degradation must reach a rendered explanation. */
  readonly disclosedAs: string;
}

export const RETRIEVAL_LATENCY_POLICY_V1: {
  readonly candidateChannelExecutor: RetrievalLatencyHopPolicyV1;
  readonly runtimeCandidateChannelNonFact: RetrievalLatencyHopPolicyV1;
  readonly runtimeCandidateChannelFact: RetrievalLatencyHopPolicyV1;
  readonly collectionSize: RetrievalLatencyHopPolicyV1;
  readonly degradedChannel: RetrievalDegradationPolicyV1;
} = Object.freeze({
  // Backstop for a roster runner that never settles. Armed per attempt at attempt
  // start, so a roster of N hung runners is bounded by one deadline, not N.
  candidateChannelExecutor: Object.freeze({
    boundMs: CANDIDATE_CHANNEL_EXECUTOR_DEADLINE_MS,
    faultSettlement: 'timeout',
  }),
  // Query 2000 + commit 500 + rollback 500 + session close 500
  // (runtime-candidate-channel.ts QUERY_TIMEOUT_MS / CLOSE_TIMEOUT_MS and the
  // finally block that closes the transaction and the session).
  //
  // This is a supremum, not an attainable elapsed time: a query that burns its
  // full bound throws straight to the catch, so the commit leg never runs. The
  // reachable maxima are 3000 (query hangs) and 1500 (commit hangs), and 3500 is
  // only approached as the query completes arbitrarily close to its own bound.
  // The tests therefore measure both legs and check the decomposition rather
  // than waiting for a 3500 that no single run produces.
  runtimeCandidateChannelNonFact: Object.freeze({
    boundMs: 3_500,
    faultSettlement: 'timeout',
  }),
  // FactStore composes two independent deadlines serially: the batch wall timeout
  // bounding session.run (6000), then the batch close timeout in the outer finally
  // (1000). The runner does not wrap this hop in its own bound.
  runtimeCandidateChannelFact: Object.freeze({
    boundMs: 7_000,
    faultSettlement: 'timeout',
  }),
  // Query 2000 + session close 500 (assembler.ts COLLECTION_SIZE_QUERY_TIMEOUT_MS /
  // COLLECTION_SIZE_CLOSE_TIMEOUT_MS, the second bounding the close in the finally).
  // Unlike the non-fact hop above this composed bound IS attainable: the finally runs
  // after the try throws, so query-timeout-then-close-timeout is a real serial path.
  // The hop overlaps the layer fetches, so the marginal wall clock it adds to a
  // request is max(0, 2500 - layerElapsed), not 2500.
  //
  // Still fail-open — a fault serves the previously cached value, or undefined when
  // there is none, and never throws.
  //
  // Ranking side effect, stated because it is real. collectionSize feeds fusion.ts:44
  // (scaleRrfK) and fusion.ts:120-121 (normalizeScores), both gated on
  // scoring.ts LARGE_COLLECTION_THRESHOLD = 10_000. A probe that now times out where
  // it previously completed slowly suppresses the hint, which reverts effectiveK to
  // the base k and skips sigmoid z-score normalization, so scores and ordering can
  // change — on deployments at or above that threshold only, and never below it.
  // The TTL stamp is written on the failure path as well as the success path, so the
  // degradation is bounded to one probe per TTL window and self-heals on the next.
  collectionSize: Object.freeze({
    boundMs: 2_500,
    faultSettlement: 'stale-or-undefined',
  }),
  // Degradation is disclosed, not hidden: a channel that cannot serve settles
  // unavailable and must survive into the rendered explanation as a channel-terminal
  // event, so an operator can see which source was missing from an answer.
  degradedChannel: Object.freeze({
    faultSettlement: 'unavailable',
    disclosedAs: 'channel-terminal',
  }),
});
