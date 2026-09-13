import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_TENANT } from '@memberry/core';
import { CodeSearch, type CodeSemanticEligibilityAuthority } from '../search.js';
import { allowEligibleSemantics } from './semantic-eligibility.fixture.js';
import { createCodeContainer, registerCodeTools } from '../tools.js';

interface SemanticSearchProbe {
  semanticVectorSearch(query: string, limit: number, asOf?: string, projectScope?: string): Promise<Array<{ id: string }>>;
}

function semanticRecord(id: string, score = 0.99, embedding: number[] = [1, 0]) {
  const properties = { id, content: `content:${id}`, embedding };
  return {
    get: (key: string) => {
      if (key === 's') return { properties };
      if (key === 'score') return score;
      if (key === 'embedding') return embedding;
      return undefined;
    },
  };
}

const embedding = {
  available: true,
  embed: vi.fn(async () => [1, 0]),
  embedBatch: vi.fn(async () => [[1, 0]]),
};

describe('CodeSearch semantic lifecycle serving gate', () => {
  it('refills from an eligibility-filtered pool when more than the vector cap of stale predecessors starve the active successor', async () => {
    const calls: Array<{ query: string; params: Record<string, unknown> }> = [];
    const run = vi.fn(async (query: string, params: Record<string, unknown>) => {
      calls.push({ query, params });
      if (query.includes('semantic_embedding')) {
        // The vector index's top 50 are modeled as obsolete and therefore all
        // removed by the source predicate. There are 75 stronger stale rows in
        // the corpus, so overfetch alone cannot reach the active successor.
        expect((params.limit as { toNumber(): number }).toNumber()).toBe(50);
        return { records: [] };
      }
      if (query.includes('MATCH (s:Semantic)')) return { records: [semanticRecord('active-successor')] };
      return { records: [] };
    });
    const driver = { session: () => ({ run, close: vi.fn(async () => undefined) }) };
    const search = new CodeSearch(driver as never, embedding, undefined, allowEligibleSemantics(), { legacyUnqualified: true });

    const result = await (search as unknown as SemanticSearchProbe).semanticVectorSearch('policy', 10);

    expect(result.map((row: { id: string }) => row.id)).toEqual(['active-successor']);
    const vectorQuery = calls.find((call) => call.query.includes('semantic_embedding'))!;
    const refillQuery = calls.find((call) => call.query.includes('MATCH (s:Semantic)'))!;
    for (const call of [vectorQuery, refillQuery]) {
      expect(call.query).toContain('(s.tenant_id IS NULL OR s.tenant_id = $tenantId)');
      expect(call.query).toContain('coalesce(s.archived, false) = false');
      expect(call.query).toContain('NOT EXISTS');
      expect(call.query).toContain('[:SUPERSEDES]->(s)');
      expect(call.params.tenantId).toBe(DEFAULT_TENANT);
    }
    expect(refillQuery.query.indexOf('WHERE')).toBeLessThan(refillQuery.query.indexOf('LIMIT $refillLimit'));
    expect((refillQuery.params.refillLimit as { toNumber(): number }).toNumber()).toBe(512);
  });

  it('uses the same historical frame in the source predicate and terminal authority', async () => {
    const asOf = '2026-05-01T00:00:00.000Z';
    const calls: Array<{ query: string; params: Record<string, unknown> }> = [];
    const run = vi.fn(async (query: string, params: Record<string, unknown>) => {
      calls.push({ query, params });
      return { records: query.includes('semantic_embedding') ? [semanticRecord('historical-active')] : [] };
    });
    const authority = allowEligibleSemantics();
    const driver = { session: () => ({ run, close: vi.fn(async () => undefined) }) };
    const search = new CodeSearch(driver as never, embedding, undefined, authority, { legacyUnqualified: true });

    const result = await (search as unknown as SemanticSearchProbe).semanticVectorSearch('history', 1, asOf);

    expect(result.map((row: { id: string }) => row.id)).toEqual(['historical-active']);
    const source = calls.find((call) => call.query.includes('semantic_embedding'))!;
    expect(source.query).toContain('datetime(coalesce(s.valid_at, s.created_at)) <= datetime($asOf)');
    expect(source.query).toContain('datetime(s.invalid_at) > datetime($asOf)');
    expect(source.params.asOf).toBe(asOf);
    expect(authority.evaluateActiveEligibility).toHaveBeenCalledWith({
      semanticIds: ['historical-active'],
      tenantId: DEFAULT_TENANT,
      asOf,
    });
  });

  it('binds caller project scope at source and terminal gates even when the legacy symbol-scope flag is off', async () => {
    const calls: Array<{ query: string; params: Record<string, unknown> }> = [];
    const run = vi.fn(async (query: string, params: Record<string, unknown>) => {
      calls.push({ query, params });
      return { records: query.includes('semantic_embedding') ? [semanticRecord('scoped-active')] : [] };
    });
    const authority = allowEligibleSemantics();
    const driver = { session: () => ({ run, close: vi.fn(async () => undefined) }) };
    const search = new CodeSearch(driver as never, embedding, undefined, authority, { legacyUnqualified: true });

    await (search as unknown as SemanticSearchProbe).semanticVectorSearch('scope', 1, undefined, 'project:memberry');

    const source = calls.find((call) => call.query.includes('semantic_embedding'))!;
    expect(source.query).toContain('$project_tag IN s.tags');
    expect(source.params.project_tag).toBe('project:memberry');
    expect(authority.evaluateActiveEligibility).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: DEFAULT_TENANT,
      projectScope: 'project:memberry',
    }));
  });

  it('fails closed on terminal ineligible, unknown, malformed, or unavailable authority results', async () => {
    const records = [semanticRecord('archived'), semanticRecord('active', 0.9)];
    const run = vi.fn(async (query: string) => ({
      records: query.includes('semantic_embedding') ? records : [],
    }));
    const driver = { session: () => ({ run, close: vi.fn(async () => undefined) }) };
    const authority = {
      evaluateActiveEligibility: vi.fn<CodeSemanticEligibilityAuthority['evaluateActiveEligibility']>(async () => [
        { id: 'archived', status: 'ineligible' as const },
        { id: 'active', status: 'eligible' as const },
      ]),
    };
    const search = new CodeSearch(driver as never, embedding, undefined, authority, { legacyUnqualified: true });
    expect((await (search as unknown as SemanticSearchProbe).semanticVectorSearch('current', 2)).map((r: { id: string }) => r.id))
      .toEqual(['active']);

    authority.evaluateActiveEligibility.mockResolvedValueOnce([
      { id: 'archived', status: 'unknown' as const },
      { id: 'active', status: 'eligible' as const },
    ]);
    expect((await (search as unknown as SemanticSearchProbe).semanticVectorSearch('current', 2)).map((r: { id: string }) => r.id))
      .toEqual(['active']);

    authority.evaluateActiveEligibility.mockResolvedValueOnce([
      { id: 'archived', status: 'unknown' as const },
    ] as never);
    expect(await (search as unknown as SemanticSearchProbe).semanticVectorSearch('current', 2)).toEqual([]);

    authority.evaluateActiveEligibility.mockRejectedValueOnce(new Error('authority unavailable'));
    expect(await (search as unknown as SemanticSearchProbe).semanticVectorSearch('current', 2)).toEqual([]);
  });

  it('preserves non-semantic lanes when the semantic authority is unavailable', async () => {
    const symbol = {
      get: (key: string) => key === 's' ? { properties: {
        id: 'symbol-active', name: 'active', kind: 'function', language: 'typescript',
        file_path: 'src/active.ts', start_line: 1, signature: 'active()', doc_comment: '',
      } } : 0.9,
    };
    const run = vi.fn(async (query: string) => {
      if (query.includes('symbol_search')) return { records: [symbol] };
      if (query.includes('semantic_embedding')) return { records: [semanticRecord('semantic-active')] };
      return { records: [] };
    });
    const driver = { session: () => ({ run, close: vi.fn(async () => undefined) }) };
    const authority = { evaluateActiveEligibility: vi.fn(async () => { throw new Error('offline'); }) };
    const search = new CodeSearch(driver as never, embedding, undefined, authority, { legacyUnqualified: true });

    const result = await search.search('active', { limit: 5, include_semantics: true });

    expect(result.some((row) => row.id === 'symbol-active')).toBe(true);
    expect(result.every((row) => row.source_type === 'symbol')).toBe(true);
  });
});

describe('historical code search serialization', () => {
  const asOf = '2026-02-01T00:00:00.000Z';
  const frame = { time_mode: 'historical', as_of: asOf };
  function fixture() {
    const symbol = {
      get: (key: string) => key === 's' ? { properties: {
        id: 'symbol-active', name: 'active', kind: 'function', language: 'typescript',
        file_path: 'src/active.ts', start_line: 1, signature: 'active()', doc_comment: '',
      } } : 0.9,
    };
    const run = vi.fn(async (query: string) => ({ records:
      query.includes('symbol_search') ? [symbol]
        : query.includes('semantic_embedding') ? [semanticRecord('semantic-history')] : [],
    }));
    const driver = { session: () => ({ run, close: vi.fn(async () => undefined) }) };
    const authority = allowEligibleSemantics();
    return { search: new CodeSearch(driver as never, embedding, undefined, authority, { legacyUnqualified: true }), authority };
  }

  it('labels historical semantic results without labeling current code symbols or changing current output', async () => {
    const { search, authority } = fixture();
    const options = { project_tag: 'project:memberry', limit: 5 };
    const current = await search.search('active', options);
    const historical = await search.search('active', { ...options, as_of: asOf });
    expect(current.length).toBeGreaterThan(0);
    expect(current.every((result) => !Object.hasOwn(result, 'temporal'))).toBe(true);
    expect(historical.find((result) => result.source_type === 'semantic')?.temporal).toEqual(frame);
    expect(historical.find((result) => result.source_type === 'symbol')).not.toHaveProperty('temporal');
    expect(historical.map(({ temporal: _temporal, ...result }) => result)).toEqual(current);
    expect(authority.evaluateActiveEligibility).toHaveBeenLastCalledWith(expect.objectContaining({
      tenantId: DEFAULT_TENANT, projectScope: 'project:memberry', asOf,
    }));
    const observed = await search.searchObserved('active', { ...options, as_of: asOf });
    expect(observed.value.find((result) => result.source_type === 'semantic')?.temporal).toEqual(frame);
  });

  it('carries the semantic historical frame into returned contexts and their rendered markdown', async () => {
    const { search } = fixture();
    const current = await search.buildContext('active', 4000);
    const historical = await search.buildContext('active', 4000, asOf);
    expect(current).not.toHaveProperty('semantic_temporal');
    expect(search.renderContextMarkdown(current)).not.toContain('Historical semantic memory frame:');
    expect(historical.semantic_temporal).toEqual(frame);
    expect(historical.semantic_memories.map((memory) => memory.id)).toContain('semantic-history');
    expect(search.renderContextMarkdown(historical)).toContain(
      `Historical semantic memory frame: ${asOf} (valid_at inclusive, invalid_at exclusive). Code symbols reflect the current index.`,
    );
  });

  it('preserves the historical label on both MCP serialization surfaces', async () => {
    const { search } = fixture();
    type Handler = (args: never) => Promise<{ content: Array<{ text: string }> }>;
    const handlers = new Map<string, Handler>();
    const server = { tool: (name: string, _description: string, _schema: unknown,
      _annotations: unknown, handler: Handler) => {
      handlers.set(name, handler);
      return { name };
    } };
    registerCodeTools(server as never, createCodeContainer({ codeSearch: search }));
    const common = { as_of: asOf, project_name: 'project:memberry' };
    const response = await handlers.get('berry_code_search')!({ ...common, query: 'active', limit: 5 } as never);
    const rows = JSON.parse(response.content[0].text);
    expect(rows.find((row: { source: string }) => row.source === 'semantic').temporal).toEqual(frame);
    expect(rows.find((row: { source: string }) => row.source === 'symbol')).not.toHaveProperty('temporal');
    const context = await handlers.get('berry_code_context')!({ ...common, task: 'active', max_tokens: 4000 } as never);
    expect(context.content[0].text).toContain(`Historical semantic memory frame: ${asOf}`);
    const current = await handlers.get('berry_code_search')!({ query: 'active', limit: 5 } as never);
    expect(JSON.parse(current.content[0].text).every((row: unknown) => !Object.hasOwn(row as object, 'temporal'))).toBe(true);
  });
});
