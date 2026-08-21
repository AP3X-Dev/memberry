import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { UnifiedAssembler } from '../assembler.js';
import { assertRetrievalTraceConformant, assertRetrievalTraceSecretSafe, replayRetrievalTrace } from '../trace.js';
import type { RetrievalTraceV1 } from '../trace.js';
import { RankedRuntimeTraceAdapter } from '../runtime-trace.js';
import { applyServedRerankerV1, createServedRerankerProviderV1 } from '../served-reranker.js';
import type { RetrievalResult } from '../types.js';

const CANARY_ID = 'raw-private-sk_live_12345678901234567890';
const ASSEMBLED_AT = '2026-08-18T00:00:00.000Z';
const DETERMINISTIC_TRACE = JSON.parse(readFileSync(
  new URL('./fixtures/retrieval-trace-deterministic-v2.json', import.meta.url),
  'utf8',
)) as RetrievalTraceV1;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function makeAssembler(codeDelay: number, memoryDelay: number, malformed = false) {
  const codeResult = {
    id: CANARY_ID,
    source_type: 'symbol', name: 'alpha', kind: 'function', file_path: 'src/a.ts', start_line: 1,
    signature: 'function alpha()', doc_comment: '', score: 0.9,
  };
  const codeLayer = {
    search: vi.fn(async () => [codeResult]),
    searchObserved: vi.fn(async () => {
      await delay(codeDelay);
      return {
        value: [codeResult],
        observation: {
          channels: [{ channel: 'code.fulltext', outcome: 'success' }],
          candidates: malformed ? [] : [{
            privateId: CANARY_ID,
            sourceType: 'symbol',
            channels: [{ channel: 'code.fulltext', rank: 1, score: 0.9 }],
            evidence: {}, estimatedTokens: 4,
          }],
          finalIds: [CANARY_ID],
        },
      };
    }),
  };
  const memoryValue = {
    markdown: '## [sem-1] (confidence: 0.90)\nremembered',
    tokens: 10,
    sources: ['sem-1'],
    assembled_at: ASSEMBLED_AT,
  };
  const memoryLayer = {
    load: vi.fn(async () => memoryValue),
    loadFreshObserved: vi.fn(async () => {
      await delay(memoryDelay);
      return {
        value: memoryValue,
        observation: {
          channels: [{ channel: 'memory.scope', outcome: 'success' }],
          candidates: [{
            privateId: 'sem-1', sourceType: 'semantic',
            channels: [{ channel: 'memory.scope', rank: 1 }],
            evidence: { confidence: 0.9 }, estimatedTokens: 3,
          }],
          finalIds: ['sem-1'],
        },
      };
    }),
  };
  const driver = {
    session: () => ({
      run: vi.fn(async () => ({ records: [{ get: () => 0 }] })),
      close: vi.fn(async () => undefined),
    }),
  };
  const redis = { get: vi.fn(async () => null), set: vi.fn(async () => undefined) };
  const embedding = { available: false, embed: vi.fn(), embedBatch: vi.fn() };
  return { assembler: new UnifiedAssembler(driver as never, redis, codeLayer, memoryLayer, embedding), codeLayer, memoryLayer };
}

interface ParityAssemblerOptions {
  task: string;
  codeDelay?: number;
  memoryDelay?: number;
  codeId?: string;
  codeReject?: boolean;
  memoryMarkdown: string;
  memorySources: string[];
}

const PARITY_CODE_RESULT = {
  source_type: 'symbol' as const,
  name: 'alpha',
  kind: 'function',
  file_path: 'src/a.ts',
  start_line: 1,
  signature: 'function alpha()',
  doc_comment: '',
  score: 0.5,
};

const PARITY_CODE_CONTENT = '**alpha** (function) — `src/a.ts:1`\n`function alpha()`';

function makeParityAssembler(options: ParityAssemblerOptions) {
  const codeId = options.codeId ?? 'code-tie';
  const codeResult = { id: codeId, ...PARITY_CODE_RESULT };
  const memoryValue = {
    markdown: options.memoryMarkdown,
    tokens: 10,
    sources: options.memorySources,
    assembled_at: ASSEMBLED_AT,
  };
  const codeLayer = {
    search: vi.fn(async () => {
      await delay(options.codeDelay ?? 0);
      if (options.codeReject) throw new Error('ordinary code failure');
      return [codeResult];
    }),
    searchObserved: vi.fn(async () => {
      await delay(options.codeDelay ?? 0);
      if (options.codeReject) throw new Error('observed code failure');
      return {
        value: [codeResult],
        observation: {
          channels: [{ channel: 'code.fulltext', outcome: 'success' }],
          candidates: [{
            privateId: codeId,
            sourceType: 'symbol',
            channels: [{ channel: 'code.fulltext', rank: 1, score: 0.5 }],
            evidence: {},
            estimatedTokens: 4,
          }],
          finalIds: [codeId],
        },
      };
    }),
  };
  const memoryLayer = {
    load: vi.fn(async () => {
      await delay(options.memoryDelay ?? 0);
      return memoryValue;
    }),
    loadFreshObserved: vi.fn(async () => {
      await delay(options.memoryDelay ?? 0);
      return {
        value: memoryValue,
        observation: {
          channels: [{ channel: 'memory.scope', outcome: 'success' }],
          candidates: options.memorySources.map((privateId, index) => ({
            privateId,
            sourceType: 'semantic',
            channels: [{ channel: 'memory.scope', rank: index + 1 }],
            evidence: {},
            estimatedTokens: 4,
          })),
          finalIds: options.memorySources,
        },
      };
    }),
  };
  const driver = {
    session: () => ({
      run: vi.fn(async () => ({ records: [{ get: () => 0 }] })),
      close: vi.fn(async () => undefined),
    }),
  };
  const redis = { get: vi.fn(async () => null), set: vi.fn(async () => undefined) };
  const embedding = { available: false, embed: vi.fn(), embedBatch: vi.fn() };
  return new UnifiedAssembler(driver as never, redis, codeLayer, memoryLayer, embedding);
}

function orderedIds(context: Awaited<ReturnType<UnifiedAssembler['assemble']>>): string[] {
  return context.sections.flatMap((section) => section.items.map((item) => item.id));
}

describe('UnifiedAssembler.assembleTraced ranked runtime', () => {
  it('keeps ordinary and traced presentation identical for an exact nonempty AMP wrapper', async () => {
    const task = 'exact wrapped task';
    const assembler = makeParityAssembler({
      task,
      memoryMarkdown: `# Memory Context\n\n**Task:** ${task}\n\n## [sem-wrapper] (confidence: 0.90)\nremembered`,
      memorySources: ['sem-wrapper'],
    });
    const options = { strategy: 'ranked' as const, include_arch: false, include_code: false };

    const ordinary = await assembler.assemble(task, options);
    const traced = await assembler.assembleTraced(task, options);

    expect(orderedIds(ordinary)).toEqual(['sem-wrapper']);
    expect(orderedIds(traced.context)).toEqual(['sem-wrapper']);
    expect(assembler.renderMarkdown(ordinary)).toBe(assembler.renderMarkdown(traced.context));
    expect(assembler.renderMarkdown(ordinary)).not.toContain('<!-- mem-');
  });

  it('treats the exact empty AMP wrapper as no memory in both modes', async () => {
    const task = 'exact empty task';
    const assembler = makeParityAssembler({
      task,
      memoryMarkdown: `# Memory Context\n\n_No relevant memories found for task: ${task}_\n`,
      memorySources: [],
    });
    const options = { strategy: 'ranked' as const, include_arch: false, include_code: false };

    const ordinary = await assembler.assemble(task, options);
    const traced = await assembler.assembleTraced(task, options);

    expect(orderedIds(ordinary)).toEqual([]);
    expect(orderedIds(traced.context)).toEqual([]);
    expect(assembler.renderMarkdown(ordinary)).toBe(assembler.renderMarkdown(traced.context));
    expect(assembler.renderMarkdown(ordinary)).not.toContain('<!-- mem-');
  });

  it('keeps equal-score ranked output canonical across opposite settlement permutations', async () => {
    const task = 'settlement parity';
    const memoryMarkdown = '## [memory-tie]\nneutral memory';
    const options = { strategy: 'ranked' as const, include_arch: false };
    const memoryFirst = makeParityAssembler({
      task, codeDelay: 20, memoryDelay: 1, memoryMarkdown, memorySources: ['memory-tie'],
    });
    const codeFirst = makeParityAssembler({
      task, codeDelay: 1, memoryDelay: 20, memoryMarkdown, memorySources: ['memory-tie'],
    });

    const memoryFirstOrdinary = await memoryFirst.assemble(task, options);
    const codeFirstOrdinary = await codeFirst.assemble(task, options);
    const memoryFirstTraced = await memoryFirst.assembleTraced(task, options);
    const codeFirstTraced = await codeFirst.assembleTraced(task, options);

    expect(orderedIds(memoryFirstOrdinary)).toEqual(['memory-tie', 'code-tie']);
    expect(orderedIds(codeFirstOrdinary)).toEqual(['memory-tie', 'code-tie']);
    expect(memoryFirst.renderMarkdown(memoryFirstOrdinary)).toBe(
      memoryFirst.renderMarkdown(memoryFirstTraced.context),
    );
    expect(codeFirst.renderMarkdown(codeFirstOrdinary)).toBe(
      codeFirst.renderMarkdown(codeFirstTraced.context),
    );
  });

  it('preserves ordinary and traced parity when a ranked channel rejects safely', async () => {
    const task = 'safe failure task';
    const assembler = makeParityAssembler({
      task,
      codeReject: true,
      memoryMarkdown: `# Memory Context\n\n**Task:** ${task}\n\n## [safe-memory]\nsurvives`,
      memorySources: ['safe-memory'],
    });
    const options = { strategy: 'ranked' as const, include_arch: false };

    const ordinary = await assembler.assemble(task, options);
    const traced = await assembler.assembleTraced(task, options);

    expect(orderedIds(ordinary)).toEqual(['safe-memory']);
    expect(orderedIds(traced.context)).toEqual(['safe-memory']);
    expect(assembler.renderMarkdown(ordinary)).toBe(assembler.renderMarkdown(traced.context));
    expect(traced.trace.events).toContainEqual(expect.objectContaining({
      kind: 'channel-terminal', channel: 'code.fulltext', outcome: 'safe-failure', code: 'query-failed',
    }));
  });

  it('keeps the canonical memory representative for equal-length duplicate cross-channel IDs', async () => {
    const task = 'duplicate parity';
    const heading = '[shared-id]';
    const memoryContent = `${heading}\n${'m'.repeat(PARITY_CODE_CONTENT.length - heading.length - 1)}`;
    expect(memoryContent).toHaveLength(PARITY_CODE_CONTENT.length);
    const assembler = makeParityAssembler({
      task,
      codeDelay: 1,
      memoryDelay: 20,
      codeId: 'shared-id',
      memoryMarkdown: `## ${memoryContent}`,
      memorySources: ['shared-id'],
    });
    const options = { strategy: 'ranked' as const, include_arch: false };

    const ordinary = await assembler.assemble(task, options);
    const traced = await assembler.assembleTraced(task, options);

    expect(orderedIds(ordinary)).toEqual(['shared-id']);
    expect(ordinary.sections[0]?.source_type).toBe('semantic');
    expect(ordinary.sections[0]?.items[0]?.content).toBe(memoryContent);
    expect(assembler.renderMarkdown(ordinary)).toBe(assembler.renderMarkdown(traced.context));
  });

  it('is deterministic across source settlement permutations, secret-safe, and does not use ordinary layer methods', async () => {
    const first = makeAssembler(20, 1);
    const second = makeAssembler(1, 20);
    const options = { strategy: 'ranked' as const, include_arch: false, max_tokens: 1000 };

    const a = await first.assembler.assembleTraced('find alpha', options);
    const b = await second.assembler.assembleTraced('find alpha', options);

    expect(a.context.sections).toEqual(b.context.sections);
    expect(a.trace).toEqual(b.trace);
    expect(first.codeLayer.search).not.toHaveBeenCalled();
    expect(first.memoryLayer.load).not.toHaveBeenCalled();
    expect(a.trace.incompleteReasons).toEqual([]);
    assertRetrievalTraceConformant(a.trace);
    assertRetrievalTraceSecretSafe(a.trace);
    expect(JSON.stringify(a.trace)).not.toContain(CANARY_ID);
    expect([...new Set(a.trace.events.map((event) => event.kind))]).toEqual(expect.arrayContaining([
      'channel-attempt', 'channel-terminal', 'candidate-filter', 'candidate-score',
      'mmr-round', 'ranked-output', 'candidate-terminal',
    ]));
    expect(a.trace.events.filter((event) => event.kind === 'candidate-score').map((event) => event.name))
      .toEqual(expect.arrayContaining(['rrf', 'feedback-multiplier', 'provenance-multiplier', 'lexical-multiplier', 'final']));
    expect(a.trace.events).toContainEqual(expect.objectContaining({ kind: 'candidate-filter', name: 'dedup', outcome: 'pass' }));
    expect(a.trace.events).toContainEqual(expect.objectContaining({
      kind: 'stage-failure', stage: 'embedding', code: 'unavailable',
    }));
  });

  it('returns unchanged context with an explicit incomplete trace when structural observation is malformed', async () => {
    const { assembler } = makeAssembler(0, 0, true);
    const result = await assembler.assembleTraced('find alpha', { strategy: 'ranked', include_arch: false });
    expect(result.context.sections.flatMap((section) => section.items).some((item) => item.id === CANARY_ID)).toBe(true);
    expect(result.trace.complete).toBe(false);
    expect(result.trace.incompleteReasons.length).toBeGreaterThan(0);
  });

  it('routes traced auto requests through the actual ranked algorithm', async () => {
    const { assembler } = makeAssembler(0, 0);
    const result = await assembler.assembleTraced('find alpha', { strategy: 'auto', include_arch: false });

    expect(result.context.strategy).toBe('ranked');
    expect(result.trace.algorithmVersion).toBe('ranked-v1');
  });

  it('routes traced auto graph requests through the actual deterministic algorithm', async () => {
    const { assembler } = makeAssembler(0, 0);
    const deterministic = {
      assembleTraced: vi.fn().mockResolvedValue({ sections: [], trace: DETERMINISTIC_TRACE }),
    };
    (assembler as unknown as { deterministic: typeof deterministic }).deterministic = deterministic;

    const result = await assembler.assembleTraced('what depends on auth', { strategy: 'auto' });

    expect(deterministic.assembleTraced).toHaveBeenCalledTimes(1);
    expect(result.context.strategy).toBe('deterministic');
    expect(result.trace.algorithmVersion).toBe('deterministic-v2');
  });

  it('records a safe channel failure after settlement without changing surviving context', async () => {
    const { assembler, codeLayer } = makeAssembler(0, 0);
    const failure = new Error('private backend detail');
    Object.defineProperty(failure, 'observation', {
      value: {
        channels: [{ channel: 'code.fulltext', outcome: 'safe-failure', code: 'query-failed' }],
        candidates: [], finalIds: [],
      },
      enumerable: false,
    });
    codeLayer.searchObserved.mockRejectedValueOnce(failure);

    const result = await assembler.assembleTraced('find alpha', { strategy: 'ranked', include_arch: false });
    expect(result.context.sections.flatMap((section) => section.items).some((item) => item.id === CANARY_ID)).toBe(false);
    expect(result.trace.complete).toBe(true);
    expect(result.trace.events).toContainEqual(expect.objectContaining({
      kind: 'channel-terminal', channel: 'code.fulltext', outcome: 'safe-failure', code: 'query-failed',
    }));
    expect(JSON.stringify(result.trace)).not.toContain('private backend detail');
  });

  it('preserves real ordinary-only port results but fails the trace closed', async () => {
    const codeLayer = {
      search: vi.fn(async () => [{
        id: 'ordinary-code', source_type: 'symbol', name: 'ordinary', kind: 'function',
        file_path: 'src/ordinary.ts', start_line: 1, signature: 'ordinary()', doc_comment: '', score: 0.9,
      }]),
    };
    const memoryLayer = {
      load: vi.fn(async () => ({
        markdown: '# Memory Context\n\n**Task:** ordinary ports\n\n## [ordinary-memory] (confidence: 0.90)\nremembered',
        tokens: 5,
        sources: ['ordinary-memory'],
        assembled_at: ASSEMBLED_AT,
      })),
    };
    const driver = { session: () => ({ run: vi.fn(async () => ({ records: [] })), close: vi.fn() }) };
    const redis = { get: vi.fn(async () => null), set: vi.fn(async () => undefined) };
    const embedding = { available: false, embed: vi.fn(), embedBatch: vi.fn() };
    const assembler = new UnifiedAssembler(driver as never, redis, codeLayer, memoryLayer, embedding);

    const result = await assembler.assembleTraced('ordinary ports', { include_arch: false });

    expect(result.context.sections.flatMap((section) => section.items).map((item) => item.id))
      .toEqual(expect.arrayContaining(['ordinary-code', 'ordinary-memory']));
    expect(result.trace.complete).toBe(false);
    expect(result.trace.incompleteReasons).toContain('candidate-output-gap');
  });

  it('does not execute proxy descriptor traps or expose their canary', async () => {
    const { assembler, codeLayer } = makeAssembler(0, 0);
    let descriptorTraps = 0;
    const hostile = new Proxy(new Error('proxy-sk_live_12345678901234567890'), {
      getOwnPropertyDescriptor() {
        descriptorTraps += 1;
        throw new Error('descriptor-sk_live_12345678901234567890');
      },
    });
    codeLayer.searchObserved.mockRejectedValueOnce(hostile);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const result = await assembler.assembleTraced('proxy failure', { include_arch: false });

    expect(descriptorTraps).toBe(0);
    expect(JSON.stringify(result.trace)).not.toContain('sk_live');
    expect(JSON.stringify(errorSpy.mock.calls)).not.toContain('sk_live');
    errorSpy.mockRestore();
  });

  it('does not execute nested structural observation accessors', async () => {
    const { assembler, codeLayer } = makeAssembler(0, 0);
    let getterCalls = 0;
    const hostileChannel = { outcome: 'safe-failure', code: 'query-failed' } as Record<string, unknown>;
    Object.defineProperty(hostileChannel, 'channel', {
      enumerable: true,
      get() {
        getterCalls += 1;
        return 'code.fulltext';
      },
    });
    const failure = new Error('accessor-sk_live_12345678901234567890');
    Object.defineProperty(failure, 'observation', {
      value: { channels: [hostileChannel], candidates: [], finalIds: [] },
    });
    codeLayer.searchObserved.mockRejectedValueOnce(failure);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const result = await assembler.assembleTraced('accessor failure', { include_arch: false });

    expect(getterCalls).toBe(0);
    expect(result.trace.events).toContainEqual(expect.objectContaining({
      kind: 'channel-terminal', channel: 'code.fulltext', outcome: 'safe-failure', code: 'query-failed',
    }));
    expect(errorSpy.mock.calls.flat().map(String).join(' ')).not.toContain('sk_live');
    errorSpy.mockRestore();
  });

  it('rejects fulfilled accessor and proxy wrappers before reading value or observation', async () => {
    for (const kind of ['value-accessor', 'observation-accessor', 'proxy'] as const) {
      const { assembler, codeLayer } = makeAssembler(0, 0);
      let forbiddenReads = 0;
      const valid = {
        value: [], observation: { channels: [], candidates: [], finalIds: [] },
      };
      const backing = {
        value: [{
          id: 'hostile-code', source_type: 'symbol', name: 'hostile', kind: 'function',
          file_path: 'src/hostile.ts', start_line: 1, signature: 'hostile()', doc_comment: '', score: 0.9,
        }],
        observation: {
          channels: [{ channel: 'code.fulltext', outcome: 'success' }],
          candidates: [], finalIds: [],
        },
      };
      let wrapper: unknown = backing;
      if (kind.endsWith('accessor')) {
        Object.defineProperty(backing, kind === 'value-accessor' ? 'value' : 'observation', {
          enumerable: true,
          get() { forbiddenReads += 1; return kind === 'value-accessor' ? valid.value : valid.observation; },
        });
      } else {
        wrapper = new Proxy(backing, {
          get(target, key, receiver) {
            if (key === 'then') return undefined;
            if (key === 'value' || key === 'observation') forbiddenReads += 1;
            return Reflect.get(target, key, receiver);
          },
        });
      }
      codeLayer.searchObserved.mockResolvedValueOnce(wrapper as never);

      const result = await assembler.assembleTraced(`hostile fulfilled ${kind}`, { include_arch: false });

      expect(forbiddenReads).toBe(0);
      expect(result.trace.complete).toBe(false);
      expect(result.trace.incompleteReasons).toContain('candidate-output-gap');
      expect(result.context.sections.flatMap((section) => section.items).some((item) => item.id === 'hostile-code')).toBe(false);
    }
  });

  it('requires observation finalIds to exactly match returned source-final IDs', async () => {
    for (const [name, candidates, finalIds] of [
      ['missing', [{
        privateId: CANARY_ID, sourceType: 'symbol',
        channels: [{ channel: 'code.fulltext', rank: 1, score: 0.9 }], evidence: {}, estimatedTokens: 4,
      }], []],
      ['ghost', [{
        privateId: 'ghost-id', sourceType: 'symbol',
        channels: [{ channel: 'code.fulltext', rank: 1, score: 0.9 }], evidence: {}, estimatedTokens: 4,
      }], ['ghost-id']],
      ['duplicate', [{
        privateId: CANARY_ID, sourceType: 'symbol',
        channels: [{ channel: 'code.fulltext', rank: 1, score: 0.9 }], evidence: {}, estimatedTokens: 4,
      }], [CANARY_ID, CANARY_ID]],
    ] as const) {
      const { assembler, codeLayer } = makeAssembler(0, 0);
      codeLayer.searchObserved.mockResolvedValueOnce({
        value: await codeLayer.search(),
        observation: {
          channels: [{ channel: 'code.fulltext', outcome: 'success' }],
          candidates: [...candidates], finalIds: [...finalIds],
        },
      } as never);

      const result = await assembler.assembleTraced(`bijection ${name}`, { include_arch: false });
      expect(result.context.sections.flatMap((section) => section.items).some((item) => item.id === CANARY_ID)).toBe(true);
      expect(result.trace.complete).toBe(false);
      expect(result.trace.incompleteReasons).toContain('candidate-output-gap');
    }
  });

  it('uses fixed trace-path logging for arch, code, memory, and shared embedding failures', async () => {
    const canary = 'backend-sk_live_12345678901234567890';
    const driver = {
      session: () => ({
        run: vi.fn(async () => { throw new Error(canary); }),
        close: vi.fn(async () => undefined),
      }),
    };
    const codeLayer = {
      search: vi.fn(),
      searchObserved: vi.fn(async () => { throw new Error(canary); }),
    };
    const memoryLayer = {
      load: vi.fn(),
      loadFreshObserved: vi.fn(async () => { throw new Error(canary); }),
    };
    const redis = { get: vi.fn(async () => null), set: vi.fn(async () => undefined) };
    const embedding = { available: true, embed: vi.fn(async () => { throw new Error(canary); }), embedBatch: vi.fn() };
    const assembler = new UnifiedAssembler(driver as never, redis, codeLayer, memoryLayer, embedding);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const result = await assembler.assembleTraced('all failures');

    expect(JSON.stringify(errorSpy.mock.calls)).not.toContain(canary);
    expect(JSON.stringify(result.trace)).not.toContain(canary);
    expect(result.trace.events).toContainEqual(expect.objectContaining({
      kind: 'stage-failure', stage: 'embedding', code: 'query-failed',
    }));
    errorSpy.mockRestore();
  });

  it('maps only explicit source-final markdown sections and marks an aggregate section incomplete', async () => {
    const { assembler, memoryLayer } = makeAssembler(0, 0);
    memoryLayer.loadFreshObserved.mockResolvedValueOnce({
      value: {
        markdown: '## Current Facts\n\n- one aggregate\n\n## [sem-1] (confidence: 0.90)\nremembered',
        tokens: 10,
        sources: ['fact-1', 'sem-1'],
        assembled_at: ASSEMBLED_AT,
      },
      observation: {
        channels: [{ channel: 'memory.scope', outcome: 'success' }],
        candidates: [
          {
            privateId: 'fact-1', sourceType: 'fact',
            channels: [{ channel: 'memory.fact', rank: 1 }],
            evidence: { confidence: 0.9 }, estimatedTokens: 3,
          },
          {
            privateId: 'sem-1', sourceType: 'semantic',
            channels: [{ channel: 'memory.scope', rank: 1 }],
            evidence: { confidence: 0.9 }, estimatedTokens: 3,
          },
        ],
        finalIds: ['fact-1', 'sem-1'],
      },
    });

    const result = await assembler.assembleTraced('memory split', {
      include_arch: false,
      include_code: false,
    });

    expect(result.context.sections.flatMap((section) => section.items).map((item) => item.id)).toEqual(['sem-1']);
    expect(result.trace.complete).toBe(false);
    expect(result.trace.incompleteReasons).toContain('candidate-output-gap');
    expect(result.trace.candidates).toHaveLength(0);
  });

  it('normalizes only the exact AMPService Memory Context presentation preamble in ranked mapping', async () => {
    const { assembler, memoryLayer } = makeAssembler(0, 0);
    memoryLayer.loadFreshObserved.mockResolvedValueOnce({
      value: {
        markdown: '# Memory Context\n\n**Task:** faithful memory fixture\n\n## [sem-1] (confidence: 0.90, score: 0.800)\nremembered',
        tokens: 10,
        sources: ['sem-1'],
        assembled_at: ASSEMBLED_AT,
      },
      observation: {
        channels: [{ channel: 'memory.scope', outcome: 'success' }],
        candidates: [{
          privateId: 'sem-1', sourceType: 'semantic',
          channels: [{ channel: 'memory.scope', rank: 1 }],
          evidence: { confidence: 0.9 }, estimatedTokens: 3,
        }],
        finalIds: ['sem-1'],
      },
    });

    const result = await assembler.assembleTraced('faithful memory fixture', {
      include_arch: false,
      include_code: false,
    });

    expect(result.context.sections.flatMap((section) => section.items)).toHaveLength(1);
    expect(result.context.sections[0]?.items[0]?.content).not.toContain('# Memory Context');
    expect(result.trace.complete).toBe(true);
    expect(result.trace.incompleteReasons).toEqual([]);
    expect(result.trace.candidates).toHaveLength(1);
  });

  it('does not normalize an arbitrary H1 or a mismatched Memory Context task preamble', async () => {
    for (const markdown of [
      '# Arbitrary Header\n\n**Task:** exact task\n\n## [sem-1] (confidence: 0.90)\nremembered',
      '# Memory Context\n\n**Task:** different task\n\n## [sem-1] (confidence: 0.90)\nremembered',
    ]) {
      const { assembler, memoryLayer } = makeAssembler(0, 0);
      memoryLayer.loadFreshObserved.mockResolvedValueOnce({
        value: { markdown, tokens: 10, sources: ['sem-1'], assembled_at: ASSEMBLED_AT },
        observation: {
          channels: [{ channel: 'memory.scope', outcome: 'success' }],
          candidates: [{
            privateId: 'sem-1', sourceType: 'semantic',
            channels: [{ channel: 'memory.scope', rank: 1 }],
            evidence: {}, estimatedTokens: 3,
          }],
          finalIds: ['sem-1'],
        },
      });

      const result = await assembler.assembleTraced('exact task', { include_arch: false, include_code: false });
      expect(result.context.sections).toEqual([]);
      expect(result.trace.events).toContainEqual(expect.objectContaining({
        kind: 'channel-terminal', channel: 'memory.scope', outcome: 'safe-failure', code: 'invalid-result',
      }));
      expect(result.trace.candidates).toHaveLength(0);
    }
  });

  it('normalizes AMPService exact empty-memory presentation without inventing a result', async () => {
    const { assembler, memoryLayer } = makeAssembler(0, 0);
    memoryLayer.loadFreshObserved.mockResolvedValueOnce({
      value: {
        markdown: '# Memory Context\n\n_No relevant memories found for task: nothing here_\n',
        tokens: 0,
        sources: [],
        assembled_at: ASSEMBLED_AT,
      },
      observation: {
        channels: [{ channel: 'memory.scope', outcome: 'success' }],
        candidates: [],
        finalIds: [],
      },
    });

    const result = await assembler.assembleTraced('nothing here', {
      include_arch: false,
      include_code: false,
    });

    expect(result.context.sections).toEqual([]);
    expect(result.trace.complete).toBe(true);
    expect(result.trace.candidates).toEqual([]);
  });

  it('emits no markdown mapping for duplicate, reordered, or injected headings', async () => {
    const cases = [
      '## [sem-1] (confidence: 0.90)\none\n\n## [sem-1] (confidence: 0.80)\ninjected duplicate',
      '## [sem-2] (confidence: 0.80)\ntwo\n\n## [sem-1] (confidence: 0.90)\none',
      '## [sem-1] (confidence: 0.90)\none\n\n## Current Facts\n\ninjected aggregate',
    ];
    for (const markdown of cases) {
      const { assembler, memoryLayer } = makeAssembler(0, 0);
      memoryLayer.loadFreshObserved.mockResolvedValueOnce({
        value: { markdown, tokens: 10, sources: ['sem-1', 'sem-2'], assembled_at: ASSEMBLED_AT },
        observation: {
          channels: [{ channel: 'memory.scope', outcome: 'success' }],
          candidates: [
            { privateId: 'sem-1', sourceType: 'semantic', channels: [{ channel: 'memory.scope', rank: 1 }], evidence: {}, estimatedTokens: 2 },
            { privateId: 'sem-2', sourceType: 'semantic', channels: [{ channel: 'memory.scope', rank: 2 }], evidence: {}, estimatedTokens: 2 },
          ],
          finalIds: ['sem-1', 'sem-2'],
        },
      });

      const result = await assembler.assembleTraced('unsafe markdown map', { include_arch: false, include_code: false });
      expect(result.context.sections).toEqual([]);
      expect(result.trace.events).toContainEqual(expect.objectContaining({
        kind: 'channel-terminal', channel: 'memory.scope', outcome: 'safe-failure', code: 'invalid-result',
      }));
      expect(result.trace.candidates).toHaveLength(0);
    }
  });

  it('records ranked output in exact final grouped and budgeted context order', async () => {
    const { assembler, codeLayer, memoryLayer } = makeAssembler(0, 0);
    const codeResults = [
      { id: 'code-1', source_type: 'symbol', name: 'alpha', kind: 'function', file_path: 'src/same.ts', start_line: 1, signature: 'alpha()', doc_comment: '', score: 0.9 },
      { id: 'code-2', source_type: 'symbol', name: 'beta', kind: 'function', file_path: 'src/same.ts', start_line: 2, signature: 'beta()', doc_comment: '', score: 0.8 },
    ];
    codeLayer.searchObserved.mockResolvedValueOnce({
      value: codeResults,
      observation: {
        channels: [{ channel: 'code.fulltext', outcome: 'success' }],
        candidates: codeResults.map((result, index) => ({
          privateId: result.id, sourceType: 'symbol' as const,
          channels: [{ channel: 'code.fulltext' as const, rank: index + 1, score: result.score }],
          evidence: {}, estimatedTokens: 3,
        })),
        finalIds: codeResults.map((result) => result.id),
      },
    });
    memoryLayer.loadFreshObserved.mockResolvedValueOnce({
      value: {
        markdown: '## [mem-1] (confidence: 0.90)\nremembered', tokens: 4, sources: ['mem-1'], assembled_at: ASSEMBLED_AT,
      },
      observation: {
        channels: [{ channel: 'memory.scope', outcome: 'success' }],
        candidates: [{
          privateId: 'mem-1', sourceType: 'semantic', channels: [{ channel: 'memory.scope', rank: 1 }],
          evidence: {}, estimatedTokens: 2,
        }],
        finalIds: ['mem-1'],
      },
    });

    const result = await assembler.assembleTraced('find function alpha', { include_arch: false, max_tokens: 1000 });
    expect(result.context.sections.flatMap((section) => section.items.map((item) => item.id)))
      .toEqual(['code-1', 'code-2', 'mem-1']);
    const byRef = new Map(result.trace.candidates.map((candidate) => [candidate.ref, candidate]));
    const outputShape = result.trace.events
      .filter((event) => event.kind === 'ranked-output')
      .sort((a, b) => a.rank - b.rank)
      .map((event) => {
        const candidate = byRef.get(event.ref)!;
        return [candidate.sourceType, candidate.channels[0]?.rank];
      });
    expect(outputShape).toEqual([['symbol', 1], ['symbol', 2], ['semantic', 1]]);
    expect(replayRetrievalTrace(result.trace).resultOrder).toEqual(
      result.trace.events.filter((event) => event.kind === 'ranked-output')
        .sort((a, b) => a.rank - b.rank).map((event) => event.ref),
    );
  });

  it('binds ranked-v2 recording privately without changing the four-argument ranked-v1 default', async () => {
    const baseline: RetrievalResult[] = [
      { id: 'private-alpha', source_type: 'semantic', title: 'alpha', content: 'alpha evidence', score: 0.9, metadata: {} },
      { id: 'private-beta', source_type: 'symbol', title: 'beta', content: 'beta evidence', score: 0.1, metadata: {} },
    ];
    const observations = [{
      channels: [{ channel: 'memory.scope' as const, outcome: 'success' as const }],
      candidates: baseline.map((item, index) => ({
        privateId: item.id,
        sourceType: item.source_type,
        channels: [{ channel: 'memory.scope' as const, rank: index + 1, score: item.score }],
        evidence: {},
        estimatedTokens: 4,
      })),
      finalIds: baseline.map((item) => item.id),
    }];
    const facts = {
      includeCode: false,
      includeArchitecture: false,
      includeMemory: true,
      projectScopeApplied: false,
      projectNameApplied: false,
      memoryScopeApplied: true,
      namedTenant: true,
      entityCount: 0,
      tagCount: 0,
      temporalFilterApplied: false,
      query: 'beta',
      maxTokens: 1_000,
    };
    const legacy = new RankedRuntimeTraceAdapter(observations, [baseline], facts, []);
    expect((legacy as unknown as { algorithmVersion: string }).algorithmVersion).toBe('ranked-v1');
    for (const method of ['filter', 'some'] as const) {
      const previous = Object.getOwnPropertyDescriptor(Array.prototype, method)!;
      let callbacks = 0;
      let failure: unknown;
      try {
        Reflect.defineProperty(Array.prototype, method, {
          value: () => { callbacks += 1; throw new Error('runtime constructor intrinsic must not run'); },
          configurable: true,
          writable: true,
        });
        try { new RankedRuntimeTraceAdapter(observations, [baseline], facts, [], 'ranked-v2'); }
        catch (error) { failure = error; }
      } finally {
        Reflect.defineProperty(Array.prototype, method, previous);
      }
      expect({ method, callbacks, failure: String(failure) }).toEqual({
        method, callbacks: 0, failure: 'Error: ranked-v2 runtime intrinsic integrity check failed',
      });
    }

    const adapter = new RankedRuntimeTraceAdapter(observations, [baseline], facts, [], 'ranked-v2');
    baseline.forEach((item) => {
      adapter.candidateWindow(item, true);
      adapter.finalScore(item, item.score);
    });
    adapter.mmr({
      round: 1,
      selected: baseline[0]!,
      lambda: 1,
      records: [
        { candidate: baseline[0]!, relevance: 0.9, pairwise: [] },
        { candidate: baseline[1]!, relevance: 0.8, pairwise: [] },
      ],
    });
    adapter.mmr({
      round: 2,
      selected: baseline[1]!,
      lambda: 1,
      records: [{
        candidate: baseline[1]!,
        relevance: 0.8,
        pairwise: [{ selected: baseline[0]!, similarity: 0 }],
      }],
    });
    adapter.recordDedup(baseline.map((item) => item.id), baseline.map((item) => item.id));
    const outcome = await applyServedRerankerV1('beta', baseline, createServedRerankerProviderV1());
    expect(outcome.outcome).toBe('reranked');
    const includedIds = outcome.results.map((item) => item.id);
    const collectionMutations = [
      { target: Map.prototype, key: 'get', previous: Object.getOwnPropertyDescriptor(Map.prototype, 'get')! },
      { target: Map.prototype, key: 'set', previous: Object.getOwnPropertyDescriptor(Map.prototype, 'set')! },
      { target: Set.prototype, key: 'has', previous: Object.getOwnPropertyDescriptor(Set.prototype, 'has')! },
      { target: Set.prototype, key: 'add', previous: Object.getOwnPropertyDescriptor(Set.prototype, 'add')! },
    ];
    let trace: RetrievalTraceV1 | undefined;
    let replay: ReturnType<typeof replayRetrievalTrace> | undefined;
    try {
      for (let index = 0; index < collectionMutations.length; index += 1) {
        const mutation = collectionMutations[index]!;
        Reflect.defineProperty(mutation.target, mutation.key, {
          value: () => { throw new Error('runtime collection intrinsic must not run'); },
          configurable: true,
          writable: true,
        });
      }
      adapter.recordReranker(baseline, outcome);
      adapter.recordBudget(includedIds);
      trace = adapter.finalize();
      replay = replayRetrievalTrace(trace);
    } finally {
      for (let index = collectionMutations.length - 1; index >= 0; index -= 1) {
        const mutation = collectionMutations[index]!;
        Reflect.defineProperty(mutation.target, mutation.key, mutation.previous);
      }
    }
    expect(trace).toBeDefined();
    if (!trace) throw new Error('ranked-v2 runtime trace was not finalized');
    expect(trace.algorithmVersion).toBe('ranked-v2');
    expect(trace.events.filter((event) => event.kind === 'reranker-stage')).toHaveLength(1);
    expect(replay?.resultOrder).toEqual(trace.resultOrder);
    const traceBytes = JSON.stringify(trace);
    expect(traceBytes).not.toContain('private-alpha');
    expect(traceBytes).not.toContain('private-beta');
    expect(traceBytes).not.toContain('alpha evidence');
    expect(traceBytes).not.toContain('beta evidence');
    expect(traceBytes).not.toContain('"privateId"');
    expect(traceBytes).not.toContain('"content"');
    expect(traceBytes).not.toContain('"title"');
    expect(traceBytes).not.toContain('"query"');
    assertRetrievalTraceConformant(trace);

    const missingBudget = new RankedRuntimeTraceAdapter(observations, [baseline], facts, [], 'ranked-v2');
    baseline.forEach((item) => {
      missingBudget.candidateWindow(item, true);
      missingBudget.finalScore(item, item.score);
    });
    missingBudget.mmr({
      round: 1,
      selected: baseline[0]!,
      lambda: 1,
      records: [
        { candidate: baseline[0]!, relevance: 0.9, pairwise: [] },
        { candidate: baseline[1]!, relevance: 0.8, pairwise: [] },
      ],
    });
    missingBudget.mmr({
      round: 2,
      selected: baseline[1]!,
      lambda: 1,
      records: [{
        candidate: baseline[1]!, relevance: 0.8,
        pairwise: [{ selected: baseline[0]!, similarity: 0 }],
      }],
    });
    missingBudget.recordDedup(baseline.map((item) => item.id), baseline.map((item) => item.id));
    missingBudget.recordReranker(baseline, outcome);
    const incomplete = missingBudget.finalize();
    expect(incomplete.complete).toBe(false);
    expect(incomplete.incompleteReasons).toContain('candidate-output-gap');
    expect(() => replayRetrievalTrace(incomplete)).toThrow(/incomplete/);

    const late = new RankedRuntimeTraceAdapter(observations, [baseline], facts, [], 'ranked-v2');
    baseline.forEach((item) => {
      late.candidateWindow(item, true);
      late.finalScore(item, item.score);
    });
    late.mmr({
      round: 1,
      selected: baseline[0]!,
      lambda: 1,
      records: [
        { candidate: baseline[0]!, relevance: 0.9, pairwise: [] },
        { candidate: baseline[1]!, relevance: 0.8, pairwise: [] },
      ],
    });
    late.mmr({
      round: 2,
      selected: baseline[1]!,
      lambda: 1,
      records: [{
        candidate: baseline[1]!, relevance: 0.8,
        pairwise: [{ selected: baseline[0]!, similarity: 0 }],
      }],
    });
    late.recordDedup(baseline.map((item) => item.id), baseline.map((item) => item.id));
    late.recordBudget(outcome.results.map((item) => item.id));
    const lateState = late as unknown as {
      budgetRecorded: boolean;
      rerankerRecorded: boolean;
      failed: boolean;
    };
    expect(lateState).toMatchObject({ budgetRecorded: true, rerankerRecorded: false, failed: true });
    late.recordReranker(baseline, outcome);
    expect(lateState.rerankerRecorded).toBe(false);
  });

  it('merges repeated private IDs with exact ranked-v2 provenance under hostile numeric setters', () => {
    const result: RetrievalResult = {
      id: 'repeat-private-id', source_type: 'semantic', title: 'repeat', content: 'repeat evidence',
      score: 0.9, metadata: {},
    };
    const baseline = [result];
    const observations = [
      {
        channels: [{ channel: 'memory.scope' as const, outcome: 'success' as const }],
        candidates: [{
          privateId: result.id, sourceType: result.source_type,
          channels: [{ channel: 'memory.scope' as const, rank: 1, score: 0.9 }],
          evidence: {}, estimatedTokens: 4,
        }],
        finalIds: [result.id],
      },
      {
        channels: [{ channel: 'memory.semantic-vector' as const, outcome: 'success' as const }],
        candidates: [{
          privateId: result.id, sourceType: result.source_type,
          channels: [{ channel: 'memory.semantic-vector' as const, rank: 1, score: 0.8 }],
          evidence: {}, estimatedTokens: 4,
        }],
        finalIds: [result.id],
      },
    ];
    const facts = {
      includeCode: false, includeArchitecture: false, includeMemory: true,
      projectScopeApplied: false, projectNameApplied: false, memoryScopeApplied: true,
      namedTenant: true, entityCount: 0, tagCount: 0, temporalFilterApplied: false,
      query: 'repeat', maxTokens: 1_000,
    };
    for (const surface of ['array', 'object', 'inserted'] as const) {
      for (const hostileIndex of [0, 1] as const) {
        const inserted = Object.create(Object.getPrototypeOf(Array.prototype)) as object;
        const originalArrayParent = Object.getPrototypeOf(Array.prototype);
        const host = surface === 'array' ? Array.prototype : surface === 'object' ? Object.prototype : inserted;
        const previous = Object.getOwnPropertyDescriptor(host, String(hostileIndex));
        let callbacks = 0;
        let adapter: RankedRuntimeTraceAdapter | undefined;
        let failure: unknown;
        try {
          Object.defineProperty(host, String(hostileIndex), {
            configurable: true,
            get: () => { callbacks += 1; return { channel: 'code.fulltext', rank: 999 }; },
            set: () => { callbacks += 1; },
          });
          if (surface === 'inserted') Object.setPrototypeOf(Array.prototype, inserted);
          try { adapter = new RankedRuntimeTraceAdapter(observations, [baseline], facts, [], 'ranked-v2'); }
          catch (error) { failure = error; }
        } finally {
          if (surface === 'inserted') Object.setPrototypeOf(Array.prototype, originalArrayParent);
          if (previous) Object.defineProperty(host, String(hostileIndex), previous);
          else delete (host as Record<string, unknown>)[String(hostileIndex)];
        }
        expect({ surface, hostileIndex, callbacks, failure }).toEqual({
          surface, hostileIndex, callbacks: 0, failure: undefined,
        });
        if (!adapter) throw new Error('ranked-v2 repeated-ID adapter was not constructed');
        adapter.candidateWindow(result, true);
        adapter.finalScore(result, result.score);
        adapter.mmr({
          round: 1, selected: result, lambda: 1,
          records: [{ candidate: result, relevance: 0.9, pairwise: [] }],
        });
        adapter.recordDedup([result.id], [result.id]);
        adapter.recordReranker(baseline, {
          outcome: 'baseline', reason: 'not-reranked', results: baseline,
        });
        adapter.recordBudget([result.id]);
        const trace = adapter.finalize();
        expect(trace.candidates).toHaveLength(1);
        expect(trace.candidates[0]?.channels).toEqual([
          { channel: 'memory.scope', rank: 1, score: 0.9 },
          { channel: 'memory.semantic-vector', rank: 1, score: 0.8 },
        ]);
        expect(JSON.stringify(trace)).not.toContain(result.id);
        expect(JSON.stringify(trace)).not.toContain('code.fulltext');
        assertRetrievalTraceConformant(trace);
      }
    }
  });

  it('keeps trace-only allocation records behind observer guards', () => {
    const root = resolve(import.meta.dirname, '../../../..');
    const fusion = readFileSync(resolve(root, 'packages/retrieval/src/fusion.ts'), 'utf8');
    const scoring = readFileSync(resolve(root, 'packages/retrieval/src/scoring.ts'), 'utf8');
    const assembler = readFileSync(resolve(root, 'packages/retrieval/src/assembler.ts'), 'utf8');
    expect(fusion).not.toContain('const admitted = new Set');
    expect(scoring).toMatch(/const roundRecords = observer \? \[\].*: undefined/);
    expect(scoring).toMatch(/const pairwise = observer \? \[\].*: undefined/);
    expect(assembler).toContain('const traceIncompleteReasons = traced ? new Set');
  });
});
