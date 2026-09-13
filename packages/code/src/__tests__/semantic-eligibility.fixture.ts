import { vi } from 'vitest';

export function allowEligibleSemantics() {
  return {
    evaluateActiveEligibility: vi.fn(async ({ semanticIds }: { semanticIds: unknown }) =>
      (semanticIds as string[]).map((id) => ({ id, status: 'eligible' as const }))),
  };
}
