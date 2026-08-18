import { createHash } from "node:crypto";
import { types as nodeUtilTypes } from "node:util";

import {
  assertRetrievalTraceSecretSafe,
  replayRetrievalTrace,
  type RetrievalTraceCandidateV1,
  type RetrievalTraceChannelStateV1,
  type RetrievalTraceEvidenceStateV1,
  type RetrievalTraceMmrPairwiseV1,
  type RetrievalTraceMmrRecordV1,
  type RetrievalTraceRequestShapeV1,
  type RetrievalTraceStageEventV1,
  type RetrievalTraceTerminalExclusionV1,
  type RetrievalTraceV1,
} from "./trace.js";

export const RETRIEVAL_EXPLANATION_VIEW_CONTRACT_ID =
  "memberry.retrieval-explanation-view" as const;
export const RETRIEVAL_EXPLANATION_VIEW_CONTRACT_VERSION = "1.0.0" as const;
export const RETRIEVAL_EXPLANATION_TEXT_MAX_UTF8_BYTES = 8 * 1024 * 1024;

const GLOBAL_THIS = globalThis;
const ARRAY_CONSTRUCTOR = Array;
const ARRAY_IS_ARRAY = Array.isArray;
const ARRAY_PROTOTYPE = Array.prototype;
const ARRAY_ITERATOR = Array.prototype[Symbol.iterator];
const BUFFER_CONSTRUCTOR = Buffer;
const BUFFER_BYTE_LENGTH = Buffer.byteLength;
const CREATE_HASH = createHash;
const ERROR_CONSTRUCTOR = Error;
const JSON_OBJECT = JSON;
const MAP_CONSTRUCTOR = Map;
const MAP_PROTOTYPE = Map.prototype;
const MATH_OBJECT = Math;
const NUMBER_CONSTRUCTOR = Number;
const NUMBER_IS_FINITE = Number.isFinite;
const NUMBER_IS_SAFE_INTEGER = Number.isSafeInteger;
const NUMBER_PROTOTYPE = Number.prototype;
const NUMBER_TO_STRING = Number.prototype.toString;
const OBJECT_CONSTRUCTOR = Object;
const OBJECT_CREATE = Object.create;
const OBJECT_DEFINE_PROPERTY = Object.defineProperty;
const OBJECT_FREEZE = Object.freeze;
const OBJECT_GET_OWN_PROPERTY_DESCRIPTOR = Object.getOwnPropertyDescriptor;
const OBJECT_GET_PROTOTYPE_OF = Object.getPrototypeOf;
const OBJECT_IS = Object.is;
const OBJECT_PROTOTYPE = Object.prototype;
const REFLECT_OBJECT = Reflect;
const REFLECT_APPLY = Reflect.apply;
const REFLECT_OWN_KEYS = Reflect.ownKeys;
const REGEXP_PROTOTYPE = RegExp.prototype;
const SET_CONSTRUCTOR = Set;
const SET_PROTOTYPE = Set.prototype;
const SET_ITERATOR = Set.prototype[Symbol.iterator];
const STRING_CONSTRUCTOR = String;
const STRING_CHAR_CODE_AT = String.prototype.charCodeAt;
const STRING_PROTOTYPE = String.prototype;
const WEAK_SET_CONSTRUCTOR = WeakSet;
const WEAK_SET_PROTOTYPE = WeakSet.prototype;
const WEAK_SET_ADD = WeakSet.prototype.add;
const WEAK_SET_HAS = WeakSet.prototype.has;
const NODE_IS_PROXY = nodeUtilTypes.isProxy;
const NODE_UTIL_TYPES = nodeUtilTypes;
const HASH_PROTOTYPE = OBJECT_GET_PROTOTYPE_OF(CREATE_HASH("sha256"));
const ARRAY_ITERATOR_PROTOTYPE = OBJECT_GET_PROTOTYPE_OF(
  REFLECT_APPLY(ARRAY_ITERATOR, [], []),
);
const SET_ITERATOR_PROTOTYPE = OBJECT_GET_PROTOTYPE_OF(
  REFLECT_APPLY(SET_ITERATOR, new SET_CONSTRUCTOR(), []),
);
const MAP_ITERATOR_PROTOTYPE = OBJECT_GET_PROTOTYPE_OF(
  new MAP_CONSTRUCTOR().entries(),
);
const ASSERT_TRACE_SECRET_SAFE: (
  value: unknown,
) => asserts value is RetrievalTraceV1 = assertRetrievalTraceSecretSafe;
const REPLAY_TRACE = replayRetrievalTrace;

const MAX_VIEW_GRAPH_ENTRIES = 200_000;
const MAX_VIEW_GRAPH_DEPTH = 24;
const MAX_VIEW_GRAPH_SCALAR_UTF8_BYTES = 4 * 1024 * 1024;

type TraceEvent = RetrievalTraceStageEventV1;

export type RetrievalExplanationReplayReceiptV1 =
  | {
      readonly replayable: true;
      readonly resultOrder: readonly string[];
      readonly terminalExclusions: readonly RetrievalTraceTerminalExclusionV1[];
      readonly replayStateDigest: string;
    }
  | {
      readonly replayable: false;
      readonly incompleteReasons: RetrievalTraceV1["incompleteReasons"];
      readonly replayStateDigest: string;
    };

export interface RetrievalExplanationViewV1 {
  readonly contractId: typeof RETRIEVAL_EXPLANATION_VIEW_CONTRACT_ID;
  readonly contractVersion: typeof RETRIEVAL_EXPLANATION_VIEW_CONTRACT_VERSION;
  readonly traceSchemaVersion: RetrievalTraceV1["schemaVersion"];
  readonly algorithmVersion: RetrievalTraceV1["algorithmVersion"];
  readonly requestShape: RetrievalTraceRequestShapeV1;
  readonly complete: boolean;
  readonly incompleteReasons: RetrievalTraceV1["incompleteReasons"];
  readonly candidates: readonly RetrievalTraceCandidateV1[];
  readonly events: readonly RetrievalTraceStageEventV1[];
  readonly replayReceipt: RetrievalExplanationReplayReceiptV1;
}

export type RetrievalExplanationViewErrorCode =
  "invalid-trace" | "invalid-view" | "text-budget-exceeded";

export class RetrievalExplanationViewContractError extends ERROR_CONSTRUCTOR {
  readonly code!: RetrievalExplanationViewErrorCode;

  constructor(code: RetrievalExplanationViewErrorCode) {
    super(`Retrieval explanation view contract error: ${code}`);
    OBJECT_DEFINE_PROPERTY(this, "name", {
      value: "RetrievalExplanationViewContractError",
      enumerable: false,
      writable: true,
      configurable: true,
    });
    OBJECT_DEFINE_PROPERTY(this, "code", {
      value: code,
      enumerable: true,
      writable: false,
      configurable: false,
    });
  }
}

type MutableRecord = Record<string, unknown>;

function createRecord(): MutableRecord {
  return OBJECT_CREATE(null) as MutableRecord;
}

function defineField(record: MutableRecord, key: string, value: unknown): void {
  OBJECT_DEFINE_PROPERTY(record, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

function finishRecord<T>(record: MutableRecord): T {
  return OBJECT_FREEZE(record) as T;
}

function createDenseArray<T>(length: number): T[] {
  return new ARRAY_CONSTRUCTOR<T>(length);
}

function defineArrayItem<T>(target: T[], index: number, value: T): void {
  OBJECT_DEFINE_PROPERTY(target, index, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

function copyArray<T, U>(
  source: readonly T[],
  copy: (value: T, index: number) => U,
): readonly U[] {
  const target = createDenseArray<U>(source.length);
  for (let index = 0; index < source.length; index += 1) {
    defineArrayItem(target, index, copy(source[index]!, index));
  }
  return OBJECT_FREEZE(target);
}

function copyStringArray(source: readonly string[]): readonly string[] {
  return copyArray(source, (value) => value);
}

interface CapturedSurfaceEntry {
  readonly key: PropertyKey;
  readonly data: boolean;
  readonly value: unknown;
  readonly writable: boolean | undefined;
  readonly get: (() => unknown) | undefined;
  readonly set: ((value: unknown) => void) | undefined;
  readonly enumerable: boolean;
  readonly configurable: boolean;
}

interface CapturedSurface {
  readonly target: object;
  readonly prototype: object | null;
  readonly entries: readonly CapturedSurfaceEntry[];
}

function captureSurfaceEntry(
  key: PropertyKey,
  descriptor: PropertyDescriptor,
): CapturedSurfaceEntry {
  const output = createRecord();
  const data = "value" in descriptor;
  defineField(output, "key", key);
  defineField(output, "data", data);
  defineField(output, "value", data ? descriptor.value : undefined);
  defineField(output, "writable", data ? descriptor.writable : undefined);
  defineField(output, "get", data ? undefined : descriptor.get);
  defineField(output, "set", data ? undefined : descriptor.set);
  defineField(output, "enumerable", descriptor.enumerable === true);
  defineField(output, "configurable", descriptor.configurable === true);
  return finishRecord(output);
}

function captureSurface(target: object): CapturedSurface {
  const keys = REFLECT_OWN_KEYS(target);
  const entries = createDenseArray<CapturedSurfaceEntry>(keys.length);
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index]!;
    const descriptor = OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(target, key)!;
    defineArrayItem(entries, index, captureSurfaceEntry(key, descriptor));
  }
  const output = createRecord();
  defineField(output, "target", target);
  defineField(output, "prototype", OBJECT_GET_PROTOTYPE_OF(target));
  defineField(output, "entries", OBJECT_FREEZE(entries));
  return finishRecord(output);
}

function captureSurfaces(
  targets: readonly object[],
): readonly CapturedSurface[] {
  const surfaces = createDenseArray<CapturedSurface>(targets.length);
  for (let index = 0; index < targets.length; index += 1) {
    defineArrayItem(surfaces, index, captureSurface(targets[index]!));
  }
  return OBJECT_FREEZE(surfaces);
}

const CAPTURED_RUNTIME_SURFACES = captureSurfaces([
  OBJECT_PROTOTYPE,
  ARRAY_PROTOTYPE,
  OBJECT_CONSTRUCTOR,
  ARRAY_CONSTRUCTOR,
  REFLECT_OBJECT,
  JSON_OBJECT,
  NUMBER_CONSTRUCTOR,
  NUMBER_PROTOTYPE,
  MATH_OBJECT,
  STRING_CONSTRUCTOR,
  STRING_PROTOTYPE,
  REGEXP_PROTOTYPE,
  SET_CONSTRUCTOR,
  SET_PROTOTYPE,
  MAP_CONSTRUCTOR,
  MAP_PROTOTYPE,
  WEAK_SET_CONSTRUCTOR,
  WEAK_SET_PROTOTYPE,
  BUFFER_CONSTRUCTOR,
  HASH_PROTOTYPE,
  ARRAY_ITERATOR_PROTOTYPE,
  SET_ITERATOR_PROTOTYPE,
  MAP_ITERATOR_PROTOTYPE,
  NODE_UTIL_TYPES,
]);

function captureGlobalBindings(
  names: readonly string[],
): readonly CapturedSurfaceEntry[] {
  const bindings = createDenseArray<CapturedSurfaceEntry>(names.length);
  for (let index = 0; index < names.length; index += 1) {
    const name = names[index]!;
    const descriptor = OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(GLOBAL_THIS, name);
    if (!descriptor) {
      throw new RetrievalExplanationViewContractError("invalid-trace");
    }
    defineArrayItem(bindings, index, captureSurfaceEntry(name, descriptor));
  }
  return OBJECT_FREEZE(bindings);
}

const CAPTURED_GLOBAL_BINDINGS = captureGlobalBindings([
  "Array",
  "Object",
  "Reflect",
  "JSON",
  "Number",
  "Math",
  "String",
  "Set",
  "Map",
  "WeakSet",
  "Buffer",
]);

function descriptorMatches(
  current: PropertyDescriptor,
  expected: CapturedSurfaceEntry,
  ignoreDataValue: boolean,
): boolean {
  const data = "value" in current;
  return (
    data === expected.data &&
    current.enumerable === expected.enumerable &&
    current.configurable === expected.configurable &&
    (data
      ? current.writable === expected.writable &&
        (ignoreDataValue || OBJECT_IS(current.value, expected.value))
      : OBJECT_IS(current.get, expected.get) &&
        OBJECT_IS(current.set, expected.set))
  );
}

function surfaceMatches(surface: CapturedSurface): boolean {
  if (!OBJECT_IS(OBJECT_GET_PROTOTYPE_OF(surface.target), surface.prototype)) {
    return false;
  }
  const keys = REFLECT_OWN_KEYS(surface.target);
  if (keys.length !== surface.entries.length) return false;
  for (let index = 0; index < keys.length; index += 1) {
    const expected = surface.entries[index]!;
    if (!OBJECT_IS(keys[index], expected.key)) return false;
    const descriptor = OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(
      surface.target,
      expected.key,
    );
    if (
      !descriptor ||
      !descriptorMatches(
        descriptor,
        expected,
        surface.target === ARRAY_PROTOTYPE && expected.key === "length",
      )
    )
      return false;
  }
  return true;
}

function assertTraceRuntimeIntegrity(): void {
  for (let index = 0; index < CAPTURED_GLOBAL_BINDINGS.length; index += 1) {
    const expected = CAPTURED_GLOBAL_BINDINGS[index]!;
    const descriptor = OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(
      GLOBAL_THIS,
      expected.key,
    );
    if (!descriptor || !descriptorMatches(descriptor, expected, false)) {
      throw new RetrievalExplanationViewContractError("invalid-trace");
    }
  }
  if (createHash !== CREATE_HASH) {
    throw new RetrievalExplanationViewContractError("invalid-trace");
  }
  for (let index = 0; index < CAPTURED_RUNTIME_SURFACES.length; index += 1) {
    if (!surfaceMatches(CAPTURED_RUNTIME_SURFACES[index]!)) {
      throw new RetrievalExplanationViewContractError("invalid-trace");
    }
  }
  if (nodeUtilTypes.isProxy !== NODE_IS_PROXY) {
    throw new RetrievalExplanationViewContractError("invalid-trace");
  }
}

function copySources(
  source: RetrievalTraceRequestShapeV1["sources"],
): RetrievalTraceRequestShapeV1["sources"] {
  const output = createRecord();
  defineField(output, "code", source.code);
  defineField(output, "architecture", source.architecture);
  defineField(output, "memory", source.memory);
  return finishRecord(output);
}

function copyRequestShape(
  source: RetrievalTraceRequestShapeV1,
): RetrievalTraceRequestShapeV1 {
  const output = createRecord();
  defineField(output, "sources", copySources(source.sources));
  defineField(output, "projectScopeApplied", source.projectScopeApplied);
  defineField(output, "tenantScope", source.tenantScope);
  defineField(output, "entityScope", source.entityScope);
  defineField(output, "tagScope", source.tagScope);
  defineField(output, "temporalFilterApplied", source.temporalFilterApplied);
  defineField(output, "queryLength", source.queryLength);
  defineField(output, "queryForm", source.queryForm);
  defineField(output, "tokenBudget", source.tokenBudget);
  defineField(output, "diversification", source.diversification);
  defineField(
    output,
    "plannedChannels",
    copyStringArray(source.plannedChannels),
  );
  return finishRecord(output);
}

function copyChannel(
  source: RetrievalTraceChannelStateV1,
): RetrievalTraceChannelStateV1 {
  const output = createRecord();
  defineField(output, "channel", source.channel);
  defineField(output, "rank", source.rank);
  if (source.score !== undefined) defineField(output, "score", source.score);
  return finishRecord(output);
}

function copyEvidence(
  source: RetrievalTraceEvidenceStateV1,
): RetrievalTraceEvidenceStateV1 {
  const output = createRecord();
  if (source.confidence !== undefined)
    defineField(output, "confidence", source.confidence);
  if (source.sourceCount !== undefined)
    defineField(output, "sourceCount", source.sourceCount);
  if (source.superseded !== undefined)
    defineField(output, "superseded", source.superseded);
  if (source.invalidated !== undefined)
    defineField(output, "invalidated", source.invalidated);
  return finishRecord(output);
}

function copyCandidate(
  source: RetrievalTraceCandidateV1,
): RetrievalTraceCandidateV1 {
  const output = createRecord();
  defineField(output, "ref", source.ref);
  defineField(output, "sourceType", source.sourceType);
  defineField(output, "channels", copyArray(source.channels, copyChannel));
  defineField(output, "evidence", copyEvidence(source.evidence));
  defineField(output, "estimatedTokens", source.estimatedTokens);
  return finishRecord(output);
}

function copyPairwise(
  source: RetrievalTraceMmrPairwiseV1,
): RetrievalTraceMmrPairwiseV1 {
  const output = createRecord();
  defineField(output, "selectedRef", source.selectedRef);
  defineField(output, "similarity", source.similarity);
  return finishRecord(output);
}

function copyMmrRecord(
  source: RetrievalTraceMmrRecordV1,
): RetrievalTraceMmrRecordV1 {
  const output = createRecord();
  defineField(output, "ref", source.ref);
  defineField(output, "relevance", source.relevance);
  defineField(output, "maxSimilarity", source.maxSimilarity);
  defineField(output, "lambda", source.lambda);
  defineField(output, "objective", source.objective);
  defineField(output, "againstRef", source.againstRef);
  defineField(output, "pairwise", copyArray(source.pairwise, copyPairwise));
  return finishRecord(output);
}

function copyEvent(source: TraceEvent): TraceEvent {
  const output = createRecord();
  defineField(output, "sequence", source.sequence);
  defineField(output, "kind", source.kind);
  switch (source.kind) {
    case "channel-attempt":
      defineField(output, "channel", source.channel);
      break;
    case "channel-terminal":
      defineField(output, "channel", source.channel);
      defineField(output, "outcome", source.outcome);
      if (source.outcome === "safe-failure")
        defineField(output, "code", source.code);
      break;
    case "candidate-filter":
      defineField(output, "ref", source.ref);
      defineField(output, "name", source.name);
      defineField(output, "outcome", source.outcome);
      break;
    case "candidate-score":
      defineField(output, "ref", source.ref);
      defineField(output, "name", source.name);
      defineField(output, "value", source.value);
      break;
    case "mmr-round":
      defineField(output, "round", source.round);
      defineField(output, "selectedRef", source.selectedRef);
      defineField(output, "records", copyArray(source.records, copyMmrRecord));
      break;
    case "ranked-output":
    case "deterministic-output":
      defineField(output, "ref", source.ref);
      defineField(output, "rank", source.rank);
      break;
    case "candidate-terminal":
      defineField(output, "ref", source.ref);
      defineField(output, "outcome", source.outcome);
      defineField(output, "reasons", copyStringArray(source.reasons));
      if (source.duplicateOfRef !== undefined) {
        defineField(output, "duplicateOfRef", source.duplicateOfRef);
      }
      break;
    case "stage-failure":
      defineField(output, "stage", source.stage);
      defineField(output, "code", source.code);
      break;
  }
  return finishRecord(output);
}

function copyTerminalExclusion(
  source: RetrievalTraceTerminalExclusionV1,
): RetrievalTraceTerminalExclusionV1 {
  const output = createRecord();
  defineField(output, "ref", source.ref);
  defineField(output, "outcome", source.outcome);
  defineField(output, "reasons", copyStringArray(source.reasons));
  if (source.duplicateOfRef !== undefined) {
    defineField(output, "duplicateOfRef", source.duplicateOfRef);
  }
  return finishRecord(output);
}

function incompleteReceipt(
  trace: RetrievalTraceV1,
): RetrievalExplanationReplayReceiptV1 {
  const output = createRecord();
  defineField(output, "replayable", false);
  defineField(
    output,
    "incompleteReasons",
    copyStringArray(trace.incompleteReasons),
  );
  defineField(output, "replayStateDigest", trace.replayStateDigest);
  return finishRecord(output);
}

function completeReceipt(
  trace: RetrievalTraceV1,
): RetrievalExplanationReplayReceiptV1 {
  const replay = REPLAY_TRACE(trace);
  const output = createRecord();
  defineField(output, "replayable", true);
  defineField(output, "resultOrder", copyStringArray(replay.resultOrder));
  defineField(
    output,
    "terminalExclusions",
    copyArray(replay.terminalExclusions, copyTerminalExclusion),
  );
  defineField(output, "replayStateDigest", replay.replayStateDigest);
  return finishRecord(output);
}

function buildValidatedView(
  trace: RetrievalTraceV1,
): RetrievalExplanationViewV1 {
  const output = createRecord();
  defineField(output, "contractId", RETRIEVAL_EXPLANATION_VIEW_CONTRACT_ID);
  defineField(
    output,
    "contractVersion",
    RETRIEVAL_EXPLANATION_VIEW_CONTRACT_VERSION,
  );
  defineField(output, "traceSchemaVersion", trace.schemaVersion);
  defineField(output, "algorithmVersion", trace.algorithmVersion);
  defineField(output, "requestShape", copyRequestShape(trace.requestShape));
  defineField(output, "complete", trace.complete);
  defineField(
    output,
    "incompleteReasons",
    copyStringArray(trace.incompleteReasons),
  );
  defineField(output, "candidates", copyArray(trace.candidates, copyCandidate));
  defineField(output, "events", copyArray(trace.events, copyEvent));
  defineField(
    output,
    "replayReceipt",
    trace.complete ? completeReceipt(trace) : incompleteReceipt(trace),
  );
  return finishRecord(output);
}

function utf8Length(value: string): number {
  return REFLECT_APPLY(BUFFER_BYTE_LENGTH, BUFFER_CONSTRUCTOR, [
    value,
    "utf8",
  ]) as number;
}

function snapshotTraceInput(value: unknown): unknown {
  const seen = new WEAK_SET_CONSTRUCTOR<object>();
  let entries = 0;
  let scalarBytes = 0;

  const addScalar = (text: string): void => {
    const remainingBytes = MAX_VIEW_GRAPH_SCALAR_UTF8_BYTES - scalarBytes;
    if (text.length > remainingBytes) {
      throw new RetrievalExplanationViewContractError("invalid-trace");
    }
    const bytes = utf8Length(text);
    if (bytes > remainingBytes) {
      throw new RetrievalExplanationViewContractError("invalid-trace");
    }
    scalarBytes += bytes;
  };

  const visit = (current: unknown, depth: number): unknown => {
    if (current === null || typeof current === "boolean") return current;
    if (typeof current === "string") {
      addScalar(current);
      return current;
    }
    if (typeof current === "number") {
      if (!NUMBER_IS_FINITE(current)) {
        throw new RetrievalExplanationViewContractError("invalid-trace");
      }
      return current;
    }
    if (
      typeof current !== "object" ||
      depth > MAX_VIEW_GRAPH_DEPTH ||
      NODE_IS_PROXY(current) ||
      weakSetHas(seen, current)
    ) {
      throw new RetrievalExplanationViewContractError("invalid-trace");
    }
    weakSetAdd(seen, current);

    const array = ARRAY_IS_ARRAY(current);
    const prototype = OBJECT_GET_PROTOTYPE_OF(current);
    if (
      array
        ? prototype !== ARRAY_PROTOTYPE
        : prototype !== OBJECT_PROTOTYPE && prototype !== null
    ) {
      throw new RetrievalExplanationViewContractError("invalid-trace");
    }
    const keys = REFLECT_OWN_KEYS(current);
    if (entries + keys.length > MAX_VIEW_GRAPH_ENTRIES) {
      throw new RetrievalExplanationViewContractError("invalid-trace");
    }
    entries += keys.length;

    if (array) {
      const lengthDescriptor = OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(
        current,
        "length",
      );
      const length = lengthDescriptor?.value;
      if (
        !lengthDescriptor ||
        !("value" in lengthDescriptor) ||
        typeof length !== "number" ||
        !NUMBER_IS_SAFE_INTEGER(length) ||
        length < 0 ||
        keys.length !== length + 1 ||
        keys[length] !== "length"
      ) {
        throw new RetrievalExplanationViewContractError("invalid-trace");
      }
      const output = createDenseArray<unknown>(length);
      for (let index = 0; index < length; index += 1) {
        const key = `${index}`;
        if (keys[index] !== key) {
          throw new RetrievalExplanationViewContractError("invalid-trace");
        }
        const descriptor = OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(current, key);
        if (
          !descriptor ||
          !("value" in descriptor) ||
          descriptor.enumerable !== true
        ) {
          throw new RetrievalExplanationViewContractError("invalid-trace");
        }
        defineArrayItem(output, index, visit(descriptor.value, depth + 1));
      }
      return OBJECT_FREEZE(output);
    }

    const output = createRecord();
    for (let index = 0; index < keys.length; index += 1) {
      const key = keys[index];
      if (typeof key !== "string") {
        throw new RetrievalExplanationViewContractError("invalid-trace");
      }
      addScalar(key);
      const descriptor = OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(current, key);
      if (
        !descriptor ||
        !("value" in descriptor) ||
        descriptor.enumerable !== true
      ) {
        throw new RetrievalExplanationViewContractError("invalid-trace");
      }
      defineField(output, key, visit(descriptor.value, depth + 1));
    }
    return finishRecord(output);
  };

  return visit(value, 0);
}

export function buildRetrievalExplanationViewV1(
  trace: unknown,
): RetrievalExplanationViewV1 {
  try {
    assertTraceRuntimeIntegrity();
    const snapshot = snapshotTraceInput(trace);
    ASSERT_TRACE_SECRET_SAFE(snapshot);
    return buildValidatedView(snapshot);
  } catch {
    throw new RetrievalExplanationViewContractError("invalid-trace");
  }
}

function weakSetHas(set: WeakSet<object>, value: object): boolean {
  return REFLECT_APPLY(WEAK_SET_HAS, set, [value]) as boolean;
}

function weakSetAdd(set: WeakSet<object>, value: object): void {
  REFLECT_APPLY(WEAK_SET_ADD, set, [value]);
}

function preflightViewGraph(value: unknown): void {
  const seen = new WEAK_SET_CONSTRUCTOR<object>();
  let entries = 0;

  const visit = (current: unknown, depth: number): void => {
    if (
      current === null ||
      typeof current === "string" ||
      typeof current === "boolean" ||
      (typeof current === "number" && NUMBER_IS_FINITE(current))
    )
      return;
    if (
      typeof current !== "object" ||
      depth > MAX_VIEW_GRAPH_DEPTH ||
      NODE_IS_PROXY(current)
    ) {
      throw new RetrievalExplanationViewContractError("invalid-view");
    }
    if (weakSetHas(seen, current)) {
      throw new RetrievalExplanationViewContractError("invalid-view");
    }
    weakSetAdd(seen, current);

    const array = ARRAY_IS_ARRAY(current);
    const prototype = OBJECT_GET_PROTOTYPE_OF(current);
    if (
      array
        ? prototype !== ARRAY_PROTOTYPE
        : prototype !== OBJECT_PROTOTYPE && prototype !== null
    ) {
      throw new RetrievalExplanationViewContractError("invalid-view");
    }
    const keys = REFLECT_OWN_KEYS(current);
    if (entries + keys.length > MAX_VIEW_GRAPH_ENTRIES) {
      throw new RetrievalExplanationViewContractError("invalid-view");
    }
    entries += keys.length;

    if (array) {
      const lengthDescriptor = OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(
        current,
        "length",
      );
      if (
        !lengthDescriptor ||
        !("value" in lengthDescriptor) ||
        typeof lengthDescriptor.value !== "number" ||
        keys.length !== lengthDescriptor.value + 1
      )
        throw new RetrievalExplanationViewContractError("invalid-view");
      for (let index = 0; index < lengthDescriptor.value; index += 1) {
        const descriptor = OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(
          current,
          `${index}`,
        );
        if (
          !descriptor ||
          !("value" in descriptor) ||
          descriptor.enumerable !== true
        ) {
          throw new RetrievalExplanationViewContractError("invalid-view");
        }
        visit(descriptor.value, depth + 1);
      }
      for (let index = 0; index < lengthDescriptor.value; index += 1) {
        if (keys[index] !== `${index}`) {
          throw new RetrievalExplanationViewContractError("invalid-view");
        }
      }
      if (keys[lengthDescriptor.value] !== "length") {
        throw new RetrievalExplanationViewContractError("invalid-view");
      }
      return;
    }

    for (let index = 0; index < keys.length; index += 1) {
      const key = keys[index];
      if (typeof key !== "string")
        throw new RetrievalExplanationViewContractError("invalid-view");
      const descriptor = OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(current, key);
      if (
        !descriptor ||
        !("value" in descriptor) ||
        descriptor.enumerable !== true
      ) {
        throw new RetrievalExplanationViewContractError("invalid-view");
      }
      visit(descriptor.value, depth + 1);
    }
  };

  visit(value, 0);
}

function hasExactKeys(value: object, expected: readonly string[]): boolean {
  const keys = REFLECT_OWN_KEYS(value);
  if (keys.length !== expected.length) return false;
  for (
    let expectedIndex = 0;
    expectedIndex < expected.length;
    expectedIndex += 1
  ) {
    let found = false;
    for (let keyIndex = 0; keyIndex < keys.length; keyIndex += 1) {
      if (keys[keyIndex] === expected[expectedIndex]) {
        found = true;
        break;
      }
    }
    if (!found) return false;
  }
  return true;
}

function traceFromView(value: unknown): RetrievalTraceV1 {
  preflightViewGraph(value);
  if (
    value === null ||
    typeof value !== "object" ||
    ARRAY_IS_ARRAY(value) ||
    !hasExactKeys(value, [
      "contractId",
      "contractVersion",
      "traceSchemaVersion",
      "algorithmVersion",
      "requestShape",
      "complete",
      "incompleteReasons",
      "candidates",
      "events",
      "replayReceipt",
    ])
  )
    throw new RetrievalExplanationViewContractError("invalid-view");

  const view = value as unknown as RetrievalExplanationViewV1;
  if (
    view.contractId !== RETRIEVAL_EXPLANATION_VIEW_CONTRACT_ID ||
    view.contractVersion !== RETRIEVAL_EXPLANATION_VIEW_CONTRACT_VERSION ||
    typeof view.complete !== "boolean" ||
    view.replayReceipt === null ||
    typeof view.replayReceipt !== "object" ||
    ARRAY_IS_ARRAY(view.replayReceipt)
  )
    throw new RetrievalExplanationViewContractError("invalid-view");

  const receipt = view.replayReceipt;
  if (view.complete) {
    if (
      receipt.replayable !== true ||
      !hasExactKeys(receipt, [
        "replayable",
        "resultOrder",
        "terminalExclusions",
        "replayStateDigest",
      ])
    )
      throw new RetrievalExplanationViewContractError("invalid-view");
    return {
      schemaVersion: view.traceSchemaVersion,
      algorithmVersion: view.algorithmVersion,
      requestShape: view.requestShape,
      complete: view.complete,
      incompleteReasons: view.incompleteReasons,
      candidates: view.candidates,
      events: view.events,
      resultOrder: receipt.resultOrder,
      terminalExclusions: receipt.terminalExclusions,
      replayStateDigest: receipt.replayStateDigest,
    };
  }

  if (
    receipt.replayable !== false ||
    !hasExactKeys(receipt, [
      "replayable",
      "incompleteReasons",
      "replayStateDigest",
    ]) ||
    !deepEqual(receipt.incompleteReasons, view.incompleteReasons)
  )
    throw new RetrievalExplanationViewContractError("invalid-view");
  return {
    schemaVersion: view.traceSchemaVersion,
    algorithmVersion: view.algorithmVersion,
    requestShape: view.requestShape,
    complete: view.complete,
    incompleteReasons: view.incompleteReasons,
    candidates: view.candidates,
    events: view.events,
    resultOrder: [],
    terminalExclusions: [],
    replayStateDigest: receipt.replayStateDigest,
  };
}

function deepEqual(left: unknown, right: unknown): boolean {
  if (OBJECT_IS(left, right)) return true;
  if (
    left === null ||
    right === null ||
    typeof left !== "object" ||
    typeof right !== "object"
  ) {
    return false;
  }
  const leftArray = ARRAY_IS_ARRAY(left);
  if (leftArray !== ARRAY_IS_ARRAY(right)) return false;
  const leftKeys = REFLECT_OWN_KEYS(left);
  const rightKeys = REFLECT_OWN_KEYS(right);
  if (leftKeys.length !== rightKeys.length) return false;
  for (let index = 0; index < leftKeys.length; index += 1) {
    const key = leftKeys[index];
    if (typeof key !== "string") return false;
    const leftDescriptor = OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(left, key);
    const rightDescriptor = OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(right, key);
    if (
      !leftDescriptor ||
      !rightDescriptor ||
      !("value" in leftDescriptor) ||
      !("value" in rightDescriptor) ||
      !deepEqual(leftDescriptor.value, rightDescriptor.value)
    )
      return false;
  }
  return true;
}

function canonicalViewFromUnknown(value: unknown): RetrievalExplanationViewV1 {
  try {
    assertTraceRuntimeIntegrity();
    const trace = traceFromView(value);
    const snapshot = snapshotTraceInput(trace);
    ASSERT_TRACE_SECRET_SAFE(snapshot);
    const canonical = buildValidatedView(snapshot);
    if (!deepEqual(canonical, value)) {
      throw new RetrievalExplanationViewContractError("invalid-view");
    }
    return canonical;
  } catch {
    throw new RetrievalExplanationViewContractError("invalid-view");
  }
}

function safeNumberText(value: number): string {
  return REFLECT_APPLY(NUMBER_TO_STRING, value, []) as string;
}

function assertSafeTextAtom(value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const code = REFLECT_APPLY(STRING_CHAR_CODE_AT, value, [index]) as number;
    if (
      code < 0x20 ||
      code > 0x7e ||
      code === 0x23 ||
      code === 0x26 ||
      code === 0x2a ||
      code === 0x3c ||
      code === 0x3e ||
      code === 0x60
    )
      throw new RetrievalExplanationViewContractError("invalid-view");
  }
}

export function renderRetrievalExplanationTextV1(view: unknown): string {
  const canonical = canonicalViewFromUnknown(view);
  let text = "";

  const append = (path: string, value: string): void => {
    assertSafeTextAtom(path);
    assertSafeTextAtom(value);
    const line = `${path}=${value}\n`;
    if (text.length + line.length > RETRIEVAL_EXPLANATION_TEXT_MAX_UTF8_BYTES) {
      throw new RetrievalExplanationViewContractError("text-budget-exceeded");
    }
    text += line;
  };

  const render = (value: unknown, path: string): void => {
    if (value === null) {
      append(path, "null");
      return;
    }
    if (typeof value === "string") {
      append(path, value);
      return;
    }
    if (typeof value === "boolean") {
      append(path, value ? "true" : "false");
      return;
    }
    if (typeof value === "number") {
      append(path, safeNumberText(value));
      return;
    }
    if (ARRAY_IS_ARRAY(value)) {
      for (let index = 0; index < value.length; index += 1) {
        render(value[index], `${path}[${index}]`);
      }
      return;
    }
    const keys = REFLECT_OWN_KEYS(value as object);
    for (let index = 0; index < keys.length; index += 1) {
      const key = keys[index] as string;
      const descriptor = OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(
        value as object,
        key,
      )!;
      render(descriptor.value, path.length === 0 ? key : `${path}.${key}`);
    }
  };

  render(canonical, "");
  return text;
}
