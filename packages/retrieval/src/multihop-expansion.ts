// RET-007 v4 candidate mechanism (spec docs/agent-runs/specs/2026-08-25-ret007-v4-candidate.md §2/§6).
//
// ONE deterministic, no-LLM, bounded, fail-closed second retrieval pass over
// the memory channel. Returns a REPLACEMENT for the pass-1 memory list; the
// number of channel lists handed to fusion.ts never changes and fusion.ts is
// not touched. Every derivation is text-only and in-module so the legacy,
// served and lab arms compute the identical bridge. No wall clock is read
// here: the caller injects `clock`; the lab injects none and uses
// MULTIHOP_LAB_BUDGET_MS so no timing path is reachable from an adapter.

import type { RetrievalResult } from './types.js';

/** Pre-registered bridge-derivation policies (Decision 2). P4' fact-lexical is a dev-only control. */
export const MULTIHOP_BRIDGE_DERIVATION = Object.freeze(['evidence-bridge', 'fact-lexical'] as const);
export type MultihopBridgeDerivation = (typeof MULTIHOP_BRIDGE_DERIVATION)[number];

/** Process flag read at bootstrap; '1' = on, default off. */
export const MULTIHOP_EXPANSION_FLAG = 'MEMBERRY_MULTIHOP_EXPANSION_V1';

/** Live-latency dial: skip pass 2 when pass 1 took longer; also the shared pass-2 deadline. */
export const MULTIHOP_PASS1_BUDGET_MS = 1500;
/** Lab budget: no deadline is ever reachable from the lab adapter. */
export const MULTIHOP_LAB_BUDGET_MS = Number.POSITIVE_INFINITY;

const MAX_BRIDGES = 3;
const MAX_LEXICAL_TERMS = 6;
/**
 * Decision 2b(2): in-module RRF constant, a PRE-REGISTERED LITERAL (not a knob, no bounds,
 * tuned on calib only). Was 60: at k = 60 a pass-2 rank-0 item scores 0.6/61 and cannot
 * outscore any pass-1 item ranked above 41, so a hop the second pass FOUND could never
 * enter the top-10 of the fused list. At k = 10 a pass-2 rank-0 item (0.6/11) outscores
 * pass-1 items ranked >= 8, so it enters at fused position 9 — inside the top-10 of the
 * 12-slot memory list the funnel emits. Weights stay [1.0, 0.6].
 */
export const MULTIHOP_RRF_K = 10;
const PASS_WEIGHTS = [1.0, 0.6] as const;
const MIN_NOVEL = 2;
const MAX_JACCARD = 0.7;
const BM25_K1 = 1.2;
const BM25_B = 0.75;

/** Comparison / yes-no forms never get a second pass (word-bounded `vs`). */
const COMPARISON_QUERY = /^(is|are|was|were|do|does|did|can|could|should|would|has|have)\b| or |compared|versus|\bvs\b|which is (more|less|larger|smaller|older|newer|bigger)/i;
/** Case-preserving name-shaped scan (duplicated from the spec, not imported from any arm). */
const NAME_SHAPED = /\b[A-Z][A-Za-z0-9]*(?:[-_][A-Za-z0-9]+)*\b/g;

export interface MultihopProbeInput {
  /** uncovered(q) joined with the bridge/terms — consumed by the legacy and lab arms. */
  conditionedTask: string;
  /** Bare bridge name for the served resolver; absent for fact-lexical (served-unreachable by construction). */
  bridge?: string;
}
export type MultihopProbe = (input: MultihopProbeInput) => Promise<readonly RetrievalResult[]>;

export type MultihopGateReason =
  | 'fired' | 'no-probe' | 'empty-pass1' | 'pass1-over-budget' | 'comparison-query'
  | 'no-bridge' | 'novelty-abort' | 'deadline' | 'error';

export interface ExpandMultihopV1Input {
  policy: MultihopBridgeDerivation;
  query: string;
  pass1: readonly RetrievalResult[];
  budgetSlots: number;
  probe?: MultihopProbe;
  /** Injected clock (ms). Absent => no timing at all. */
  clock?: () => number;
  pass1ElapsedMs?: number;
  /** Pass-1 skip threshold and pass-2 deadline; defaults to MULTIHOP_PASS1_BUDGET_MS. */
  budgetMs?: number;
  /** Identity for merge/novelty/Jaccard: memory id (legacy/lab) or evidenceId (served). */
  identityKey?: (result: RetrievalResult) => string;
}

export interface ExpandMultihopV1Output {
  results: readonly RetrievalResult[];
  fired: boolean;
  pass2Ids: readonly string[];
  reason: MultihopGateReason;
}

/** Funnel tokenizer rule, duplicated: lowercase, [a-z0-9]+, length >= 2. */
function tokenize(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((token) => token.length >= 2);
}

function nameShaped(text: string): string[] {
  return text.match(NAME_SHAPED) ?? [];
}

/**
 * Decision 2a (pass 1) and Decision 2c (pass 2): both lists arrive UNRANKED at the seam (corpus
 * order in the lab, the memory layer's own order live), so the module computes its own
 * deterministic relevance rank — BM25-lite of each item's content vs `queryText` (IDF over the
 * contents of THAT list, k1 = 1.2, b = 0.75), ties by list position.
 *
 * Pass 1 (`queryText` = q) drives top-3 derivation and the pass-1 RRF ranks (Decision 2b(3)
 * removed the lexical-tail replacement: what survives is decided by the FUSED order). Pass 2 is
 * ranked PER PROBE against THAT probe's conditionedTask — the text that actually retrieved it.
 * Neither is used for the gate-not-fired return, which is the caller's list untouched.
 */
function rankByRelevance(queryText: string, results: readonly RetrievalResult[]): RetrievalResult[] {
  const docs = results.map((result) => tokenize(result.content));
  const n = docs.length;
  const avgdl = docs.reduce((sum, doc) => sum + doc.length, 0) / n || 1;
  const documentFrequency = new Map<string, number>();
  for (const doc of docs) for (const token of new Set(doc)) documentFrequency.set(token, (documentFrequency.get(token) ?? 0) + 1);
  const queryTokens = [...new Set(tokenize(queryText))];
  const scores = docs.map((doc) => {
    const tf = new Map<string, number>();
    for (const token of doc) tf.set(token, (tf.get(token) ?? 0) + 1);
    const norm = BM25_K1 * (1 - BM25_B + BM25_B * doc.length / avgdl);
    return queryTokens.reduce((score, token) => {
      const frequency = tf.get(token) ?? 0;
      if (frequency === 0) return score;
      const df = documentFrequency.get(token) ?? 0;
      return score + Math.log(1 + (n - df + 0.5) / (df + 0.5)) * (frequency * (BM25_K1 + 1)) / (frequency + norm);
    }, 0);
  });
  return results.map((result, index) => ({ result, index }))
    .sort((left, right) => (scores[right.index]! - scores[left.index]!) || (left.index - right.index))
    .map(({ result }) => result);
}

function unchanged(pass1: readonly RetrievalResult[], reason: MultihopGateReason): ExpandMultihopV1Output {
  return { results: pass1, fired: false, pass2Ids: [], reason };
}

/**
 * Bridges: name-shaped tokens of the pass-1 top-3 (by the module's own BM25-lite rank) minus the
 * name-shaped tokens of q. Decision 2b(4): the ranking key is strictly lexicographic — the SOURCE
 * memory's BM25-lite rank ascending first, then passage frequency ascending; n <= MAX_BRIDGES.
 */
function deriveBridges(query: string, pass1: readonly RetrievalResult[]): string[] {
  const inQuery = new Set(nameShaped(query));
  const firstRank = new Map<string, number>();
  pass1.slice(0, 3).forEach((result, rank) => {
    for (const token of nameShaped(result.content)) {
      if (inQuery.has(token) || firstRank.has(token)) continue;
      firstRank.set(token, rank);
    }
  });
  const frequency = new Map<string, number>();
  for (const result of pass1) {
    for (const token of new Set(nameShaped(result.content))) frequency.set(token, (frequency.get(token) ?? 0) + 1);
  }
  return [...firstRank.keys()]
    .sort((left, right) => (firstRank.get(left)! - firstRank.get(right)!)
      || (frequency.get(left)! - frequency.get(right)!))
    .slice(0, MAX_BRIDGES);
}

/** Top-IDF terms (IDF over pass-1 contents) of pass-1 top-3 not in q, m <= 6. */
function deriveLexicalTerms(query: string, pass1: readonly RetrievalResult[]): string[] {
  const inQuery = new Set(tokenize(query));
  const documentFrequency = new Map<string, number>();
  for (const result of pass1) {
    for (const token of new Set(tokenize(result.content))) documentFrequency.set(token, (documentFrequency.get(token) ?? 0) + 1);
  }
  const corpusSize = pass1.length;
  const idf = (token: string) => Math.log((corpusSize + 1) / ((documentFrequency.get(token) ?? 0) + 1));
  const seen = new Set<string>();
  const candidates: string[] = [];
  for (const result of pass1.slice(0, 3)) {
    for (const token of tokenize(result.content)) {
      if (inQuery.has(token) || seen.has(token)) continue;
      seen.add(token);
      candidates.push(token);
    }
  }
  // Stable sort: IDF desc, then first appearance.
  return candidates
    .map((token, index) => ({ token, index, idf: idf(token) }))
    .sort((left, right) => (right.idf - left.idf) || (left.index - right.index))
    .slice(0, MAX_LEXICAL_TERMS)
    .map(({ token }) => token);
}

function jaccard(left: ReadonlySet<string>, right: ReadonlySet<string>): number {
  if (left.size === 0 && right.size === 0) return 0;
  let intersection = 0;
  for (const value of left) if (right.has(value)) intersection += 1;
  return intersection / (left.size + right.size - intersection);
}

function withDeadline<T>(work: Promise<T>, budgetMs: number): Promise<T> {
  if (!Number.isFinite(budgetMs)) return work;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new MultihopDeadline()), budgetMs);
    timer.unref?.();
  });
  return Promise.race([work, deadline]).finally(() => { if (timer !== undefined) clearTimeout(timer); });
}

class MultihopDeadline extends Error {
  constructor() { super('multihop:deadline'); }
}

export async function expandMultihopV1(input: ExpandMultihopV1Input): Promise<ExpandMultihopV1Output> {
  const { pass1 } = input;
  try {
    if (!input.probe) return unchanged(pass1, 'no-probe');
    if (pass1.length === 0) return unchanged(pass1, 'empty-pass1');
    const budgetMs = input.budgetMs ?? MULTIHOP_PASS1_BUDGET_MS;
    if (input.pass1ElapsedMs !== undefined && input.pass1ElapsedMs > budgetMs) return unchanged(pass1, 'pass1-over-budget');
    const query = input.query;
    if (COMPARISON_QUERY.test(query)) return unchanged(pass1, 'comparison-query');
    // Decision 2a: every position-dependent step below reads the module's own relevance rank.
    const ranked = rankByRelevance(query, pass1);
    const bridges = deriveBridges(query, ranked);
    if (bridges.length === 0) return unchanged(pass1, 'no-bridge');

    const top3Tokens = new Set(ranked.slice(0, 3).flatMap((result) => tokenize(result.content)));
    const queryTokens = [...new Set(tokenize(query))];
    const uncovered = queryTokens.filter((token) => !top3Tokens.has(token));
    const probes: MultihopProbeInput[] = input.policy === 'evidence-bridge'
      ? bridges.map((bridge) => ({ conditionedTask: [...uncovered, bridge].join(' '), bridge }))
      : [{ conditionedTask: [...uncovered, ...deriveLexicalTerms(query, ranked)].join(' ') }];

    // Concurrent probes, ONE shared deadline, bridge-order concatenation (completion-order independent).
    const started = input.clock?.();
    const probe = input.probe;
    const perBridge = await withDeadline(Promise.all(probes.map((request) => probe(request))), input.clock ? budgetMs : Number.POSITIVE_INFINITY);
    if (started !== undefined && input.clock!() - started > budgetMs) return unchanged(pass1, 'deadline');

    const identityKey = input.identityKey ?? ((result: RetrievalResult) => result.id);
    const pass1Keys = new Set(pass1.map(identityKey));
    // Decision 2c: rank the pass-2 results in-module, symmetric with 2a's pass-1 ranking. Each
    // probe's results are ranked by the SAME BM25-lite against THAT probe's conditionedTask (IDF
    // over that probe's returned contents); the concatenated pass-2 list is then ordered by that
    // rank, ties by probe order then original position. Probe-return order (corpus order in the
    // lab) is noise and must not reach the RRF.
    const rankedPerProbe = perBridge.map((results, probeIndex) => rankByRelevance(probes[probeIndex]!.conditionedTask, results));
    const rawPass2: RetrievalResult[] = [];
    const seen = new Set<string>();
    for (const { result } of rankedPerProbe
      .flatMap((results, probeIndex) => results.map((result, rank) => ({ result, rank, probeIndex })))
      .sort((left, right) => (left.rank - right.rank) || (left.probeIndex - right.probeIndex))) {
      const key = identityKey(result);
      if (seen.has(key)) continue;
      seen.add(key);
      rawPass2.push(result);
    }
    const k = input.budgetSlots;
    if (jaccard(new Set(rawPass2.slice(0, k).map(identityKey)), new Set(pass1.slice(0, k).map(identityKey))) > MAX_JACCARD) {
      return unchanged(pass1, 'novelty-abort');
    }
    const querySet = new Set(queryTokens);
    // Distractor latch: a pass-2 hit sharing no token with q is dropped BEFORE ranks are assigned.
    // Decision 2b(1): what survives is the MERGED list — an identity already in pass 1 keeps its
    // place, accrues both RRF terms, and occupies its pass-2 rank position. The novelty abort still
    // counts NEW identities only.
    const pass2 = rawPass2.filter((result) => tokenize(`${result.title} ${result.content}`).some((token) => querySet.has(token)));
    const pass2OnlyKeys = new Set(pass2.map(identityKey).filter((key) => !pass1Keys.has(key)));
    if (pass2OnlyKeys.size < MIN_NOVEL) return unchanged(pass1, 'novelty-abort');

    // Weighted RRF inside the module: pass-1 @ 1.0, the concatenated pass-2 list @ 0.6,
    // k = MULTIHOP_RRF_K. Insertion order is pass-1 rank then pass-2 rank.
    const scores = new Map<string, number>();
    const byKey = new Map<string, RetrievalResult>();
    ranked.forEach((result, rank) => {
      const key = identityKey(result);
      // The pass-1 object is the representative: live, its id encodes the pass-1 channel rank.
      if (!byKey.has(key)) byKey.set(key, result);
      scores.set(key, (scores.get(key) ?? 0) + PASS_WEIGHTS[0]! / (MULTIHOP_RRF_K + rank + 1));
    });
    // Rank among NEW evidence: an identity already in pass 1 still MERGES and still accrues its
    // pass-2 term, but it does not CONSUME a rank position. The probe returns ~12 items of which
    // ~11 are pass-1 duplicates; letting those duplicates occupy the leading pass-2 ranks pushes
    // the one genuinely new item — the missing hop, the entire point of the second pass — below
    // the worst pass-1 item, where it can never enter the fused output.
    const carriesBridge = (result: RetrievalResult, bridgeSet: ReadonlySet<string>): boolean =>
      tokenize(`${result.title} ${result.content}`).some((token) => bridgeSet.has(token));
    const bridgeSet = new Set(bridges.flatMap((bridge) => tokenize(bridge)));
    // Protect second-hop-shaped evidence ALREADY in pass 1. A second hop shares no token with q —
    // that is what makes it a second hop — so BM25 against q ranks it near the bottom of pass 1,
    // which is exactly the band a promoted pass-2 item evicts. Ranking the eviction by q-relevance
    // therefore throws out the answer whenever pass 1 had already found it. What marks a passage as
    // second-hop evidence is the bridge, not the query, so a pass-1 item carrying the bridge earns
    // the same second-pass term a new find does.
    let carrierRank = 0;
    for (const result of ranked) {
      if (!carriesBridge(result, bridgeSet)) continue;
      const key = identityKey(result);
      scores.set(key, (scores.get(key) ?? 0) + PASS_WEIGHTS[1]! / (MULTIHOP_RRF_K + carrierRank + 1));
      carrierRank += 1;
    }
    // ONE pass-2 term per identity, and only for identities the second pass ADDED. Giving each of
    // the ~11 duplicates a confirmation boost lifts the whole pass-1 list by about the same amount,
    // changing no ordering among them while leaving the one new item below all of them.
    let novelRank = 0;
    for (const result of pass2) {
      const key = identityKey(result);
      if (!pass2OnlyKeys.has(key)) continue;
      if (!byKey.has(key)) byKey.set(key, result);
      scores.set(key, (scores.get(key) ?? 0) + PASS_WEIGHTS[1]! / (MULTIHOP_RRF_K + novelRank + 1));
      novelRank += 1;
    }
    const fused = [...byKey.keys()].sort((left, right) => (scores.get(right)! - scores.get(left)!)
      || (Number(pass2OnlyKeys.has(left)) - Number(pass2OnlyKeys.has(right))));
    // Decision 2b(3): replace by FUSED order — the output is the top `budgetSlots` of the fused
    // list, so nothing is evicted by lexical rank alone. Pass-2-ONLY identities are capped at
    // ceil(budgetSlots/2) by SKIPPING the lower-fused ones (never by truncating the tail), and the
    // freed slots go to the next pass-1 items, so the total slot count is unchanged.
    const pass2Cap = Math.ceil(k / 2);
    const results: RetrievalResult[] = [];
    let pass2Used = 0;
    for (const key of fused) {
      if (results.length >= k) break;
      if (pass2OnlyKeys.has(key)) {
        if (pass2Used >= pass2Cap) continue;
        pass2Used += 1;
      }
      results.push(byKey.get(key)!);
    }
    const pass2Ids = results.filter((result) => pass2OnlyKeys.has(identityKey(result))).map((result) => result.id);
    return { results, fired: true, pass2Ids, reason: 'fired' };
  } catch (error) {
    return unchanged(pass1, error instanceof MultihopDeadline ? 'deadline' : 'error');
  }
}
