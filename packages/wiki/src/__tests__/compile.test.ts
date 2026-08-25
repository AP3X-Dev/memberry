// packages/wiki/src/__tests__/compile.test.ts
// Tests for WikiCompiler, slugify, and resolveInlineLinks.

import { describe, it, expect, vi } from 'vitest';
import { slugify, resolveInlineLinks, WikiCompiler, deriveEpisodicScope, resolvePublishedWikiDir } from '../compile.js';
import type { EpisodicEntry } from '../types.js';
import type { Driver, Session, Result } from 'neo4j-driver';

describe('deriveEpisodicScope', () => {
  const known = ['agent-assist-cr', 'ag3ntic', 'mars-fps', 'amp']
    .sort((a, b) => b.length - a.length);
  const ep = (over: Partial<EpisodicEntry>): EpisodicEntry => ({
    id: 'x', task: '', content: '', outcome: null, session_id: '', created_at: '', project_scope: null, ...over,
  });

  it('keeps an explicit task-prefix scope', () => {
    expect(deriveEpisodicScope(ep({ project_scope: 'ag3ntic' }), known)).toBe('ag3ntic');
  });

  it('falls back to a [project:…] prefix in content', () => {
    expect(deriveEpisodicScope(ep({ content: '[project:mars-fps] did a thing' }), known)).toBe('mars-fps');
  });

  it('infers the project from a known name in the session_id', () => {
    expect(deriveEpisodicScope(ep({ session_id: 'session-20260608-ag3ntic-morph' }), known)).toBe('ag3ntic');
  });

  it('prefers the most specific (longest) known match', () => {
    expect(deriveEpisodicScope(ep({ session_id: 'session-1-agent-assist-cr-review' }), known)).toBe('agent-assist-cr');
  });

  it('returns empty when nothing matches', () => {
    expect(deriveEpisodicScope(ep({ session_id: 'session-20260608-2115' }), known)).toBe('');
  });
});

// slugify tests

describe('slugify', () => {
  it('converts to lowercase', () => {
    expect(slugify('Mars FPS')).toBe('mars-fps');
  });

  it('replaces spaces with hyphens', () => {
    expect(slugify('game engine')).toBe('game-engine');
  });

  it('replaces non-alphanumeric chars with hyphens', () => {
    expect(slugify('ECS (Entity Component System)')).toBe('ecs-entity-component-system');
  });

  it('trims leading/trailing hyphens', () => {
    expect(slugify('---hello---')).toBe('hello');
  });

  it('collapses multiple hyphens', () => {
    expect(slugify('hello   world   test')).toBe('hello-world-test');
  });

  it('handles empty string', () => {
    expect(slugify('')).toBe('');
  });

  it('handles pure punctuation', () => {
    expect(slugify('!!??...')).toBe('');
  });

  it('handles numbers', () => {
    expect(slugify('v2.0 release')).toBe('v2-0-release');
  });

  it('handles single char', () => {
    expect(slugify('A')).toBe('a');
  });

  it('handles already-slug', () => {
    expect(slugify('already-slug')).toBe('already-slug');
  });

  it('handles unicode characters', () => {
    expect(slugify('cafe latte')).toBe('cafe-latte');
  });

  it('handles mixed case and numbers', () => {
    expect(slugify('MyComponent2Test')).toBe('mycomponent2test');
  });
});

// resolveInlineLinks tests

describe('resolveInlineLinks', () => {
  it('links a single mention of an entity', () => {
    const result = resolveInlineLinks('Uses Redis for caching', ['Redis'], 'my-proj');
    expect(result).toBe('Uses [[projects/my-proj/redis|Redis]] for caching');
  });

  it('links all occurrences of the same entity (global)', () => {
    const text = 'Redis handles caching. Redis also handles pub/sub. Redis is fast.';
    const result = resolveInlineLinks(text, ['Redis'], 'my-proj');
    const link = '[[projects/my-proj/redis|Redis]]';
    expect(result).toBe(`${link} handles caching. ${link} also handles pub/sub. ${link} is fast.`);
  });

  it('does not double-link an entity already inside a [[wikilink]]', () => {
    const text = 'See [[projects/my-proj/redis|Redis]] and also Redis is great';
    const result = resolveInlineLinks(text, ['Redis'], 'my-proj');
    // The first "Redis" is inside [[...]] — must stay untouched. The second gets linked.
    expect(result).toBe('See [[projects/my-proj/redis|Redis]] and also [[projects/my-proj/redis|Redis]] is great');
  });

  it('handles multiple different entities each appearing multiple times', () => {
    const text = 'Neo4j stores data. Redis caches it. Neo4j is a graph DB. Redis is fast.';
    const result = resolveInlineLinks(text, ['Neo4j', 'Redis'], 'proj');
    expect(result).toContain('[[projects/proj/neo4j|Neo4j]] stores data');
    expect(result).toContain('[[projects/proj/redis|Redis]] caches it');
    expect(result).toContain('[[projects/proj/neo4j|Neo4j]] is a graph DB');
    expect(result).toContain('[[projects/proj/redis|Redis]] is fast');
  });

  it('is case-insensitive when matching', () => {
    const text = 'redis handles caching. REDIS also handles pub/sub.';
    const result = resolveInlineLinks(text, ['Redis'], 'my-proj');
    const link = '[[projects/my-proj/redis|Redis]]';
    expect(result).toBe(`${link} handles caching. ${link} also handles pub/sub.`);
  });

  it('returns text unchanged when no entity refs match', () => {
    const text = 'Nothing to link here.';
    const result = resolveInlineLinks(text, ['Redis'], 'proj');
    expect(result).toBe('Nothing to link here.');
  });

  it('handles empty entity refs array', () => {
    const text = 'Some text about Redis.';
    const result = resolveInlineLinks(text, [], 'proj');
    expect(result).toBe('Some text about Redis.');
  });

  it('prefers longer entity names over shorter ones', () => {
    const text = 'The auth module handles authentication.';
    const result = resolveInlineLinks(text, ['auth', 'auth module'], 'proj');
    // "auth module" is longer, should be linked first
    expect(result).toContain('[[projects/proj/auth-module|auth module]]');
  });
});

// Mock helpers

function mockRecord(data: Record<string, unknown>) {
  return {
    get(key: string) {
      return data[key];
    },
    keys: Object.keys(data),
  };
}

function mockResult(records: ReturnType<typeof mockRecord>[] = []): Result {
  return { records } as unknown as Result;
}

function createMockDriver(queryResponses: Map<string, ReturnType<typeof mockResult>>): Driver {
  const mockSession = {
    run: vi.fn(async (query: string, _params?: unknown) => {
      // Match query responses by substring match
      for (const [key, value] of queryResponses) {
        if (query.includes(key)) return value;
      }
      return mockResult([]);
    }),
    close: vi.fn(async () => {}),
  } as unknown as Session;

  return {
    session: vi.fn(() => mockSession),
  } as unknown as Driver;
}

function createParamAwareMockDriver(
  handler: (query: string, params?: Record<string, unknown>) => ReturnType<typeof mockResult>,
): Driver {
  const mockSession = {
    run: vi.fn(async (query: string, params?: Record<string, unknown>) => handler(query, params)),
    close: vi.fn(async () => {}),
  } as unknown as Session;

  return {
    session: vi.fn(() => mockSession),
  } as unknown as Driver;
}

/** Like createParamAwareMockDriver but the handler may be async (e.g. to delay). */
function createAsyncMockDriver(
  handler: (query: string, params?: Record<string, unknown>) => Promise<ReturnType<typeof mockResult>>,
): Driver {
  const mockSession = {
    run: vi.fn(async (query: string, params?: Record<string, unknown>) => handler(query, params)),
    close: vi.fn(async () => {}),
  } as unknown as Session;

  return {
    session: vi.fn(() => mockSession),
  } as unknown as Driver;
}

async function fileExists(fs: typeof import('node:fs/promises'), p: string): Promise<boolean> {
  try { await fs.access(p); return true; } catch { return false; }
}

// WikiCompiler tests

describe('WikiCompiler', () => {
  it('compiles an empty graph with zero projects', async () => {
    const driver = createMockDriver(new Map());
    const compiler = new WikiCompiler(driver);

    const os = await import('node:os');
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    const outputDir = path.join(os.tmpdir(), `amp-wiki-test-${Date.now()}`);

    try {
      const result = await compiler.compile(outputDir);

      expect(result.projects_compiled).toBe(0);
      expect(result.articles_compiled).toBe(0);
      expect(result.episodics_rendered).toBe(0);
      expect(result.output_dir).toBe(outputDir);
      expect(result.cross_project_pages).toBe(3); // decisions + patterns + recent
      const publishedDir = await resolvePublishedWikiDir(outputDir);

      // Verify output files exist
      const indexStat = await fs.stat(path.join(publishedDir, '_index.md'));
      expect(indexStat.isFile()).toBe(true);

      const decisionsStat = await fs.stat(path.join(publishedDir, '_decisions.md'));
      expect(decisionsStat.isFile()).toBe(true);

      const patternsStat = await fs.stat(path.join(publishedDir, '_patterns.md'));
      expect(patternsStat.isFile()).toBe(true);

      const recentStat = await fs.stat(path.join(publishedDir, '_recent.md'));
      expect(recentStat.isFile()).toBe(true);
    } finally {
      await fs.rm(outputDir, { recursive: true, force: true });
    }
  });

  it('creates library directory with empty index when no sources', async () => {
    const driver = createMockDriver(new Map());
    const compiler = new WikiCompiler(driver);

    const os = await import('node:os');
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    const outputDir = path.join(os.tmpdir(), `amp-wiki-test-lib-${Date.now()}`);

    try {
      await compiler.compile(outputDir);

      const publishedDir = await resolvePublishedWikiDir(outputDir);
      const libIndex = await fs.readFile(path.join(publishedDir, 'library', '_index.md'), 'utf-8');
      expect(libIndex).toContain('Source Library');
      expect(libIndex).toContain('No sources indexed yet');
    } finally {
      await fs.rm(outputDir, { recursive: true, force: true });
    }
  });

  it('creates topics directory with empty index when no qualified tags', async () => {
    const driver = createMockDriver(new Map());
    const compiler = new WikiCompiler(driver);

    const os = await import('node:os');
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    const outputDir = path.join(os.tmpdir(), `amp-wiki-test-topics-${Date.now()}`);

    try {
      await compiler.compile(outputDir);

      const publishedDir = await resolvePublishedWikiDir(outputDir);
      const topicsIndex = await fs.readFile(path.join(publishedDir, 'topics', '_index.md'), 'utf-8');
      expect(topicsIndex).toContain('Topics');
      expect(topicsIndex).toContain('No topics discovered yet');
    } finally {
      await fs.rm(outputDir, { recursive: true, force: true });
    }
  });

  it('publishes a clean generation without mutating legacy root files', async () => {
    const driver = createMockDriver(new Map());
    const compiler = new WikiCompiler(driver);

    const os = await import('node:os');
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    const outputDir = path.join(os.tmpdir(), `amp-wiki-test-clean-${Date.now()}`);

    try {
      // Create a stale file
      await fs.mkdir(outputDir, { recursive: true });
      await fs.writeFile(path.join(outputDir, 'stale.md'), 'old content', 'utf-8');

      await compiler.compile(outputDir);

      const publishedDir = await resolvePublishedWikiDir(outputDir);
      await expect(fs.stat(path.join(publishedDir, 'stale.md'))).rejects.toThrow();
      // The legacy tree is left recoverable; the pointer makes it unserved.
      expect(await fs.readFile(path.join(outputDir, 'stale.md'), 'utf-8')).toBe('old content');
    } finally {
      await fs.rm(outputDir, { recursive: true, force: true });
    }
  });

  it('uses canonical human-facing project rows for the portal index', async () => {
    const projects = [
      mockRecord({
        id: 'proj-alpha-title',
        name: 'Project Alpha',
        type: 'project',
        description: 'Human name wins',
        aliases: null,
        created_at: '2026-01-01T00:00:00Z',
      }),
      mockRecord({
        id: 'proj-alpha-slug',
        name: 'project-alpha',
        type: 'project',
        description: 'Duplicate slug row',
        aliases: null,
        created_at: '2026-01-01T00:00:00Z',
      }),
      mockRecord({
        id: 'proj-boot',
        name: '__boot_smoke__',
        type: 'project',
        description: 'Internal smoke-test scope',
        aliases: null,
        created_at: '2026-01-01T00:00:00Z',
      }),
    ];

    const alphaEntity = mockRecord({
      id: 'ent-alpha',
      name: 'AlphaEngine',
      type: 'module',
      description: 'Core engine',
      aliases: null,
      created_at: '2026-01-01T00:00:00Z',
    });

    const alphaEpisodic = mockRecord({
      id: 'ep-alpha',
      task: '[project:project-alpha] Implemented engine',
      content: 'Implemented AlphaEngine',
      outcome: 'approved',
      session_id: 'session-alpha',
      created_at: '2026-05-01T10:00:00Z',
    });

    const bootEpisodic = mockRecord({
      id: 'ep-boot',
      task: '[project:__boot_smoke__] Smoke run',
      content: 'Boot smoke completed',
      outcome: 'approved',
      session_id: 'session-boot',
      created_at: '2026-05-02T10:00:00Z',
    });

    const driver = createParamAwareMockDriver((query, params) => {
      if (query.includes('collect(DISTINCT e.name) AS entities')) return mockResult([]);
      if (query.includes('ep.task STARTS WITH')) return mockResult([]);
      if (query.includes("(e:Entity {type: 'project'})")) return mockResult(projects);
      if (query.includes('CONTAINS*1..')) {
        return params?.projectName === 'Project Alpha' || params?.projectName === 'project-alpha'
          ? mockResult([alphaEntity])
          : mockResult([]);
      }
      if (query.includes('-[:MODIFIED]->')) return mockResult([]);
      if (query.includes('ep.task CONTAINS $tag')) {
        if (params?.tag === '[project:project-alpha]') return mockResult([alphaEpisodic]);
        if (params?.tag === '[project:__boot_smoke__]') return mockResult([bootEpisodic]);
        return mockResult([]);
      }
      if (query.includes('UNWIND s.tags')) return mockResult([]);
      if (query.includes('labels(n)[0]')) {
        return mockResult([
          mockRecord({ label: 'Entity', cnt: 4 }),
          mockRecord({ label: 'Semantic', cnt: 0 }),
          mockRecord({ label: 'Episodic', cnt: 2 }),
          mockRecord({ label: 'Source', cnt: 0 }),
        ]);
      }
      if (query.includes('MATCH (s:Source)')) return mockResult([]);
      if (query.includes('LIMIT $limit')) return mockResult([alphaEpisodic, bootEpisodic]);
      if (query.includes('count(s) AS cnt')) return mockResult([mockRecord({ cnt: 0 })]);
      if (query.includes('[:ABOUT]->(e:Entity {name: $name})')) return mockResult([]);
      if (query.includes('parent:Entity')) return mockResult([]);
      if (query.includes('->(child:Entity)')) return mockResult([]);
      if (query.includes('(other:Entity)-[r2]->')) return mockResult([]);
      if (query.includes('[:CITES]->(src:Source')) return mockResult([]);
      return mockResult([]);
    });
    const compiler = new WikiCompiler(driver);

    const os = await import('node:os');
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    const outputDir = path.join(os.tmpdir(), `amp-wiki-human-nav-${Date.now()}`);

    try {
      await compiler.compile(outputDir);

      const publishedDir = await resolvePublishedWikiDir(outputDir);
      const portal = await fs.readFile(path.join(publishedDir, '_index.md'), 'utf-8');
      const alphaRows = portal.match(/\[\[projects\/project-alpha\/_index\|/g) ?? [];
      expect(alphaRows).toHaveLength(1);
      expect(portal).toContain('[[projects/project-alpha/_index|Project Alpha]]');
      expect(portal).not.toContain('__boot_smoke__');
      expect(portal).toContain('> **1** projects');
    } finally {
      await fs.rm(outputDir, { recursive: true, force: true });
    }
  });

  it('compiles a semantic-only virtual project from s.scope without a project Entity', async () => {
    const semantic = mockRecord({
      id: 'sem-semantic-only',
      content: 'Semantic-only knowledge remains visible in the wiki',
      confidence: 0.91,
      tags: ['architecture'],
      scope: 'project:semantic-only',
      entities: [],
    });

    const driver = createParamAwareMockDriver((query) => {
      if (query.includes('collect(DISTINCT e.name) AS entities')) return mockResult([semantic]);
      if (query.includes('ep.task STARTS WITH') && query.includes('MATCH (s:Semantic)')) {
        return mockResult([mockRecord({ proj: 'semantic-only' })]);
      }
      if (query.includes("MATCH (e:Entity {type: 'project'})")) return mockResult([]);
      if (query.includes('UNWIND s.tags')) return mockResult([]);
      if (query.includes('labels(n)[0]')) {
        return mockResult([
          mockRecord({ label: 'Entity', cnt: 0 }),
          mockRecord({ label: 'Semantic', cnt: 1 }),
          mockRecord({ label: 'Episodic', cnt: 0 }),
          mockRecord({ label: 'Source', cnt: 0 }),
        ]);
      }
      return mockResult([]);
    });
    const outputDir = (await import('node:path')).join(
      (await import('node:os')).tmpdir(),
      `amp-wiki-semantic-virtual-${Date.now()}`,
    );
    const fs = await import('node:fs/promises');

    try {
      const result = await new WikiCompiler(driver).compile(outputDir);
      const publishedDir = await resolvePublishedWikiDir(outputDir);
      const projectIndex = await fs.readFile(
        (await import('node:path')).join(publishedDir, 'projects', 'semantic-only', '_index.md'),
        'utf-8',
      );
      const decisions = await fs.readFile((await import('node:path')).join(publishedDir, '_decisions.md'), 'utf-8');

      expect(result.projects_compiled).toBe(1);
      expect(projectIndex).toContain('Semantic-only knowledge remains visible in the wiki');
      expect(decisions).toContain('Semantic-only knowledge remains visible in the wiki');
    } finally {
      await fs.rm(outputDir, { recursive: true, force: true });
    }
  });

  it('keeps a scoped compile unpublished so it cannot replace the served global generation', async () => {
    const os = await import('node:os');
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    const outputDir = path.join(os.tmpdir(), `amp-wiki-scoped-publication-${Date.now()}`);
    const compiler = new WikiCompiler(createMockDriver(new Map()));

    try {
      await compiler.compile(outputDir, 'all');
      const globalBefore = await resolvePublishedWikiDir(outputDir);
      const pointerBefore = await fs.readFile(path.join(outputDir, '.active-generation'), 'utf-8');

      const scoped = await compiler.compile(outputDir, 'project:alpha');

      expect(scoped.output_dir).not.toBe(outputDir);
      expect(scoped.output_dir).toContain(`${path.sep}.generations${path.sep}scoped${path.sep}alpha${path.sep}`);
      expect(await resolvePublishedWikiDir(outputDir)).toBe(globalBefore);
      expect(await fs.readFile(path.join(outputDir, '.active-generation'), 'utf-8')).toBe(pointerBefore);
      expect((await fs.stat(path.join(scoped.output_dir, '_index.md'))).isFile()).toBe(true);
    } finally {
      await fs.rm(outputDir, { recursive: true, force: true });
    }
  });

  it('recovers the newest complete generation and bounds stale/crash residue', async () => {
    const os = await import('node:os');
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    const outputDir = path.join(os.tmpdir(), `amp-wiki-generation-recovery-${Date.now()}`);
    const globalParent = path.join(outputDir, '.generations', 'global');
    const compiler = new WikiCompiler(createMockDriver(new Map()));

    try {
      await fs.mkdir(path.join(globalParent, '.building-crashed'), { recursive: true });
      for (let i = 0; i < 5; i++) await compiler.compile(outputDir);

      const entries = await fs.readdir(globalParent);
      const complete = entries.filter((entry) => entry.startsWith('gen-'));
      expect(complete.length).toBeLessThanOrEqual(3);
      expect(entries).not.toContain('.building-crashed');

      const newest = [...complete].sort().at(-1)!;
      await fs.writeFile(path.join(outputDir, '.active-generation'), '{corrupt', 'utf-8');
      expect(await resolvePublishedWikiDir(outputDir)).toBe(path.join(globalParent, newest));
    } finally {
      await fs.rm(outputDir, { recursive: true, force: true });
    }
  });

  it('compiles within 500ms budget on a realistic-sized mock graph', async () => {
    // Simulate a graph with 2 projects, 20 entities each, 50 semantics, 219 episodics
    const entities = Array.from({ length: 20 }, (_, i) => mockRecord({
      id: `ent-${i}`,
      name: `module-${i}`,
      type: 'module',
      description: `Module ${i}`,
      aliases: null,
      created_at: '2026-01-01T00:00:00Z',
    }));

    const semantics = Array.from({ length: 50 }, (_, i) => mockRecord({
      id: `sem-${i}`,
      content: `Semantic knowledge ${i} about module-${i % 20}`,
      confidence: 0.5 + (i % 5) * 0.1,
      tags: ['project:test-proj', i % 3 === 0 ? 'architecture' : 'api-design'],
      entities: [`module-${i % 20}`],
      updated_at: '2026-03-01T00:00:00Z',
      entity_refs: [],
    }));

    const episodics = Array.from({ length: 50 }, (_, i) => mockRecord({
      id: `ep-${i}`,
      task: `[project:test-proj] Task ${i}`,
      content: `Did something about module-${i % 20}`,
      outcome: 'approved',
      session_id: `session-${Math.floor(i / 5)}`,
      created_at: new Date(2026, 0, 1 + i).toISOString(),
    }));

    const projectRecord = mockRecord({
      id: 'proj-1',
      name: 'test-proj',
      type: 'project',
      description: 'Test project',
      aliases: null,
      created_at: '2026-01-01T00:00:00Z',
    });

    // Build query→response map. The mock driver matches by first substring hit,
    // so more specific patterns must come before general ones.
    const responses = new Map<string, ReturnType<typeof mockResult>>([
      ['ep.task STARTS WITH', mockResult([])],
      ["(e:Entity {type: 'project'})\n", mockResult([projectRecord])],
      ['CONTAINS*1..', mockResult(entities)],
      ['-[:MODIFIED]->', mockResult([])],
      ['UNWIND s.tags', mockResult([])],
      ['count(s) AS cnt', mockResult([mockRecord({ cnt: 0 })])],
      ['[:ABOUT]->(e:Entity {name: $name})', mockResult([])],
      ['[:CITES]->(src:Source', mockResult([])],
      ['collect(DISTINCT e.name) AS entities', mockResult(semantics)],
      ['labels(n)[0]', mockResult([
        mockRecord({ label: 'Entity', cnt: 20 }),
        mockRecord({ label: 'Semantic', cnt: 50 }),
        mockRecord({ label: 'Episodic', cnt: 219 }),
        mockRecord({ label: 'Source', cnt: 0 }),
      ])],
      ['(s:Source)\n', mockResult([])],
      ['LIMIT $limit', mockResult(episodics.slice(0, 10))],
      ['ep.task CONTAINS $name OR ep.content CONTAINS', mockResult([])],
      ['ep.task CONTAINS $tag', mockResult(episodics)],
      ['parent:Entity', mockResult([])],
      ['->(child:Entity)', mockResult([])],
      ['(other:Entity)-[r2]->', mockResult([])],
    ]);

    const driver = createMockDriver(responses);
    const compiler = new WikiCompiler(driver);

    const os = await import('node:os');
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    const outputDir = path.join(os.tmpdir(), `amp-wiki-perf-${Date.now()}`);

    try {
      const start = performance.now();
      await compiler.compile(outputDir);
      const elapsed = performance.now() - start;

      // Keep a generous regression ceiling because a full Windows workspace
      // run contends heavily on filesystem and antivirus I/O. Focused runs are
      // normally sub-second; this gate detects catastrophic regressions without
      // flaking under parallel package load.
      expect(elapsed).toBeLessThan(5_000);
    } finally {
      await fs.rm(outputDir, { recursive: true, force: true });
    }
  });

  it('OPT-9: serializes two overlapping compile() calls on the same dir', async () => {
    const os = await import('node:os');
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    const outputDir = path.join(os.tmpdir(), `amp-wiki-lock-${Date.now()}`);
    const lockPath = path.join(outputDir, '.compile.lock');

    // Concurrency monitor. The driver's first query (fetchAllSemantics) only runs
    // AFTER acquireCompileLock succeeds, because the clear+all phases live inside
    // compileLocked. We open a "critical section active" window there, hold it
    // open across a real delay so the two compiles would genuinely overlap if NOT
    // serialized, then close it. If the lock works, the two windows never overlap.
    let active = 0;
    let maxActive = 0;
    let lockPresentDuringCriticalSection = false;
    const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

    const makeDriver = (): Driver => {
      let firstQuery = true;
      return createAsyncMockDriver(async (query) => {
        if (firstQuery && query.includes('collect(DISTINCT e.name) AS entities')) {
          firstQuery = false;
          active++;
          maxActive = Math.max(maxActive, active);
          // The lockfile we hold must exist on disk right now.
          lockPresentDuringCriticalSection ||= await fileExists(fs, lockPath);
          await delay(80); // widen the window so a broken lock would interleave
          active--;
        }
        return mockResult([]);
      });
    };

    const c1 = new WikiCompiler(makeDriver());
    const c2 = new WikiCompiler(makeDriver());

    try {
      const [r1, r2] = await Promise.all([c1.compile(outputDir), c2.compile(outputDir)]);

      // Both completed and produced a full, structurally-complete wiki.
      expect(r1.cross_project_pages).toBe(3);
      expect(r2.cross_project_pages).toBe(3);

      // The critical sections never overlapped (the lock serialized them).
      expect(maxActive).toBe(1);
      // The lock was genuinely held on disk while a compile did its work.
      expect(lockPresentDuringCriticalSection).toBe(true);
      // Both runs' finally blocks released the lock (none left behind).
      await expect(fs.access(lockPath)).rejects.toThrow();

      // Final wiki is intact: the cross-project pages a complete compile emits.
      const publishedDir = await resolvePublishedWikiDir(outputDir);
      for (const f of ['_index.md', '_decisions.md', '_patterns.md', '_recent.md']) {
        const st = await fs.stat(path.join(publishedDir, f));
        expect(st.isFile()).toBe(true);
      }
    } finally {
      await fs.rm(outputDir, { recursive: true, force: true });
    }
  });

  it('renews a slow compile lease so a contender cannot break an active owner', async () => {
    const os = await import('node:os');
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    const outputDir = path.join(os.tmpdir(), `amp-wiki-heartbeat-${Date.now()}`);
    const lockPath = path.join(outputDir, '.compile.lock');
    // Heartbeat-to-stale margin is 20x: a loaded vitest worker can stall the
    // event loop for tens of milliseconds, and a tighter margin let a healthy
    // lease look stale to the contender, which then broke it legitimately.
    const timings = {
      compileLockStaleMs: 600,
      compileLockHeartbeatMs: 30,
      compileLockTimeoutMs: 5_000,
      compileLockRetryMs: 5,
    };
    let active = 0;
    let maxActive = 0;
    let releaseSlow!: () => void;
    const slowGate = new Promise<void>((resolve) => { releaseSlow = resolve; });
    let slowEntered!: () => void;
    const entered = new Promise<void>((resolve) => { slowEntered = resolve; });
    let slow: Promise<unknown> | null = null;
    let contender: Promise<unknown> | null = null;
    const readLease = async (): Promise<{ at: string; token: string }> => {
      for (let attempt = 0; attempt < 20; attempt++) {
        try {
          return JSON.parse(await fs.readFile(lockPath, 'utf-8')) as { at: string; token: string };
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
      }
      throw new Error('compile lease did not become readable');
    };

    const slowDriver = createAsyncMockDriver(async (query) => {
      if (query.includes('collect(DISTINCT e.name) AS entities')) {
        active++;
        maxActive = Math.max(maxActive, active);
        slowEntered();
        await slowGate;
        active--;
      }
      return mockResult([]);
    });
    const contenderDriver = createAsyncMockDriver(async (query) => {
      if (query.includes('collect(DISTINCT e.name) AS entities')) {
        active++;
        maxActive = Math.max(maxActive, active);
        active--;
      }
      return mockResult([]);
    });

    try {
      slow = new WikiCompiler(slowDriver, timings).compile(outputDir);
      await entered;
      const firstLease = await readLease();
      // Wait for a renewal rather than a fixed interval: bounded well inside
      // staleMs so a heartbeat that never fires still fails here.
      let renewedLease = firstLease;
      const renewDeadline = Date.now() + timings.compileLockStaleMs / 2;
      while (Date.parse(renewedLease.at) <= Date.parse(firstLease.at)) {
        if (Date.now() > renewDeadline) throw new Error('compile lease was not renewed');
        await new Promise((resolve) => setTimeout(resolve, 10));
        renewedLease = await readLease();
      }
      expect(renewedLease.token).toBe(firstLease.token);
      expect(Date.parse(renewedLease.at)).toBeGreaterThan(Date.parse(firstLease.at));

      contender = new WikiCompiler(contenderDriver, timings).compile(outputDir);
      // Longer than staleMs: an unrenewed lease would be broken in this window.
      await new Promise((resolve) => setTimeout(resolve, timings.compileLockStaleMs + 200));
      expect(maxActive).toBe(1);
      releaseSlow();
      await Promise.all([slow, contender]);
      expect(maxActive).toBe(1);
      await expect(fs.access(lockPath)).rejects.toThrow();
    } finally {
      releaseSlow?.();
      await Promise.allSettled([slow, contender].filter((promise): promise is Promise<unknown> => promise !== null));
      await fs.rm(outputDir, { recursive: true, force: true });
    }
  });

  it('OPT-9: a stale lock left by a crashed compile is broken and acquired', async () => {
    const os = await import('node:os');
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    const outputDir = path.join(os.tmpdir(), `amp-wiki-stalelock-${Date.now()}`);
    const lockPath = path.join(outputDir, '.compile.lock');

    try {
      await fs.mkdir(outputDir, { recursive: true });
      // Simulate a crashed prior compile: a lockfile whose timestamp is well past
      // the cold-compile-safe stale threshold. A new compile must break it.
      const stale = new Date(Date.now() - 2 * 60 * 60_000).toISOString();
      await fs.writeFile(lockPath, JSON.stringify({ pid: 999999, at: stale }), 'utf-8');

      const compiler = new WikiCompiler(createMockDriver(new Map()));
      const result = await compiler.compile(outputDir);

      expect(result.cross_project_pages).toBe(3);
      // The stale lock was broken and the new run released its own lock at the end.
      await expect(fs.access(lockPath)).rejects.toThrow();
    } finally {
      await fs.rm(outputDir, { recursive: true, force: true });
    }
  });

  it('OPT-9: release does not delete a lock now owned by a successor token', async () => {
    const os = await import('node:os');
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    const outputDir = path.join(os.tmpdir(), `amp-wiki-ownerlock-${Date.now()}`);
    const lockPath = path.join(outputDir, '.compile.lock');
    const successor = JSON.stringify({ pid: 424242, at: new Date().toISOString(), token: 'successor-token' });
    let replaced = false;

    const driver = createAsyncMockDriver(async (query) => {
      if (!replaced && query.includes('collect(DISTINCT e.name) AS entities')) {
        replaced = true;
        await fs.writeFile(lockPath, successor, 'utf-8');
      }
      return mockResult([]);
    });

    try {
      await new WikiCompiler(driver).compile(outputDir);
      expect(await fs.readFile(lockPath, 'utf-8')).toBe(successor);
    } finally {
      await fs.rm(outputDir, { recursive: true, force: true });
    }
  });

  it('honors project scope when compiling a single project wiki', async () => {
    const alphaProject = mockRecord({
      id: 'proj-alpha',
      name: 'alpha',
      type: 'project',
      description: 'Alpha project',
      aliases: null,
      created_at: '2026-01-01T00:00:00Z',
    });
    const betaProject = mockRecord({
      id: 'proj-beta',
      name: 'beta',
      type: 'project',
      description: 'Beta project',
      aliases: null,
      created_at: '2026-01-01T00:00:00Z',
    });
    const alphaEntity = mockRecord({
      id: 'ent-alpha',
      name: 'AlphaEngine',
      type: 'module',
      description: 'Alpha engine',
      aliases: null,
      created_at: '2026-01-01T00:00:00Z',
    });
    const betaEntity = mockRecord({
      id: 'ent-beta',
      name: 'BetaEngine',
      type: 'module',
      description: 'Beta engine',
      aliases: null,
      created_at: '2026-01-01T00:00:00Z',
    });
    const alphaSemantic = mockRecord({
      id: 'sem-alpha',
      content: 'Alpha keeps project-scoped wiki output focused',
      confidence: 0.9,
      tags: ['project:alpha', 'alpha-topic'],
      entities: ['AlphaEngine'],
      updated_at: '2026-04-01T00:00:00Z',
      entity_refs: [],
    });
    const betaSemantic = mockRecord({
      id: 'sem-beta',
      content: 'Beta should not leak into alpha wiki output',
      confidence: 0.95,
      tags: ['project:beta', 'beta-topic'],
      // A shared ABOUT entity reproduces the global-compile leak: without the
      // per-project semantic filter this beta claim appears on alpha's index.
      entities: ['AlphaEngine', 'BetaEngine'],
      updated_at: '2026-04-01T00:00:00Z',
      entity_refs: [],
    });
    const alphaEpisodic = mockRecord({
      id: 'ep-alpha',
      task: '[project:alpha] Alpha task',
      content: 'Alpha activity',
      outcome: 'approved',
      session_id: 'session-alpha',
      created_at: '2026-05-01T10:00:00Z',
    });
    const betaEpisodic = mockRecord({
      id: 'ep-beta',
      task: '[project:beta] Beta task',
      content: 'Beta activity',
      outcome: 'approved',
      session_id: 'session-beta',
      created_at: '2026-05-02T10:00:00Z',
    });
    const alphaSource = mockRecord({
      id: 'src-alpha',
      title: 'Alpha Source',
      source_type: 'note',
      path: '/tmp/alpha.md',
      project_tag: 'project:alpha',
      created_at: '2026-05-01T00:00:00Z',
    });
    const betaSource = mockRecord({
      id: 'src-beta',
      title: 'Beta Source',
      source_type: 'note',
      path: '/tmp/beta.md',
      project_tag: 'project:beta',
      created_at: '2026-05-01T00:00:00Z',
    });

    const driver = createParamAwareMockDriver((query, params) => {
      if (query.includes('collect(DISTINCT e.name) AS entities')) return mockResult([alphaSemantic, betaSemantic]);
      if (query.includes('ep.task STARTS WITH')) return mockResult([]);
      if (query.includes("(e:Entity {type: 'project'})")) return mockResult([alphaProject, betaProject]);
      if (query.includes('CONTAINS*1..')) {
        if (params?.projectName === 'alpha') return mockResult([alphaEntity]);
        if (params?.projectName === 'beta') return mockResult([betaEntity]);
        return mockResult([]);
      }
      if (query.includes('-[:MODIFIED]->')) return mockResult([]);
      if (query.includes('ep.task CONTAINS $tag')) {
        if (params?.tag === '[project:alpha]') return mockResult([alphaEpisodic]);
        if (params?.tag === '[project:beta]') return mockResult([betaEpisodic]);
        return mockResult([]);
      }
      if (query.includes('ep.task CONTAINS $name OR ep.content CONTAINS')) return mockResult([]);
      if (query.includes('MATCH (s:Semantic)-[about:ABOUT]->(e:Entity {name: $name})')) {
        if (params?.name === 'AlphaEngine') return mockResult([alphaSemantic, betaSemantic]);
        if (params?.name === 'BetaEngine') return mockResult([betaSemantic]);
        return mockResult([]);
      }
      if (query.includes('parent:Entity')) return mockResult([]);
      if (query.includes('->(child:Entity)')) return mockResult([]);
      if (query.includes('MATCH (s:Semantic)-[:ABOUT]->(target:Entity')) return mockResult([]);
      if (query.includes('(other:Entity)-[r2]->')) return mockResult([]);
      if (query.includes('MATCH (s:Semantic)-[:ABOUT]->(e:Entity {name: $name})\n       MATCH (s)-[:CITES]->(src:Source)')) return mockResult([]);
      if (query.includes('MATCH (s:Source)')) return mockResult([alphaSource, betaSource]);
      if (query.includes('MATCH (s:Semantic)-[:CITES]->(src:Source')) {
        if (params?.sourceId === 'src-alpha') return mockResult([alphaSemantic]);
        if (params?.sourceId === 'src-beta') return mockResult([betaSemantic]);
        return mockResult([]);
      }
      if (query.includes('UNWIND s.tags')) {
        return mockResult([
          mockRecord({ tag: 'alpha-topic', count: 3, projects: [] }),
          mockRecord({ tag: 'beta-topic', count: 3, projects: [] }),
        ]);
      }
      if (query.includes('labels(n)[0]')) {
        return mockResult([
          mockRecord({ label: 'Entity', cnt: 4 }),
          mockRecord({ label: 'Semantic', cnt: 2 }),
          mockRecord({ label: 'Episodic', cnt: 2 }),
          mockRecord({ label: 'Source', cnt: 2 }),
        ]);
      }
      if (query.includes('LIMIT $limit')) return mockResult([betaEpisodic, alphaEpisodic]);
      return mockResult([]);
    });

    const compiler = new WikiCompiler(driver);
    const os = await import('node:os');
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    const outputDir = path.join(os.tmpdir(), `amp-wiki-project-scope-${Date.now()}`);
    const allOutputDir = path.join(os.tmpdir(), `amp-wiki-project-scope-all-${Date.now()}`);

    try {
      const scopedResult = await compiler.compile(outputDir, 'project:alpha');
      const scopedDir = scopedResult.output_dir;

      const portal = await fs.readFile(path.join(scopedDir, '_index.md'), 'utf-8');
      expect(portal).toContain('> **1** projects');
      expect(portal).toContain('Alpha keeps project-scoped wiki output focused');
      expect(portal).not.toContain('Beta should not leak');

      const decisions = await fs.readFile(path.join(scopedDir, '_decisions.md'), 'utf-8');
      expect(decisions).toContain('Alpha keeps project-scoped wiki output focused');
      expect(decisions).not.toContain('Beta should not leak');

      const recent = await fs.readFile(path.join(scopedDir, '_recent.md'), 'utf-8');
      expect(recent).toContain('Alpha task');
      expect(recent).not.toContain('Beta task');

      const alphaArticle = await fs.readFile(path.join(scopedDir, 'projects', 'alpha', 'alphaengine.md'), 'utf-8');
      expect(alphaArticle).toContain('Alpha keeps project-scoped wiki output focused');
      expect(alphaArticle).not.toContain('Beta should not leak');

      const library = await fs.readFile(path.join(scopedDir, 'library', '_index.md'), 'utf-8');
      expect(library).toContain('Alpha Source');
      expect(library).not.toContain('Beta Source');

      const topics = await fs.readFile(path.join(scopedDir, 'topics', '_index.md'), 'utf-8');
      expect(topics).toContain('alpha-topic');
      expect(topics).not.toContain('beta-topic');

      await expect(fs.stat(path.join(scopedDir, 'projects', 'beta', '_index.md'))).rejects.toThrow();

      // A global compile still keeps each project index isolated even when
      // claims from different projects share an ABOUT entity.
      await compiler.compile(allOutputDir);
      const globalDir = await resolvePublishedWikiDir(allOutputDir);
      const globalAlphaIndex = await fs.readFile(path.join(globalDir, 'projects', 'alpha', '_index.md'), 'utf-8');
      expect(globalAlphaIndex).toContain('Alpha keeps project-scoped wiki output focused');
      expect(globalAlphaIndex).not.toContain('Beta should not leak');
    } finally {
      await fs.rm(outputDir, { recursive: true, force: true });
      await fs.rm(allOutputDir, { recursive: true, force: true });
    }
  });
});
