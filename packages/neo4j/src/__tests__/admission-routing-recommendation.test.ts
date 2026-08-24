import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  DEFAULT_TIER_ROUTING_CONFIG,
  TrustedAdmissionPreprocessorV1,
  createAdmissionObservationV1,
  routeAdmissionTierV1,
  type TierRoutingRecommendationV1,
} from '@memberry/core';
import { describe, expect, it, vi } from 'vitest';
import type { Driver } from 'neo4j-driver';

import {
  AdmissionRoutingRecommendationStore,
  AdmissionRoutingRecommendationStoreError,
  type AdmissionRoutingRecommendationScopeV1,
} from '../admission-routing-recommendation.js';
import { TenantAdmin } from '../tenant-admin.js';

const SCOPE: AdmissionRoutingRecommendationScopeV1 = {
  tenantId: 'tenant-acme',
  projectScope: 'project:memberry',
  episodeId: 'ep-admission-001',
};
const TENANT_ADMIN_SOURCE = fileURLToPath(new URL('../tenant-admin.ts', import.meta.url));

function safeFacts() {
  return new TrustedAdmissionPreprocessorV1().preprocess({
    captureState: 'accepted-nonduplicate',
    task: 'persist routing shadow result',
    content: 'plain durable decision',
    tags: ['project:memberry'],
    scope: 'project:memberry',
    tenantId: 'tenant-acme',
    redactionConfigured: true,
    memoryType: 'decision',
    outcome: 'approved',
    hasSignals: true,
    hasEntities: true,
    hasModel: false,
  });
}

function recommendation(
  config: Parameters<typeof routeAdmissionTierV1>[2] = DEFAULT_TIER_ROUTING_CONFIG,
): TierRoutingRecommendationV1 {
  return routeAdmissionTierV1(safeFacts(), null, config);
}

type Stored = {
  properties: Record<string, unknown>;
  relationships: Array<{ type: string; episodeId: string }>;
};

function resultRecord(values: Record<string, unknown>) {
  return { get: (key: string) => values[key] };
}

function makeDriver() {
  const nodes = new Map<string, Stored>();
  const queries: string[] = [];

  const tx = {
    run: vi.fn(async (query: string, params: Record<string, unknown> = {}) => {
      queries.push(query);
      if (!query.includes('admission-routing-recommendation:merge')) throw new Error('unexpected query');
      const exactEpisode = params.tenantId === SCOPE.tenantId
        && params.projectScope === SCOPE.projectScope
        && params.episodeId === SCOPE.episodeId;
      if (!exactEpisode) return { records: [] };
      const id = String(params.id);
      let node = nodes.get(id);
      const created = node === undefined;
      if (node === undefined) {
        node = {
          properties: structuredClone(params.properties as Record<string, unknown>),
          relationships: [{ type: 'RECOMMENDS_FOR', episodeId: String(params.episodeId) }],
        };
        nodes.set(id, node);
      }
      const exactLinkCount = node.relationships
        .filter((link) => link.type === 'RECOMMENDS_FOR' && link.episodeId === params.episodeId).length;
      return { records: [resultRecord({
        properties: structuredClone(node.properties),
        relationshipCount: node.relationships.length,
        exactLinkCount,
        created,
      })] };
    }),
  };
  const session = {
    executeWrite: vi.fn(async <T>(work: (transaction: typeof tx) => Promise<T>) => work(tx)),
    executeRead: vi.fn(),
    close: vi.fn(async () => undefined),
  };
  const driver = { session: vi.fn(() => session) } as unknown as Driver;
  return { driver, nodes, queries };
}

describe('AdmissionRoutingRecommendationStore MEM-003', () => {
  it('persists via constraint-backed MERGE with a RECOMMENDS_FOR edge and flattened closed keys', async () => {
    const fake = makeDriver();
    await new AdmissionRoutingRecommendationStore(fake.driver).persist(SCOPE, recommendation());

    const query = fake.queries[0]!;
    expect(query).toContain('MERGE (r:AdmissionRoutingRecommendation {id: $id})');
    expect(query).not.toContain('CREATE (r:AdmissionRoutingRecommendation');
    expect(query).toContain('CREATE (r)-[:RECOMMENDS_FOR]->(e)');

    expect(fake.nodes.size).toBe(1);
    const stored = [...fake.nodes.values()][0]!;
    expect(Object.keys(stored.properties).sort()).toEqual([
      'config_identity', 'contract_version', 'episode_id', 'id', 'observed_at',
      'policy_id', 'policy_version', 'project_scope', 'reason_code',
      'recommended_tier', 'tenant_id', 'would_change_baseline',
    ]);
    expect(stored.properties).toMatchObject({
      tenant_id: SCOPE.tenantId,
      project_scope: SCOPE.projectScope,
      episode_id: SCOPE.episodeId,
      policy_id: 'tier-routing-admission',
      policy_version: '1.0.0',
      contract_version: '1.0.0',
      recommended_tier: 'semantic-candidate',
      reason_code: 'approved-decision-candidate',
      would_change_baseline: true,
    });
  });

  it('is MERGE-idempotent for the same (config, triple) tuple: one node, one stable id', async () => {
    const fake = makeDriver();
    const store = new AdmissionRoutingRecommendationStore(fake.driver);
    await store.persist(SCOPE, recommendation());
    const firstObservedAt = [...fake.nodes.values()][0]!.properties.observed_at;
    // Second call stamps a later observed_at; read-back must still accept it.
    await new Promise((resolve) => setTimeout(resolve, 5));
    await store.persist(SCOPE, recommendation());
    expect(fake.nodes.size).toBe(1);
    expect([...fake.nodes.values()][0]!.properties.observed_at).toBe(firstObservedAt);
  });

  it('rejects substantive drift and unknown keys on read-back without healing', async () => {
    const fake = makeDriver();
    const store = new AdmissionRoutingRecommendationStore(fake.driver);
    await store.persist(SCOPE, recommendation());
    const [id, stored] = [...fake.nodes.entries()][0]!;

    for (const mutate of [
      (properties: Record<string, unknown>) => { properties.recommended_tier = 'discard'; },
      (properties: Record<string, unknown>) => { properties.extra = true; },
      (properties: Record<string, unknown>) => { delete properties.reason_code; },
    ]) {
      const corrupted = structuredClone(stored);
      mutate(corrupted.properties);
      fake.nodes.set(id, corrupted);
      await expect(store.persist(SCOPE, recommendation()))
        .rejects.toMatchObject({ code: 'existing_state_mismatch' });
      fake.nodes.set(id, structuredClone(stored));
    }
  });

  it('fails value-free when the exact scoped episode does not exist', async () => {
    const fake = makeDriver();
    let error: unknown;
    try {
      await new AdmissionRoutingRecommendationStore(fake.driver)
        .persist({ ...SCOPE, episodeId: 'ep-missing-canary' }, recommendation());
    } catch (caught) { error = caught; }
    expect(error).toBeInstanceOf(AdmissionRoutingRecommendationStoreError);
    expect(error).toMatchObject({ code: 'episode_not_found' });
    expect(String(error)).not.toContain('ep-missing-canary');
  });

  it('derives a distinct-domain id: config-stable, config-sensitive, never the observation id', async () => {
    const fake = makeDriver();
    const store = new AdmissionRoutingRecommendationStore(fake.driver);
    await store.persist(SCOPE, recommendation());
    await store.persist(SCOPE, recommendation());
    expect(fake.nodes.size).toBe(1);
    const routingId = String([...fake.nodes.keys()][0]);
    expect(routingId).toMatch(/^admission-routing-recommendation:sha256:[0-9a-f]{64}$/);

    // A threshold change yields a NEW sibling node (configIdentity is in the tuple).
    await store.persist(SCOPE, recommendation({
      ...DEFAULT_TIER_ROUTING_CONFIG,
      protectedSensitivityMinPermille: 501,
    }));
    expect(fake.nodes.size).toBe(2);
    const ids = [...fake.nodes.keys()].map(String);
    expect(new Set(ids).size).toBe(2);

    // Not the observation store's digest for the same triple (distinct domain).
    const observationDigest = 'bea1a61e5e5f5bebf408e45782659bc89df0dca4298a384c7eefbee1bf0e93c6';
    for (const id of ids) expect(id).not.toContain(observationDigest);
  });

  it('returns the routing recommendation type unchanged through the core policy (sink shape sanity)', () => {
    // The runtime sink contract is persist(scope, recommendation) -> void; the
    // store's persist resolves undefined so it satisfies it structurally.
    const store = new AdmissionRoutingRecommendationStore(makeDriver().driver);
    const sink: { persist(scope: AdmissionRoutingRecommendationScopeV1, rec: TierRoutingRecommendationV1): Promise<void> } = store;
    expect(typeof sink.persist).toBe('function');
  });

  it('stays outside tenant counts/export and is deleted before Episodic on tenant delete', async () => {
    const queries: string[] = [];
    const run = vi.fn(async (query: string) => {
      queries.push(query);
      return { records: [resultRecord({ c: 0 })] };
    });
    const driver = {
      session: vi.fn(() => ({ run, close: vi.fn(async () => undefined) })),
    } as unknown as Driver;
    const admin = new TenantAdmin(driver);

    const counts = await admin.stats('tenant-acme');
    expect(Object.keys(counts).sort()).toEqual(['Episodic', 'Fact', 'MemoryBlock', 'Semantic']);
    expect(queries.some((query) => query.includes('AdmissionRoutingRecommendation'))).toBe(false);

    queries.length = 0;
    await admin.delete('tenant-acme');
    const routing = queries.findIndex((query) => query.includes('MATCH (r:AdmissionRoutingRecommendation'));
    const episodic = queries.findIndex((query) =>
      query.includes('MATCH (n:Episodic') && query.includes('DETACH DELETE'));
    expect(routing).toBeGreaterThan(-1);
    expect(episodic).toBeGreaterThan(routing);

    // Source pin: TenantCounts labels stay closed — the sidecar is not a category.
    const source = readFileSync(TENANT_ADMIN_SOURCE, 'utf8');
    const labels = source.slice(source.indexOf('const TENANT_LABELS'), source.indexOf('] as const'));
    expect(labels).not.toContain('AdmissionRoutingRecommendation');
  });

  it('sanity: the persisted tier for these facts matches the pure policy output', () => {
    expect(recommendation()).toMatchObject({
      recommendedTier: 'semantic-candidate',
      reasonCode: 'approved-decision-candidate',
      wouldChangeBaseline: true,
    });
    // Anchors the fixture against the MEM-001 observation contract too.
    const observation = createAdmissionObservationV1(
      { safeFacts: safeFacts() },
      { now: () => new Date('2026-08-24T12:00:00.000Z') },
    );
    expect(observation.safeFacts.captureState).toBe('accepted-nonduplicate');
  });
});
