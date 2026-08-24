// packages/retrieval/src/__tests__/code-plane-status.test.ts
// COD-010 fail-loud code-plane status: `berry_context(include_code=true)` can no
// longer silently yield zero code — every drop path is disclosed on the context
// (`code_plane`) and rendered into the provenance line.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { UnifiedAssembler, type AssemblerCodeLayer, type AssemblerMemoryLayer } from '../assembler.js';
import type { FeedbackRedisLayer } from '../feedback.js';
import type { EmbeddingProvider } from '@memberry/core';
import type { UnifiedContext } from '../types.js';

// ─── Mock factories (assembler.test.ts style) ────────────────────────────────

function createMockRedis(): FeedbackRedisLayer {
  return {
    zincrby: vi.fn().mockResolvedValue(1),
    zrevrangeWithScores: vi.fn().mockResolvedValue([]),
    lpush: vi.fn().mockResolvedValue(1),
    ltrim: vi.fn().mockResolvedValue(undefined),
  };
}

function createMockEmbedding(): EmbeddingProvider {
  return {
    embed: vi.fn().mockResolvedValue(Array(384).fill(0)),
    embedBatch: vi.fn().mockResolvedValue([]),
  };
}

function createMockDriver() {
  const mockSession = {
    run: vi.fn().mockResolvedValue({ records: [] }),
    close: vi.fn().mockResolvedValue(undefined),
  };
  return {
    session: vi.fn().mockReturnValue(mockSession),
    mockSession,
  };
}

function codeRow(id: string, doc: string, score: number) {
  return {
    id,
    source_type: 'symbol',
    name: id,
    kind: 'function',
    file_path: `/src/${id}.ts`,
    start_line: 1,
    signature: `function ${id}(): void`,
    doc_comment: doc,
    score,
  };
}

function codeLayerWith(rows: unknown[]): AssemblerCodeLayer {
  return { search: vi.fn().mockResolvedValue(rows) } as AssemblerCodeLayer;
}

const RANKED_CODE_ONLY = {
  strategy: 'ranked' as const,
  include_arch: false,
  include_memory: false,
};

describe('COD-010 code-plane status', () => {
  let driver: ReturnType<typeof createMockDriver>;
  let redis: FeedbackRedisLayer;
  let embedding: EmbeddingProvider;

  beforeEach(() => {
    driver = createMockDriver();
    redis = createMockRedis();
    embedding = createMockEmbedding();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  function makeAssembler(codeLayer: AssemblerCodeLayer | null, memoryLayer: AssemblerMemoryLayer | null = null) {
    return new UnifiedAssembler(driver as never, redis, codeLayer, memoryLayer, embedding);
  }

  describe('ranked outcomes', () => {
    it('reports served with DELIVERED count K and channel count N when the budget drops rows', async () => {
      // Two channel rows; the oversized one cannot fit the 100-token budget, so
      // the response delivers exactly one symbol item: K=1 must not equal N=2.
      const assembler = makeAssembler(codeLayerWith([
        codeRow('sym-oversized', 'x'.repeat(2000), 0.99),
        codeRow('sym-fitting', 'small', 0.5),
      ]));

      const ctx = await assembler.assemble('find fitting symbol', { ...RANKED_CODE_ONLY, max_tokens: 100 });

      expect(ctx.sections.find((s) => s.source_type === 'symbol')?.items.map((i) => i.id)).toEqual(['sym-fitting']);
      expect(ctx.code_plane).toEqual({ outcome: 'served', results: 1, candidates: 2 });
      // Rendered at the END of the provenance line, after **IDs:**.
      expect(assembler.renderMarkdown(ctx)).toMatch(/\*\*IDs:\*\* \d+ \| \*\*Code:\*\* served \(1 of 2\)$/m);
    });

    it('reports budget eviction (never a false served) when the channel returned rows but zero were delivered', async () => {
      const assembler = makeAssembler(codeLayerWith([codeRow('sym-oversized', 'x'.repeat(2000), 0.99)]));

      const ctx = await assembler.assemble('find code', { ...RANKED_CODE_ONLY, max_tokens: 50 });

      expect(ctx.sections.find((s) => s.source_type === 'symbol')).toBeUndefined();
      expect(ctx.code_plane).toEqual({ outcome: 'no-results', reason: 'budget-evicted', candidates: 1 });
      const md = assembler.renderMarkdown(ctx);
      expect(md).toContain('**Code:** budget-evicted (0 of 1)');
      expect(md).not.toContain('**Code:** served');
    });

    it('reports no-results without a reason when the channel returned nothing', async () => {
      const assembler = makeAssembler(codeLayerWith([]));

      const ctx = await assembler.assemble('find code', RANKED_CODE_ONLY);

      expect(ctx.code_plane).toEqual({ outcome: 'no-results' });
      expect(assembler.renderMarkdown(ctx)).toContain('**Code:** none found');
    });

    it('captures a channel rejection as failed query-failed even untraced (capture is not trace-gated)', async () => {
      const codeLayer: AssemblerCodeLayer = {
        search: vi.fn().mockRejectedValue(new Error('code search down')),
      };
      const assembler = makeAssembler(codeLayer);

      const ctx = await assembler.assemble('find code', RANKED_CODE_ONLY);

      expect(ctx.code_plane).toEqual({ outcome: 'failed', reason: 'query-failed' });
      expect(assembler.renderMarkdown(ctx)).toContain('**Code:** failed (query-failed)');
    });

    it('classifies a provider-contract violation as failed invalid-result', async () => {
      // Non-array provider result trips the assembler provider snapshot guard.
      const codeLayer: AssemblerCodeLayer = {
        search: vi.fn().mockResolvedValue({} as never),
      };
      const assembler = makeAssembler(codeLayer);

      const ctx = await assembler.assemble('find code', RANKED_CODE_ONLY);

      expect(ctx.code_plane).toEqual({ outcome: 'failed', reason: 'invalid-result' });
      expect(assembler.renderMarkdown(ctx)).toContain('**Code:** failed (invalid-result)');
    });
  });

  describe('ranked unsupported precedence', () => {
    it('reports code-layer-missing when no code layer is wired', async () => {
      const assembler = makeAssembler(null);

      const ctx = await assembler.assemble('find code', RANKED_CODE_ONLY);

      expect(ctx.code_plane).toEqual({ outcome: 'unsupported', reason: 'code-layer-missing' });
      expect(assembler.renderMarkdown(ctx)).toContain('**Code:** unavailable (code-layer-missing)');
    });

    it('reports tenant-scope for a named tenant', async () => {
      const codeLayer = codeLayerWith([codeRow('sym-1', 'doc', 0.9)]);
      const assembler = makeAssembler(codeLayer);

      const ctx = await assembler.assemble('find code', { ...RANKED_CODE_ONLY, tenantId: 'acme' });

      expect(codeLayer.search).not.toHaveBeenCalled();
      expect(ctx.code_plane).toEqual({ outcome: 'unsupported', reason: 'tenant-scope' });
      expect(assembler.renderMarkdown(ctx)).toContain('**Code:** unavailable (tenant-scope)');
    });

    it('prefers tenant-scope over stable-id-lane for a named tenant with resolvedEntityIds', async () => {
      const assembler = makeAssembler(codeLayerWith([codeRow('sym-1', 'doc', 0.9)]));

      const ctx = await assembler.assemble('find code', {
        ...RANKED_CODE_ONLY, tenantId: 'acme', resolvedEntityIds: ['entity-stable'],
      } as never);

      expect(ctx.code_plane).toEqual({ outcome: 'unsupported', reason: 'tenant-scope' });
    });

    it('reports stable-id-lane for the default tenant with resolvedEntityIds', async () => {
      const assembler = makeAssembler(codeLayerWith([codeRow('sym-1', 'doc', 0.9)]));

      const ctx = await assembler.assemble('find code', {
        ...RANKED_CODE_ONLY, resolvedEntityIds: ['entity-stable'],
      } as never);

      expect(ctx.code_plane).toEqual({ outcome: 'unsupported', reason: 'stable-id-lane' });
      expect(assembler.renderMarkdown(ctx)).toContain('**Code:** unavailable (stable-id-lane)');
    });

    it('prefers code-layer-missing over stable-id-lane for the default tenant with no code layer', async () => {
      const assembler = makeAssembler(null);

      const ctx = await assembler.assemble('find code', {
        ...RANKED_CODE_ONLY, resolvedEntityIds: ['entity-stable'],
      } as never);

      expect(ctx.code_plane).toEqual({ outcome: 'unsupported', reason: 'code-layer-missing' });
    });
  });

  describe('deterministic strategy', () => {
    it('reports deterministic-strategy on the untraced build', async () => {
      const assembler = makeAssembler(codeLayerWith([codeRow('sym-1', 'doc', 0.9)]));

      const ctx = await assembler.assemble('arch query', { strategy: 'deterministic' });

      expect(ctx.strategy).toBe('deterministic');
      expect(ctx.code_plane).toEqual({ outcome: 'unsupported', reason: 'deterministic-strategy' });
      expect(assembler.renderMarkdown(ctx)).toContain('**Code:** unavailable (deterministic-strategy)');
    });

    it('reports deterministic-strategy on the traced build too', async () => {
      const assembler = makeAssembler(codeLayerWith([codeRow('sym-1', 'doc', 0.9)]));

      const traced = await assembler.assembleTraced('arch query', { strategy: 'deterministic' });

      expect(traced.context.strategy).toBe('deterministic');
      expect(traced.context.code_plane).toEqual({ outcome: 'unsupported', reason: 'deterministic-strategy' });
    });

    it('reports tenant-scope for a named tenant reaching deterministic via direct assemble()', async () => {
      const assembler = makeAssembler(codeLayerWith([codeRow('sym-1', 'doc', 0.9)]));

      const ctx = await assembler.assemble('arch query', { strategy: 'deterministic', tenantId: 'acme' });

      expect(ctx.code_plane).toEqual({ outcome: 'unsupported', reason: 'tenant-scope' });
    });
  });

  describe('include_code = false', () => {
    it('omits the field and the rendered segment entirely (ranked)', async () => {
      const assembler = makeAssembler(codeLayerWith([codeRow('sym-1', 'doc', 0.9)]));

      const ctx = await assembler.assemble('find code', { ...RANKED_CODE_ONLY, include_code: false });

      expect(ctx).not.toHaveProperty('code_plane');
      expect(assembler.renderMarkdown(ctx)).not.toContain('**Code:**');
    });

    it('omits the field and the rendered segment entirely (deterministic)', async () => {
      const assembler = makeAssembler(codeLayerWith([codeRow('sym-1', 'doc', 0.9)]));

      const ctx = await assembler.assemble('arch query', { strategy: 'deterministic', include_code: false });

      expect(ctx).not.toHaveProperty('code_plane');
      expect(assembler.renderMarkdown(ctx)).not.toContain('**Code:**');
    });
  });

  describe('renderMarkdown segment forms', () => {
    function ctxWith(code_plane: NonNullable<UnifiedContext['code_plane']>): UnifiedContext {
      return {
        task: 'test', strategy: 'ranked', sections: [], token_count: 0,
        assembled_at: '2026-08-24T00:00:00.000Z', code_plane,
      };
    }

    it.each([
      [{ outcome: 'served', results: 3, candidates: 7 }, '**Code:** served (3 of 7)'],
      [{ outcome: 'no-results' }, '**Code:** none found'],
      [{ outcome: 'no-results', reason: 'budget-evicted', candidates: 4 }, '**Code:** budget-evicted (0 of 4)'],
      [{ outcome: 'unsupported', reason: 'candidate-channel' }, '**Code:** unavailable (candidate-channel)'],
      [{ outcome: 'failed', reason: 'query-failed' }, '**Code:** failed (query-failed)'],
    ] as const)('renders %j as "%s" at the end of the provenance line', (status, segment) => {
      const assembler = makeAssembler(null);
      const md = assembler.renderMarkdown(ctxWith(status));
      const provenanceLine = md.split('\n').find((line) => line.startsWith('**Strategy:**'));
      expect(provenanceLine?.endsWith(` | ${segment}`)).toBe(true);
      expect(md).toContain(segment);
    });
  });

  describe('determinism and trace parity', () => {
    it('produces a deeply-equal status for two identical calls', async () => {
      const assembler = makeAssembler(codeLayerWith([
        codeRow('sym-oversized', 'x'.repeat(2000), 0.99),
        codeRow('sym-fitting', 'small', 0.5),
      ]));

      const first = await assembler.assemble('find fitting symbol', { ...RANKED_CODE_ONLY, max_tokens: 100 });
      const second = await assembler.assemble('find fitting symbol', { ...RANKED_CODE_ONLY, max_tokens: 100 });

      expect(first.code_plane).toEqual(second.code_plane);
    });

    it('keeps the traced sources.code flag unchanged by the hoisted gate (eligible and ineligible)', async () => {
      const assembler = makeAssembler(codeLayerWith([codeRow('sym-1', 'doc', 0.9)]), {
        load: vi.fn().mockResolvedValue({
          markdown: '## [sem-1] (confidence: 0.9)\nremembered\n',
          tokens: 10, sources: ['sem-1'], assembled_at: '2026-08-24T00:00:00.000Z',
        }),
      });

      const eligible = await assembler.assembleTraced('find code', { strategy: 'ranked', include_arch: false });
      const ineligible = await assembler.assembleTraced('find code', {
        strategy: 'ranked', include_arch: false, tenantId: 'acme',
      });

      expect(eligible.trace.requestShape.sources.code).toBe(true);
      expect(eligible.context.code_plane?.outcome).toBe('served');
      expect(ineligible.trace.requestShape.sources.code).toBe(false);
      expect(ineligible.context.code_plane).toEqual({ outcome: 'unsupported', reason: 'tenant-scope' });
    });
  });
});
