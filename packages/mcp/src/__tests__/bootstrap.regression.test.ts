// packages/mcp/src/__tests__/bootstrap.regression.test.ts
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const BOOTSTRAP_SOURCE = fs.readFileSync(
  path.resolve(__dirname, '../bootstrap.ts'),
  'utf-8',
);

describe('bootstrap.ts regression', () => {
  it('BUG-0007: apply adapter wraps reviewProposal in try/catch and returns failure on error', () => {
    // Before the fix, the apply adapter always returned { applied: true }
    // even when reviewProposal threw. The fix wraps it in try/catch
    // and returns { applied: false, error } on failure.

    // Verify the apply adapter contains a try/catch pattern
    const applyBlock = BOOTSTRAP_SOURCE.match(
      /apply:\s*async\s*\([^)]*\)\s*=>\s*\{([\s\S]*?)\n\s{4}\},/,
    );
    expect(applyBlock).not.toBeNull();

    const applyBody = applyBlock![1];

    // Must contain try/catch
    expect(applyBody).toContain('try');
    expect(applyBody).toContain('catch');

    // Must return applied: false on error path
    expect(applyBody).toContain('applied: false');
  });

  it('OPT-102: wires the episodic accessor into the ConsolidationEngine neo4j layer', () => {
    // Before the fix, bootstrap built `new ConsolidationEngine(redisLayer,
    // { semantic, fact }, config)` with NO episodic accessor, so in production
    // _deriveTenantFromEpisodes' episode-fetch path was dead — a promote/supersede
    // whose after.tenant_id is unset mis-attributed the consolidated semantic to
    // DEFAULT_TENANT in multi-tenant mode. The fix passes core.episodic (an
    // EpisodicStore exposing getById + getTenantsByIds, OPT-45) as the 2nd arg's
    // episodic accessor. (Engine-level derivation behaviour is covered by
    // consolidation.test.ts; this pins the prod wiring that activates it.)
    const ctorMatch = BOOTSTRAP_SOURCE.match(
      /new ConsolidationEngine\(([\s\S]*?)\n\s{2}\);/,
    );
    expect(ctorMatch).not.toBeNull();
    const ctorArgs = ctorMatch![1];

    // The neo4j-layer (2nd) arg must include the episodic accessor alongside
    // semantic + fact so the engine can read source episodes' tenant_id.
    expect(ctorArgs).toMatch(/\{\s*semantic,\s*episodic,\s*fact:/);

    // And episodic must be destructured from the core service kit (between
    // scopedQuery and factStore) — not a stray identifier.
    expect(BOOTSTRAP_SOURCE).toMatch(/scopedQuery,\s*episodic,\s*factStore:/);
  });
});
