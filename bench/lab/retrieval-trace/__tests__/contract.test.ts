import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  canonicalTraceJson,
  RetrievalTraceCollector,
  type RetrievalTraceV1,
} from '../../../../packages/retrieval/src/index.js';
import {
  assertTraceConformanceManifest,
  inspectTraceToolResult,
  sanitizeTraceConformanceManifest,
} from '../contract.js';

const approvedTrace = JSON.parse(readFileSync(
  new URL('../../../../packages/retrieval/src/__tests__/fixtures/retrieval-trace-deterministic-v2.json', import.meta.url),
  'utf8',
)) as RetrievalTraceV1;

const markdown = [
  '# Unified Context',
  '**Task:** fixture query',
  '**Strategy:** deterministic | **Tokens:** ~4 | **Sources:** arch_entity:2, aspect:1, semantic:1 | **IDs:** 4',
  '',
  '## Architecture',
  '',
  '<!-- item-a -->',
  'A',
  '<!-- item-b -->',
  'B',
  '## Cross-Cutting Concerns',
  '',
  '<!-- item-c -->',
  'C',
  '## Knowledge',
  '',
  '<!-- item-d -->',
  'D',
].join('\n');

function toolResult(parts: string[]): unknown {
  return { content: parts.map((text) => ({ type: 'text', text })) };
}

const liveExpectation = {
  expectedTask: 'fixture query',
  expectedStrategy: 'deterministic',
  expectedResultIds: ['item-a', 'item-b', 'item-c', 'item-d'],
} as const;

function manifestCase(
  id: 'deterministic' | 'ranked' | 'auto' | 'named-tenant-forced-ranked',
): Record<string, unknown> {
  const actualAlgorithm = id === 'deterministic' || id === 'auto' ? 'deterministic-v2' : 'ranked-v1';
  const requestedStrategy = id === 'named-tenant-forced-ranked' ? 'deterministic' : id;
  return {
    id,
    requestedStrategy,
    actualAlgorithm,
    authScope: id === 'named-tenant-forced-ranked' ? 'named-tenant' : 'default',
    contentBlocks: { omitted: 1, false: 1, traced: 2 },
    parity: { falseEqualsOmitted: true, tracedMarkdownEqualsOrdinary: true },
    trace: {
      algorithmVersion: actualAlgorithm,
      complete: true,
      candidateCount: 1,
      eventCount: 4,
      resultCount: 1,
      exclusionCount: 0,
      plannedChannelCount: 1,
      settledChannelCount: 1,
      terminalCount: 1,
      canonical: true,
      replayEquivalent: true,
      channelSettlementComplete: true,
      terminalCoverageComplete: true,
      markdownResultCountEquivalent: true,
      resultOrderBindingDigest: `sha256:${'b'.repeat(64)}`,
      replayStateDigest: `sha256:${'a'.repeat(64)}`,
    },
  };
}

function validManifest(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    packet: 'RET-001D',
    generatedAt: '2026-08-15T00:00:00.000Z',
    git: { sha: 'b'.repeat(40), dirty: false },
    runtime: { node: 'v22.23.0', platform: 'linux', arch: 'x64' },
    config: {
      host: '127.0.0.1', port: 3411, transport: 'streamable-http-mcp',
      requestTimeoutMs: 10_000, startupTimeoutMs: 300_000, responseByteLimit: 4_194_304,
    },
    services: {
      redis: {
        containerId: 'c'.repeat(64), imageId: `sha256:${'d'.repeat(64)}`, version: '7.4.1',
      },
      neo4j: {
        containerId: 'e'.repeat(64), imageId: `sha256:${'f'.repeat(64)}`, version: '5.26.12',
      },
    },
    result: {
      fidelity: 'composition-root / live-disposable-persistence',
      cases: ['deterministic', 'ranked', 'auto', 'named-tenant-forced-ranked'].map((id) =>
        manifestCase(id as Parameters<typeof manifestCase>[0])),
      readiness: {
        singleDefault: { httpStatus: 200, classification: 'ready' },
        namedTenant: { httpStatus: 503, classification: 'expected-logical-multitenant-degraded' },
      },
      invariants: {
        canonicalValidation: true,
        replayResultOrder: true,
        noTraceParity: true,
        secretContentSafety: true,
        boundedExecution: true,
        tenantIsolation: true,
      },
    },
    cleanup: {
      fixtureNodesRemaining: 0,
      fixtureRelationshipsRemaining: 0,
      redisKeysRemaining: 0,
      childProcessesStopped: true,
      temporaryExportPathRemoved: true,
      disposableServiceOwnership: 'caller-provided-loopback-services',
    },
  };
}

function manifestTruth(manifest: Record<string, unknown> = validManifest()): Record<string, unknown> {
  return {
    git: structuredClone(manifest.git),
    runtime: structuredClone(manifest.runtime),
    config: structuredClone(manifest.config),
    services: structuredClone(manifest.services),
  };
}

describe('RET-001D trace conformance contract', () => {
  it.each(['omitted', 'false'] as const)('proves %s include_trace is an exact one-block path', (mode) => {
    expect(inspectTraceToolResult(toolResult([markdown]), { mode, ...liveExpectation } as never)).toEqual({
      markdown,
      contentBlockCount: 1,
    });
  });

  it('accepts only canonical complete traces whose replay and markdown result counts agree', () => {
    const inspected = inspectTraceToolResult(toolResult([markdown, canonicalTraceJson(approvedTrace)]), {
      mode: 'true',
      expectedAlgorithm: 'deterministic-v2',
      forbiddenValues: ['fixture query', 'secret-token'],
      ...liveExpectation,
    });
    expect(inspected).toMatchObject({
      markdown,
      contentBlockCount: 2,
      trace: {
        algorithmVersion: 'deterministic-v2',
        complete: true,
        candidateCount: 5,
        eventCount: 26,
        resultCount: 4,
        canonical: true,
        replayEquivalent: true,
        channelSettlementComplete: true,
        terminalCoverageComplete: true,
        markdownResultCountEquivalent: true,
      },
    });
  });

  it.each([
    ['malformed json', '{'],
    ['incomplete trace', canonicalTraceJson({ ...approvedTrace, complete: false, incompleteReasons: ['channel-gap'] })],
    ['mismatched algorithm', canonicalTraceJson(approvedTrace)],
    ['replay mismatch', JSON.stringify({ ...approvedTrace, resultOrder: [...approvedTrace.resultOrder].reverse() })],
  ])('fails closed for %s', (_label, traceText) => {
    const expectedAlgorithm = _label === 'mismatched algorithm' ? 'ranked-v1' : 'deterministic-v2';
    expect(() => inspectTraceToolResult(toolResult([markdown, traceText]), {
      mode: 'true',
      expectedAlgorithm,
      forbiddenValues: ['fixture query'],
      ...liveExpectation,
    })).toThrow(/^RET001D_/);
  });

  it('rejects oversized trace text before JSON parsing', () => {
    expect(() => inspectTraceToolResult(toolResult([markdown, 'x'.repeat(4_194_305)]), {
      mode: 'true',
      expectedAlgorithm: 'deterministic-v2',
      ...liveExpectation,
    })).toThrow('RET001D_TRACE_TOO_LARGE');
  });

  it('binds the live markdown task, strategy, result IDs, and source counts to the trace', () => {
    const traceText = canonicalTraceJson(approvedTrace);
    for (const invalidMarkdown of [
      markdown.replace('**Task:** fixture query', '**Task:** substituted query'),
      markdown.replace('**Strategy:** deterministic', '**Strategy:** ranked'),
      markdown.replace('<!-- item-a -->', '<!-- wrong-id -->'),
      markdown.replace('arch_entity:2, aspect:1, semantic:1', 'arch_entity:4'),
    ]) {
      expect(() => inspectTraceToolResult(toolResult([invalidMarkdown, traceText]), {
        mode: 'true', expectedAlgorithm: 'deterministic-v2', ...liveExpectation,
      } as never)).toThrow(/^RET001D_/);
    }
  });

  it('rejects reordered same-source Markdown items instead of accepting aggregate equivalence', () => {
    const first = '<!-- item-a -->\nA';
    const second = '<!-- item-b -->\nB';
    const reordered = markdown.replace(`${first}\n${second}`, `${second}\n${first}`);
    expect(() => inspectTraceToolResult(toolResult([reordered, canonicalTraceJson(approvedTrace)]), {
      mode: 'true', expectedAlgorithm: 'deterministic-v2', ...liveExpectation,
    })).toThrow('RET001D_MARKDOWN_RESULT_ORDER_MISMATCH');
  });

  it('rejects a complete but vacuous trace and empty seeded presentation', () => {
    const collector = new RetrievalTraceCollector('deterministic-v2', approvedTrace.requestShape);
    for (const channel of approvedTrace.requestShape.plannedChannels) {
      collector.attemptChannel(channel);
      collector.settleChannel(channel, { outcome: 'success' });
    }
    const emptyTrace = collector.finalize();
    const emptyMarkdown = markdown
      .replace('arch_entity:2, aspect:1, semantic:1', 'none')
      .replace('**IDs:** 4', '**IDs:** 0')
      .split('\n').slice(0, 4).join('\n');
    expect(() => inspectTraceToolResult(toolResult([emptyMarkdown, canonicalTraceJson(emptyTrace)]), {
      mode: 'true', expectedAlgorithm: 'deterministic-v2',
      expectedTask: 'fixture query', expectedStrategy: 'deterministic', expectedResultIds: [],
    } as never)).toThrow('RET001D_SEEDED_RESULT_EMPTY');
  });

  it('requires exact sanitized manifest keys and never invokes accessors', () => {
    const getter = { reads: 0 };
    const hostile = Object.defineProperty({}, 'packet', {
      enumerable: true,
      get() { getter.reads += 1; return 'RET-001D'; },
    });
    expect(() => sanitizeTraceConformanceManifest(hostile, [], manifestTruth() as never))
      .toThrow('RET001D_MANIFEST_NONCANONICAL');
    expect(getter.reads).toBe(0);

    const truth = manifestTruth();
    const manifest = sanitizeTraceConformanceManifest(validManifest(), ['secret-token'], truth as never);
    expect(() => assertTraceConformanceManifest({ ...manifest as object, extra: true }, truth as never))
      .toThrow('RET001D_MANIFEST_KEYS');
    expect(JSON.stringify(manifest)).not.toContain('secret-token');
    expect(() => sanitizeTraceConformanceManifest({ value: 'secret-token' }, ['secret-token'], truth as never))
      .toThrow('RET001D_MANIFEST_FORBIDDEN_VALUE');
  });

  it.each([
    ['empty case set', (manifest: any) => { manifest.result.cases = []; }],
    ['dirty git state', (manifest: any) => { manifest.git.dirty = true; }],
    ['invented runtime', (manifest: any) => { manifest.runtime = { node: 'browser', platform: 'web', arch: 'unknown' }; }],
    ['redirected config', (manifest: any) => { manifest.config.host = '0.0.0.0'; }],
    ['wrong transport', (manifest: any) => { manifest.config.transport = 'sse'; }],
    ['wrong fidelity', (manifest: any) => { manifest.result.fidelity = 'fixture'; }],
    ['wrong ownership', (manifest: any) => { manifest.cleanup.disposableServiceOwnership = 'shared-services'; }],
    ['mutable Redis image claim', (manifest: any) => { manifest.services.redis.imageId = 'redis:7-alpine'; }],
    ['missing Neo4j version', (manifest: any) => { manifest.services.neo4j.version = ''; }],
    ['vacuous case', (manifest: any) => {
      manifest.result.cases[0].trace.candidateCount = 0;
      manifest.result.cases[0].trace.resultCount = 0;
      manifest.result.cases[0].trace.terminalCount = 0;
    }],
  ])('rejects %s in a purported live manifest', (_label, mutate) => {
    const manifest = validManifest();
    mutate(manifest);
    expect(() => assertTraceConformanceManifest(manifest, manifestTruth() as never)).toThrow(/^RET001D_/);
  });

  it.each([
    ['another valid Node runtime', (manifest: any) => { manifest.runtime.node = 'v22.22.0'; }],
    ['another valid loopback port', (manifest: any) => { manifest.config.port = 3412; }],
    ['another plausible Redis image', (manifest: any) => {
      manifest.services.redis.imageId = `sha256:${'0'.repeat(64)}`;
    }],
    ['another plausible Neo4j version', (manifest: any) => { manifest.services.neo4j.version = '5.26.13'; }],
  ])('binds the manifest to the observed %s instead of accepting plausible metadata', (_label, mutate) => {
    const manifest = validManifest();
    const truth = manifestTruth(manifest);
    mutate(manifest);
    expect(() => assertTraceConformanceManifest(manifest, truth as never))
      .toThrow('RET001D_MANIFEST_TRUTH_MISMATCH');
  });
});
