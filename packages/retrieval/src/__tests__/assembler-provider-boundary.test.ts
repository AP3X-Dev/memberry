import { Buffer } from 'node:buffer';
import { Record as Neo4jRecord } from 'neo4j-driver';
import { describe, expect, it, vi } from 'vitest';
import {
  UnifiedAssembler,
  type AssemblerCodeLayer,
  type AssemblerMemoryLayer,
  type TracedUnifiedContext,
} from '../assembler.js';

const MAX_STRING_BYTES = 65_536;
const MAX_AGGREGATE_STRING_BYTES = 262_144;
const MAX_CODE_RESULTS = 20;
const MAX_MEMORY_SOURCES = 512;
const MAX_ARCH_RESULTS = 15;

type Lane = 'ordinary' | 'traced';
type CodeResult = Awaited<ReturnType<AssemblerCodeLayer['search']>>[number];

function codeResult(overrides: Partial<CodeResult> = {}): CodeResult {
  return {
    id: 'code-1',
    source_type: 'symbol',
    name: 'alpha',
    kind: 'function',
    language: 'typescript',
    file_path: 'src/alpha.ts',
    start_line: 1,
    signature: 'alpha()',
    doc_comment: 'Alpha docs',
    score: 0.9,
    content: 'export function alpha() {}',
    ...overrides,
  };
}

function memoryResult(overrides: Partial<Awaited<ReturnType<AssemblerMemoryLayer['load']>>> = {}) {
  return {
    markdown: '## [mem-1] (confidence: 0.90)\nremembered',
    tokens: 8,
    sources: ['mem-1'],
    assembled_at: '2026-08-18T00:00:00.000Z',
    ...overrides,
  };
}

function archRecord(overrides: Record<string, unknown> = {}): Neo4jRecord {
  return new Neo4jRecord(['e', 'score'], [{
    properties: {
      id: 'arch-1',
      name: 'Architecture',
      category: 'component',
      responsibility: 'Keeps boundaries safe',
      interface_desc: 'assemble()',
      ...overrides,
    },
  }, 0.8]);
}

function makeDependencies(input: {
  code?: unknown;
  codeObserved?: unknown;
  memory?: unknown;
  memoryObserved?: unknown;
  arch?: unknown;
  llm?: unknown;
} = {}) {
  const codeSearch = vi.fn(async () => (input.code ?? []) as never);
  const memoryLoad = vi.fn(async () => (input.memory ?? memoryResult({ markdown: '', tokens: 0, sources: [] })) as never);
  const run = vi.fn(async (cypher: string) => {
    if (cypher.includes('MATCH (s:Symbol)')) {
      return { records: [new Neo4jRecord(['c'], [0])] };
    }
    if (cypher.includes("queryNodes('entity_arch_content'")) {
      return input.arch ?? { records: [] };
    }
    return { records: [] };
  });
  const close = vi.fn(async () => undefined);
  const session = vi.fn(() => ({ run, close }));
  const redis = {
    zincrby: vi.fn(async () => 0),
    zrevrangeWithScores: vi.fn(async () => []),
    lpush: vi.fn(async () => 0),
    ltrim: vi.fn(async () => undefined),
  };
  const embedding = { available: false, embed: vi.fn(), embedBatch: vi.fn() };
  const memoryLayer = input.memoryObserved === undefined
    ? { load: memoryLoad }
    : { load: memoryLoad, loadFreshObserved: vi.fn(async () => input.memoryObserved as never) };
  const codeLayer = input.codeObserved === undefined
    ? { search: codeSearch }
    : { search: codeSearch, searchObserved: vi.fn(async () => input.codeObserved as never) };
  const assembler = new UnifiedAssembler(
    { session } as never,
    redis,
    codeLayer,
    memoryLayer,
    embedding,
    input.llm as never,
  );
  return { assembler, codeSearch, codeLayer, memoryLoad, memoryLayer, run, close, session, redis, embedding };
}

async function invoke(
  lane: Lane,
  assembler: UnifiedAssembler,
  options: Parameters<UnifiedAssembler['assemble']>[1],
) {
  if (lane === 'traced') return assembler.assembleTraced('find alpha', options);
  return { context: await assembler.assemble('find alpha', options) };
}

function ids(result: { context: Awaited<ReturnType<UnifiedAssembler['assemble']>> }): string[] {
  return result.context.sections.flatMap((section) => section.items.map((item) => item.id));
}

function expectInvalidTrace(result: unknown, channel: 'code.fulltext' | 'memory.scope' | 'arch.fulltext'): void {
  const traced = result as TracedUnifiedContext;
  expect(traced.trace.events).toContainEqual(expect.objectContaining({
    kind: 'channel-terminal', channel, outcome: 'safe-failure', code: 'invalid-result',
  }));
}

function codeOptions(maxTokens = 1_000_000) {
  return { strategy: 'ranked' as const, include_arch: false, include_code: true, include_memory: false, max_tokens: maxTokens };
}

function memoryOptions(maxTokens = 8_000) {
  return { strategy: 'ranked' as const, include_arch: false, include_code: false, include_memory: true, max_tokens: maxTokens };
}

function archOptions(maxTokens = 1_000_000) {
  return { strategy: 'ranked' as const, include_arch: true, include_code: false, include_memory: false, max_tokens: maxTokens };
}

describe('UnifiedAssembler provider-result boundaries', () => {
  it.each(['ordinary', 'traced'] as const)('%s accepts valid code, memory, and architecture results', async (lane) => {
    const deps = makeDependencies({
      code: [codeResult()],
      memory: memoryResult(),
      arch: { records: [archRecord()] },
    });
    const result = await invoke(lane, deps.assembler, {
      strategy: 'ranked', include_arch: true, include_code: true, include_memory: true, max_tokens: 8_000,
    });

    expect(ids(result)).toEqual(expect.arrayContaining(['code-1', 'mem-1', 'arch-1']));
    expect(deps.codeSearch).toHaveBeenCalledTimes(1);
    expect(deps.memoryLoad).toHaveBeenCalledTimes(1);
    expect(deps.run.mock.calls.some(([query]) => String(query).includes("queryNodes('entity_arch_content'"))).toBe(true);
  });

  it('uses production-authentic optional code fields and MemoryContext assembled_at through ask, fusion, and trace', async () => {
    const chat = vi.fn(async () => JSON.stringify({ answer: 'Alpha is present.', cited: [1] }));
    const llm = { available: true, chat, modelFor: vi.fn(() => 'test-model') };
    const code = codeResult();
    const emptyMemory = memoryResult({ markdown: '', tokens: 0, sources: [] });
    const deps = makeDependencies({
      code: [code],
      codeObserved: {
        value: [code],
        observation: {
          channels: [{ channel: 'code.fulltext', outcome: 'success' }],
          candidates: [{ privateId: 'code-1', sourceType: 'symbol', channels: [{ channel: 'code.fulltext', rank: 1, score: 0.9 }], evidence: {}, estimatedTokens: 8 }],
          finalIds: ['code-1'],
        },
      },
      memory: emptyMemory,
      memoryObserved: { value: emptyMemory, observation: { channels: [{ channel: 'memory.scope', outcome: 'success' }], candidates: [], finalIds: [] } },
      llm,
    });

    const traced = await invoke('traced', deps.assembler, {
      strategy: 'ranked', include_arch: false, include_code: true, include_memory: true, max_tokens: 8_000,
    });
    expect(ids(traced)).toContain('code-1');
    expect((traced as TracedUnifiedContext).trace.events).toContainEqual(expect.objectContaining({ kind: 'ranked-output' }));

    const answer = await deps.assembler.ask('find alpha');
    expect(answer.cited_ids).toEqual(['code-1']);
    expect(chat).toHaveBeenCalledTimes(1);
  });

  it.each(['ordinary', 'traced'] as const)('%s emits only the authenticated archive suffix from a real Core memory shape', async (lane) => {
    const markdown = [
      '## Core Memory', '', '### persona', 'helpful', '',
      '## Current Facts', '', '- **Alpha** uses **Beta** (confidence: 0.90, since: 2026-08-18)', '',
      '## [sem-1] (confidence: 0.90, score: 0.800)', '', 'remembered', '',
    ].join('\n');
    const context = memoryResult({ markdown, tokens: 20, sources: ['fact-1', 'sem-1'] });
    const observation = {
      channels: [{ channel: 'memory.scope', outcome: 'success' }],
      candidates: [
        { privateId: 'fact-1', sourceType: 'fact', channels: [{ channel: 'memory.fact', rank: 1 }], evidence: {}, estimatedTokens: 4 },
        { privateId: 'sem-1', sourceType: 'semantic', channels: [{ channel: 'memory.scope', rank: 1 }], evidence: {}, estimatedTokens: 3 },
      ],
      finalIds: ['fact-1', 'sem-1'],
    };
    const deps = makeDependencies({
      memory: context,
      ...(lane === 'traced' ? { memoryObserved: { value: context, observation } } : {}),
    });
    const result = await invoke(lane, deps.assembler, memoryOptions());
    expect(ids(result)).toEqual(['sem-1']);
    expect(JSON.stringify(result.context)).not.toContain('fact-1');
    if (lane === 'traced') {
      const trace = (result as TracedUnifiedContext).trace;
      expect(trace.complete).toBe(false);
      expect(trace.incompleteReasons).toContain('candidate-output-gap');
      expect(trace.candidates).toHaveLength(0);
    }
  });

  it.each(['ordinary', 'traced'] as const)('%s accepts aggregate-only Core memory without fabricating attribution', async (lane) => {
    const context = memoryResult({
      markdown: '## Working Memory\n\n### working_state\nactive\n',
      tokens: 4,
      sources: [],
    });
    const observation = { channels: [{ channel: 'memory.block', outcome: 'success' }], candidates: [], finalIds: [] };
    const deps = makeDependencies({
      memory: context,
      ...(lane === 'traced' ? { memoryObserved: { value: context, observation } } : {}),
    });
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const result = await invoke(lane, deps.assembler, memoryOptions());
    expect(ids(result)).toEqual([]);
    expect(error).not.toHaveBeenCalled();
    if (lane === 'traced') {
      expect((result as TracedUnifiedContext).trace.incompleteReasons).toContain('candidate-output-gap');
    }
    error.mockRestore();
  });

  it.each(['ordinary', 'traced'] as const)('%s accepts each exact Core aggregate heading before an authenticated archive suffix', async (lane) => {
    const context = memoryResult({
      markdown: [
        '## Core Memory', '', '### persona', 'helpful', '',
        '## Working Memory', '', '### working_state', 'active', '',
        '## Current Facts', '', '- current', '',
        '## Fact Timeline', '', '- historical', '',
        '## [sem-1] (confidence: 0.90)', '', 'remembered',
      ].join('\n'),
      tokens: 20,
      sources: ['core-1', 'working-1', 'fact-1', 'timeline-1', 'sem-1'],
    });
    const deps = makeDependencies({ memory: context });
    const result = await invoke(lane, deps.assembler, memoryOptions());
    expect(ids(result)).toEqual(['sem-1']);
    if (lane === 'traced') {
      expect((result as TracedUnifiedContext).trace.incompleteReasons).toContain('candidate-output-gap');
    }
  });

  it('bounds memory heading scans and materialization by authenticated source cardinality', async () => {
    const headingSource = '^## ([^\\r\\n]+)(?:\\r?\\n|$)';
    const originalExec = RegExp.prototype.exec;
    let headingExecs = 0;
    const exec = vi.spyOn(RegExp.prototype, 'exec').mockImplementation(function instrumentedExec(
      this: RegExp,
      input: string,
    ) {
      if (this.source === headingSource) headingExecs += 1;
      return originalExec.call(this, input);
    });
    const matchAll = vi.spyOn(String.prototype, 'matchAll');
    const byteLength = vi.spyOn(Buffer, 'byteLength');

    try {
      Buffer.byteLength('instrumentation-positive');
      [...'## Instrumentation\n'.matchAll(/^## ([^\r\n]+)(?:\r?\n|$)/gm)];
      expect(byteLength).toHaveBeenCalled();
      expect(matchAll).toHaveBeenCalled();
      expect(headingExecs).toBeGreaterThan(0);

      for (const sourceCount of [0, 2, MAX_MEMORY_SOURCES]) {
        const sources = Array.from({ length: sourceCount }, (_, index) => `fan-${index}`);
        const markdown = Array.from({ length: 1_000 }, (_, index) => `## [fan-${index}]\nx`).join('\n');
        expect(Buffer.byteLength(markdown)).toBeLessThanOrEqual(MAX_STRING_BYTES);
        byteLength.mockClear();
        matchAll.mockClear();
        headingExecs = 0;

        const result = await invoke('ordinary', makeDependencies({
          memory: memoryResult({ markdown, tokens: 1, sources }),
        }).assembler, memoryOptions());

        expect(ids(result), `sources=${sourceCount}`).toEqual([]);
        expect(matchAll, `sources=${sourceCount}`).not.toHaveBeenCalled();
        expect(headingExecs, `sources=${sourceCount}`).toBe(sourceCount + 1);
        expect(byteLength, `sources=${sourceCount}`).toHaveBeenCalledTimes(2 + (2 * sourceCount));
      }
    } finally {
      byteLength.mockRestore();
      matchAll.mockRestore();
      exec.mockRestore();
    }
  });

  it.each(['ordinary', 'traced'] as const)('%s rejects unknown, duplicate, and non-suffix memory headings as invalid-result', async (lane) => {
    for (const context of [
      memoryResult({ markdown: '## Unknown Aggregate\n\nsecret', sources: [] }),
      memoryResult({ markdown: '## [sem-1]\none\n\n## [sem-1]\ntwo', sources: ['sem-1', 'sem-1'] }),
      memoryResult({ markdown: '## [sem-1]\none', sources: ['sem-1', 'sem-2'] }),
    ]) {
      const deps = makeDependencies({ memory: context });
      const result = await invoke(lane, deps.assembler, memoryOptions());
      expect(ids(result)).toEqual([]);
      if (lane === 'traced') expectInvalidTrace(result, 'memory.scope');
    }
  });

  it.each(['ordinary', 'traced'] as const)('%s validates code language/content and memory assembled_at without coercion', async (lane) => {
    for (const [kind, deps] of [
      ['language', makeDependencies({ code: [codeResult({ language: 7 as never })] })],
      ['content', makeDependencies({ code: [codeResult({ content: {} as never })] })],
      ['assembled_at', makeDependencies({ memory: memoryResult({ assembled_at: {} as never }) })],
    ] as const) {
      const result = await invoke(lane, deps.assembler, kind === 'assembled_at' ? memoryOptions() : codeOptions());
      expect(ids(result), kind).toEqual([]);
      if (lane === 'traced') expectInvalidTrace(result, kind === 'assembled_at' ? 'memory.scope' : 'code.fulltext');
    }
  });

  it.each(['ordinary', 'traced'] as const)('%s enforces byte ceilings for code optional fields and memory assembled_at', async (lane) => {
    for (const field of ['language', 'content'] as const) {
      const exact = 'x'.repeat(MAX_STRING_BYTES);
      expect(ids(await invoke(lane, makeDependencies({
        code: [codeResult({ [field]: exact })],
      }).assembler, codeOptions())), field).toContain('code-1');
      const rejected = await invoke(lane, makeDependencies({
        code: [codeResult({ [field]: `${exact}x` })],
      }).assembler, codeOptions());
      expect(ids(rejected), field).toEqual([]);
      if (lane === 'traced') expectInvalidTrace(rejected, 'code.fulltext');
    }
    const exactTimestamp = 't'.repeat(MAX_STRING_BYTES);
    expect(ids(await invoke(lane, makeDependencies({
      memory: memoryResult({ assembled_at: exactTimestamp }),
    }).assembler, memoryOptions(1_000_000)))).toContain('mem-1');
    const rejectedTimestamp = await invoke(lane, makeDependencies({
      memory: memoryResult({ assembled_at: `${exactTimestamp}x` }),
    }).assembler, memoryOptions(1_000_000));
    expect(ids(rejectedTimestamp)).toEqual([]);
    if (lane === 'traced') expectInvalidTrace(rejectedTimestamp, 'memory.scope');
  });

  it.each(['ordinary', 'traced'] as const)('%s rejects revoked nested provider arrays with fixed invalid-result semantics', async (lane) => {
    const revoked = Proxy.revocable([], {});
    revoked.revoke();
    const deps = makeDependencies({ arch: { records: [archRecord({ aliases: revoked.proxy })] } });
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const result = await invoke(lane, deps.assembler, archOptions());
    expect(ids(result)).toEqual([]);
    expect(JSON.stringify(error.mock.calls)).not.toContain('revoked');
    if (lane === 'traced') expectInvalidTrace(result, 'arch.fulltext');
    error.mockRestore();
  });

  it('keeps a valid ranked sibling when another provider lane is invalid, after positive controls are cleared', async () => {
    const hooks = vi.fn();
    const hostile = new Proxy({ split() { hooks(); return []; } }, {
      get(target, key, receiver) { hooks(); return Reflect.get(target, key, receiver); },
    });
    hostile.split();
    expect(hooks).toHaveBeenCalled();
    hooks.mockClear();
    const invalidCode = codeResult({ doc_comment: hostile as never });
    const memory = memoryResult();
    const deps = makeDependencies({
      code: [invalidCode],
      codeObserved: {
        value: [invalidCode],
        observation: {
          channels: [{ channel: 'code.fulltext', outcome: 'success' }],
          candidates: [{ privateId: 'code-1', sourceType: 'symbol', channels: [{ channel: 'code.fulltext', rank: 1 }], evidence: {}, estimatedTokens: 8 }],
          finalIds: ['code-1'],
        },
      },
      memory,
      memoryObserved: {
        value: memory,
        observation: {
          channels: [{ channel: 'memory.scope', outcome: 'success' }],
          candidates: [{ privateId: 'mem-1', sourceType: 'semantic', channels: [{ channel: 'memory.scope', rank: 1 }], evidence: {}, estimatedTokens: 4 }],
          finalIds: ['mem-1'],
        },
      },
    });
    const result = await invoke('traced', deps.assembler, {
      strategy: 'ranked', include_arch: false, include_code: true, include_memory: true, max_tokens: 8_000,
    });
    expect(hooks).not.toHaveBeenCalled();
    expect(ids(result)).toContain('mem-1');
    expect(ids(result)).not.toContain('code-1');
    expectInvalidTrace(result, 'code.fulltext');
    expect((result as TracedUnifiedContext).trace.events).toContainEqual(expect.objectContaining({ kind: 'ranked-output' }));
  });

  it.each(['ordinary', 'traced'] as const)('%s rejects code accessors and nested proxies without hooks or leaked diagnostics', async (lane) => {
    const hooks = vi.fn();
    const marker = 'private-code-marker';
    const nested = new Proxy({ marker }, {
      get(target, key, receiver) { hooks(); return Reflect.get(target, key, receiver); },
      getOwnPropertyDescriptor(target, key) { hooks(); return Reflect.getOwnPropertyDescriptor(target, key); },
      ownKeys(target) { hooks(); return Reflect.ownKeys(target); },
    });
    const item = codeResult({ name: nested as never, doc_comment: nested as never });
    const results: unknown[] = [item];
    Object.defineProperty(results, '0', { enumerable: true, get() { hooks(); throw new Error(marker); } });
    const deps = makeDependencies({ code: results });
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const result = await invoke(lane, deps.assembler, codeOptions());

    expect(hooks).not.toHaveBeenCalled();
    expect(ids(result)).not.toContain('code-1');
    expect(JSON.stringify(error.mock.calls)).not.toContain(marker);
    if (lane === 'traced') expectInvalidTrace(result, 'code.fulltext');
    error.mockRestore();
  });

  it.each(['ordinary', 'traced'] as const)('%s rejects a proxied code result root without traps', async (lane) => {
    const hooks = vi.fn();
    const resultRoot = new Proxy([codeResult()], {
      get(target, key, receiver) {
        // Native promise assimilation must read `then` before the assembler can
        // authenticate a fulfilled provider value. Count every later trap.
        if (key !== 'then') hooks();
        return Reflect.get(target, key, receiver);
      },
      getOwnPropertyDescriptor(target, key) { hooks(); return Reflect.getOwnPropertyDescriptor(target, key); },
      ownKeys(target) { hooks(); return Reflect.ownKeys(target); },
    });
    const deps = makeDependencies({ code: resultRoot });
    const result = await invoke(lane, deps.assembler, codeOptions());
    expect(hooks).not.toHaveBeenCalled();
    expect(ids(result)).toEqual([]);
    if (lane === 'traced') expectInvalidTrace(result, 'code.fulltext');
  });

  it.each(['ordinary', 'traced'] as const)('%s authenticates every code primitive before split, interpolation, and scoring', async (lane) => {
    for (const field of ['id', 'source_type', 'name', 'kind', 'file_path', 'start_line', 'signature', 'doc_comment', 'score'] as const) {
      const hooks = vi.fn();
      const hostile = new Proxy({
        toString() { hooks(); return 'hostile'; },
        valueOf() { hooks(); return 0.9; },
        split() { hooks(); return ['hostile']; },
      }, { get(target, key, receiver) { hooks(); return Reflect.get(target, key, receiver); } });
      const deps = makeDependencies({ code: [codeResult({ [field]: hostile } as never)] });
      const result = await invoke(lane, deps.assembler, codeOptions());
      expect(hooks, field).not.toHaveBeenCalled();
      expect(ids(result), field).toEqual([]);
      if (lane === 'traced') expectInvalidTrace(result, 'code.fulltext');
    }
  });

  it.each(['ordinary', 'traced'] as const)('%s enforces the requested code count before visiting entries', async (lane) => {
    const hooks = vi.fn();
    const results = Array.from({ length: MAX_CODE_RESULTS + 1 }, (_, index) => codeResult({ id: `code-${index}` }));
    Object.defineProperty(results, '0', { enumerable: true, get() { hooks(); return codeResult(); } });
    const deps = makeDependencies({ code: results });
    const result = await invoke(lane, deps.assembler, codeOptions());
    expect(hooks).not.toHaveBeenCalled();
    expect(ids(result)).toEqual([]);
    if (lane === 'traced') expectInvalidTrace(result, 'code.fulltext');
  });

  it.each(['ordinary', 'traced'] as const)('%s accepts exact code string byte ceilings and rejects the next byte', async (lane) => {
    for (const [label, exact, oversized] of [
      ['ascii', 'x'.repeat(MAX_STRING_BYTES), 'x'.repeat(MAX_STRING_BYTES + 1)],
      ['multibyte', '🙂'.repeat(MAX_STRING_BYTES / 4), `${'🙂'.repeat(MAX_STRING_BYTES / 4)}x`],
    ] as const) {
      const accepted = makeDependencies({ code: [codeResult({ signature: exact })] });
      expect(ids(await invoke(lane, accepted.assembler, codeOptions())), label).toContain('code-1');
      const rejected = makeDependencies({ code: [codeResult({ signature: oversized })] });
      const result = await invoke(lane, rejected.assembler, codeOptions());
      expect(ids(result), label).toEqual([]);
      if (lane === 'traced') expectInvalidTrace(result, 'code.fulltext');
    }
  });

  it.each(['ordinary', 'traced'] as const)('%s enforces code aggregate bytes and preflights against the remaining budget', async (lane) => {
    const makeAggregate = (extra: number) => {
      let remaining = MAX_AGGREGATE_STRING_BYTES + extra;
      const rows = Array.from({ length: MAX_CODE_RESULTS }, (_, index) => codeResult({
        id: `c${index}`,
        source_type: 'symbol',
        name: '', kind: '', language: '', file_path: '', signature: '', doc_comment: '', content: '',
      }));
      for (const row of rows) remaining -= Buffer.byteLength(row.id) + Buffer.byteLength(row.source_type);
      let tail: { row: CodeResult; field: 'name' | 'kind' | 'file_path' | 'signature' | 'doc_comment' } | undefined;
      for (const row of rows) {
        for (const field of ['name', 'kind', 'file_path', 'signature', 'doc_comment'] as const) {
          const size = Math.min(MAX_STRING_BYTES, Math.max(0, remaining));
          row[field] = 'x'.repeat(size);
          remaining -= size;
          if (size < MAX_STRING_BYTES) tail = { row, field };
        }
      }
      expect(remaining).toBe(0);
      return { rows, tail };
    };
    const exact = makeAggregate(0);
    expect(ids(await invoke(lane, makeDependencies({ code: exact.rows }).assembler, codeOptions()))).toHaveLength(MAX_CODE_RESULTS);

    const over = makeAggregate(0);
    const tail = over.tail!;
    tail.row[tail.field] += '\ud800';
    const rejectedTail = tail.row[tail.field];
    const byteLength = vi.spyOn(Buffer, 'byteLength');
    const before = byteLength.mock.calls.length;
    const result = await invoke(lane, makeDependencies({ code: over.rows }).assembler, codeOptions());
    expect(ids(result)).toEqual([]);
    expect(byteLength.mock.calls.slice(before).some(([value]) => value === rejectedTail)).toBe(false);
    if (lane === 'traced') expectInvalidTrace(result, 'code.fulltext');
    byteLength.mockRestore();
  });

  it.each(['ordinary', 'traced'] as const)('%s rejects memory root/source accessors and proxies without hooks', async (lane) => {
    const hooks = vi.fn();
    const marker = 'private-memory-marker';
    const sources = new Proxy(['mem-1'], {
      get(target, key, receiver) { hooks(); return Reflect.get(target, key, receiver); },
      ownKeys(target) { hooks(); return Reflect.ownKeys(target); },
      getOwnPropertyDescriptor(target, key) { hooks(); return Reflect.getOwnPropertyDescriptor(target, key); },
    });
    const memory = { tokens: 8, sources } as Record<string, unknown>;
    Object.defineProperty(memory, 'markdown', { enumerable: true, get() { hooks(); throw new Error(marker); } });
    const deps = makeDependencies({ memory });
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const result = await invoke(lane, deps.assembler, memoryOptions());
    expect(hooks).not.toHaveBeenCalled();
    expect(ids(result)).toEqual([]);
    expect(JSON.stringify(error.mock.calls)).not.toContain(marker);
    if (lane === 'traced') expectInvalidTrace(result, 'memory.scope');
    error.mockRestore();
  });

  it.each(['ordinary', 'traced'] as const)('%s validates memory primitives before markdown section scans', async (lane) => {
    for (const field of ['markdown', 'tokens', 'sources'] as const) {
      const hooks = vi.fn();
      const hostile = new Proxy({
        split() { hooks(); return []; },
        valueOf() { hooks(); return 8; },
      }, { get(target, key, receiver) { hooks(); return Reflect.get(target, key, receiver); } });
      const deps = makeDependencies({ memory: memoryResult({ [field]: hostile } as never) });
      const result = await invoke(lane, deps.assembler, memoryOptions());
      expect(hooks, field).not.toHaveBeenCalled();
      expect(ids(result), field).toEqual([]);
      if (lane === 'traced') expectInvalidTrace(result, 'memory.scope');
    }
  });

  it.each(['ordinary', 'traced'] as const)('%s enforces memory token and source cardinality requests', async (lane) => {
    const maxMemoryTokens = Math.floor(8_000 / 3);
    const exactSources = Array.from({ length: MAX_MEMORY_SOURCES }, (_, index) => `m-${index}`);
    const exact = makeDependencies({ memory: memoryResult({
      markdown: exactSources.map((id) => `## [${id}]\nx`).join('\n\n'),
      tokens: maxMemoryTokens,
      sources: exactSources,
    }) });
    expect(ids(await invoke(lane, exact.assembler, memoryOptions()))).toEqual(exactSources.slice(0, 50));

    for (const hostile of [
      memoryResult({ tokens: maxMemoryTokens + 1 }),
      memoryResult({ sources: Array(MAX_MEMORY_SOURCES + 1).fill('m') }),
    ]) {
      const result = await invoke(lane, makeDependencies({ memory: hostile }).assembler, memoryOptions());
      expect(ids(result)).toEqual([]);
      if (lane === 'traced') expectInvalidTrace(result, 'memory.scope');
    }
  });

  it.each(['ordinary', 'traced'] as const)('%s enforces memory string and aggregate byte budgets', async (lane) => {
    const prefix = '## [m] (confidence: 0.9)\n';
    const exactMarkdown = `${prefix}${'x'.repeat(MAX_STRING_BYTES - Buffer.byteLength(prefix))}`;
    expect(Buffer.byteLength(exactMarkdown)).toBe(MAX_STRING_BYTES);
    expect(ids(await invoke(lane, makeDependencies({
      memory: memoryResult({ markdown: exactMarkdown, tokens: 1, sources: ['m'] }),
    }).assembler, memoryOptions(1_000_000)))).toContain('m');

    const oversized = await invoke(lane, makeDependencies({
      memory: memoryResult({ markdown: `${exactMarkdown}x`, tokens: 1, sources: ['m'] }),
    }).assembler, memoryOptions(1_000_000));
    expect(ids(oversized)).toEqual([]);
    if (lane === 'traced') expectInvalidTrace(oversized, 'memory.scope');

    const sourceCount = MAX_MEMORY_SOURCES;
    const assembledAt = memoryResult().assembled_at;
    const archiveId = 'm';
    const aggregateMarkdown = `## Current Facts\n\n${'a'.repeat(1_000)}\n\n## [${archiveId}] (confidence: 0.9)\nx`;
    const fixed = Buffer.byteLength(aggregateMarkdown) + Buffer.byteLength(assembledAt);
    const sourceBytes = MAX_AGGREGATE_STRING_BYTES - fixed - Buffer.byteLength(archiveId);
    const each = Math.floor(sourceBytes / (sourceCount - 1));
    const remainder = sourceBytes - (each * (sourceCount - 1));
    const sources = Array.from({ length: sourceCount - 1 }, (_, index) => (
      's'.repeat(each + (index < remainder ? 1 : 0))
    ));
    expect(sources.every((source) => source.length > 0 && source.length <= 512)).toBe(true);
    sources.push(archiveId);
    const exactAggregate = memoryResult({ markdown: aggregateMarkdown, tokens: 1, sources, assembled_at: assembledAt });
    expect(fixed + sources.reduce((sum, source) => sum + Buffer.byteLength(source), 0)).toBe(MAX_AGGREGATE_STRING_BYTES);
    expect(ids(await invoke(lane, makeDependencies({ memory: exactAggregate }).assembler, memoryOptions()))).toContain(archiveId);
    sources[0] += '\ud800';
    const over = await invoke(lane, makeDependencies({ memory: exactAggregate }).assembler, memoryOptions());
    expect(ids(over)).toEqual([]);
    if (lane === 'traced') expectInvalidTrace(over, 'memory.scope');
  });

  it.each(['ordinary', 'traced'] as const)('%s rejects non-stable architecture raw accessors and proxies without hooks', async (lane) => {
    const hooks = vi.fn();
    const marker = 'private-arch-marker';
    const entity = {} as Record<string, unknown>;
    Object.defineProperty(entity, 'properties', { enumerable: true, get() { hooks(); throw new Error(marker); } });
    const records = [new Neo4jRecord(['e', 'score'], [entity, 0.8])];
    const arch = {} as Record<string, unknown>;
    Object.defineProperty(arch, 'records', { enumerable: true, get() { hooks(); return records; } });
    const deps = makeDependencies({ arch });
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const result = await invoke(lane, deps.assembler, archOptions());
    expect(hooks).not.toHaveBeenCalled();
    expect(ids(result)).toEqual([]);
    expect(JSON.stringify(error.mock.calls)).not.toContain(marker);
    if (lane === 'traced') expectInvalidTrace(result, 'arch.fulltext');
    error.mockRestore();
  });

  it.each(['ordinary', 'traced'] as const)('%s authenticates architecture properties and scores before interpolation/scoring', async (lane) => {
    for (const field of ['id', 'name', 'category', 'type', 'responsibility', 'interface_desc', 'score'] as const) {
      const hooks = vi.fn();
      const hostile = new Proxy({
        toString() { hooks(); return 'hostile'; },
        valueOf() { hooks(); return 0.8; },
        slice() { hooks(); return 'hostile'; },
      }, { get(target, key, receiver) { hooks(); return Reflect.get(target, key, receiver); } });
      const record = field === 'score'
        ? new Neo4jRecord(['e', 'score'], [{ properties: { id: 'a', name: 'A' } }, hostile])
        : archRecord({ [field]: hostile });
      const result = await invoke(lane, makeDependencies({ arch: { records: [record] } }).assembler, archOptions());
      expect(hooks, field).not.toHaveBeenCalled();
      expect(ids(result), field).toEqual([]);
      if (lane === 'traced') expectInvalidTrace(result, 'arch.fulltext');
    }
  });

  it.each(['ordinary', 'traced'] as const)('%s enforces architecture count and byte budgets', async (lane) => {
    const exactCount = Array.from({ length: MAX_ARCH_RESULTS }, (_, index) => archRecord({ id: `a-${index}`, name: `A${index}` }));
    expect(ids(await invoke(lane, makeDependencies({ arch: { records: exactCount } }).assembler, archOptions())))
      .toHaveLength(MAX_ARCH_RESULTS);
    const overCount = [...exactCount, archRecord({ id: 'overflow', name: 'Overflow' })];
    const rejectedCount = await invoke(lane, makeDependencies({ arch: { records: overCount } }).assembler, archOptions());
    expect(ids(rejectedCount)).toEqual([]);
    if (lane === 'traced') expectInvalidTrace(rejectedCount, 'arch.fulltext');

    const exact = '🙂'.repeat(MAX_STRING_BYTES / 4);
    expect(ids(await invoke(lane, makeDependencies({
      arch: { records: [archRecord({ responsibility: exact })] },
    }).assembler, archOptions()))).toContain('arch-1');
    const oversized = await invoke(lane, makeDependencies({
      arch: { records: [archRecord({ responsibility: `${exact}x` })] },
    }).assembler, archOptions());
    expect(ids(oversized)).toEqual([]);
    if (lane === 'traced') expectInvalidTrace(oversized, 'arch.fulltext');

    const records = Array.from({ length: MAX_ARCH_RESULTS }, (_, index) => archRecord({
      id: `a${index}`, name: '', category: '', responsibility: '', interface_desc: '',
    }));
    let remaining = MAX_AGGREGATE_STRING_BYTES;
    for (const record of records) {
      const props = (record.get('e') as { properties: Record<string, unknown> }).properties;
      remaining -= Buffer.byteLength(props.id as string);
    }
    for (const record of records) {
      const props = (record.get('e') as { properties: Record<string, unknown> }).properties;
      for (const field of ['name', 'category', 'responsibility', 'interface_desc'] as const) {
        const size = Math.min(MAX_STRING_BYTES, Math.max(0, remaining));
        props[field] = 'x'.repeat(size);
        remaining -= size;
      }
    }
    expect(remaining).toBe(0);
    expect(ids(await invoke(lane, makeDependencies({ arch: { records } }).assembler, archOptions())))
      .toHaveLength(MAX_ARCH_RESULTS);
    const lastProps = (records.at(-1)!.get('e') as { properties: Record<string, unknown> }).properties;
    lastProps.interface_desc = `${lastProps.interface_desc as string}\ud800`;
    const overAggregate = await invoke(lane, makeDependencies({ arch: { records } }).assembler, archOptions());
    expect(ids(overAggregate)).toEqual([]);
    if (lane === 'traced') expectInvalidTrace(overAggregate, 'arch.fulltext');
  });
});
