// packages/mcp/src/__tests__/wiki-autorefresh.wiring.test.ts
//
// gap-15 (T10): pins the PRODUCTION WIRING of the opt-in wiki autorefresh so a
// future refactor can't silently disconnect the trigger from its hook points.
// (The guard/debounce BEHAVIOR is covered by wiki-autorefresh.test.ts; this file
// asserts the call sites exist in bootstrap.ts + tools.ts.)
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const BOOTSTRAP_SOURCE = fs.readFileSync(path.resolve(__dirname, '../bootstrap.ts'), 'utf-8');
const TOOLS_SOURCE = fs.readFileSync(path.resolve(__dirname, '../tools.ts'), 'utf-8');

describe('wiki autorefresh wiring (gap-15)', () => {
  it('bootstrap.ts configures the recompiler with a FULL (no-project-tag) compile', () => {
    // The recompile closure must call rawWikiCompiler.compile(outputDir) with NO
    // project_tag arg — a scoped recompile would rm -rf the whole dir but only
    // re-emit one project. The single-arg call = compile ALL projects.
    expect(BOOTSTRAP_SOURCE).toContain('configureWikiAutorefresh(');
    expect(BOOTSTRAP_SOURCE).toMatch(/rawWikiCompiler\.compile\(\s*outputDir\s*\)/);
    // And it must reuse the same compiler that backs berry_compile (the driver is
    // only available in bootstrap), not construct a second one.
    const cfg = BOOTSTRAP_SOURCE.match(/configureWikiAutorefresh\(\{([\s\S]*?)\}\);/);
    expect(cfg).not.toBeNull();
    expect(cfg![1]).toContain('rawWikiCompiler.compile');
  });

  it('the store monkey-patch durably schedules publication after each store', () => {
    // The coordinator persists dirty intent before its debounced, retrying full
    // publication. This replaced the older in-memory scheduleWikiRecompile hook.
    expect(BOOTSTRAP_SOURCE).toContain('await consolidationCoordinator.schedulePublication()');
    const storeOverride = BOOTSTRAP_SOURCE.match(
      /ampService\.store\s*=\s*async[\s\S]*?return result;\s*\};/,
    );
    expect(storeOverride).not.toBeNull();
    expect(storeOverride![0]).toContain('await consolidationCoordinator.schedulePublication()');
    expect(storeOverride![0]).toContain('consolidationCoordinator.schedule(resolveEpisodeScope(input))');
  });

  it('setup and successful consolidation mutation paths trigger an immediate recompile', () => {
    expect(TOOLS_SOURCE).toContain("import { recompileWikiNow } from './wiki-autorefresh.js'");
    // Two setup paths plus run/apply/dream consolidation mutation paths.
    const calls = TOOLS_SOURCE.match(/await recompileWikiNow\(\);/g) ?? [];
    expect(calls.length).toBe(5);

    const consolidateHandler = TOOLS_SOURCE.match(
      /async berry_consolidate\(args\)[\s\S]*?async berry_resolve\(args\)/,
    );
    expect(consolidateHandler).not.toBeNull();
    expect(consolidateHandler![0].match(/await recompileWikiNow\(\);/g)).toHaveLength(3);
  });
});
