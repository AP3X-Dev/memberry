import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  canonicalTraceJson,
  RetrievalTraceCollector,
  type RetrievalTraceRequestShapeV1,
  type RetrievalTraceV1,
} from '../../../../packages/retrieval/src/index.js';
import {
  assertTraceConformanceManifest,
  inspectRet010dRerankerStage,
  inspectTraceToolResult,
  RET010D_RANKED_V2_TRACE_HARD_EVENT_LIMIT,
  sanitizeTraceConformanceManifest,
  TRACE_HARD_EVENT_LIMIT,
  traceHardEventLimitV1,
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

function ret010dManifestCase(
  id: 'authority-disabled-ranked' | 'authority-served-ranked'
    | 'authority-disabled-auto' | 'authority-served-auto'
    | 'authority-disabled-deterministic' | 'authority-served-deterministic',
): Record<string, unknown> {
  const served = id.includes('-served-');
  const requestedStrategy = id.endsWith('-deterministic') ? 'deterministic'
    : id.endsWith('-auto') ? 'auto' : 'ranked';
  const actualAlgorithm = served && requestedStrategy !== 'deterministic' ? 'ranked-v2' : 'ranked-v1';
  return {
    id,
    runtimeProfile: served ? 'served' : 'disabled',
    requestedStrategy,
    actualAlgorithm,
    contentBlocks: { omitted: 1, false: 1, traced: 2 },
    parity: { falseEqualsOmitted: true, tracedMarkdownEqualsOrdinary: true },
    presentationCount: 1,
    presentationOrderDigest: `sha256:${(served && requestedStrategy !== 'deterministic' ? 'd' : 'c').repeat(64)}`,
    rerankerStage: actualAlgorithm === 'ranked-v2' ? {
      present: true,
      outcome: 'reranked',
      candidateCount: 1,
      providerIdentity: 'memberry.local.lexical/bm25f-query-v1/fixed-blend-v1/local',
    } : { present: false },
    trace: {
      algorithmVersion: actualAlgorithm,
      complete: true,
      candidateCount: 1,
      eventCount: actualAlgorithm === 'ranked-v2' ? 7 : 6,
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

const ret010dIds = [
  'authority-disabled-ranked', 'authority-served-ranked',
  'authority-disabled-auto', 'authority-served-auto',
  'authority-disabled-deterministic', 'authority-served-deterministic',
] as const;

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
      ret010dCases: ret010dIds.map(ret010dManifestCase),
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
  it('retains the generic trace bound and reserves exactly one ranked-v2 event', () => {
    expect(TRACE_HARD_EVENT_LIMIT).toBe(8_192);
    expect(RET010D_RANKED_V2_TRACE_HARD_EVENT_LIMIT).toBe(8_193);
    expect(traceHardEventLimitV1('deterministic-v2')).toBe(8_192);
    expect(traceHardEventLimitV1('ranked-v1')).toBe(8_192);
    expect(traceHardEventLimitV1('ranked-v2')).toBe(8_193);
  });

  it('summarizes exactly one frozen ranked-v2 reranker stage without candidate content or IDs', () => {
    const request: RetrievalTraceRequestShapeV1 = {
      sources: { code: false, architecture: false, memory: true },
      projectScopeApplied: true,
      tenantScope: 'default',
      entityScope: 'few',
      tagScope: 'none',
      temporalFilterApplied: true,
      queryLength: 'short',
      queryForm: 'prose',
      tokenBudget: 'small',
      diversification: 'mmr',
      plannedChannels: ['memory.scope'],
    };
    const collector = new RetrievalTraceCollector('ranked-v2', request);
    collector.attemptChannel('memory.scope');
    collector.settleChannel('memory.scope', { outcome: 'success' });
    const handle = collector.addCandidate({
      sourceType: 'semantic', channels: [{ channel: 'memory.scope', rank: 1 }],
      evidence: { confidence: 0.8 }, estimatedTokens: 1,
    });
    collector.recordFilter(handle, { name: 'mmr', outcome: 'pass' });
    collector.recordMmrRound(1, handle, [{
      candidate: handle, relevance: 1, lambda: 1, pairwise: [],
    }]);
    collector.recordFilter(handle, { name: 'dedup', outcome: 'pass' });
    collector.recordRerankerStage([handle], {
      outcome: 'reranked', candidates: [{ candidateHandle: handle, calibratedScore: 1 }],
    });
    collector.recordFilter(handle, { name: 'token-budget', outcome: 'pass' });
    collector.recordTerminal(handle, { outcome: 'included', reasons: [] });
    collector.recordOutput(handle, 1);
    const trace = collector.finalize();
    const rankedMarkdown = markdown
      .replace('**Strategy:** deterministic | **Tokens:** ~4 | **Sources:** arch_entity:2, aspect:1, semantic:1 | **IDs:** 4',
        '**Strategy:** ranked | **Tokens:** ~1 | **Sources:** semantic:1 | **IDs:** 1')
      .replace(/## Architecture[\s\S]*$/, '## Knowledge\n\n<!-- item-a -->\nA');
    const summary = inspectRet010dRerankerStage(
      toolResult([rankedMarkdown, canonicalTraceJson(trace)]), 'reranked',
    );
    expect(summary).toEqual({
      present: true,
      outcome: 'reranked',
      candidateCount: 1,
      providerIdentity: 'memberry.local.lexical/bm25f-query-v1/fixed-blend-v1/local',
    });
    expect(JSON.stringify(summary)).not.toContain('item-a');
  });

  it('keeps the original four cases exact while requiring six closed RET-010D profiles', () => {
    const manifest = validManifest() as any;
    expect(manifest.result.cases.map((entry: any) => entry.id)).toEqual([
      'deterministic', 'ranked', 'auto', 'named-tenant-forced-ranked',
    ]);
    expect(manifest.result.ret010dCases.map((entry: any) => [
      entry.id, entry.runtimeProfile, entry.requestedStrategy, entry.actualAlgorithm,
    ])).toEqual([
      ['authority-disabled-ranked', 'disabled', 'ranked', 'ranked-v1'],
      ['authority-served-ranked', 'served', 'ranked', 'ranked-v2'],
      ['authority-disabled-auto', 'disabled', 'auto', 'ranked-v1'],
      ['authority-served-auto', 'served', 'auto', 'ranked-v2'],
      ['authority-disabled-deterministic', 'disabled', 'deterministic', 'ranked-v1'],
      ['authority-served-deterministic', 'served', 'deterministic', 'ranked-v1'],
    ]);
    expect(() => assertTraceConformanceManifest(manifest, manifestTruth(manifest) as never)).not.toThrow();
  });
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
    ['missing profile case', (manifest: any) => { manifest.result.ret010dCases.pop(); }],
    ['duplicate profile case', (manifest: any) => {
      manifest.result.ret010dCases[5] = structuredClone(manifest.result.ret010dCases[0]);
    }],
    ['foreign profile id', (manifest: any) => { manifest.result.ret010dCases[0].id = 'authority-shadow-ranked'; }],
    ['wrong served algorithm', (manifest: any) => {
      manifest.result.ret010dCases[1].actualAlgorithm = 'ranked-v1';
    }],
    ['missing served reranker event', (manifest: any) => {
      manifest.result.ret010dCases[1].rerankerStage = { present: false };
    }],
    ['invented deterministic reranker event', (manifest: any) => {
      manifest.result.ret010dCases[5].rerankerStage = structuredClone(
        manifest.result.ret010dCases[1].rerankerStage,
      );
    }],
    ['unchanged served ranked control', (manifest: any) => {
      manifest.result.ret010dCases[1].presentationOrderDigest =
        manifest.result.ret010dCases[0].presentationOrderDigest;
    }],
    ['changed deterministic bypass', (manifest: any) => {
      manifest.result.ret010dCases[5].presentationOrderDigest = `sha256:${'e'.repeat(64)}`;
    }],
  ])('rejects RET-010D %s', (_label, mutate) => {
    const manifest = validManifest();
    mutate(manifest);
    expect(() => assertTraceConformanceManifest(manifest, manifestTruth() as never)).toThrow(/^RET010D_/);
  });

  it.each([
    [512, false],
    [513, true],
  ] as const)('enforces the exact RET-010D candidate-count boundary at %i', (candidateCount, rejected) => {
    const manifest = validManifest() as any;
    const trace = manifest.result.ret010dCases[0].trace;
    trace.candidateCount = candidateCount;
    trace.terminalCount = candidateCount;
    const assertion = () => assertTraceConformanceManifest(manifest, manifestTruth() as never);
    if (rejected) expect(assertion).toThrow('RET010D_MANIFEST_SHAPE');
    else expect(assertion).not.toThrow();
  });

  it.each([
    ['ranked-v1', 8_192, false],
    ['ranked-v1', 8_193, true],
    ['ranked-v2', 8_193, false],
    ['ranked-v2', 8_194, true],
  ] as const)('enforces the %s RET-010D event boundary at %i', (algorithm, eventCount, rejected) => {
    const manifest = validManifest() as any;
    const trace = manifest.result.ret010dCases[algorithm === 'ranked-v2' ? 1 : 0].trace;
    trace.eventCount = eventCount;
    const assertion = () => assertTraceConformanceManifest(manifest, manifestTruth() as never);
    if (rejected) expect(assertion).toThrow('RET010D_MANIFEST_SHAPE');
    else expect(assertion).not.toThrow();
  });

  it('rejects a RET-010D presentation count that differs from trace result count', () => {
    const manifest = validManifest() as any;
    manifest.result.ret010dCases[0].presentationCount = 2;
    expect(() => assertTraceConformanceManifest(manifest, manifestTruth() as never))
      .toThrow('RET010D_MANIFEST_SHAPE');
  });

  it('rejects a ranked-v2 reranker candidate count larger than the trace candidate set', () => {
    const manifest = validManifest() as any;
    manifest.result.ret010dCases[1].rerankerStage.candidateCount = 2;
    expect(() => assertTraceConformanceManifest(manifest, manifestTruth() as never))
      .toThrow('RET010D_MANIFEST_SHAPE');
  });

  it('rejects a deterministic matched pair with different presentation counts', () => {
    const manifest = validManifest() as any;
    const served = manifest.result.ret010dCases[5];
    served.presentationCount = 2;
    served.trace.resultCount = 2;
    served.trace.candidateCount = 2;
    served.trace.terminalCount = 2;
    expect(() => assertTraceConformanceManifest(manifest, manifestTruth() as never))
      .toThrow('RET010D_MANIFEST_SHAPE');
  });

  it('sanitizes RET-010D receipts without query, content, private IDs, scope names, or provider bytes', () => {
    const manifest = validManifest();
    const truth = manifestTruth(manifest);
    const forbidden = [
      'query bytes', 'source content', 'private-id', 'project:secret',
      '{"contractId":"memberry.reranker"}',
    ];
    const sanitized = sanitizeTraceConformanceManifest(manifest, forbidden, truth as never);
    const bytes = JSON.stringify(sanitized);
    for (const value of forbidden) expect(bytes).not.toContain(value);
    expect(() => sanitizeTraceConformanceManifest(
      { ...manifest, leaked: forbidden[0] }, forbidden, truth as never,
    )).toThrow('RET001D_MANIFEST_FORBIDDEN_VALUE');
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
