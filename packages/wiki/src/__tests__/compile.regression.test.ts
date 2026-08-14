// packages/wiki/src/__tests__/compile.regression.test.ts
//
// Source-level regression pins for the wiki compiler (mirrors the
// bootstrap.regression.test.ts convention) — guard structural invariants that
// are awkward to exercise through the full WikiCompiler.run pipeline.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const COMPILE_SRC = fs.readFileSync(path.resolve(__dirname, '../compile.ts'), 'utf-8');

describe('compile.ts regression', () => {
  it('OPT-58: Phase 2 reuses the Phase-1 batched episodics map, not a per-entity re-fetch', () => {
    // Phase 1 batch-fetches every entity's episodics once (fetchEpisodicsForEntities,
    // the OPT-22 single-scan) into a global name→episodics map; Phase 2 must REUSE
    // that map rather than re-running the single-entity fetchEpisodicsForEntity per
    // article (its per-entity result is identical — proven in queries.test.ts).

    // The single-entity fetch CALL must be gone (match the invocation `(`, not a
    // mention — an explanatory comment may still reference the name). `...Entity(`
    // does not match the batched `...Entities(`, so this ignores the Phase-1 call.
    expect(COMPILE_SRC).not.toMatch(/\bfetchEpisodicsForEntity\(/);

    // The batched form is still used (Phase 1).
    expect(COMPILE_SRC).toContain('fetchEpisodicsForEntities(');

    // The global reuse map is keyed by stable entity ID, preventing same-name
    // entities in different projects from sharing history.
    expect(COMPILE_SRC).toContain('entityEpisodicsById');
    expect(COMPILE_SRC).toMatch(/entityEpisodicsById\.get\(entity\.id\)/);
  });

  it('gap-15: publishes private generations without removing or clearing the volume root', () => {
    // outputDir may be a Docker volume MOUNT POINT (the shared wiki_output
    // volume); rm-ing a mount point fails with EBUSY and crash-loops the wiki
    // container. The compiler now writes a fresh tree and atomically selects it;
    // neither the mount nor the currently served tree is cleared in place.
    expect(COMPILE_SRC).not.toMatch(/\brm\(outputDir\s*,/); // never rm the dir/mount itself
    expect(COMPILE_SRC).toContain('WIKI_GENERATIONS_DIRNAME');
    expect(COMPILE_SRC).toContain('publishGenerationPointer(outputDir, generationName)');
    expect(COMPILE_SRC).toContain('await rename(buildingDir, generationDir)');
  });
});
