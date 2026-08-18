import { Buffer as NodeBuffer } from 'node:buffer';
import { types as nodeUtilTypes } from 'node:util';

const OBJECT_CREATE = Object.create;
const OBJECT_DEFINE_PROPERTY = Object.defineProperty;
const OBJECT_FREEZE = Object.freeze;
const OBJECT_GET_PROTOTYPE_OF = Object.getPrototypeOf;
const OBJECT_GET_OWN_PROPERTY_DESCRIPTOR = Object.getOwnPropertyDescriptor;
const OBJECT_HAS_OWN = Object.hasOwn;
const OBJECT_PROTOTYPE = Object.prototype;
const ARRAY_IS_ARRAY = Array.isArray;
const ARRAY_PROTOTYPE = Array.prototype;
const REFLECT_OWN_KEYS = Reflect.ownKeys;
const NODE_IS_PROXY = nodeUtilTypes.isProxy;
const BUFFER_BYTE_LENGTH = NodeBuffer.byteLength;
const INTRINSIC_STRING = String;
const STRING_CHAR_CODE_AT = Function.prototype.call.bind(String.prototype.charCodeAt) as (
  input: string,
  index: number,
) => number;
const INTRINSIC_MAP = Map;
const MAP_GET = Function.prototype.call.bind(Map.prototype.get) as <K, V>(
  map: Map<K, V>,
  key: K,
) => V | undefined;
const MAP_SET = Function.prototype.call.bind(Map.prototype.set) as <K, V>(
  map: Map<K, V>,
  key: K,
  value: V,
) => Map<K, V>;
const MAP_HAS = Function.prototype.call.bind(Map.prototype.has) as <K, V>(
  map: Map<K, V>,
  key: K,
) => boolean;
const INTRINSIC_WEAK_SET = WeakSet;
const WEAK_SET_HAS = Function.prototype.call.bind(WeakSet.prototype.has) as (
  set: WeakSet<object>,
  value: object,
) => boolean;
const WEAK_SET_ADD = Function.prototype.call.bind(WeakSet.prototype.add) as (
  set: WeakSet<object>,
  value: object,
) => WeakSet<object>;
const INTRINSIC_ERROR = Error;

export const CAPABILITY_POLICY_CONTRACT_ID = 'memberry.capability-policy' as const;
export const CAPABILITY_POLICY_CONTRACT_VERSION = '1.0.0' as const;
export const CAPABILITY_POLICY_MAX_GRANTS = 128 as const;
export const CAPABILITY_POLICY_MAX_ACTOR_ID_BYTES = 200 as const;
export const CAPABILITY_POLICY_MAX_TENANT_ID_BYTES = 200 as const;
export const CAPABILITY_POLICY_MAX_PROJECT_ID_BYTES = 200 as const;
export const CAPABILITY_POLICY_MAX_DOMAIN_ID_BYTES = 128 as const;
export const CAPABILITY_POLICY_MAX_TOOL_ID_BYTES = 128 as const;

export type CapabilityOperationV1 = 'read' | 'create' | 'update' | 'delete' | 'admin';

export type CapabilityScopeV1 =
  | { readonly kind: 'tenant' }
  | { readonly kind: 'project'; readonly projectId: string };

export interface ActorCapabilityGrantV1 {
  readonly scope: CapabilityScopeV1;
  readonly domainId: string;
  readonly toolId: string;
  readonly operation: CapabilityOperationV1;
}

export interface ActorCapabilityPolicyV1 {
  readonly contractId: typeof CAPABILITY_POLICY_CONTRACT_ID;
  readonly contractVersion: typeof CAPABILITY_POLICY_CONTRACT_VERSION;
  readonly actorId: string;
  readonly tenantId: string;
  readonly grants: readonly ActorCapabilityGrantV1[];
}

export interface CapabilityCheckRequestV1 {
  readonly contractId: typeof CAPABILITY_POLICY_CONTRACT_ID;
  readonly contractVersion: typeof CAPABILITY_POLICY_CONTRACT_VERSION;
  readonly actorId: string;
  readonly tenantId: string;
  readonly scope: CapabilityScopeV1;
  readonly domainId: string;
  readonly toolId: string;
  readonly operation: CapabilityOperationV1;
}

export interface CapabilityEvaluationResultV1 {
  readonly allowed: boolean;
  readonly reason: 'allowed' | 'denied';
}

export type CapabilityPolicyContractErrorCodeV1 =
  | 'invalid-policy'
  | 'invalid-request'
  | 'budget-exceeded';

export class CapabilityPolicyContractError extends INTRINSIC_ERROR {
  declare readonly code: CapabilityPolicyContractErrorCodeV1;

  constructor(code: CapabilityPolicyContractErrorCodeV1) {
    super(`capability_policy_contract:${code}`);
    OBJECT_DEFINE_PROPERTY(this, 'name', {
      value: 'CapabilityPolicyContractError',
      writable: true,
      enumerable: false,
      configurable: true,
    });
    OBJECT_DEFINE_PROPERTY(this, 'code', {
      value: code,
      writable: false,
      enumerable: true,
      configurable: false,
    });
  }
}

class InvalidValue extends INTRINSIC_ERROR {}
class BudgetExceeded extends INTRINSIC_ERROR {}

interface ParseState {
  readonly seen: WeakSet<object>;
}

interface EnteredRecord {
  readonly snapshot: Record<string, unknown>;
  readonly keyCount: number;
}

type OperationMap = Map<CapabilityOperationV1, true>;
type ToolMap = Map<string, OperationMap>;
type DomainMap = Map<string, ToolMap>;
type ProjectMap = Map<string, DomainMap>;

interface GrantIndex {
  readonly tenant: DomainMap;
  readonly projects: ProjectMap;
}

const POLICY_KEYS = OBJECT_FREEZE([
  'contractId', 'contractVersion', 'actorId', 'tenantId', 'grants',
] as const);
const GRANT_KEYS = OBJECT_FREEZE(['scope', 'domainId', 'toolId', 'operation'] as const);
const REQUEST_KEYS = OBJECT_FREEZE([
  'contractId', 'contractVersion', 'actorId', 'tenantId', 'scope', 'domainId', 'toolId', 'operation',
] as const);
const SCOPE_KEYS = OBJECT_FREEZE(['kind', 'projectId'] as const);
const TENANT_SCOPE_KEYS = OBJECT_FREEZE(['kind'] as const);
const PROJECT_SCOPE_KEYS = OBJECT_FREEZE(['kind', 'projectId'] as const);
const ARRAY_INDEX_KEYS: string[] = [];
for (let index = 0; index < CAPABILITY_POLICY_MAX_GRANTS; index += 1) {
  OBJECT_DEFINE_PROPERTY(ARRAY_INDEX_KEYS, index, {
    value: INTRINSIC_STRING(index),
    writable: true,
    enumerable: true,
    configurable: true,
  });
}
OBJECT_FREEZE(ARRAY_INDEX_KEYS);

function frozenTenantScope(): CapabilityScopeV1 {
  const result = OBJECT_CREATE(null) as { kind: 'tenant' };
  result.kind = 'tenant';
  return OBJECT_FREEZE(result);
}

function frozenProjectScope(projectId: string): CapabilityScopeV1 {
  const result = OBJECT_CREATE(null) as { kind: 'project'; projectId: string };
  result.kind = 'project';
  result.projectId = projectId;
  return OBJECT_FREEZE(result);
}

function frozenGrant(
  scope: CapabilityScopeV1,
  domainId: string,
  toolId: string,
  operation: CapabilityOperationV1,
): ActorCapabilityGrantV1 {
  const result = OBJECT_CREATE(null) as {
    scope: CapabilityScopeV1;
    domainId: string;
    toolId: string;
    operation: CapabilityOperationV1;
  };
  result.scope = scope;
  result.domainId = domainId;
  result.toolId = toolId;
  result.operation = operation;
  return OBJECT_FREEZE(result);
}

function frozenPolicy(
  actorId: string,
  tenantId: string,
  grants: readonly ActorCapabilityGrantV1[],
): ActorCapabilityPolicyV1 {
  const result = OBJECT_CREATE(null) as {
    contractId: typeof CAPABILITY_POLICY_CONTRACT_ID;
    contractVersion: typeof CAPABILITY_POLICY_CONTRACT_VERSION;
    actorId: string;
    tenantId: string;
    grants: readonly ActorCapabilityGrantV1[];
  };
  result.contractId = CAPABILITY_POLICY_CONTRACT_ID;
  result.contractVersion = CAPABILITY_POLICY_CONTRACT_VERSION;
  result.actorId = actorId;
  result.tenantId = tenantId;
  result.grants = grants;
  return OBJECT_FREEZE(result);
}

function frozenRequest(
  actorId: string,
  tenantId: string,
  scope: CapabilityScopeV1,
  domainId: string,
  toolId: string,
  operation: CapabilityOperationV1,
): CapabilityCheckRequestV1 {
  const result = OBJECT_CREATE(null) as {
    contractId: typeof CAPABILITY_POLICY_CONTRACT_ID;
    contractVersion: typeof CAPABILITY_POLICY_CONTRACT_VERSION;
    actorId: string;
    tenantId: string;
    scope: CapabilityScopeV1;
    domainId: string;
    toolId: string;
    operation: CapabilityOperationV1;
  };
  result.contractId = CAPABILITY_POLICY_CONTRACT_ID;
  result.contractVersion = CAPABILITY_POLICY_CONTRACT_VERSION;
  result.actorId = actorId;
  result.tenantId = tenantId;
  result.scope = scope;
  result.domainId = domainId;
  result.toolId = toolId;
  result.operation = operation;
  return OBJECT_FREEZE(result);
}

function frozenResult(allowed: boolean, reason: 'allowed' | 'denied'): CapabilityEvaluationResultV1 {
  const result = OBJECT_CREATE(null) as { allowed: boolean; reason: 'allowed' | 'denied' };
  result.allowed = allowed;
  result.reason = reason;
  return OBJECT_FREEZE(result);
}

const ALLOWED_RESULT = frozenResult(true, 'allowed');
const DENIED_RESULT = frozenResult(false, 'denied');

function freshState(): ParseState {
  return { seen: new INTRINSIC_WEAK_SET<object>() };
}

function containsKey(keys: readonly string[], key: string): boolean {
  for (let index = 0; index < keys.length; index += 1) {
    if (keys[index] === key) return true;
  }
  return false;
}

function enterRecord(
  input: unknown,
  allowedKeys: readonly string[],
  requiredKeys: readonly string[],
  state: ParseState,
): EnteredRecord {
  if (typeof input !== 'object' || input === null || NODE_IS_PROXY(input) || ARRAY_IS_ARRAY(input)) {
    throw new InvalidValue();
  }
  const prototype = OBJECT_GET_PROTOTYPE_OF(input);
  if (prototype !== OBJECT_PROTOTYPE && prototype !== null) throw new InvalidValue();
  if (WEAK_SET_HAS(state.seen, input)) throw new InvalidValue();
  WEAK_SET_ADD(state.seen, input);

  const ownKeys = REFLECT_OWN_KEYS(input);
  if (ownKeys.length < requiredKeys.length || ownKeys.length > allowedKeys.length) throw new InvalidValue();
  const snapshot = OBJECT_CREATE(null) as Record<string, unknown>;
  for (let index = 0; index < ownKeys.length; index += 1) {
    const key = ownKeys[index]!;
    if (typeof key !== 'string' || !containsKey(allowedKeys, key)) throw new InvalidValue();
  }
  for (let index = 0; index < requiredKeys.length; index += 1) {
    const key = requiredKeys[index]!;
    const descriptor = OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(input, key);
    if (descriptor === undefined
      || !OBJECT_HAS_OWN(descriptor, 'value')
      || descriptor.enumerable !== true) throw new InvalidValue();
    snapshot[key] = descriptor.value;
  }
  for (let index = 0; index < allowedKeys.length; index += 1) {
    const key = allowedKeys[index]!;
    if (OBJECT_HAS_OWN(snapshot, key)) continue;
    const descriptor = OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(input, key);
    if (descriptor === undefined) continue;
    if (!OBJECT_HAS_OWN(descriptor, 'value') || descriptor.enumerable !== true) throw new InvalidValue();
    snapshot[key] = descriptor.value;
  }
  return { snapshot, keyCount: ownKeys.length };
}

function requireExactVariant(entered: EnteredRecord, keys: readonly string[]): void {
  if (entered.keyCount !== keys.length) throw new InvalidValue();
  for (let index = 0; index < keys.length; index += 1) {
    if (!OBJECT_HAS_OWN(entered.snapshot, keys[index]!)) throw new InvalidValue();
  }
}

function isAsciiAlphaNumeric(code: number): boolean {
  return (code >= 48 && code <= 57)
    || (code >= 65 && code <= 90)
    || (code >= 97 && code <= 122);
}

function safeIdentifier(input: unknown, maxBytes: number): string {
  if (typeof input !== 'string') throw new InvalidValue();
  if (input.length > maxBytes) throw new BudgetExceeded();
  const byteLength = BUFFER_BYTE_LENGTH(input, 'utf8');
  if (byteLength > maxBytes) throw new BudgetExceeded();
  if (input.length === 0) throw new InvalidValue();
  const first = STRING_CHAR_CODE_AT(input, 0);
  const last = STRING_CHAR_CODE_AT(input, input.length - 1);
  if (!isAsciiAlphaNumeric(first) || !isAsciiAlphaNumeric(last)) throw new InvalidValue();
  for (let index = 1; index + 1 < input.length; index += 1) {
    const code = STRING_CHAR_CODE_AT(input, index);
    if (!isAsciiAlphaNumeric(code)
      && code !== 45
      && code !== 46
      && code !== 58
      && code !== 64
      && code !== 95) throw new InvalidValue();
  }
  return input;
}

function operationValue(input: unknown): CapabilityOperationV1 {
  if (input === 'read'
    || input === 'create'
    || input === 'update'
    || input === 'delete'
    || input === 'admin') return input;
  throw new InvalidValue();
}

function scopeValue(input: unknown, state: ParseState): CapabilityScopeV1 {
  const entered = enterRecord(input, SCOPE_KEYS, TENANT_SCOPE_KEYS, state);
  const kind = entered.snapshot.kind;
  if (kind === 'tenant') {
    requireExactVariant(entered, TENANT_SCOPE_KEYS);
    return frozenTenantScope();
  }
  if (kind === 'project') {
    requireExactVariant(entered, PROJECT_SCOPE_KEYS);
    return frozenProjectScope(safeIdentifier(
      entered.snapshot.projectId,
      CAPABILITY_POLICY_MAX_PROJECT_ID_BYTES,
    ));
  }
  throw new InvalidValue();
}

function grantValue(input: unknown, state: ParseState): ActorCapabilityGrantV1 {
  const entered = enterRecord(input, GRANT_KEYS, GRANT_KEYS, state);
  return frozenGrant(
    scopeValue(entered.snapshot.scope, state),
    safeIdentifier(entered.snapshot.domainId, CAPABILITY_POLICY_MAX_DOMAIN_ID_BYTES),
    safeIdentifier(entered.snapshot.toolId, CAPABILITY_POLICY_MAX_TOOL_ID_BYTES),
    operationValue(entered.snapshot.operation),
  );
}

function denseGrantArray(input: unknown, state: ParseState): readonly ActorCapabilityGrantV1[] {
  if (typeof input !== 'object' || input === null || NODE_IS_PROXY(input) || !ARRAY_IS_ARRAY(input)) {
    throw new InvalidValue();
  }
  if (OBJECT_GET_PROTOTYPE_OF(input) !== ARRAY_PROTOTYPE) throw new InvalidValue();
  if (WEAK_SET_HAS(state.seen, input)) throw new InvalidValue();
  WEAK_SET_ADD(state.seen, input);

  const lengthDescriptor = OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(input, 'length');
  if (lengthDescriptor === undefined
    || !OBJECT_HAS_OWN(lengthDescriptor, 'value')
    || typeof lengthDescriptor.value !== 'number'
    || lengthDescriptor.value < 0
    || lengthDescriptor.value % 1 !== 0
    || lengthDescriptor.enumerable !== false
    || lengthDescriptor.configurable !== false) throw new InvalidValue();
  const length = lengthDescriptor.value;
  if (length > CAPABILITY_POLICY_MAX_GRANTS) throw new BudgetExceeded();
  const ownKeys = REFLECT_OWN_KEYS(input);
  if (ownKeys.length !== length + 1) throw new InvalidValue();

  const result: ActorCapabilityGrantV1[] = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(input, ARRAY_INDEX_KEYS[index]!);
    if (descriptor === undefined
      || !OBJECT_HAS_OWN(descriptor, 'value')
      || descriptor.enumerable !== true) throw new InvalidValue();
    OBJECT_DEFINE_PROPERTY(result, index, {
      value: grantValue(descriptor.value, state),
      writable: true,
      enumerable: true,
      configurable: true,
    });
  }
  return OBJECT_FREEZE(result);
}

function newGrantIndex(): GrantIndex {
  return {
    tenant: new INTRINSIC_MAP<string, ToolMap>(),
    projects: new INTRINSIC_MAP<string, DomainMap>(),
  };
}

function addDomainGrant(
  domains: DomainMap,
  domainId: string,
  toolId: string,
  operation: CapabilityOperationV1,
): boolean {
  let tools = MAP_GET(domains, domainId);
  if (tools === undefined) {
    tools = new INTRINSIC_MAP<string, OperationMap>();
    MAP_SET(domains, domainId, tools);
  }
  let operations = MAP_GET(tools, toolId);
  if (operations === undefined) {
    operations = new INTRINSIC_MAP<CapabilityOperationV1, true>();
    MAP_SET(tools, toolId, operations);
  }
  if (MAP_HAS(operations, operation)) return false;
  MAP_SET(operations, operation, true);
  return true;
}

function addGrant(index: GrantIndex, grant: ActorCapabilityGrantV1): boolean {
  if (grant.scope.kind === 'tenant') {
    return addDomainGrant(index.tenant, grant.domainId, grant.toolId, grant.operation);
  }
  let domains = MAP_GET(index.projects, grant.scope.projectId);
  if (domains === undefined) {
    domains = new INTRINSIC_MAP<string, ToolMap>();
    MAP_SET(index.projects, grant.scope.projectId, domains);
  }
  return addDomainGrant(domains, grant.domainId, grant.toolId, grant.operation);
}

function hasDomainGrant(
  domains: DomainMap | undefined,
  domainId: string,
  toolId: string,
  operation: CapabilityOperationV1,
): boolean {
  if (domains === undefined) return false;
  const tools = MAP_GET(domains, domainId);
  if (tools === undefined) return false;
  const operations = MAP_GET(tools, toolId);
  return operations !== undefined && MAP_HAS(operations, operation);
}

function parsePolicy(input: unknown): ActorCapabilityPolicyV1 {
  const state = freshState();
  const entered = enterRecord(input, POLICY_KEYS, POLICY_KEYS, state);
  if (entered.snapshot.contractId !== CAPABILITY_POLICY_CONTRACT_ID
    || entered.snapshot.contractVersion !== CAPABILITY_POLICY_CONTRACT_VERSION) throw new InvalidValue();
  const actorId = safeIdentifier(entered.snapshot.actorId, CAPABILITY_POLICY_MAX_ACTOR_ID_BYTES);
  const tenantId = safeIdentifier(entered.snapshot.tenantId, CAPABILITY_POLICY_MAX_TENANT_ID_BYTES);
  const grants = denseGrantArray(entered.snapshot.grants, state);
  const uniqueness = newGrantIndex();
  for (let index = 0; index < grants.length; index += 1) {
    if (!addGrant(uniqueness, grants[index]!)) throw new InvalidValue();
  }
  return frozenPolicy(actorId, tenantId, grants);
}

function parseRequest(input: unknown): CapabilityCheckRequestV1 {
  const state = freshState();
  const entered = enterRecord(input, REQUEST_KEYS, REQUEST_KEYS, state);
  if (entered.snapshot.contractId !== CAPABILITY_POLICY_CONTRACT_ID
    || entered.snapshot.contractVersion !== CAPABILITY_POLICY_CONTRACT_VERSION) throw new InvalidValue();
  return frozenRequest(
    safeIdentifier(entered.snapshot.actorId, CAPABILITY_POLICY_MAX_ACTOR_ID_BYTES),
    safeIdentifier(entered.snapshot.tenantId, CAPABILITY_POLICY_MAX_TENANT_ID_BYTES),
    scopeValue(entered.snapshot.scope, state),
    safeIdentifier(entered.snapshot.domainId, CAPABILITY_POLICY_MAX_DOMAIN_ID_BYTES),
    safeIdentifier(entered.snapshot.toolId, CAPABILITY_POLICY_MAX_TOOL_ID_BYTES),
    operationValue(entered.snapshot.operation),
  );
}

function isPrivateError(error: unknown, prototype: object): boolean {
  return typeof error === 'object'
    && error !== null
    && !NODE_IS_PROXY(error)
    && OBJECT_GET_PROTOTYPE_OF(error) === prototype;
}

export function parseActorCapabilityPolicyV1(input: unknown): ActorCapabilityPolicyV1 {
  try {
    return parsePolicy(input);
  } catch (error) {
    throw new CapabilityPolicyContractError(
      isPrivateError(error, BudgetExceeded.prototype) ? 'budget-exceeded' : 'invalid-policy',
    );
  }
}

export function parseCapabilityCheckRequestV1(input: unknown): CapabilityCheckRequestV1 {
  try {
    return parseRequest(input);
  } catch (error) {
    throw new CapabilityPolicyContractError(
      isPrivateError(error, BudgetExceeded.prototype) ? 'budget-exceeded' : 'invalid-request',
    );
  }
}

export function evaluateCapabilityV1(policy: unknown, request: unknown): CapabilityEvaluationResultV1 {
  const parsedPolicy = parseActorCapabilityPolicyV1(policy);
  const parsedRequest = parseCapabilityCheckRequestV1(request);
  if (parsedPolicy.actorId !== parsedRequest.actorId || parsedPolicy.tenantId !== parsedRequest.tenantId) {
    return DENIED_RESULT;
  }

  const index = newGrantIndex();
  for (let grantIndex = 0; grantIndex < parsedPolicy.grants.length; grantIndex += 1) {
    addGrant(index, parsedPolicy.grants[grantIndex]!);
  }
  if (hasDomainGrant(index.tenant, parsedRequest.domainId, parsedRequest.toolId, parsedRequest.operation)) {
    return ALLOWED_RESULT;
  }
  if (parsedRequest.scope.kind === 'project'
    && hasDomainGrant(
      MAP_GET(index.projects, parsedRequest.scope.projectId),
      parsedRequest.domainId,
      parsedRequest.toolId,
      parsedRequest.operation,
    )) return ALLOWED_RESULT;
  return DENIED_RESULT;
}
