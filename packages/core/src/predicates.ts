// packages/core/src/predicates.ts
// Predicate normalization shared by the fact extractor (extract.ts) and the
// service-layer reconciliation/conflict logic (service.ts). Lives in its own
// module so extract.ts can normalize predicates without importing service.ts
// (service.ts imports extract.ts → importing back would be circular).
//
// Maps synonym predicates to canonical forms so "uses", "depends on", "relies on"
// all compare as the same predicate. Prevents false-negative conflict detection,
// and lets the extraction shape-gate (isSaneFact, OPT-04) recognize a KNOWN
// space-form synonym as legitimate instead of dropping it (OPT-69) — while an
// UNKNOWN space/punctuation predicate is left unchanged and still rejected.

const PREDICATE_SYNONYMS: Record<string, string> = {
  // uses / depends-on family
  'uses': 'uses',
  'depends_on': 'uses',
  'depends on': 'uses',
  'relies_on': 'uses',
  'relies on': 'uses',
  'requires': 'uses',
  'built_with': 'uses',
  'built with': 'uses',
  'powered_by': 'uses',
  'powered by': 'uses',
  'utilizes': 'uses',
  // prefers family
  'prefers': 'prefers',
  'favors': 'prefers',
  'defaults_to': 'prefers',
  'defaults to': 'prefers',
  'chooses': 'prefers',
  // located-at family
  'located_at': 'located_at',
  'located at': 'located_at',
  'deployed_at': 'located_at',
  'deployed at': 'located_at',
  'deployed_to': 'located_at',
  'deployed to': 'located_at',
  'hosted_on': 'located_at',
  'hosted on': 'located_at',
  'runs_on': 'located_at',
  'runs on': 'located_at',
  // implements family
  'implements': 'implements',
  'provides': 'implements',
  'exposes': 'implements',
  'offers': 'implements',
  // owns / maintains family
  'owns': 'owns',
  'maintains': 'owns',
  'manages': 'owns',
  'responsible_for': 'owns',
  'responsible for': 'owns',
  // is / identity family
  'is': 'is',
  'is_a': 'is',
  'is a': 'is',
  'type_is': 'is',
  // version family
  'version_is': 'version_is',
  'version is': 'version_is',
  'at_version': 'version_is',
  'at version': 'version_is',
};

export function normalizePredicate(predicate: string): string {
  const lower = predicate.toLowerCase().trim();
  const canonical = PREDICATE_SYNONYMS[lower] ?? lower;
  if (canonical !== lower) {
    console.debug(`[predicate-norm] "${predicate}" → "${canonical}"`);
  }
  return canonical;
}

/**
 * Returns a copy of the current predicate synonym map.
 * Useful for debugging and inspection via berry_query.
 */
export function getPredicateSynonyms(): Record<string, string> {
  return { ...PREDICATE_SYNONYMS };
}
