import { isProxy } from 'node:util/types';

type JsonRecord = Record<string, unknown>;

const STATUS_KEYS = [
  'schema_version', 'affects_readiness', 'history_scope', 'history_complete',
  'counters_saturated', 'caller_type_known', 'content_captured', 'identity_captured',
  'calls', 'routing', 'resolution',
] as const;
const CALL_KEYS = ['total', 'berry_context', 'berry_ask'] as const;
const ROUTING_KEYS = ['unanchored', 'anchored_legacy', 'anchored_resolver'] as const;
const FAILURE_KEYS = [
  'invalid_request', 'resolution_failed', 'authentication_required', 'unavailable', 'other_failure',
] as const;
const COUNTER_KEYS = ['attempted', 'resolved', 'failed', ...FAILURE_KEYS] as const;
const RESOLUTION_KEYS = [...COUNTER_KEYS, 'success_rate'] as const;

function record(value: unknown): JsonRecord | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && !isProxy(value)
    ? value as JsonRecord
    : undefined;
}

function exactKeys(value: JsonRecord, expected: readonly string[]): boolean {
  try {
    const keys = Reflect.ownKeys(value);
    return keys.length === expected.length
      && keys.every((key) => typeof key === 'string' && expected.includes(key));
  } catch {
    return false;
  }
}

function nonnegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function saturatedSum(values: readonly number[]): number {
  return values.reduce((total, value) => Math.min(Number.MAX_SAFE_INTEGER, total + value), 0);
}

/** Closed, content-free contract shared by every live /readyz evidence consumer. */
export function hasClosedRetrievalResolutionStatusV1(value: unknown): boolean {
  const status = record(value);
  if (!status) return false;
  const calls = record(status.calls);
  const routing = record(status.routing);
  const resolution = record(status.resolution);
  if (!calls || !routing || !resolution
    || !exactKeys(status, STATUS_KEYS)
    || !exactKeys(calls, CALL_KEYS)
    || !exactKeys(routing, ROUTING_KEYS)
    || !exactKeys(resolution, RESOLUTION_KEYS)
    || CALL_KEYS.some((key) => !nonnegativeSafeInteger(calls[key]))
    || ROUTING_KEYS.some((key) => !nonnegativeSafeInteger(routing[key]))
    || COUNTER_KEYS.some((key) => !nonnegativeSafeInteger(resolution[key]))) return false;

  const callValues = CALL_KEYS.map((key) => calls[key] as number);
  const routeValues = ROUTING_KEYS.map((key) => routing[key] as number);
  const failureValues = FAILURE_KEYS.map((key) => resolution[key] as number);
  const attempted = resolution.attempted as number;
  const resolved = resolution.resolved as number;
  return status.schema_version === 1
    && status.affects_readiness === false
    && status.history_scope === 'process-lifetime'
    && status.history_complete === false
    && typeof status.counters_saturated === 'boolean'
    && status.caller_type_known === false
    && status.content_captured === false
    && status.identity_captured === false
    && callValues[0] === saturatedSum(callValues.slice(1))
    && callValues[0] === saturatedSum(routeValues)
    && resolution.failed === saturatedSum(failureValues)
    && attempted === saturatedSum([resolved, resolution.failed as number])
    && Object.is(resolution.success_rate, attempted === 0 ? null : resolved / attempted);
}
