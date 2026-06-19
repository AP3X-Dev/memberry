// packages/code/src/__tests__/symbol-store.sibling-tag.live.test.ts
//
// OPT-7: when the file watcher reindexes a file WITHOUT project context and a NEW
// symbol is added, the new symbol must inherit the file's stored project_tag from
// an existing same-file sibling — NOT be stamped null. A null-tagged new symbol is
// invisible to a tag-scoped query while its siblings match (reader/writer scope
// divergence).
//
// Flow:
//   1. indexFile under project tag 'project:opt7x' stamps siblings with the tag.
//   2. Re-indexFile the same file WITHOUT a tag (the watcher's context-free path),
//      with a NEW symbol added to the source.
//   3. Assert the NEW symbol carries the SAME project_tag, so a tag-scoped
//      findSymbols query returns it.
//
// This FAILS before the fix: the new symbol is created with project_tag = null,
// so the scoped lookup excludes it (`expect(scopedNames).toContain('opt7NewWidget')`
// fails) and its stored project_tag is undefined, not the tag.
//
// Skips when Neo4j is unreachable (same probe pattern as the other live tests).
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, writeFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { createNeo4jDriver } from '@memberry/neo4j';
import { CodeIndexer } from '../indexer.js';
import { SymbolStore } from '../symbol-store.js';

const NEO4J_URI = process.env.NEO4J_URI || 'bolt://localhost:7687';
const NEO4J_USER = process.env.NEO4J_USER || 'neo4j';
const NEO4J_PASSWORD = process.env.NEO4J_PASSWORD || 'password';

const TAG = 'project:opt7x';
const OTHER_TAG = 'project:opt7y';

// First index: one symbol. Second index (watcher-style, no tag) ADDS a new symbol.
const FILE_V1 = `export function opt7OriginalWidget(): number {
  return 1;
}
`;
const FILE_V2 = `export function opt7OriginalWidget(): number {
  return 1;
}

export function opt7NewWidget(): number {
  return 2;
}
`;

// A second file in the SAME temp dir, scoped to a DIFFERENT tag. Its symbol shares
// the dir, so a tag-scoped query that fell back to the file_path path heuristic
// (the only path open to a null-tagged new symbol) could NOT separate it from the
// TAG file — only the canonical stored tag can. This makes the scoped-lookup
// assertion below genuinely discriminating.
const OTHER_FILE_SRC = `export function opt7OtherWidget(): number {
  return 3;
}
`;

describe('SymbolStore — watcher reindex inherits sibling project_tag for new symbols (OPT-7, live Neo4j)', () => {
  let neo4jAvailable = false;
  const driver = createNeo4jDriver(NEO4J_URI, NEO4J_USER, NEO4J_PASSWORD);
  let dir = '';
  let file = '';
  let otherFile = '';

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
    try {
      await driver.getServerInfo();
      neo4jAvailable = true;
    } catch {
      console.warn(`[skip] Neo4j not reachable at ${NEO4J_URI} — skipping OPT-7 sibling-tag test`);
      return;
    }
    dir = await mkdtemp(join(tmpdir(), 'amp-opt7-'));
    file = join(dir, 'widgets.ts');
    otherFile = join(dir, 'other.ts');
    await wipe();
  });

  afterAll(async () => {
    if (neo4jAvailable) await wipe();
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {});
    await driver.close().catch(() => {});
  });

  it('stamps a new symbol added on a context-free reindex with the file sibling tag, so a scoped query finds it', async () => {
    if (!neo4jAvailable) return;

    const indexer = new CodeIndexer(driver);
    const store = new SymbolStore(driver);

    // 0. A SECOND file in the same dir, scoped to a DIFFERENT tag — so the scoped
    //    lookup below cannot rely on the file_path heuristic to separate projects.
    await writeFile(otherFile, OTHER_FILE_SRC, 'utf8');
    await indexer.indexFile(otherFile, 'typescript', OTHER_TAG);

    // 1. Index the file under TAG. The original symbol carries the tag.
    await writeFile(file, FILE_V1, 'utf8');
    await indexer.indexFile(file, 'typescript', TAG);

    const original = (await store.getByFile(file)).find((s) => s.name === 'opt7OriginalWidget');
    expect(original).toBeDefined();
    expect(original!.project_tag).toBe(TAG);

    // 2. Edit the file to ADD a new symbol, then reindex WITHOUT a tag — exactly
    //    what the watcher does (indexFile(path, language) with no projectTag).
    await writeFile(file, FILE_V2, 'utf8');
    await indexer.indexFile(file, 'typescript', undefined);

    // 3. The NEW symbol must carry the file's project_tag (inherited from its
    //    scoped sibling), not null. Without the fix it is stamped null here — this
    //    assertion FAILS (project_tag is undefined, not the tag).
    const added = (await store.getByFile(file)).find((s) => s.name === 'opt7NewWidget');
    expect(added).toBeDefined();
    expect(added!.project_tag).toBe(TAG);

    // The original symbol's tag is still preserved (COALESCE-on-match unchanged).
    const originalAfter = (await store.getByFile(file)).find((s) => s.name === 'opt7OriginalWidget');
    expect(originalAfter!.project_tag).toBe(TAG);

    // 4. A tag-scoped lookup (with a dir path hint) returns the TAG file's symbols
    //    — including the new one — but NEVER the OTHER_TAG file's symbol. Without
    //    the fix the new symbol is null-tagged: it would be admitted into the
    //    OTHER_TAG scope too (its null tag falls through to the shared-dir path
    //    heuristic), so it leaks across project scopes. With the fix it is stamped
    //    TAG and stays in TAG's scope only.
    const scopedToTag = await store.findSymbols({ project_tag: TAG, file_path: dir, limit: 20 });
    const tagNames = scopedToTag.map((s) => s.name);
    expect(tagNames).toContain('opt7OriginalWidget');
    expect(tagNames).toContain('opt7NewWidget');

    const scopedToOther = await store.findSymbols({ project_tag: OTHER_TAG, file_path: dir, limit: 20 });
    const otherNames = scopedToOther.map((s) => s.name);
    expect(otherNames).toContain('opt7OtherWidget');
    // The new symbol belongs to TAG, not OTHER_TAG. A null-tagged new symbol would
    // leak into OTHER_TAG's results via the shared-dir path fallback.
    expect(otherNames).not.toContain('opt7NewWidget');
  });
});
