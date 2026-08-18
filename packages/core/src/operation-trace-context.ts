import { types as nodeUtilTypes } from "node:util";

const OBJECT_CREATE = Object.create;
const OBJECT_DEFINE_PROPERTY = Object.defineProperty;
const OBJECT_FREEZE = Object.freeze;
const OBJECT_GET_PROTOTYPE_OF = Object.getPrototypeOf;
const OBJECT_GET_OWN_PROPERTY_DESCRIPTOR = Object.getOwnPropertyDescriptor;
const OBJECT_HAS_OWN = Object.hasOwn;
const OBJECT_PROTOTYPE = Object.prototype;
const ARRAY_IS_ARRAY = Array.isArray;
const REFLECT_OWN_KEYS = Reflect.ownKeys;
const NODE_IS_PROXY = nodeUtilTypes.isProxy;
const STRING_CHAR_CODE_AT = Function.prototype.call.bind(
  String.prototype.charCodeAt,
) as (input: string, index: number) => number;
const INTRINSIC_ERROR = Error;

export const OPERATION_TRACE_CONTEXT_CONTRACT_ID =
  "memberry.operation-trace-context" as const;
export const OPERATION_TRACE_CONTEXT_CONTRACT_VERSION = "1.0.0" as const;
export const OPERATION_TRACE_STAGES = OBJECT_FREEZE([
  "store",
  "extraction",
  "consolidation",
  "retrieval",
  "mutation",
  "wiki-publication",
] as const);

export type OperationTraceStageV1 = (typeof OPERATION_TRACE_STAGES)[number];
export type OperationTraceFlagsV1 = "00" | "01";

export interface OperationTraceContextV1 {
  readonly contractId: typeof OPERATION_TRACE_CONTEXT_CONTRACT_ID;
  readonly contractVersion: typeof OPERATION_TRACE_CONTEXT_CONTRACT_VERSION;
  readonly traceId: string;
  readonly spanId: string;
  readonly parentSpanId: string | null;
  readonly traceFlags: OperationTraceFlagsV1;
  readonly stage: OperationTraceStageV1;
}

export type OperationTraceContextContractErrorCodeV1 =
  "invalid-context" | "invalid-span-id" | "invalid-stage";

export class OperationTraceContextContractError extends INTRINSIC_ERROR {
  declare readonly code: OperationTraceContextContractErrorCodeV1;

  constructor(code: OperationTraceContextContractErrorCodeV1) {
    super(`operation_trace_context:${code}`);
    OBJECT_DEFINE_PROPERTY(this, "name", {
      value: "OperationTraceContextContractError",
      writable: true,
      enumerable: false,
      configurable: true,
    });
    OBJECT_DEFINE_PROPERTY(this, "code", {
      value: code,
      writable: false,
      enumerable: true,
      configurable: false,
    });
  }
}

class InvalidValue extends INTRINSIC_ERROR {}

const CONTEXT_KEYS = OBJECT_FREEZE([
  "contractId",
  "contractVersion",
  "traceId",
  "spanId",
  "parentSpanId",
  "traceFlags",
  "stage",
] as const);

function containsKey(keys: readonly string[], key: string): boolean {
  for (let index = 0; index < keys.length; index += 1) {
    if (keys[index] === key) return true;
  }
  return false;
}

function exactContextRecord(input: unknown): Record<string, unknown> {
  if (
    typeof input !== "object" ||
    input === null ||
    NODE_IS_PROXY(input) ||
    ARRAY_IS_ARRAY(input)
  )
    throw new InvalidValue();
  const prototype = OBJECT_GET_PROTOTYPE_OF(input);
  if (prototype !== OBJECT_PROTOTYPE && prototype !== null)
    throw new InvalidValue();
  const ownKeys = REFLECT_OWN_KEYS(input);
  if (ownKeys.length !== CONTEXT_KEYS.length) throw new InvalidValue();
  for (let index = 0; index < ownKeys.length; index += 1) {
    const key = ownKeys[index]!;
    if (typeof key !== "string" || !containsKey(CONTEXT_KEYS, key))
      throw new InvalidValue();
  }
  const snapshot = OBJECT_CREATE(null) as Record<string, unknown>;
  for (let index = 0; index < CONTEXT_KEYS.length; index += 1) {
    const key = CONTEXT_KEYS[index]!;
    const descriptor = OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(input, key);
    if (
      descriptor === undefined ||
      !OBJECT_HAS_OWN(descriptor, "value") ||
      descriptor.enumerable !== true
    )
      throw new InvalidValue();
    OBJECT_DEFINE_PROPERTY(snapshot, key, {
      value: descriptor.value,
      writable: true,
      enumerable: true,
      configurable: true,
    });
  }
  return snapshot;
}

function fixedLowerHex(input: unknown, length: number): string {
  if (typeof input !== "string" || input.length !== length)
    throw new InvalidValue();
  let nonzero = false;
  for (let index = 0; index < input.length; index += 1) {
    const code = STRING_CHAR_CODE_AT(input, index);
    const digit = code >= 48 && code <= 57;
    const lowerHexLetter = code >= 97 && code <= 102;
    if (!digit && !lowerHexLetter) throw new InvalidValue();
    if (code !== 48) nonzero = true;
  }
  if (!nonzero) throw new InvalidValue();
  return input;
}

function traceFlagsValue(input: unknown): OperationTraceFlagsV1 {
  if (input === "00" || input === "01") return input;
  throw new InvalidValue();
}

function stageValue(input: unknown): OperationTraceStageV1 {
  if (
    input === "store" ||
    input === "extraction" ||
    input === "consolidation" ||
    input === "retrieval" ||
    input === "mutation" ||
    input === "wiki-publication"
  )
    return input;
  throw new InvalidValue();
}

function defineField(
  record: Record<string, unknown>,
  key: string,
  value: unknown,
): void {
  OBJECT_DEFINE_PROPERTY(record, key, {
    value,
    writable: true,
    enumerable: true,
    configurable: true,
  });
}

function frozenContext(
  traceId: string,
  spanId: string,
  parentSpanId: string | null,
  traceFlags: OperationTraceFlagsV1,
  stage: OperationTraceStageV1,
): OperationTraceContextV1 {
  const result = OBJECT_CREATE(null) as Record<string, unknown>;
  defineField(result, "contractId", OPERATION_TRACE_CONTEXT_CONTRACT_ID);
  defineField(
    result,
    "contractVersion",
    OPERATION_TRACE_CONTEXT_CONTRACT_VERSION,
  );
  defineField(result, "traceId", traceId);
  defineField(result, "spanId", spanId);
  defineField(result, "parentSpanId", parentSpanId);
  defineField(result, "traceFlags", traceFlags);
  defineField(result, "stage", stage);
  return OBJECT_FREEZE(result) as unknown as OperationTraceContextV1;
}

function parseContext(input: unknown): OperationTraceContextV1 {
  const snapshot = exactContextRecord(input);
  if (
    snapshot.contractId !== OPERATION_TRACE_CONTEXT_CONTRACT_ID ||
    snapshot.contractVersion !== OPERATION_TRACE_CONTEXT_CONTRACT_VERSION
  )
    throw new InvalidValue();
  const traceId = fixedLowerHex(snapshot.traceId, 32);
  const spanId = fixedLowerHex(snapshot.spanId, 16);
  const parentSpanId =
    snapshot.parentSpanId === null
      ? null
      : fixedLowerHex(snapshot.parentSpanId, 16);
  if (parentSpanId === spanId) throw new InvalidValue();
  return frozenContext(
    traceId,
    spanId,
    parentSpanId,
    traceFlagsValue(snapshot.traceFlags),
    stageValue(snapshot.stage),
  );
}

export function parseOperationTraceContextV1(
  input: unknown,
): OperationTraceContextV1 {
  try {
    return parseContext(input);
  } catch {
    throw new OperationTraceContextContractError("invalid-context");
  }
}

function childSpanId(input: unknown): string {
  try {
    return fixedLowerHex(input, 16);
  } catch {
    throw new OperationTraceContextContractError("invalid-span-id");
  }
}

function childStage(input: unknown): OperationTraceStageV1 {
  try {
    return stageValue(input);
  } catch {
    throw new OperationTraceContextContractError("invalid-stage");
  }
}

export function deriveOperationTraceChildV1(
  parent: unknown,
  freshSpanId: unknown,
  stage: unknown,
): OperationTraceContextV1 {
  const parsedParent = parseOperationTraceContextV1(parent);
  const parsedSpanId = childSpanId(freshSpanId);
  if (
    parsedSpanId === parsedParent.spanId ||
    parsedSpanId === parsedParent.parentSpanId
  ) {
    throw new OperationTraceContextContractError("invalid-span-id");
  }
  const parsedStage = childStage(stage);
  return frozenContext(
    parsedParent.traceId,
    parsedSpanId,
    parsedParent.spanId,
    parsedParent.traceFlags,
    parsedStage,
  );
}

export function formatOperationTraceparentV1(input: unknown): string {
  const parsed = parseOperationTraceContextV1(input);
  return `00-${parsed.traceId}-${parsed.spanId}-${parsed.traceFlags}`;
}
