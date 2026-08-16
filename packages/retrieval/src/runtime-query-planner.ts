import { types as nodeUtilTypes } from 'node:util';
import {
  QUERY_PLAN_CONTRACT_ID,
  QUERY_PLAN_CONTRACT_VERSION,
  QUERY_PLAN_MAX_HINTS_PER_KIND,
  parseQueryPlanV1,
  type QueryPlanV1,
} from './query-plan.js';

const SAFE_PROJECT_SCOPE = /^project:[a-z0-9][a-z0-9._-]*$/;
const SAFE_HINT = /^[A-Za-z0-9][A-Za-z0-9._/@:+-]*$/;
const RESERVED_AUTHORITY_HINT = /^(?:project|tenant):/i;
const MAX_PROJECT_SCOPE_LENGTH = 136;
const MAX_HINT_LENGTH = 200;

export class RuntimeQueryPlannerError extends Error {
  constructor(readonly code: 'invalid_request' | 'authentication_required' | 'unavailable' | 'resolution_failed') {
    super(`runtime_query_planner:${code}`);
    this.name = 'RuntimeQueryPlannerError';
  }
}

function invalidRequest(): never {
  throw new RuntimeQueryPlannerError('invalid_request');
}

function snapshotEntityHints(input: unknown): readonly string[] {
  try {
    if (typeof input !== 'object' || input === null || nodeUtilTypes.isProxy(input)
      || !Array.isArray(input) || Object.getPrototypeOf(input) !== Array.prototype) {
      return invalidRequest();
    }
    const lengthDescriptor = Object.getOwnPropertyDescriptor(input, 'length');
    if (!lengthDescriptor || !Object.prototype.hasOwnProperty.call(lengthDescriptor, 'value')
      || !Number.isSafeInteger(lengthDescriptor.value) || lengthDescriptor.value < 1
      || lengthDescriptor.value > QUERY_PLAN_MAX_HINTS_PER_KIND
      || Reflect.ownKeys(input).length !== lengthDescriptor.value + 1) {
      return invalidRequest();
    }
    const values: string[] = [];
    for (let index = 0; index < lengthDescriptor.value; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(input, String(index));
      if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')
        || descriptor.enumerable !== true || typeof descriptor.value !== 'string'
        || descriptor.value.length < 1 || descriptor.value.length > MAX_HINT_LENGTH
        || !SAFE_HINT.test(descriptor.value) || RESERVED_AUTHORITY_HINT.test(descriptor.value)) {
        return invalidRequest();
      }
      values.push(descriptor.value);
    }
    return Object.freeze([...new Set(values)].sort());
  } catch (error) {
    if (error instanceof RuntimeQueryPlannerError) throw error;
    return invalidRequest();
  }
}

/**
 * Build the unresolved V1 plan used by the authenticated MCP integration.
 * Only the closure-bound tenant and explicit canonical project are authority;
 * public entity_scope values remain non-authoritative resolver hints.
 */
export interface RuntimeQueryPlannerReceiptV1 {
  readonly plan: QueryPlanV1;
  readonly trustedProjectScopes: readonly [string];
}

export function buildRuntimeQueryPlannerReceiptV1(input: {
  tenantId: unknown;
  projectName: unknown;
  entityScope: unknown;
  asOf?: unknown;
}): RuntimeQueryPlannerReceiptV1 {
  try {
    if (typeof input !== 'object' || input === null || nodeUtilTypes.isProxy(input)
      || Array.isArray(input) || Object.getPrototypeOf(input) !== Object.prototype) {
      return invalidRequest();
    }
    const keys = Reflect.ownKeys(input);
    if (keys.length < 3 || keys.length > 4
      || keys.some((key) => typeof key !== 'string'
        || !['tenantId', 'projectName', 'entityScope', 'asOf'].includes(key))) {
      return invalidRequest();
    }
    const values = new Map<string, unknown>();
    for (const key of keys as string[]) {
      const descriptor = Object.getOwnPropertyDescriptor(input, key);
      if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')
        || descriptor.enumerable !== true) return invalidRequest();
      values.set(key, descriptor.value);
    }
    if (!values.has('tenantId') || !values.has('projectName') || !values.has('entityScope')) {
      return invalidRequest();
    }
    const tenantId = values.get('tenantId');
    const projectName = values.get('projectName');
    if (typeof tenantId !== 'string' || typeof projectName !== 'string'
      || projectName.length < 1 || projectName.length > MAX_PROJECT_SCOPE_LENGTH
      || !SAFE_PROJECT_SCOPE.test(projectName)) return invalidRequest();
    const entities = snapshotEntityHints(values.get('entityScope'));
    const temporalFrame = values.has('asOf') && values.get('asOf') !== undefined
      ? { mode: 'as-of' as const, asOf: values.get('asOf') }
      : { mode: 'current' as const };
    // Snapshot the authenticated caller's canonical project independently of
    // the parsed plan. The trusted resolver authority must never be recovered
    // from plan bytes, even though both values are intentionally equal.
    const trustedProjectScopes = Object.freeze([projectName]) as readonly [string];
    const plan = parseQueryPlanV1({
      contractId: QUERY_PLAN_CONTRACT_ID,
      contractVersion: QUERY_PLAN_CONTRACT_VERSION,
      authority: {
        tenantId,
        callerScopes: { projects: [projectName], repositories: [], entities: [], symbols: [] },
      },
      intent: 'HYBRID',
      temporalFrame,
      evidenceNeeds: ['memory'],
      hints: { source: 'task', repositories: [], entities, symbols: [] },
      resolution: { state: 'unresolved', canonicalEntityIds: [] },
    });
    return Object.freeze({ plan, trustedProjectScopes });
  } catch (error) {
    if (error instanceof RuntimeQueryPlannerError) throw error;
    return invalidRequest();
  }
}

export function buildRuntimeQueryPlanV1(input: {
  tenantId: unknown;
  projectName: unknown;
  entityScope: unknown;
  asOf?: unknown;
}): QueryPlanV1 {
  return buildRuntimeQueryPlannerReceiptV1(input).plan;
}
