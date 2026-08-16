import { isInt } from 'neo4j-driver';

/** Normalize Neo4j's lossless integer representation at the trusted record boundary. */
export function normalizeSemanticSignalCount(value: unknown): number {
  let normalized: number;
  if (typeof value === 'number') {
    normalized = value;
  } else if (isInt(value) && value.inSafeRange()) {
    normalized = value.toNumber();
  } else {
    throw new TypeError('Invalid Semantic signal_count');
  }

  if (!Number.isSafeInteger(normalized) || normalized < 0) {
    throw new TypeError('Invalid Semantic signal_count');
  }
  return normalized;
}
