// Shared, constant-time preflight for direct retrieval query inputs. This uses
// JavaScript code units (`string.length`) deliberately: it rejects before any
// normalization, Unicode traversal, regex work, provider call, or coercion.

export const MAX_QUERY_INPUT_CODE_UNITS = 5_000;
export const MAX_FEEDBACK_QUERY_INPUT_CODE_UNITS = 2_000;

const QUERY_INPUT_INVALID = 'query_input_invalid';
const QUERY_INPUT_TOO_LARGE = 'query_input_too_large';

export function queryInputCodeUnits(value: unknown): number {
  if (typeof value !== 'string') throw new Error(QUERY_INPUT_INVALID);
  return value.length;
}

export function assertBoundedQueryInput(
  value: unknown,
  maxCodeUnits = MAX_QUERY_INPUT_CODE_UNITS,
): asserts value is string {
  if (queryInputCodeUnits(value) > maxCodeUnits) {
    throw new Error(QUERY_INPUT_TOO_LARGE);
  }
}
