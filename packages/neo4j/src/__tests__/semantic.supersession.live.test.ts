import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { SemanticNode } from '@memberry/core';
import { createNeo4jDriver } from '../driver.js';
import { SemanticStore } from '../semantic.js';
import { initSchema } from '../schema.js';

const mode = process.env.MEMBERRY_PR01_LIVE;
if (mode !== undefined && mode !== 'required') {
  throw new Error('MEMBERRY_PR01_LIVE must be exactly "required" when set');
}
const liveDescribe = mode === 'required' ? describe : describe.skip;
const NEO4J_URI = process.env.NEO4J_URI || 'bolt://localhost:7687';
const NEO4J_USER = process.env.NEO4J_USER || 'neo4j';
const NEO4J_PASSWORD = process.env.NEO4J_PASSWORD || 'password';
const PREFIX = `semantic-supersession-${Date.now()}`;

liveDescribe('SemanticStore supersession transaction behavior', () => {
  const driver = createNeo4jDriver(NEO4J_URI, NEO4J_USER, NEO4J_PASSWORD);
  const store = new SemanticStore(driver);
  let neo4jAvailable = false;

  beforeAll(async () => {
    if (!process.env.NEO4J_URI || !process.env.NEO4J_USER || !process.env.NEO4J_PASSWORD) {
      throw new Error('PR-01 required live mode needs NEO4J_URI, NEO4J_USER, and NEO4J_PASSWORD');
    }
    await driver.getServerInfo();
    // The production store relies on Semantic.id uniqueness for global successor
    // claims. Every standalone fixture must install its own required schema.
    await initSchema(driver);
    neo4jAvailable = true;
  });

  afterAll(async () => {
    if (neo4jAvailable) {
      const session = driver.session();
      try {
        await session.run('MATCH (n) WHERE n.id STARTS WITH $prefix DETACH DELETE n', {
          prefix: PREFIX,
        });
      } finally {
        await session.close();
      }
    }
    await driver.close().catch(() => {});
  });

  function successor(suffix: string, overrides: Partial<SemanticNode> = {}): SemanticNode {
    return {
      id: `${PREFIX}-${suffix}`,
      content: `successor ${suffix}`,
      confidence: 0.9,
      signal_count: 2,
      created_at: '2026-09-09T12:00:00.000Z',
      updated_at: '2026-09-09T12:00:00.000Z',
      decay_class: 'stable',
      memory_type: 'decision',
      tags: ['durable', 'project:alpha'],
      scope: 'project:alpha',
      tenant_id: 'tenant-a',
      ...overrides,
    };
  }

  async function seedOld(
    suffix: string,
    overrides: Record<string, unknown> = {},
  ): Promise<string> {
    const id = `${PREFIX}-${suffix}`;
    const setClauses = ['future_valid_at', 'invalid_at', 'archived']
      .filter((key) => Object.prototype.hasOwnProperty.call(overrides, key))
      .map((key) => {
        if (key === 'future_valid_at') return 's.valid_at = $future_valid_at';
        return `s.${key} = $${key}`;
      });
    const session = driver.session();
    try {
      await session.run(
        `CREATE (s:Semantic {
           id: $id, content: 'old', confidence: 0.8, signal_count: 1,
           created_at: '2026-01-01T00:00:00.000Z',
           updated_at: '2026-01-01T00:00:00.000Z',
           valid_at: '2026-01-01T00:00:00.000Z',
           decay_class: 'stable', status: 'active', archived: false,
           tenant_id: 'tenant-a', scope: 'project:alpha', tags: ['project:alpha']
         })
         ${setClauses.length > 0 ? `SET ${setClauses.join(', ')}` : ''}`,
        { id, ...overrides },
      );
    } finally {
      await session.close();
    }
    return id;
  }

  it('atomically aligns intervals, canonicalizes ABOUT identity, and permits only exact replay', async () => {
    const oldId = `${PREFIX}-old-happy`;
    const entityId = `${PREFIX}-entity`;
    const node = successor('new-happy');
    const session = driver.session();
    try {
      await session.run(
        `CREATE (old:Semantic {
           id: $oldId, content: 'old', confidence: 0.8, signal_count: 1,
           created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z',
           valid_at: '2026-01-01T00:00:00.000Z', decay_class: 'stable',
           status: 'active', archived: false, tenant_id: 'tenant-a',
           scope: 'project:alpha', tags: ['project:alpha']
         })
         CREATE (entity:Entity {id: $entityId, tenant_id: 'tenant-a', project_scope: 'project:alpha'})
         CREATE (old)-[:ABOUT {valid_at: '2026-01-01T00:00:00.000Z'}]->(entity)`,
        { oldId, entityId },
      );
    } finally {
      await session.close();
    }

    await expect(store.supersede(oldId, node)).resolves.toBe(node.id);
    await expect(store.supersede(oldId, { ...node })).resolves.toBe(node.id);
    await expect(store.supersede(oldId, { ...node, content: 'not an exact replay' })).rejects.toThrow(
      'conflicting successor',
    );
    await expect(store.supersede(oldId, successor('competitor'))).rejects.toThrow(
      'conflicting successor',
    );

    const verify = driver.session();
    try {
      const result = await verify.run(
        `MATCH (new:Semantic {id: $newId})-[transition:SUPERSEDES]->(old:Semantic {id: $oldId})
         MATCH (old)-[oldR:ABOUT]->(entity:Entity {id: $entityId})
         MATCH (new)-[newR:ABOUT]->(entity)
         RETURN new.valid_at AS newValidAt, old.invalid_at AS oldInvalidAt,
                old.status AS oldStatus, oldR.invalid_at AS oldAboutInvalidAt,
                newR.valid_at AS newAboutValidAt, newR.invalid_at AS newAboutInvalidAt,
                new.tags AS tags, new.supersession_operation_digest AS digest,
                transition.valid_at AS transitionValidAt`,
        { newId: node.id, oldId, entityId },
      );
      const record = result.records[0]!;
      const transition = record.get('newValidAt') as string;
      expect(record.get('oldInvalidAt')).toBe(transition);
      expect(record.get('transitionValidAt')).toBe(transition);
      expect(record.get('oldAboutInvalidAt')).toBe(transition);
      expect(record.get('newAboutValidAt')).toBe(transition);
      expect(record.get('newAboutInvalidAt')).toBeNull();
      expect(record.get('oldStatus')).toBe('superseded');
      expect(record.get('tags')).toEqual(['durable', 'project:alpha']);
      expect(record.get('digest')).toMatch(/^sha256:[a-f0-9]{64}$/);
    } finally {
      await verify.close();
    }
  });

  it('copies only owned project endpoints and replay never reopens a subsequently revoked association', async () => {
    const oldId = await seedOld('endpoint-owner');
    const node = successor('endpoint-successor');
    const entities = [
      { id: `${PREFIX}-endpoint-owned`, tenant_id: 'tenant-a', project_scope: 'project:alpha' },
      { id: `${PREFIX}-endpoint-foreign-tenant`, tenant_id: 'tenant-b', project_scope: 'project:alpha' },
      { id: `${PREFIX}-endpoint-foreign-project`, tenant_id: 'tenant-a', project_scope: 'project:beta' },
      { id: `${PREFIX}-endpoint-unscoped`, tenant_id: 'tenant-a' },
      { id: `${PREFIX}-endpoint-ambiguous`, tenant_id: 'tenant-a', project_scope: 'project:beta', tags: ['project:alpha'] },
    ];
    const session = driver.session();
    try {
      await session.run(`MATCH (old:Semantic {id: $oldId}) UNWIND $entities AS props
        CREATE (entity:Entity) SET entity = props CREATE (old)-[:ABOUT {valid_at: $start}]->(entity)`,
      { oldId, entities, start: '2026-01-01T00:00:00.000Z' });
      await store.supersede(oldId, node);
      const copied = await session.run(`MATCH (new:Semantic {id: $newId})-[:ABOUT]->(e:Entity) RETURN e.id AS id`, { newId: node.id });
      expect(copied.records.map(r => r.get('id'))).toEqual([entities[0]!.id]);
      const foreign = await session.run(`MATCH (old:Semantic {id: $oldId})-[r:ABOUT]->(e:Entity)
        WHERE e.id <> $owned RETURN r.invalid_at AS invalidAt`, { oldId, owned: entities[0]!.id });
      expect(foreign.records).toHaveLength(4);
      expect(foreign.records.every(r => r.get('invalidAt') === null)).toBe(true);
      const revokedAt = '2099-01-01T00:00:00.000Z';
      await session.run(`MATCH (:Semantic {id: $newId})-[r:ABOUT]->() SET r.invalid_at = $revokedAt`,
        { newId: node.id, revokedAt });
      await expect(store.supersede(oldId, { ...node })).resolves.toBe(node.id);
      const replay = await session.run(`MATCH (:Semantic {id: $newId})-[r:ABOUT]->() RETURN r.invalid_at AS invalidAt`, { newId: node.id });
      expect(replay.records[0]!.get('invalidAt')).toBe(revokedAt);
    } finally { await session.close(); }
  });

  it('validates writer start timestamps and compares equivalent instants at the exact transition boundary', async () => {
    const now = '2026-09-09T12:00:00.000Z';
    const session = driver.session();
    try {
      for (const [suffix, start] of [
        ['malformed-start', '0000-not-a-timestamp'],
        ['impossible-start', '2026-02-30T00:00:00.000Z'],
        ['future-start', '2026-09-09T12:00:00.001Z'],
        ['missing-start', null],
      ] as const) {
        const oldId = await seedOld(suffix, { future_valid_at: start });
        if (start === null) await session.run('MATCH (s:Semantic {id: $id}) REMOVE s.created_at', { id: oldId });
        const node = successor(`${suffix}-successor`);
        const clock = vi.spyOn(Date.prototype, 'toISOString').mockReturnValue(now);
        try { await expect(store.supersede(oldId, node)).rejects.toThrow(); }
        finally { clock.mockRestore(); }
        const checked = await session.run(`MATCH (old:Semantic {id: $oldId})
          OPTIONAL MATCH (new:Semantic {id: $newId})
          RETURN old.invalid_at AS invalidAt, old.__supersede_lock AS lock,
            old.status AS status, count(new) AS successors`, { oldId, newId: node.id });
        const record = checked.records[0]!;
        expect(record.get('invalidAt')).toBeNull(); expect(record.get('lock')).toBeNull();
        expect(record.get('status')).toBe('active'); expect(record.get('successors').toNumber()).toBe(0);
      }
      const oldId = await seedOld('equivalent-start', { future_valid_at: '2026-09-09T12:00:00Z' });
      const node = successor('equivalent-start-successor');
      const clock = vi.spyOn(Date.prototype, 'toISOString').mockReturnValue(now);
      try { await expect(store.supersede(oldId, node)).resolves.toBe(node.id); }
      finally { clock.mockRestore(); }
      const checked = await session.run(`MATCH (new:Semantic {id: $newId})-[r:SUPERSEDES]->(old:Semantic {id: $oldId})
        RETURN old.invalid_at AS invalidAt, new.valid_at AS validAt, r.valid_at AS edgeValidAt`, { oldId, newId: node.id });
      expect(checked.records[0]!.toObject()).toEqual({ invalidAt: now, validAt: now, edgeValidAt: now });

      // Corrupt both persisted interval strings after a completed transition.
      // Replay equality alone must not authorize a malformed successor start.
      await session.run(`MATCH (new:Semantic {id: $newId})-[:SUPERSEDES]->(old:Semantic {id: $oldId})
        SET new.valid_at = '0000-not-a-timestamp', old.invalid_at = '0000-not-a-timestamp'`, { oldId, newId: node.id });
      await expect(store.supersede(oldId, node)).rejects.toThrow('conflicting successor');
      const preserved = await session.run(`MATCH (:Semantic {id: $newId})-[r:SUPERSEDES]->() RETURN r.valid_at AS validAt`, { newId: node.id });
      expect(preserved.records[0]!.get('validAt')).toBe(now);
    } finally { await session.close(); }
  });

  it('copies ABOUT intervals only when active at the exact transition, including equivalent UTC instants', async () => {
    const now = '2026-09-09T12:00:00.000Z';
    const oldId = await seedOld('about-boundary');
    const node = successor('about-boundary-successor');
    const associations = [
      { suffix: 'open', valid_at: '2026-01-01T00:00:00.000Z', invalid_at: null, copied: true },
      { suffix: 'legacy-start', valid_at: null, invalid_at: null, copied: true },
      { suffix: 'starts-now', valid_at: '2026-09-09T12:00:00Z', invalid_at: null, copied: true },
      { suffix: 'ends-later', valid_at: null, invalid_at: '2026-09-09T12:00:00.001Z', copied: true },
      { suffix: 'ends-now', valid_at: null, invalid_at: now, copied: false },
      { suffix: 'ends-equivalent', valid_at: null, invalid_at: '2026-09-09T12:00:00Z', copied: false },
      { suffix: 'starts-later', valid_at: '2026-09-09T12:00:00.001Z', invalid_at: null, copied: false },
      { suffix: 'malformed-start', valid_at: '0000-invalid', invalid_at: null, copied: false },
      { suffix: 'malformed-end', valid_at: null, invalid_at: 'zzzz-invalid', copied: false },
    ].map(entry => ({ ...entry, id: `${PREFIX}-about-boundary-${entry.suffix}` }));
    const session = driver.session();
    try {
      await session.run(`MATCH (old:Semantic {id: $oldId}) UNWIND $associations AS entry
        CREATE (e:Entity {id: entry.id, tenant_id: 'tenant-a', project_scope: 'project:alpha'})
        CREATE (old)-[r:ABOUT]->(e) SET r.valid_at = entry.valid_at, r.invalid_at = entry.invalid_at`,
      { oldId, associations });
      const clock = vi.spyOn(Date.prototype, 'toISOString').mockReturnValue(now);
      try { await expect(store.supersede(oldId, node)).resolves.toBe(node.id); }
      finally { clock.mockRestore(); }
      const result = await session.run(`MATCH (:Semantic {id: $newId})-[r:ABOUT]->(e:Entity)
        RETURN e.id AS id, r.valid_at AS start, r.invalid_at AS end ORDER BY id`, { newId: node.id });
      expect(result.records.map(record => record.toObject())).toEqual(associations.filter(entry => entry.copied)
        .map(entry => ({ id: entry.id, start: now, end: null })).sort((a, b) => a.id.localeCompare(b.id)));
      const excluded = await session.run(`MATCH (:Semantic {id: $oldId})-[r:ABOUT]->(e:Entity)
        WHERE e.id IN $ids RETURN e.id AS id, r.valid_at AS start, r.invalid_at AS end ORDER BY id`,
      { oldId, ids: associations.filter(entry => !entry.copied).map(entry => entry.id) });
      expect(excluded.records.map(record => record.toObject())).toEqual(associations.filter(entry => !entry.copied)
        .map(entry => ({ id: entry.id, start: entry.valid_at, end: entry.invalid_at })).sort((a, b) => a.id.localeCompare(b.id)));
    } finally { await session.close(); }
  });

  it('rejects inactive predecessors and tenant, project, and existing-id collisions without mutation', async () => {
    const activeId = await seedOld('old-active');
    const futureId = await seedOld('old-future', {
      future_valid_at: '2999-01-01T00:00:00.000Z',
    });
    const invalidId = await seedOld('old-invalid', {
      invalid_at: '2026-02-01T00:00:00.000Z',
    });
    const archivedId = await seedOld('old-archived', { archived: true });

    await expect(
      store.supersede(activeId, successor('wrong-tenant', { tenant_id: 'tenant-b' })),
    ).rejects.toThrow('outside tenant/project');
    await expect(
      store.supersede(
        activeId,
        successor('wrong-project', { scope: 'project:beta', tags: ['project:beta'] }),
      ),
    ).rejects.toThrow('outside tenant/project');
    await expect(store.supersede(futureId, successor('future-successor'))).rejects.toThrow(
      'inactive',
    );
    await expect(store.supersede(invalidId, successor('invalid-successor'))).rejects.toThrow(
      'inactive',
    );
    await expect(store.supersede(archivedId, successor('archived-successor'))).rejects.toThrow(
      'inactive',
    );

    const collision = successor('existing-collision');
    await store.create(collision);
    await expect(store.supersede(activeId, collision)).rejects.toThrow('conflicting successor');

    const verify = driver.session();
    try {
      const result = await verify.run(
        `MATCH (old:Semantic {id: $activeId})
         OPTIONAL MATCH (candidate:Semantic)-[:SUPERSEDES]->(old)
         RETURN old.invalid_at AS invalidAt, count(candidate) AS successors`,
        { activeId },
      );
      expect(result.records[0]!.get('invalidAt')).toBeNull();
      const count = result.records[0]!.get('successors') as { toNumber(): number };
      expect(count.toNumber()).toBe(0);
    } finally {
      await verify.close();
    }
  });

  it('serializes cross-predecessor claims for one successor id without mutating the loser', async () => {
    const matrix = [
      {
        label: 'same-scope',
        left: { tenant: 'tenant-a', scope: 'project:alpha' },
        right: { tenant: 'tenant-a', scope: 'project:alpha' },
      },
      {
        label: 'cross-tenant',
        left: { tenant: 'tenant-a', scope: 'project:alpha' },
        right: { tenant: 'tenant-b', scope: 'project:alpha' },
      },
      {
        label: 'cross-project',
        left: { tenant: 'tenant-a', scope: 'project:alpha' },
        right: { tenant: 'tenant-a', scope: 'project:beta' },
      },
    ] as const;

    for (const entry of matrix) {
      const leftId = `${PREFIX}-${entry.label}-left`;
      const rightId = `${PREFIX}-${entry.label}-right`;
      const newId = `${PREFIX}-${entry.label}-shared-new`;
      const seed = driver.session();
      try {
        await seed.run(
          `CREATE (:Semantic {
             id: $leftId, content: 'left', confidence: 0.8, signal_count: 1,
             created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z',
             valid_at: '2026-01-01T00:00:00.000Z', decay_class: 'stable',
             status: 'active', archived: false, tenant_id: $leftTenant,
             scope: $leftScope, tags: [$leftScope]
           })
           CREATE (:Semantic {
             id: $rightId, content: 'right', confidence: 0.8, signal_count: 1,
             created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z',
             valid_at: '2026-01-01T00:00:00.000Z', decay_class: 'stable',
             status: 'active', archived: false, tenant_id: $rightTenant,
             scope: $rightScope, tags: [$rightScope]
           })`,
          {
            leftId,
            rightId,
            leftTenant: entry.left.tenant,
            leftScope: entry.left.scope,
            rightTenant: entry.right.tenant,
            rightScope: entry.right.scope,
          },
        );
      } finally {
        await seed.close();
      }

      const leftNew = successor(`${entry.label}-ignored`, {
        id: newId,
        tenant_id: entry.left.tenant,
        scope: entry.left.scope,
        tags: [entry.left.scope],
      });
      const rightNew = successor(`${entry.label}-ignored`, {
        id: newId,
        tenant_id: entry.right.tenant,
        scope: entry.right.scope,
        tags: [entry.right.scope],
      });
      const attempts = await Promise.allSettled([
        store.supersede(leftId, leftNew),
        store.supersede(rightId, rightNew),
      ]);
      expect(attempts.filter((attempt) => attempt.status === 'fulfilled')).toHaveLength(1);
      expect(attempts.filter((attempt) => attempt.status === 'rejected')).toHaveLength(1);
      const winnerIndex = attempts.findIndex((attempt) => attempt.status === 'fulfilled');
      const winnerId = winnerIndex === 0 ? leftId : rightId;
      const loserId = winnerIndex === 0 ? rightId : leftId;

      const verify = driver.session();
      try {
        const result = await verify.run(
          `MATCH (old:Semantic) WHERE old.id IN $oldIds
           OPTIONAL MATCH (new:Semantic {id: $newId})-[r:SUPERSEDES]->(old)
           RETURN old.id AS oldId, old.invalid_at AS invalidAt,
                  old.status AS status, count(r) AS edges`,
          { oldIds: [leftId, rightId], newId },
        );
        const rows = new Map(
          result.records.map((record) => [record.get('oldId') as string, record]),
        );
        expect(rows.get(winnerId)!.get('invalidAt')).toBeTruthy();
        expect(rows.get(winnerId)!.get('status')).toBe('superseded');
        expect(rows.get(winnerId)!.get('edges').toNumber()).toBe(1);
        expect(rows.get(loserId)!.get('invalidAt')).toBeNull();
        expect(rows.get(loserId)!.get('status')).toBe('active');
        expect(rows.get(loserId)!.get('edges').toNumber()).toBe(0);
      } finally {
        await verify.close();
      }
    }
  });
});
