// packages/code/src/__tests__/symbol-project-scope.live.test.ts
//
// T5/gap-11: code Symbols are scoped by a canonical, single-scope project_tag
// stamped at index time, and search/lookup filter by s.project_tag BEFORE any
// file_path path heuristic. This is an end-to-end check against a real Neo4j:
//
//   1. indexFile under project tag 'project:t5x' stamps s.project_tag = 'project:t5x'.
//   2. indexFile (a DIFFERENT file) under a DIFFERENT tag stamps that tag.
//   3. Re-indexing the first file WITHOUT a tag PRESERVES the stored tag (COALESCE).
//   4. berry_code_search scoped to 'project:t5x' returns ONLY the t5x symbols —
//      even though both files live under the SAME temp dir (so a file_path
//      substring heuristic could NOT separate them); the canonical tag does.
//   5. SymbolStore.findSymbols scoped to a tag returns only that tag's symbols.
//
// Skips when Neo4j is unreachable (same probe pattern as semantic.test.ts).
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, writeFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import type { EmbeddingProvider } from '@memberry/core';
import { createNeo4jDriver } from '@memberry/neo4j';
import { CodeIndexer } from '../indexer.js';
import { SymbolStore } from '../symbol-store.js';
import { CodeSearch } from '../search.js';
import { initCodeSchema } from '../schema.js';

const NEO4J_URI = process.env.NEO4J_URI || 'bolt://localhost:7687';
const NEO4J_USER = process.env.NEO4J_USER || 'neo4j';
const NEO4J_PASSWORD = process.env.NEO4J_PASSWORD || 'password';

const TAG_A = 'project:t5x';
const TAG_B = 'project:t5y';

// Distinct, fulltext-findable symbol names per file so the search assertion can
// target one project without relying on file paths.
const FILE_A = `export function t5xAlphaWidget(): number {
  return 1;
}
`;
const FILE_B = `export function t5yBetaGadget(): number {
  return 2;
}
`;

// No-embedding provider → CodeSearch uses fulltext + the deterministic lexical
// index only (no dense vectors), so results are stable without an OpenAI key.
function disabledEmbedding(): EmbeddingProvider {
  return {
    available: false,
    embed: async () => new Array(1536).fill(0),
    embedBatch: async (t: string[]) => t.map(() => new Array(1536).fill(0)),
  };
}

async function isNeo4jReachable(): Promise<boolean> {
  const probe = createNeo4jDriver(NEO4J_URI, NEO4J_USER, NEO4J_PASSWORD);
  try {
    await probe.getServerInfo();
    return true;
  } catch {
    return false;
  } finally {
    await probe.close().catch(() => {});
  }
}

describe('Symbol project scoping (T5/gap-11, live Neo4j)', () => {
  let neo4jAvailable = false;
  const driver = createNeo4jDriver(NEO4J_URI, NEO4J_USER, NEO4J_PASSWORD);
  let dir = '';
  let fileA = '';
  let fileB = '';

  async function wipe(): Promise<void> {
    if (!dir) return;
    const s = driver.session();
    try {
      await s.run('MATCH (n:Symbol) WHERE n.file_path STARTS WITH $d DETACH DELETE n', { d: dir });
      await s.run('MATCH (e:Entity:Component) WHERE e.path STARTS WITH $d DETACH DELETE e', { d: dir });
    } finally {
      await s.close();
    }
  }

  beforeAll(async () => {
    neo4jAvailable = await isNeo4jReachable();
    if (!neo4jAvailable) {
      console.warn(`[skip] Neo4j not reachable at ${NEO4J_URI} — skipping project-scope tests`);
      return;
    }
    // Fulltext + project index must exist for the scoped search assertion.
    await initCodeSchema(driver);
    dir = await mkdtemp(join(tmpdir(), 'amp-t5scope-'));
    fileA = join(dir, 'alpha.ts');
    fileB = join(dir, 'beta.ts');
    await writeFile(fileA, FILE_A, 'utf8');
    await writeFile(fileB, FILE_B, 'utf8');
    await wipe();
  });

  afterAll(async () => {
    if (neo4jAvailable) await wipe();
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {});
    await driver.close().catch(() => {});
  });

  it('stamps s.project_tag at index time, scopes search by tag before the path heuristic, and preserves the tag on context-free reindex', async () => {
    if (!neo4jAvailable) return;

    const indexer = new CodeIndexer(driver);
    const store = new SymbolStore(driver);
    const search = new CodeSearch(driver, disabledEmbedding());

    // 1. Index file A under TAG_A and file B under TAG_B (same temp dir).
    await indexer.indexFile(fileA, 'typescript', TAG_A);
    await indexer.indexFile(fileB, 'typescript', TAG_B);

    // The stored Symbol carries the canonical project_tag.
    const alpha = (await store.getByFile(fileA)).find((s) => s.name === 't5xAlphaWidget');
    expect(alpha).toBeDefined();
    expect(alpha!.project_tag).toBe(TAG_A);

    const beta = (await store.getByFile(fileB)).find((s) => s.name === 't5yBetaGadget');
    expect(beta).toBeDefined();
    expect(beta!.project_tag).toBe(TAG_B);

    // 2. Re-index file A WITHOUT a tag (the watcher's context-free path) — the
    //    COALESCE-on-match preserves the existing stored tag rather than clearing it.
    await indexer.indexFile(fileA, 'typescript', undefined);
    const alphaAfter = (await store.getByFile(fileA)).find((s) => s.name === 't5xAlphaWidget');
    expect(alphaAfter!.project_tag).toBe(TAG_A);

    // 3. berry_code_search scoped to TAG_A returns ONLY t5x symbols. Both files
    //    share the same temp dir, so this can ONLY be the canonical-tag filter —
    //    a file_path substring heuristic could not separate them.
    const scopedToA = await search.search('t5', {
      project_tag: TAG_A,
      include_semantics: false,
      limit: 20,
    });
    const scopedNames = scopedToA.map((r) => r.name);
    expect(scopedNames).toContain('t5xAlphaWidget');
    expect(scopedNames).not.toContain('t5yBetaGadget');

    // Control: an unscoped search over the same temp dir sees BOTH symbols, so
    // the exclusion above is the scope filter, not a fulltext miss.
    const unscoped = await search.search('t5', {
      file_path: dir,
      include_semantics: false,
      limit: 20,
    });
    const unscopedNames = unscoped.map((r) => r.name);
    expect(unscopedNames).toContain('t5xAlphaWidget');
    expect(unscopedNames).toContain('t5yBetaGadget');

    // 4. SymbolStore.findSymbols scoped to TAG_B returns only t5y symbols.
    const lookupB = await store.findSymbols({ project_tag: TAG_B, limit: 20 });
    const lookupNames = lookupB.map((s) => s.name);
    expect(lookupNames).toContain('t5yBetaGadget');
    expect(lookupNames).not.toContain('t5xAlphaWidget');
  });
});
