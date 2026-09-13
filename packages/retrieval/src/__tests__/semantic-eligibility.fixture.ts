import type { SemanticEligibilityAuthority } from '../semantic-eligibility-adapter.js';

export const allowAllSemanticEligibility: SemanticEligibilityAuthority = Object.freeze({
  evaluateActiveEligibility: async ({ semanticIds }) =>
    semanticIds.map((id) => ({ id, status: 'eligible' as const })),
});
