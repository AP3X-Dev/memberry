// IDX-003 acceptance gate — assertions C10-C14, the fail-loud guard.
//
// checkVectorIndexDimensions catches an index whose SHAPE drifted. It does not
// catch the failure that actually happened for the entire life of the code
// index: an index created correctly, with the right dimensions, that nothing
// ever wrote to. Queries against it return zero rows, the channel reports
// SUCCESS, and retrieval silently degrades to lexical-only with nothing in any
// log. That is why 54,314 symbols sat at 0 embeddings without a single alert.
//
// This guard reports a label that has nodes and NOT ONE embedding.

import { describe, expect, it, vi } from 'vitest';
import { checkEmptyVectorIndexes } from '../migrations.js';

/** Driver whose per-label counts come from a fixture map. */
function driverWith(counts: Record<string, { nodes: number; embedded: number }>, opts: { throws?: boolean } = {}) {
  const run = vi.fn(async (cypher: string) => {
    if (opts.throws) throw new Error('permission denied');
    const label = ['Symbol', 'Semantic', 'Episodic', 'Fact'].find((l) => cypher.includes(`:${l}`));
    const entry = label ? counts[label] : undefined;
    if (!entry) return { records: [] };
    return {
      records: [{
        get: (key: string) => (key === 'nodes' ? entry.nodes : entry.embedded),
      }],
    };
  });
  return { driver: { session: () => ({ run, close: vi.fn(async () => undefined) }) }, run };
}

describe('IDX-003 empty vector index guard', () => {
  it('C10 — reports a label with nodes and zero embeddings: the live defect', async () => {
    const { driver } = driverWith({
      Symbol: { nodes: 54314, embedded: 0 },
      Semantic: { nodes: 192, embedded: 192 },
      Episodic: { nodes: 10, embedded: 10 },
      Fact: { nodes: 0, embedded: 0 },
    });
    const empty = await checkEmptyVectorIndexes(driver as never);
    expect(empty).toEqual([{ label: 'Symbol', nodes: 54314, embedded: 0 }]);
  });

  it('C11 — a PARTIALLY embedded label is backfill in progress, not a wiring defect', async () => {
    const { driver } = driverWith({
      Symbol: { nodes: 54314, embedded: 1 },
      Semantic: { nodes: 192, embedded: 192 },
      Episodic: { nodes: 0, embedded: 0 },
      Fact: { nodes: 0, embedded: 0 },
    });
    // One embedding proves the writer is wired. Reporting here would cry wolf
    // through every backfill and train people to ignore the warning.
    expect(await checkEmptyVectorIndexes(driver as never)).toEqual([]);
  });

  it('C12 — a label with no nodes is not reported: nothing is wrong with empty', async () => {
    const { driver } = driverWith({
      Symbol: { nodes: 0, embedded: 0 },
      Semantic: { nodes: 0, embedded: 0 },
      Episodic: { nodes: 0, embedded: 0 },
      Fact: { nodes: 0, embedded: 0 },
    });
    expect(await checkEmptyVectorIndexes(driver as never)).toEqual([]);
  });

  it('C13 — reports EVERY affected label, not just the first', async () => {
    const { driver } = driverWith({
      Symbol: { nodes: 54314, embedded: 0 },
      Semantic: { nodes: 192, embedded: 0 },
      Episodic: { nodes: 5, embedded: 0 },
      Fact: { nodes: 3, embedded: 0 },
    });
    const empty = await checkEmptyVectorIndexes(driver as never);
    expect(empty.map((e) => e.label)).toEqual(['Symbol', 'Semantic', 'Episodic', 'Fact']);
  });

  it('C14 — a restricted or unavailable server skips the guard rather than failing boot', async () => {
    const { driver } = driverWith({}, { throws: true });
    // Same contract as checkVectorIndexDimensions: a diagnostic must never be
    // the reason the server will not start.
    await expect(checkEmptyVectorIndexes(driver as never)).resolves.toEqual([]);
  });

  it('C15 — the guard closes its session even when the query throws', async () => {
    const close = vi.fn(async () => undefined);
    const driver = {
      session: () => ({ run: vi.fn(async () => { throw new Error('boom'); }), close }),
    };
    await checkEmptyVectorIndexes(driver as never);
    expect(close).toHaveBeenCalled();
  });
});
