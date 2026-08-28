// IDX-003 acceptance gate — assertions C10-C15, the fail-loud guard.
// EXTENDED by IDX-004 with S11/S12: the guard now measures COVERAGE, not emptiness.
//
// checkVectorIndexDimensions catches an index whose SHAPE drifted. It does not
// catch the failure that actually happened for the entire life of the code
// index: an index created correctly, with the right dimensions, that nothing
// ever wrote to. Queries against it return zero rows, the channel reports
// SUCCESS, and retrieval silently degrades to lexical-only with nothing in any
// log. That is why 54,314 symbols sat at 0 embeddings without a single alert.
//
// IDX-004 then found the guard's own blind spot: it fired only at exactly zero,
// so a half-finished backfill read as healthy. See C11, which now asserts the
// OPPOSITE of what it asserted under IDX-003, deliberately.

import { describe, expect, it, vi } from 'vitest';
import { checkVectorIndexCoverage } from '../migrations.js';

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

const FULL = { nodes: 200, embedded: 200 };

describe('vector index coverage guard (IDX-003 C10-C15, IDX-004 S11-S12)', () => {
  it('C10 — reports a label with nodes and zero embeddings: the live defect', async () => {
    const { driver } = driverWith({
      Symbol: { nodes: 54314, embedded: 0 },
      Semantic: { nodes: 192, embedded: 192 },
      Episodic: { nodes: 10, embedded: 10 },
      Fact: { nodes: 0, embedded: 0 },
    });
    const under = await checkVectorIndexCoverage(driver as never);
    expect(under).toEqual([{ label: 'Symbol', nodes: 54314, embedded: 0, ratio: 0 }]);
  });

  it('C11 — a PARTIALLY embedded label IS reported (supersedes the IDX-003 rationale)', async () => {
    const { driver } = driverWith({
      Symbol: { nodes: 54314, embedded: 1 },
      Semantic: { nodes: 192, embedded: 192 },
      Episodic: { nodes: 0, embedded: 0 },
      Fact: { nodes: 0, embedded: 0 },
    });
    // THIS ASSERTION IS INVERTED FROM IDX-003, ON PURPOSE.
    //
    // It used to read: "One embedding proves the writer is wired. Reporting here would cry wolf
    // through every backfill and train people to ignore the warning." That was correct WHILE a
    // backfill was the expected state. Its cost was concrete: it called Symbol at 16,399/54,314
    // — 30% — perfectly healthy, which is exactly the condition IDX-004 was created to find.
    //
    // Post-backfill the Symbol population is 54,314/54,314, so sub-95% is no longer routine.
    // The residual cry-wolf window is real and narrow and is shipped stated, not hidden:
    // indexing a NEW project of ~2,860+ symbols and restarting the server before its embed pass
    // finishes will report DEGRADED for that process lifetime, because the guard runs once at
    // boot. That needs a restart mid-backfill.
    const under = await checkVectorIndexCoverage(driver as never);
    expect(under.map((e) => e.label)).toEqual(['Symbol']);
    expect(under[0].embedded).toBe(1);
  });

  it('S11 — fires below the 0.95 floor and stays quiet at or above it', async () => {
    const at = async (embedded: number) => {
      const { driver } = driverWith({
        Symbol: { nodes: 1000, embedded },
        Semantic: FULL, Episodic: FULL, Fact: FULL,
      });
      return (await checkVectorIndexCoverage(driver as never)).map((e) => e.label);
    };
    expect(await at(300)).toEqual(['Symbol']);   // 30% — the state IDX-004 found live
    expect(await at(940)).toEqual(['Symbol']);   // 94% — just under
    expect(await at(949)).toEqual(['Symbol']);   // 94.9% — just under
    expect(await at(950)).toEqual([]);           // exactly 95% — the boundary is inclusive
    expect(await at(1000)).toEqual([]);          // 100%
  });

  it('S11b — the reported ratio is the real coverage, so a warning can name it', async () => {
    const { driver } = driverWith({
      Symbol: { nodes: 54314, embedded: 16399 },
      Semantic: FULL, Episodic: FULL, Fact: FULL,
    });
    const under = await checkVectorIndexCoverage(driver as never);
    expect(under[0].ratio).toBeCloseTo(0.3019, 4);
  });

  it('C12 / S12 — a label with no nodes is not reported: nothing is wrong with empty', async () => {
    const { driver } = driverWith({
      Symbol: { nodes: 0, embedded: 0 },
      Semantic: { nodes: 0, embedded: 0 },
      Episodic: { nodes: 0, embedded: 0 },
      Fact: { nodes: 0, embedded: 0 },
    });
    // Load-bearing: 0/0 is NaN, and the predicate is written `!(ratio >= FLOOR)` precisely so
    // that a NaN REPORTS rather than passing silently. Remove the `nodes === 0` guard in the
    // source and this assertion goes red — which is the whole point of writing it that way.
    expect(await checkVectorIndexCoverage(driver as never)).toEqual([]);
  });

  it('S18 — Fact is NOT guarded, because nothing reads fact_embedding', async () => {
    const { driver } = driverWith({
      Symbol: { nodes: 54314, embedded: 54314 },
      Semantic: { nodes: 194, embedded: 194 },
      Episodic: { nodes: 1695, embedded: 1695 },
      Fact: { nodes: 29314, embedded: 0 },
    });
    // The live state as of 2026-08-28. Fact at 0/29,314 would otherwise pin `status.degraded`
    // non-empty on every boot forever, and an alarm that can never clear is not an alarm — the
    // exact trap this guard was widened to escape. `fact_embedding` appears only in its own
    // CREATE statement in schema.ts, so no query can silently get nothing from it.
    //
    // This is a scope correction, NOT a mute, and it costs something real: the Fact plane's
    // open decision (build a reader or drop the index) has just lost its only automated
    // reminder. RESEARCH-LEDGER.md RL-008 is now the only thing holding it.
    expect(await checkVectorIndexCoverage(driver as never)).toEqual([]);
  });

  it('C13 — reports EVERY affected READ label, not just the first', async () => {
    const { driver } = driverWith({
      Symbol: { nodes: 54314, embedded: 0 },
      Semantic: { nodes: 192, embedded: 0 },
      Episodic: { nodes: 5, embedded: 0 },
      Fact: { nodes: 3, embedded: 0 },
    });
    const under = await checkVectorIndexCoverage(driver as never);
    expect(under.map((e) => e.label)).toEqual(['Symbol', 'Semantic', 'Episodic']);
  });

  it('C14 — a restricted or unavailable server skips the guard rather than failing boot', async () => {
    const { driver } = driverWith({}, { throws: true });
    // Same contract as checkVectorIndexDimensions: a diagnostic must never be
    // the reason the server will not start.
    await expect(checkVectorIndexCoverage(driver as never)).resolves.toEqual([]);
  });

  it('C15 — the guard closes its session even when the query throws', async () => {
    const close = vi.fn(async () => undefined);
    const driver = {
      session: () => ({ run: vi.fn(async () => { throw new Error('boom'); }), close }),
    };
    await checkVectorIndexCoverage(driver as never);
    expect(close).toHaveBeenCalled();
  });
});
