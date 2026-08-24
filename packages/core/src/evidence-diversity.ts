// packages/core/src/evidence-diversity.ts
//
// MEM-004 / MEM-FR-4: hardened evidence-diversity gate for automatic
// promotion. Text distinctness is keyed on a Unicode-folded normalization so
// punctuation-only, quote-style, case, whitespace, and NFKC-confusable
// variants of one sentence count as ONE piece of evidence.

/** The minimal shape the gate needs — EpisodicNode satisfies it structurally. */
export interface EvidenceRecordV1 {
  readonly agent_id: string;
  readonly session_id: string;
  readonly content: string;
}

export interface CorroborationRequirementV1 {
  readonly minSources: number;
  readonly minDistinctEvidence: number;
}

/**
 * Hardened text-diversity key, in this order: Unicode NFKC → locale-independent
 * toLowerCase → strip combining marks (\p{M}) → strip punctuation and symbols
 * (\p{P}, \p{S}) → collapse whitespace → trim.
 *
 * Tradeoff (deliberate): symbol stripping can merge symbol-only deltas with
 * identical alphanumerics ("x=1" vs "x>1" → "x1") — a false REJECTION of a
 * promotion, never a false acceptance; digits and letters survive, so common
 * config diffs stay distinct.
 */
export function normalizeEvidenceTextV1(s: string): string {
  return s
    .normalize('NFKC')
    .toLowerCase()
    .replace(/\p{M}/gu, '')
    .replace(/[\p{P}\p{S}]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Distinct `agent_id`+`session_id` pairs; NUL-separated so keys cannot collide. */
export function countIndependentSources(cluster: readonly EvidenceRecordV1[]): number {
  return new Set(cluster.map((record) => `${record.agent_id}\u0000${record.session_id}`)).size;
}

/** Distinct evidence texts under the hardened normalization. */
export function countDistinctEvidence(cluster: readonly EvidenceRecordV1[]): number {
  return new Set(cluster.map((record) => normalizeEvidenceTextV1(record.content))).size;
}

/**
 * The automatic-promotion corroboration gate: a cluster qualifies only with
 * enough independent sources AND enough genuinely distinct evidence texts.
 */
export function clusterHasIndependentCorroborationV1(
  cluster: readonly EvidenceRecordV1[],
  requirement: CorroborationRequirementV1,
): boolean {
  return (
    countIndependentSources(cluster) >= requirement.minSources
    && countDistinctEvidence(cluster) >= requirement.minDistinctEvidence
  );
}
