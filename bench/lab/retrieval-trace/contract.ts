import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { isProxy } from 'node:util/types';

import {
  assertRetrievalTraceConformant,
  canonicalTraceJson,
  replayRetrievalTrace,
  type RetrievalTraceAlgorithmVersion,
  type RetrievalTraceV1,
} from '../../../packages/retrieval/src/index.js';

const MAX_TRACE_JSON_BYTES = 4_194_304;
const MAX_MARKDOWN_BYTES = 4_194_304;
const TRACE_HARD_CANDIDATE_LIMIT = 512;
const TRACE_HARD_EVENT_LIMIT = 8_192;

type JsonRecord = Record<string, unknown>;

export interface TraceInspectionSummary {
  readonly algorithmVersion: RetrievalTraceAlgorithmVersion;
  readonly complete: true;
  readonly candidateCount: number;
  readonly eventCount: number;
  readonly resultCount: number;
  readonly exclusionCount: number;
  readonly plannedChannelCount: number;
  readonly settledChannelCount: number;
  readonly terminalCount: number;
  readonly canonical: true;
  readonly replayEquivalent: true;
  readonly channelSettlementComplete: true;
  readonly terminalCoverageComplete: true;
  readonly markdownResultCountEquivalent: true;
  readonly resultOrderBindingDigest: string;
  readonly replayStateDigest: string;
}

export type TraceToolInspection =
  | { readonly markdown: string; readonly contentBlockCount: 1 }
  | { readonly markdown: string; readonly contentBlockCount: 2; readonly trace: TraceInspectionSummary };

export interface TraceManifestTruth {
  readonly git: Readonly<{ sha: string; dirty: false }>;
  readonly runtime: Readonly<{ node: string; platform: string; arch: string }>;
  readonly config: Readonly<Record<string, unknown>>;
  readonly services: Readonly<Record<string, unknown>>;
}

interface MarkdownInspection {
  readonly resultIds: readonly string[];
  readonly resultSourceTypes: readonly string[];
  readonly sourceCounts: Readonly<Record<string, number>>;
}

function fail(code: string): never {
  throw new Error(code);
}

function plainRecord(value: unknown, code: string): JsonRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value) || isProxy(value)) fail(code);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) fail(code);
  return value as JsonRecord;
}

function exactKeys(record: JsonRecord, expected: readonly string[], code: string): void {
  const keys = Reflect.ownKeys(record);
  if (keys.some((key) => typeof key !== 'string') || keys.length !== expected.length
    || expected.some((key) => !keys.includes(key))) fail(code);
}

function keysFrom(record: JsonRecord, allowed: readonly string[], required: readonly string[], code: string): void {
  const keys = Reflect.ownKeys(record);
  if (keys.some((key) => typeof key !== 'string' || !allowed.includes(key))
    || required.some((key) => !keys.includes(key))) fail(code);
}

function descriptorValue(record: JsonRecord, key: string, code: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  if (!descriptor || !('value' in descriptor) || descriptor.get || descriptor.set || !descriptor.enumerable) fail(code);
  return descriptor.value;
}

function denseArray(value: unknown, max: number, code: string): unknown[] {
  if (!Array.isArray(value) || isProxy(value) || value.length > max) fail(code);
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key === 'symbol')) fail(code);
  for (let index = 0; index < value.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !('value' in descriptor) || descriptor.get || descriptor.set || !descriptor.enumerable) fail(code);
  }
  return value;
}

function textParts(value: unknown): string[] {
  const result = plainRecord(value, 'RET001D_MCP_RESULT_INVALID');
  keysFrom(result, ['content', 'isError'], ['content'], 'RET001D_MCP_RESULT_INVALID');
  if (Reflect.ownKeys(result).includes('isError')
    && descriptorValue(result, 'isError', 'RET001D_MCP_RESULT_INVALID') === true) fail('RET001D_MCP_TOOL_FAILURE');
  const parts = denseArray(descriptorValue(result, 'content', 'RET001D_MCP_RESULT_INVALID'), 2, 'RET001D_MCP_RESULT_INVALID');
  return parts.map((part) => {
    const item = plainRecord(part, 'RET001D_MCP_RESULT_INVALID');
    exactKeys(item, ['type', 'text'], 'RET001D_MCP_RESULT_INVALID');
    if (descriptorValue(item, 'type', 'RET001D_MCP_RESULT_INVALID') !== 'text') fail('RET001D_MCP_RESULT_INVALID');
    const text = descriptorValue(item, 'text', 'RET001D_MCP_RESULT_INVALID');
    if (typeof text !== 'string') fail('RET001D_MCP_RESULT_INVALID');
    return text;
  });
}

function inspectMarkdown(
  markdown: string,
  expectation: {
    readonly expectedTask: string;
    readonly expectedStrategy: 'deterministic' | 'ranked';
    readonly expectedResultIds?: readonly string[];
  },
): MarkdownInspection {
  if (Buffer.byteLength(markdown, 'utf8') > MAX_MARKDOWN_BYTES) fail('RET001D_MARKDOWN_INVALID');
  const lines = markdown.split('\n');
  if (lines[0] !== '# Unified Context' || lines[1] !== `**Task:** ${expectation.expectedTask}`) {
    fail('RET001D_MARKDOWN_REQUEST_MISMATCH');
  }
  const summary = lines[2]?.match(/^\*\*Strategy:\*\* (deterministic|ranked) \| \*\*Tokens:\*\* ~(\d+) \| \*\*Sources:\*\* (.+) \| \*\*IDs:\*\* (\d+)$/);
  if (!summary || summary[1] !== expectation.expectedStrategy) fail('RET001D_MARKDOWN_REQUEST_MISMATCH');
  const tokenCount = Number(summary[2]);
  const declaredIds = Number(summary[4]);
  if (!Number.isSafeInteger(tokenCount) || tokenCount <= 0 || !Number.isSafeInteger(declaredIds) || declaredIds <= 0) {
    fail('RET001D_SEEDED_RESULT_EMPTY');
  }
  const sourceCounts: Record<string, number> = {};
  if (summary[3] === 'none') fail('RET001D_SEEDED_RESULT_EMPTY');
  for (const item of summary[3]!.split(', ')) {
    const parsed = item.match(/^([a-z][a-z0-9_]*):(\d+)$/);
    if (!parsed || parsed[1] in sourceCounts) fail('RET001D_MARKDOWN_PROVENANCE_INVALID');
    const count = Number(parsed[2]);
    if (!Number.isSafeInteger(count) || count <= 0) fail('RET001D_MARKDOWN_PROVENANCE_INVALID');
    sourceCounts[parsed[1]!] = count;
  }
  const resultIds: string[] = [];
  const resultSourceTypes: string[] = [];
  const markerIndexes: number[] = [];
  const headingSource = new Map<string, string>([
    ['Domain Hierarchy', 'arch_entity'], ['Target Components', 'arch_entity'],
    ['Dependencies & Dependents', 'arch_entity'], ['Architecture', 'arch_entity'],
    ['Cross-Cutting Concerns', 'aspect'], ['Semantic Knowledge', 'semantic'],
    ['Knowledge', 'semantic'], ['Code', 'symbol'], ['History', 'episodic'],
  ]);
  let currentSource: string | undefined;
  for (let index = 0; index < lines.length; index++) {
    const heading = lines[index]!.match(/^## (.+)$/);
    if (heading) currentSource = headingSource.get(heading[1]!);
    const marker = lines[index]!.match(/^<!-- ([^<>\r\n]+?)(?: — .*)? -->$/);
    if (!marker) continue;
    const id = marker[1]!.trim();
    if (!id || resultIds.includes(id)) fail('RET001D_MARKDOWN_RESULT_INVALID');
    resultIds.push(id);
    if (!currentSource) fail('RET001D_MARKDOWN_PROVENANCE_INVALID');
    resultSourceTypes.push(currentSource);
    markerIndexes.push(index);
  }
  if (resultIds.length !== declaredIds
    || Object.values(sourceCounts).reduce((sum, count) => sum + count, 0) !== declaredIds) {
    fail('RET001D_MARKDOWN_RESULT_COUNT_MISMATCH');
  }
  for (let position = 0; position < markerIndexes.length; position++) {
    const start = markerIndexes[position]! + 1;
    const end = markerIndexes[position + 1] ?? lines.length;
    if (!lines.slice(start, end).some((line) => line.trim().length > 0 && !/^<!--/.test(line))) {
      fail('RET001D_MARKDOWN_RESULT_INVALID');
    }
  }
  if (expectation.expectedResultIds) {
    if (expectation.expectedResultIds.length === 0) fail('RET001D_SEEDED_RESULT_MISSING');
    if (!isDeepStrictEqual(resultIds, expectation.expectedResultIds)) fail('RET001D_MARKDOWN_RESULT_ORDER_MISMATCH');
  }
  return Object.freeze({
    resultIds: Object.freeze(resultIds),
    resultSourceTypes: Object.freeze(resultSourceTypes),
    sourceCounts: Object.freeze(sourceCounts),
  });
}

export function observeOrderedMarkdownResultIds(
  result: unknown,
  expectation: {
    readonly expectedTask: string;
    readonly expectedStrategy: 'deterministic' | 'ranked';
    readonly requiredResultIds: readonly string[];
  },
): readonly string[] {
  const parts = textParts(result);
  if (parts.length !== 1) fail('RET001D_NO_TRACE_BLOCK_COUNT');
  const presentation = inspectMarkdown(parts[0]!, expectation);
  if (expectation.requiredResultIds.length === 0
    || expectation.requiredResultIds.some((id) => !presentation.resultIds.includes(id))) {
    fail('RET001D_SEEDED_RESULT_MISSING');
  }
  return presentation.resultIds;
}

function traceSummary(
  presentation: MarkdownInspection,
  traceText: string,
  expectedAlgorithm: RetrievalTraceAlgorithmVersion,
  forbiddenValues: readonly string[],
): TraceInspectionSummary {
  if (Buffer.byteLength(traceText, 'utf8') > MAX_TRACE_JSON_BYTES) fail('RET001D_TRACE_TOO_LARGE');
  let parsed: unknown;
  try { parsed = JSON.parse(traceText); }
  catch { fail('RET001D_TRACE_JSON_INVALID'); }
  try { assertRetrievalTraceConformant(parsed); }
  catch { fail('RET001D_TRACE_CONFORMANCE_INVALID'); }
  const trace = parsed as RetrievalTraceV1;
  if (trace.algorithmVersion !== expectedAlgorithm) fail('RET001D_TRACE_ALGORITHM_MISMATCH');
  if (trace.complete !== true || trace.incompleteReasons.length !== 0) fail('RET001D_TRACE_INCOMPLETE');
  if (trace.candidates.length > TRACE_HARD_CANDIDATE_LIMIT || trace.events.length > TRACE_HARD_EVENT_LIMIT) {
    fail('RET001D_TRACE_BOUNDS_INVALID');
  }
  if (trace.candidates.length === 0 || trace.events.length === 0 || trace.resultOrder.length === 0
    || trace.requestShape.plannedChannels.length === 0) fail('RET001D_SEEDED_RESULT_EMPTY');
  const canonical = canonicalTraceJson(trace);
  if (canonical !== traceText) fail('RET001D_TRACE_NONCANONICAL');
  for (const forbidden of forbiddenValues) {
    if (forbidden && (traceText.includes(forbidden) || canonical.includes(forbidden))) fail('RET001D_TRACE_FORBIDDEN_VALUE');
  }
  let replay: ReturnType<typeof replayRetrievalTrace>;
  try { replay = replayRetrievalTrace(trace); }
  catch { fail('RET001D_TRACE_REPLAY_INVALID'); }
  if (!isDeepStrictEqual(replay.resultOrder, trace.resultOrder)
    || !isDeepStrictEqual(replay.terminalExclusions, trace.terminalExclusions)
    || replay.replayStateDigest !== trace.replayStateDigest) fail('RET001D_TRACE_REPLAY_MISMATCH');

  const attempts = trace.events.filter((event) => event.kind === 'channel-attempt');
  const settlements = trace.events.filter((event) => event.kind === 'channel-terminal');
  const terminals = trace.events.filter((event) => event.kind === 'candidate-terminal');
  const planned = trace.requestShape.plannedChannels;
  const settlementComplete = planned.every((channel) =>
    attempts.filter((event) => event.kind === 'channel-attempt' && event.channel === channel).length === 1
      && settlements.filter((event) => event.kind === 'channel-terminal' && event.channel === channel).length === 1)
    && attempts.length === planned.length && settlements.length === planned.length;
  if (!settlementComplete) fail('RET001D_TRACE_CHANNEL_SETTLEMENT_INVALID');
  const candidateRefs = new Set(trace.candidates.map(({ ref }) => ref));
  const terminalRefs = new Set(terminals.map(({ ref }) => ref));
  const terminalCoverage = terminals.length === candidateRefs.size
    && terminalRefs.size === candidateRefs.size
    && [...candidateRefs].every((ref) => terminalRefs.has(ref))
    && terminals.every((event) => event.kind !== 'candidate-terminal'
      || (event.outcome === 'included' ? event.reasons.length === 0 : event.reasons.length > 0));
  if (!terminalCoverage) fail('RET001D_TRACE_TERMINAL_COVERAGE_INVALID');
  if (presentation.resultIds.length !== trace.resultOrder.length) fail('RET001D_MARKDOWN_RESULT_COUNT_MISMATCH');
  const candidatesByRef = new Map(trace.candidates.map((candidate) => [candidate.ref, candidate]));
  const traceSourceCounts: Record<string, number> = {};
  const traceSourceTypes: string[] = [];
  for (const ref of trace.resultOrder) {
    const sourceType = candidatesByRef.get(ref)?.sourceType;
    if (!sourceType) fail('RET001D_MARKDOWN_TRACE_BINDING_INVALID');
    traceSourceCounts[sourceType] = (traceSourceCounts[sourceType] ?? 0) + 1;
    traceSourceTypes.push(sourceType);
  }
  if (!isDeepStrictEqual(
    Object.entries(traceSourceCounts).sort(([left], [right]) => left.localeCompare(right)),
    Object.entries(presentation.sourceCounts).sort(([left], [right]) => left.localeCompare(right)),
  )) fail('RET001D_MARKDOWN_TRACE_BINDING_INVALID');
  if (!isDeepStrictEqual(traceSourceTypes, presentation.resultSourceTypes)) {
    fail('RET001D_MARKDOWN_TRACE_BINDING_INVALID');
  }
  const resultOrderBindingDigest = `sha256:${createHash('sha256').update(JSON.stringify(
    trace.resultOrder.map((ref, index) => [ref, presentation.resultIds[index]]),
  )).digest('hex')}`;

  return Object.freeze({
    algorithmVersion: trace.algorithmVersion,
    complete: true,
    candidateCount: trace.candidates.length,
    eventCount: trace.events.length,
    resultCount: trace.resultOrder.length,
    exclusionCount: trace.terminalExclusions.length,
    plannedChannelCount: planned.length,
    settledChannelCount: settlements.length,
    terminalCount: terminals.length,
    canonical: true,
    replayEquivalent: true,
    channelSettlementComplete: true,
    terminalCoverageComplete: true,
    markdownResultCountEquivalent: true,
    resultOrderBindingDigest,
    replayStateDigest: trace.replayStateDigest,
  });
}

export function inspectTraceToolResult(
  result: unknown,
  expectation: {
    readonly mode: 'omitted' | 'false' | 'true';
    readonly expectedTask: string;
    readonly expectedStrategy: 'deterministic' | 'ranked';
    readonly expectedResultIds: readonly string[];
    readonly expectedAlgorithm?: RetrievalTraceAlgorithmVersion;
    readonly forbiddenValues?: readonly string[];
  },
): TraceToolInspection {
  const parts = textParts(result);
  if (parts.length === 0) fail('RET001D_MARKDOWN_INVALID');
  const presentation = inspectMarkdown(parts[0]!, expectation);
  if (expectation.mode !== 'true') {
    if (parts.length !== 1) fail('RET001D_NO_TRACE_BLOCK_COUNT');
    return Object.freeze({ markdown: parts[0]!, contentBlockCount: 1 });
  }
  if (parts.length !== 2 || !expectation.expectedAlgorithm) fail('RET001D_TRACE_BLOCK_COUNT');
  return Object.freeze({
    markdown: parts[0]!,
    contentBlockCount: 2,
    trace: traceSummary(presentation, parts[1]!, expectation.expectedAlgorithm, expectation.forbiddenValues ?? []),
  });
}

function canonicalClone(value: unknown, forbiddenValues: readonly string[], depth = 0, ancestors = new Set<object>()): unknown {
  if (depth > 32) fail('RET001D_MANIFEST_NONCANONICAL');
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    if (forbiddenValues.some((forbidden) => forbidden && value.includes(forbidden))) fail('RET001D_MANIFEST_FORBIDDEN_VALUE');
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail('RET001D_MANIFEST_NONCANONICAL');
    return value;
  }
  if (typeof value !== 'object' || value === null || isProxy(value)) fail('RET001D_MANIFEST_NONCANONICAL');
  if (ancestors.has(value)) fail('RET001D_MANIFEST_NONCANONICAL');
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const array = denseArray(value, 64, 'RET001D_MANIFEST_NONCANONICAL');
      return array.map((item) => canonicalClone(item, forbiddenValues, depth + 1, ancestors));
    }
    const record = plainRecord(value, 'RET001D_MANIFEST_NONCANONICAL');
    const keys = Reflect.ownKeys(record);
    if (keys.some((key) => typeof key !== 'string') || keys.length > 64) fail('RET001D_MANIFEST_NONCANONICAL');
    const output: JsonRecord = {};
    for (const key of (keys as string[]).sort()) {
      if (key === '__proto__' || key === 'prototype' || key === 'constructor') fail('RET001D_MANIFEST_NONCANONICAL');
      output[key] = canonicalClone(descriptorValue(record, key, 'RET001D_MANIFEST_NONCANONICAL'), forbiddenValues, depth + 1, ancestors);
    }
    return output;
  } finally {
    ancestors.delete(value);
  }
}

function assertBooleanRecord(value: unknown, keys: readonly string[]): void {
  const record = plainRecord(value, 'RET001D_MANIFEST_SHAPE');
  exactKeys(record, keys, 'RET001D_MANIFEST_KEYS');
  for (const key of keys) if (descriptorValue(record, key, 'RET001D_MANIFEST_SHAPE') !== true) fail('RET001D_MANIFEST_SHAPE');
}

function assertCase(value: unknown): void {
  const record = plainRecord(value, 'RET001D_MANIFEST_SHAPE');
  exactKeys(record, ['actualAlgorithm', 'authScope', 'contentBlocks', 'id', 'parity', 'requestedStrategy', 'trace'], 'RET001D_MANIFEST_KEYS');
  const blocks = plainRecord(descriptorValue(record, 'contentBlocks', 'RET001D_MANIFEST_SHAPE'), 'RET001D_MANIFEST_SHAPE');
  exactKeys(blocks, ['false', 'omitted', 'traced'], 'RET001D_MANIFEST_KEYS');
  if (descriptorValue(blocks, 'omitted', 'RET001D_MANIFEST_SHAPE') !== 1
    || descriptorValue(blocks, 'false', 'RET001D_MANIFEST_SHAPE') !== 1
    || descriptorValue(blocks, 'traced', 'RET001D_MANIFEST_SHAPE') !== 2) fail('RET001D_MANIFEST_SHAPE');
  assertBooleanRecord(descriptorValue(record, 'parity', 'RET001D_MANIFEST_SHAPE'), ['falseEqualsOmitted', 'tracedMarkdownEqualsOrdinary']);
  const id = descriptorValue(record, 'id', 'RET001D_MANIFEST_SHAPE');
  const requestedStrategy = descriptorValue(record, 'requestedStrategy', 'RET001D_MANIFEST_SHAPE');
  const actualAlgorithm = descriptorValue(record, 'actualAlgorithm', 'RET001D_MANIFEST_SHAPE');
  const authScope = descriptorValue(record, 'authScope', 'RET001D_MANIFEST_SHAPE');
  const exactCase = {
    deterministic: ['deterministic', 'deterministic-v2', 'default'],
    ranked: ['ranked', 'ranked-v1', 'default'],
    auto: ['auto', 'deterministic-v2', 'default'],
    'named-tenant-forced-ranked': ['deterministic', 'ranked-v1', 'named-tenant'],
  } as const;
  if (typeof id !== 'string' || !(id in exactCase)
    || !isDeepStrictEqual([requestedStrategy, actualAlgorithm, authScope], exactCase[id as keyof typeof exactCase])) {
    fail('RET001D_MANIFEST_SHAPE');
  }
  const trace = plainRecord(descriptorValue(record, 'trace', 'RET001D_MANIFEST_SHAPE'), 'RET001D_MANIFEST_SHAPE');
  exactKeys(trace, [
    'algorithmVersion', 'candidateCount', 'canonical', 'channelSettlementComplete', 'complete', 'eventCount',
    'exclusionCount', 'markdownResultCountEquivalent', 'plannedChannelCount', 'replayEquivalent', 'replayStateDigest',
    'resultCount', 'resultOrderBindingDigest', 'settledChannelCount', 'terminalCount', 'terminalCoverageComplete',
  ], 'RET001D_MANIFEST_KEYS');
  const traceValue = (key: string) => descriptorValue(trace, key, 'RET001D_MANIFEST_SHAPE');
  if (traceValue('complete') !== true || traceValue('canonical') !== true || traceValue('replayEquivalent') !== true
    || traceValue('channelSettlementComplete') !== true || traceValue('terminalCoverageComplete') !== true
    || traceValue('markdownResultCountEquivalent') !== true
    || !['deterministic-v2', 'ranked-v1'].includes(String(traceValue('algorithmVersion')))
    || traceValue('algorithmVersion') !== actualAlgorithm
    || typeof traceValue('replayStateDigest') !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(String(traceValue('replayStateDigest')))
    || typeof traceValue('resultOrderBindingDigest') !== 'string'
    || !/^sha256:[0-9a-f]{64}$/.test(String(traceValue('resultOrderBindingDigest')))
    || !['candidateCount', 'eventCount', 'exclusionCount', 'plannedChannelCount', 'resultCount', 'settledChannelCount', 'terminalCount']
      .every((key) => Number.isSafeInteger(traceValue(key)) && Number(traceValue(key)) >= 0)
    || ['candidateCount', 'eventCount', 'plannedChannelCount', 'resultCount', 'settledChannelCount', 'terminalCount']
      .some((key) => Number(traceValue(key)) === 0)
    || traceValue('candidateCount') !== traceValue('terminalCount')
    || traceValue('plannedChannelCount') !== traceValue('settledChannelCount')
    || Number(traceValue('resultCount')) > Number(traceValue('candidateCount'))) fail('RET001D_MANIFEST_SHAPE');
}

function serviceIdentity(value: unknown): JsonRecord {
  const service = plainRecord(value, 'RET001D_MANIFEST_SHAPE');
  exactKeys(service, ['containerId', 'imageId', 'version'], 'RET001D_MANIFEST_KEYS');
  const containerId = descriptorValue(service, 'containerId', 'RET001D_MANIFEST_SHAPE');
  const imageId = descriptorValue(service, 'imageId', 'RET001D_MANIFEST_SHAPE');
  const version = descriptorValue(service, 'version', 'RET001D_MANIFEST_SHAPE');
  if (typeof containerId !== 'string' || !/^[0-9a-f]{64}$/.test(containerId)
    || typeof imageId !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(imageId)
    || typeof version !== 'string' || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) {
    fail('RET001D_MANIFEST_SHAPE');
  }
  return { containerId, imageId, version };
}

export function assertTraceConformanceManifest(value: unknown, truth: TraceManifestTruth): void {
  const root = plainRecord(value, 'RET001D_MANIFEST_SHAPE');
  exactKeys(root, [
    'cleanup', 'config', 'generatedAt', 'git', 'packet', 'result', 'runtime', 'schemaVersion', 'services',
  ], 'RET001D_MANIFEST_KEYS');
  const schemaVersion = descriptorValue(root, 'schemaVersion', 'RET001D_MANIFEST_SHAPE');
  const packet = descriptorValue(root, 'packet', 'RET001D_MANIFEST_SHAPE');
  const generatedAt = descriptorValue(root, 'generatedAt', 'RET001D_MANIFEST_SHAPE');
  if (schemaVersion !== 1 || packet !== 'RET-001D' || typeof generatedAt !== 'string'
    || Number.isNaN(Date.parse(generatedAt)) || new Date(generatedAt).toISOString() !== generatedAt) {
    fail('RET001D_MANIFEST_SHAPE');
  }
  const git = plainRecord(descriptorValue(root, 'git', 'RET001D_MANIFEST_SHAPE'), 'RET001D_MANIFEST_SHAPE');
  exactKeys(git, ['dirty', 'sha'], 'RET001D_MANIFEST_KEYS');
  const sha = descriptorValue(git, 'sha', 'RET001D_MANIFEST_SHAPE');
  if (typeof sha !== 'string' || !/^[0-9a-f]{40}$/.test(sha)
    || descriptorValue(git, 'dirty', 'RET001D_MANIFEST_SHAPE') !== false) fail('RET001D_MANIFEST_SHAPE');
  const runtime = plainRecord(descriptorValue(root, 'runtime', 'RET001D_MANIFEST_SHAPE'), 'RET001D_MANIFEST_SHAPE');
  exactKeys(runtime, ['arch', 'node', 'platform'], 'RET001D_MANIFEST_KEYS');
  const runtimeNode = descriptorValue(runtime, 'node', 'RET001D_MANIFEST_SHAPE');
  const runtimePlatform = descriptorValue(runtime, 'platform', 'RET001D_MANIFEST_SHAPE');
  const runtimeArch = descriptorValue(runtime, 'arch', 'RET001D_MANIFEST_SHAPE');
  if (typeof runtimeNode !== 'string' || !/^v(?:20|22)\.\d+\.\d+(?:[-+].+)?$/.test(runtimeNode)
    || !['linux', 'win32', 'darwin'].includes(String(runtimePlatform))
    || !['x64', 'arm64'].includes(String(runtimeArch))) fail('RET001D_MANIFEST_SHAPE');
  const config = plainRecord(descriptorValue(root, 'config', 'RET001D_MANIFEST_SHAPE'), 'RET001D_MANIFEST_SHAPE');
  exactKeys(config, ['host', 'port', 'requestTimeoutMs', 'responseByteLimit', 'startupTimeoutMs', 'transport'], 'RET001D_MANIFEST_KEYS');
  const configValue = (key: string) => descriptorValue(config, key, 'RET001D_MANIFEST_SHAPE');
  if (!['127.0.0.1', '::1', 'localhost'].includes(String(configValue('host')))
    || !Number.isSafeInteger(configValue('port')) || Number(configValue('port')) < 1024 || Number(configValue('port')) > 65_535
    || configValue('transport') !== 'streamable-http-mcp'
    || !Number.isSafeInteger(configValue('requestTimeoutMs')) || Number(configValue('requestTimeoutMs')) < 100 || Number(configValue('requestTimeoutMs')) > 60_000
    || !Number.isSafeInteger(configValue('startupTimeoutMs')) || Number(configValue('startupTimeoutMs')) < 1_000 || Number(configValue('startupTimeoutMs')) > 600_000
    || configValue('responseByteLimit') !== MAX_TRACE_JSON_BYTES) fail('RET001D_MANIFEST_SHAPE');
  const result = plainRecord(descriptorValue(root, 'result', 'RET001D_MANIFEST_SHAPE'), 'RET001D_MANIFEST_SHAPE');
  exactKeys(result, ['cases', 'fidelity', 'invariants', 'readiness'], 'RET001D_MANIFEST_KEYS');
  if (descriptorValue(result, 'fidelity', 'RET001D_MANIFEST_SHAPE') !== 'composition-root / live-disposable-persistence') {
    fail('RET001D_MANIFEST_SHAPE');
  }
  const cases = denseArray(descriptorValue(result, 'cases', 'RET001D_MANIFEST_SHAPE'), 4, 'RET001D_MANIFEST_SHAPE');
  if (cases.length !== 4) fail('RET001D_MANIFEST_SHAPE');
  cases.forEach(assertCase);
  const expectedIds = ['auto', 'deterministic', 'named-tenant-forced-ranked', 'ranked'];
  const actualIds = cases.map((entry) => String(descriptorValue(entry as JsonRecord, 'id', 'RET001D_MANIFEST_SHAPE'))).sort();
  if (!isDeepStrictEqual(actualIds, expectedIds)) fail('RET001D_MANIFEST_SHAPE');
  const readiness = plainRecord(descriptorValue(result, 'readiness', 'RET001D_MANIFEST_SHAPE'), 'RET001D_MANIFEST_SHAPE');
  exactKeys(readiness, ['namedTenant', 'singleDefault'], 'RET001D_MANIFEST_KEYS');
  const singleDefault = plainRecord(
    descriptorValue(readiness, 'singleDefault', 'RET001D_MANIFEST_SHAPE'), 'RET001D_MANIFEST_SHAPE',
  );
  const namedTenant = plainRecord(
    descriptorValue(readiness, 'namedTenant', 'RET001D_MANIFEST_SHAPE'), 'RET001D_MANIFEST_SHAPE',
  );
  exactKeys(singleDefault, ['classification', 'httpStatus'], 'RET001D_MANIFEST_KEYS');
  exactKeys(namedTenant, ['classification', 'httpStatus'], 'RET001D_MANIFEST_KEYS');
  if (descriptorValue(singleDefault, 'httpStatus', 'RET001D_MANIFEST_SHAPE') !== 200
    || descriptorValue(singleDefault, 'classification', 'RET001D_MANIFEST_SHAPE') !== 'ready'
    || descriptorValue(namedTenant, 'httpStatus', 'RET001D_MANIFEST_SHAPE') !== 503
    || descriptorValue(namedTenant, 'classification', 'RET001D_MANIFEST_SHAPE')
      !== 'expected-logical-multitenant-degraded') fail('RET001D_MANIFEST_SHAPE');
  assertBooleanRecord(descriptorValue(result, 'invariants', 'RET001D_MANIFEST_SHAPE'), [
    'boundedExecution', 'canonicalValidation', 'noTraceParity', 'replayResultOrder', 'secretContentSafety', 'tenantIsolation',
  ]);
  const cleanup = plainRecord(descriptorValue(root, 'cleanup', 'RET001D_MANIFEST_SHAPE'), 'RET001D_MANIFEST_SHAPE');
  exactKeys(cleanup, [
    'childProcessesStopped', 'disposableServiceOwnership', 'fixtureNodesRemaining', 'fixtureRelationshipsRemaining',
    'redisKeysRemaining', 'temporaryExportPathRemoved',
  ], 'RET001D_MANIFEST_KEYS');
  if (descriptorValue(cleanup, 'fixtureNodesRemaining', 'RET001D_MANIFEST_SHAPE') !== 0
    || descriptorValue(cleanup, 'fixtureRelationshipsRemaining', 'RET001D_MANIFEST_SHAPE') !== 0
    || descriptorValue(cleanup, 'redisKeysRemaining', 'RET001D_MANIFEST_SHAPE') !== 0
    || descriptorValue(cleanup, 'childProcessesStopped', 'RET001D_MANIFEST_SHAPE') !== true
    || descriptorValue(cleanup, 'temporaryExportPathRemoved', 'RET001D_MANIFEST_SHAPE') !== true
    || descriptorValue(cleanup, 'disposableServiceOwnership', 'RET001D_MANIFEST_SHAPE') !== 'caller-provided-loopback-services') {
    fail('RET001D_MANIFEST_SHAPE');
  }
  const observedTruth = {
    git: { sha, dirty: false },
    runtime: { node: runtimeNode, platform: runtimePlatform, arch: runtimeArch },
    config: Object.fromEntries(
      ['host', 'port', 'requestTimeoutMs', 'responseByteLimit', 'startupTimeoutMs', 'transport']
        .map((key) => [key, configValue(key)]),
    ),
    services: (() => {
      const services = plainRecord(descriptorValue(root, 'services', 'RET001D_MANIFEST_SHAPE'), 'RET001D_MANIFEST_SHAPE');
      exactKeys(services, ['neo4j', 'redis'], 'RET001D_MANIFEST_KEYS');
      return {
        redis: serviceIdentity(descriptorValue(services, 'redis', 'RET001D_MANIFEST_SHAPE')),
        neo4j: serviceIdentity(descriptorValue(services, 'neo4j', 'RET001D_MANIFEST_SHAPE')),
      };
    })(),
  };
  const expectedTruth = {
    git: truth.git,
    runtime: truth.runtime,
    config: truth.config,
    services: truth.services,
  };
  if (!isDeepStrictEqual(observedTruth, expectedTruth)) fail('RET001D_MANIFEST_TRUTH_MISMATCH');
}

export function sanitizeTraceConformanceManifest(
  value: unknown,
  forbiddenValues: readonly string[],
  truth: TraceManifestTruth,
): unknown {
  const cloned = canonicalClone(value, forbiddenValues);
  assertTraceConformanceManifest(cloned, truth);
  return cloned;
}
