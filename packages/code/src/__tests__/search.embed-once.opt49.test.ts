// packages/code/src/__tests__/search.embed-once.opt49.test.ts
//
// OPT-49: CodeSearch.search ran the symbol dense channel (vectorSearch) and the
// semantic dense channel (semanticVectorSearch), each of which embedded the
// query independently — so a single search() embedded the query TWICE. search()
// now embeds it ONCE into a shared promise both channels await.
import { describe, it, expect, vi } from 'vitest';
import { CodeSearch } from '../search.js';

function makeDriver(): unknown {
  // Every index query returns no records — we only care about embed call count.
  const session = { run: vi.fn(async () => ({ records: [] })), close: vi.fn() };
  return { session: vi.fn(() => session) };
}

describe('OPT-49: CodeSearch embeds the query once per search()', () => {
  it('embeds the query exactly once across the symbol + semantic dense channels', async () => {
    const embed = vi.fn(async () => new Array(1536).fill(0));
    const embedding = {
      embed,
      embedBatch: vi.fn(async (t: string[]) => t.map(() => new Array(1536).fill(0))),
    };
    const search = new CodeSearch(makeDriver() as never, embedding as never);

    await search.search('find the auth handler', { include_semantics: true, limit: 10 });

    expect(embed).toHaveBeenCalledTimes(1); // was 2 before OPT-49
    expect(embed).toHaveBeenCalledWith('find the auth handler');
  });

  it('does not embed at all when the provider is unavailable', async () => {
    const embed = vi.fn(async () => new Array(1536).fill(0));
    const embedding = { available: false, embed, embedBatch: vi.fn() };
    const search = new CodeSearch(makeDriver() as never, embedding as never);

    await search.search('q', { include_semantics: true });

    expect(embed).not.toHaveBeenCalled();
  });
});
