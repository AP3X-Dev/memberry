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
  // Query 2000 + commit 500 + rollback 500 + session close 500, all serial
  // (runtime-candidate-channel.ts QUERY_TIMEOUT_MS / CLOSE_TIMEOUT_MS and the
  // finally block that closes the transaction and the session).
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
  // Characterized, not fixed: assembler.ts getCollectionSize awaits session.run with
  // no timeout of any kind. It is fail-open — a failure serves the previously cached
  // value, or undefined when there is none, and never throws. A hang is unbounded.
  // Follow-up: RET-011-COLLECTION-SIZE-BOUND.
  collectionSize: Object.freeze({
    boundMs: null,
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
