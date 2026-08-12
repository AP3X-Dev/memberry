// Covers checkVectorIndexDimensions' index selection. The check used to compare
// EVERY vector index against EMBEDDING_DIM, so the deliberately non-1536 code
// indexes (symbol_lexical 4096, symbol_mini 64) registered as permanent drift and
// held the server in DEGRADED MODE.
import { describe, it, expect, vi } from 'vitest';
import { checkVectorIndexDimensions } from '../migrations.js';
import { EMBEDDING_DIM } from '@memberry/core';

/** Driver stub returning one SHOW INDEXES row per given index. */
function driverWith(rows: Array<{ name: string; properties: string[]; dimensions: number }>) {
  const records = rows.map((r) => ({
    get: (key: string) => {
      if (key === 'name') return r.name;
      if (key === 'properties') return r.properties;
      return { indexConfig: { 'vector.dimensions': r.dimensions } };
    },
  }));
  return {
    session: () => ({
      run: vi.fn().mockResolvedValue({ records }),
      close: vi.fn().mockResolvedValue(undefined),
    }),
  } as never;
}

describe('checkVectorIndexDimensions', () => {
  it('ignores vector indexes that do not hold embedding-model vectors', async () => {
    const driver = driverWith([
      { name: 'semantic_embedding', properties: ['embedding'], dimensions: EMBEDDING_DIM },
      { name: 'symbol_lexical', properties: ['lexical_vector'], dimensions: 4096 },
      { name: 'symbol_mini', properties: ['mini_vector'], dimensions: 64 },
    ]);

    expect(await checkVectorIndexDimensions(driver)).toEqual([]);
  });

  it('still reports a real embedding-index dimension mismatch', async () => {
    const driver = driverWith([
      { name: 'semantic_embedding', properties: ['embedding'], dimensions: 768 },
      { name: 'symbol_mini', properties: ['mini_vector'], dimensions: 64 },
    ]);

    expect(await checkVectorIndexDimensions(driver)).toEqual([
      { name: 'semantic_embedding', actual: 768, expected: EMBEDDING_DIM },
    ]);
  });
});
