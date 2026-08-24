// packages/neo4j/src/__tests__/anti-entropy-graph.test.ts
//
// MEM-007 graph orphan repair (behavioral fake driver, lifecycle-store.test.ts
// harness style). The fake filters episode rows from the QUERY PARAMS — not
// from re-implemented predicates — so the gap-13/T7 aliasing regression
// genuinely fails if the bracketed `[project:<name>]` task token is ever
// weakened to a bare substring. Also pins:
//  - emitted cypher/params (MERGE relationship, never a bare CONTAINS $canonTag,
//    never an Entity CREATE/MERGE, type:'project' in the orphan guard);
//  - LIMIT batching + MERGE idempotence (re-runs converge to zero);
//  - deriveProjectTag: existing-link dominance, guarded lowercase-name
//    fallback, null (=> engine skip) when neither grounds the tag.

import { describe, it, expect, vi } from 'vitest';
import { LifecycleStore } from '../lifecycle.js';

interface FakeEpisode {
  id: string;
  scope?: string;
  tags?: string[];
  task?: string;
  /** `${name}|${type}` keys of entities this episode REFERENCES. */
  linked: Set<string>;
}

interface FakeEntity { name: string; type: string }

function record(values: Record<string, unknown>) {
  return { get: (key: string) => values[key] };
}

/** Behavioral fake driver over an in-memory episode/entity table. */
function makeGraphDriver(entities: FakeEntity[], episodes: FakeEpisode[]) {
  const queries: Array<{ cypher: string; params: Record<string, unknown> }> = [];
  const session = {
    run: vi.fn(async (cypher: string, params: Record<string, unknown> = {}) => {
      queries.push({ cypher, params });

      if (cypher.includes('RETURN proj.name AS name')) {
        return {
          records: entities
            .filter((e) => e.type === 'project')
            .map((e) => record({ name: e.name }))
            .sort(),
        };
      }

      if (cypher.includes('ORDER BY c DESC')) {
        // Dominant scope among episodes already linked to the project root.
        const key = `${params.projectName}|project`;
        const counts = new Map<string, number>();
        for (const ep of episodes) {
          if (!ep.linked.has(key) || !ep.scope) continue;
          counts.set(ep.scope, (counts.get(ep.scope) ?? 0) + 1);
        }
        const top = [...counts.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0];
        return { records: top ? [record({ scope: top[0], c: top[1] })] : [] };
      }

      if (cypher.includes('RETURN count(ep) AS c')) {
        // Fallback-tag existence probe.
        const candidate = params.candidate as string;
        const c = episodes.filter((ep) => ep.scope === candidate || (ep.tags ?? []).includes(candidate)).length;
        return { records: [record({ c })] };
      }

      if (cypher.includes('MERGE (ep)-[:REFERENCES]->')) {
        // Behavioral link: candidates are selected from the PARAMS the store
        // sent, so a dropped bracket in taskTag re-admits the aliasing row.
        const canonTag = params.canonTag as string;
        const taskTag = params.taskTag as string;
        const projectName = params.projectName as string;
        const batch = Number(params.batch);
        const key = `${projectName}|project`;
        if (!entities.some((e) => e.name === projectName && e.type === 'project')) {
          return { records: [record({ linked: 0, ids: [] })] };
        }
        const candidates = episodes
          .filter((ep) =>
            (ep.scope === canonTag || (ep.tags ?? []).includes(canonTag) || (ep.task ?? '').includes(taskTag))
            && !ep.linked.has(key))
          .slice(0, batch);
        for (const ep of candidates) ep.linked.add(key);
        return { records: [record({ linked: candidates.length, ids: candidates.map((ep) => ep.id) })] };
      }

      return { records: [] };
    }),
    close: vi.fn(),
  };
  return { driver: { session: vi.fn(() => session) } as any, queries };
}

function seed() {
  const entities: FakeEntity[] = [
    { name: 'foo', type: 'project' },
    // Same-named NON-project entity: must never satisfy the orphan guard.
    { name: 'foo', type: 'component' },
    { name: 'foobar', type: 'project' },
  ];
  const episodes: FakeEpisode[] = [
    { id: 'ep-scope', scope: 'project:foo', linked: new Set() },
    { id: 'ep-tags', tags: ['project:foo'], linked: new Set() },
    { id: 'ep-task', task: '[project:foo] fix the parser', linked: new Set() },
    // gap-13/T7 aliasing regression rows: belong to project:foobar; the task
    // contains the bare substring `project:foo` but NOT the bracketed token.
    { id: 'ep-foobar-scope', scope: 'project:foobar', linked: new Set() },
    { id: 'ep-foobar-task', scope: 'project:foobar', task: 'notes on project:foobar rollout', linked: new Set() },
    { id: 'ep-unrelated', scope: 'project:other', task: 'mentions project:foo casually', linked: new Set() },
  ];
  return { entities, episodes };
}

describe('LifecycleStore.linkOrphanEpisodics', () => {
  it('links exactly the three provably-owned orphans and never the bare-substring aliasing rows', async () => {
    const { entities, episodes } = seed();
    const { driver } = makeGraphDriver(entities, episodes);
    const store = new LifecycleStore(driver);

    const result = await store.linkOrphanEpisodics('foo', 'project:foo', 1000);

    expect(result.linked).toBe(3);
    expect(result.ids.sort()).toEqual(['ep-scope', 'ep-tags', 'ep-task']);
    expect(episodes.find((ep) => ep.id === 'ep-foobar-scope')!.linked.size).toBe(0);
    expect(episodes.find((ep) => ep.id === 'ep-foobar-task')!.linked.size).toBe(0);
    expect(episodes.find((ep) => ep.id === 'ep-unrelated')!.linked.size).toBe(0);
  });

  it('emits the bracketed task token and MERGE relationship — never a bare CONTAINS or an Entity create', async () => {
    const { entities, episodes } = seed();
    const { driver, queries } = makeGraphDriver(entities, episodes);
    const store = new LifecycleStore(driver);

    await store.linkOrphanEpisodics('foo', 'project:foo', 1000);

    const link = queries.find((q) => q.cypher.includes('MERGE (ep)-[:REFERENCES]->'))!;
    expect(link).toBeDefined();
    // The bracketed legacy token, byte-for-byte (brackets kill the aliasing).
    expect(link.params.taskTag).toBe('[project:foo]');
    expect(link.cypher).toContain('ep.task CONTAINS $taskTag');
    expect(link.cypher).not.toContain('ep.task CONTAINS $canonTag');
    // Orphan guard names the project TYPE so a same-named non-project Entity
    // cannot permanently exclude an episode.
    expect(link.cypher).toContain("NOT (ep)-[:REFERENCES]->(:Entity {name: $projectName, type: 'project'})");
    // Repair never creates Entity roots: relationship MERGE only, project MATCHed.
    expect(link.cypher).toContain("MATCH (proj:Entity {name: $projectName, type: 'project'})");
    expect(link.cypher).not.toContain('CREATE');
    expect(link.cypher).not.toMatch(/MERGE \(proj/);
  });

  it('a same-named non-project Entity does not block the repair (type-qualified guard)', async () => {
    const { entities, episodes } = seed();
    // Inject the P2-5 hazard: an episode already linked to the COMPONENT `foo`.
    const ep = episodes.find((e) => e.id === 'ep-scope')!;
    ep.linked.add('foo|component');
    const { driver } = makeGraphDriver(entities, episodes);
    const store = new LifecycleStore(driver);

    const result = await store.linkOrphanEpisodics('foo', 'project:foo', 1000);
    expect(result.ids).toContain('ep-scope');
    expect(ep.linked.has('foo|project')).toBe(true);
  });

  it('honors the batch bound and converges over re-runs (MERGE + NOT-guard idempotence)', async () => {
    const { entities, episodes } = seed();
    const { driver, queries } = makeGraphDriver(entities, episodes);
    const store = new LifecycleStore(driver);

    const first = await store.linkOrphanEpisodics('foo', 'project:foo', 2);
    expect(first.linked).toBe(2);
    const second = await store.linkOrphanEpisodics('foo', 'project:foo', 2);
    expect(second.linked).toBe(1);
    const third = await store.linkOrphanEpisodics('foo', 'project:foo', 2);
    expect(third.linked).toBe(0);
    expect(third.ids).toEqual([]);
    for (const q of queries.filter((q) => q.cypher.includes('MERGE (ep)'))) {
      expect(q.cypher).toContain('LIMIT toInteger($batch)');
      expect(q.params.batch).toBe(2);
    }
  });

  it('rejects a non-integer batch size like the other batched mutations', async () => {
    const { driver } = makeGraphDriver([], []);
    const store = new LifecycleStore(driver);
    await expect(store.linkOrphanEpisodics('foo', 'project:foo', 10.5)).rejects.toThrow('invalid_batch_rows');
  });
});

describe('LifecycleStore.listProjectRoots / deriveProjectTag', () => {
  it('lists only project-typed entity roots', async () => {
    const { entities, episodes } = seed();
    const { driver } = makeGraphDriver(entities, episodes);
    const store = new LifecycleStore(driver);
    expect(await store.listProjectRoots()).toEqual(['foo', 'foobar']);
  });

  it('derives the tag from the dominant scope of already-linked episodes', async () => {
    const { entities, episodes } = seed();
    episodes.push(
      { id: 'ep-l1', scope: 'project:foo-real-tag', linked: new Set(['foo|project']) },
      { id: 'ep-l2', scope: 'project:foo-real-tag', linked: new Set(['foo|project']) },
      { id: 'ep-l3', scope: 'project:noise', linked: new Set(['foo|project']) },
    );
    const { driver } = makeGraphDriver(entities, episodes);
    const store = new LifecycleStore(driver);
    expect(await store.deriveProjectTag('foo')).toBe('project:foo-real-tag');
  });

  it('falls back to project:<lowercased name> only when some episode carries that scope or tag', async () => {
    const { entities, episodes } = seed();
    const { driver } = makeGraphDriver(entities, episodes);
    const store = new LifecycleStore(driver);
    // No existing links for `foo`, but ep-scope carries scope project:foo.
    expect(await store.deriveProjectTag('foo')).toBe('project:foo');
  });

  it('returns null (=> engine skip) when neither existing links nor the name-derived tag ground it', async () => {
    const entities: FakeEntity[] = [{ name: 'ghost', type: 'project' }];
    const { driver } = makeGraphDriver(entities, []);
    const store = new LifecycleStore(driver);
    expect(await store.deriveProjectTag('ghost')).toBeNull();
  });
});
