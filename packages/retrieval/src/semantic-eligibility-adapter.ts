import { ScopedQuery } from '@memberry/neo4j';
import type { Driver } from 'neo4j-driver';

export interface SemanticEligibilityAuthority {
  evaluateActiveEligibility(input: {
    semanticIds: readonly string[];
    tenantId?: string;
    projectScope?: string;
    asOf?: string;
  }): Promise<ReadonlyArray<{ id: string; status: 'eligible' | 'ineligible' | 'unknown' }>>;
}

export function neo4jSemanticEligibilityAuthority(driver: Driver): SemanticEligibilityAuthority {
  return new ScopedQuery(driver);
}

/** Fail-closed adapter only; lifecycle meaning remains owned by ScopedQuery. */
export async function filterSemanticEvidence<T>(
  candidates: readonly T[],
  authority: SemanticEligibilityAuthority | undefined,
  read: { tenantId?: string; projectScope?: string; asOf?: string },
  sourceType: (candidate: T) => string,
  evidenceId: (candidate: T) => string,
): Promise<T[]> {
  const semanticIds = [...new Set(candidates
    .filter((candidate) => sourceType(candidate) === 'semantic')
    .map(evidenceId))];
  if (semanticIds.length === 0) return [...candidates];
  if (!authority) return candidates.filter((candidate) => sourceType(candidate) !== 'semantic');

  let evaluations: ReadonlyArray<{ id: string; status: 'eligible' | 'ineligible' | 'unknown' }>;
  try {
    evaluations = await authority.evaluateActiveEligibility({ semanticIds, ...read });
  } catch {
    return candidates.filter((candidate) => sourceType(candidate) !== 'semantic');
  }
  if (!Array.isArray(evaluations)) {
    return candidates.filter((candidate) => sourceType(candidate) !== 'semantic');
  }

  const requested = new Set(semanticIds);
  const decided = new Set<string>();
  const eligible = new Set<string>();
  for (const evaluation of evaluations) {
    if (evaluation === null || typeof evaluation !== 'object'
      || typeof evaluation.id !== 'string' || !requested.has(evaluation.id)
      || decided.has(evaluation.id)
      || (evaluation.status !== 'eligible' && evaluation.status !== 'ineligible'
        && evaluation.status !== 'unknown')) {
      return candidates.filter((candidate) => sourceType(candidate) !== 'semantic');
    }
    decided.add(evaluation.id);
    if (evaluation.status === 'eligible') eligible.add(evaluation.id);
  }
  return candidates.filter((candidate) =>
    sourceType(candidate) !== 'semantic' || eligible.has(evidenceId(candidate)));
}
