import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  AdmissionShadowRuntime,
  type AdmissionShadowHook,
} from '../admission-shadow.js';
import { DEFAULT_TIER_ROUTING_CONFIG } from '../admission-routing.js';
import { AMPService, type Neo4jLayer, type RedisLayer } from '../service.js';
import type { AMPConfig, EpisodicNode } from '../types.js';
import type { TrustedAdmissionInputV1 } from '../admission.js';

const SECRET = ['sk', 'abcdEFGH1234567890'].join('-');

function config(overrides: Partial<AMPConfig> = {}): AMPConfig {
  return {
    redis: { url: 'redis://test' },
    neo4j: { uri: 'bolt://test', user: 'neo4j', password: '' },
    embedding: { provider: 'openai', apiKey: 'test-key' },
    cache: { defaultTTL: 300, contextTTL: 300, embeddingTTL: 86400 },
    consolidation: { autoApply: false, signalThreshold: 3 },
    exportPath: '/tmp/memberry',
    ...overrides,
  };
}

function redis(events: string[]): RedisLayer {
  return {
    cache: {
      get: vi.fn(),
      set: vi.fn(),
      invalidateByScope: vi.fn(async () => { events.push('cache'); return 0; }),
      invalidateByNodeId: vi.fn(async () => { events.push('signal-cache'); return 0; }),
    },
    embeddings: { get: vi.fn(), set: vi.fn() },
    dedup: {
      isDuplicate: vi.fn(),
      markSeen: vi.fn(),
      checkAndMark: vi.fn(async () => { events.push('dedup'); return false; }),
      unmark: vi.fn(async () => { events.push('unmark'); }),
    },
    signals: { publish: vi.fn(async () => { events.push('signal-publish'); return '1-0'; }) },
    queue: { incrementScore: vi.fn(async () => { events.push('signal-score'); return 1; }) },
    extraction: { enqueue: vi.fn(async () => { events.push('extraction'); return '1-0'; }) },
  };
}

function neo4j(events: string[]): Neo4jLayer & { captured?: EpisodicNode } {
  const layer: Neo4jLayer & { captured?: EpisodicNode } = {
    episodic: {
      create: vi.fn(),
      createWithLinks: vi.fn(async (node) => {
        events.push('episode');
        layer.captured = node;
        return node.id;
      }),
      linkToAgent: vi.fn(),
      linkToEntity: vi.fn(),
      linkToModel: vi.fn(),
      linkSignal: vi.fn(async () => { events.push('signal-link'); }),
    },
    query: { byScope: vi.fn(), byVector: vi.fn() },
    semantic: { existingIds: vi.fn(async (ids) => ids) },
    fact: {
      getActive: vi.fn(),
      create: vi.fn(),
      findBySubjectPredicate: vi.fn(),
      invalidate: vi.fn(),
    },
  };
  return layer;
}

const input = {
  session_id: 'session-test',
  agent_id: 'agent-test',
  task: 'store a decision',
  content: 'the durable decision',
  tenantId: 'tenant-test',
  tags: ['project:test'],
  memory_type: 'decision' as const,
  outcome: 'approved' as const,
};

function observationSink(events?: string[]) {
  return {
    persist: vi.fn(async (_scope: unknown, observation: unknown) => {
      events?.push('observation-persist');
      return observation;
    }),
  };
}

function routingSink(events?: string[]) {
  return {
    persist: vi.fn(async () => { events?.push('routing-persist'); }),
  };
}

function runtimeWith(
  routing: { persist: (scope: unknown, rec: unknown) => Promise<void> } | undefined,
  obsSink: { persist: (scope: unknown, observation: unknown) => Promise<unknown> },
  timeoutMs = 250,
): AdmissionShadowRuntime {
  return new AdmissionShadowRuntime({
    enabled: true,
    timeoutMs,
    sink: obsSink as never,
    ...(routing ? { routing: { config: DEFAULT_TIER_ROUTING_CONFIG, sink: routing as never } } : {}),
  });
}

function service(
  events: string[],
  shadow: AdmissionShadowHook,
  overrides: Partial<AMPConfig> = {},
): { service: AMPService; redisLayer: ReturnType<typeof redis>; neo4jLayer: ReturnType<typeof neo4j> } {
  const redisLayer = redis(events);
  const neo4jLayer = neo4j(events);
  const svc = new AMPService(
    redisLayer, neo4jLayer,
    { embed: vi.fn(async () => [0.1]), embedBatch: vi.fn() },
    config(overrides), undefined, undefined, shadow,
  );
  return { service: svc, redisLayer, neo4jLayer };
}

function trustedInput(overrides: Partial<TrustedAdmissionInputV1> = {}): TrustedAdmissionInputV1 {
  return {
    captureState: 'accepted-nonduplicate',
    task: 'store a decision',
    content: 'the durable decision',
    tags: ['project:test'],
    scope: 'project:test',
    tenantId: 'tenant-test',
    redactionConfigured: false,
    memoryType: 'general',
    hasSignals: false,
    hasEntities: false,
    hasModel: false,
    ...overrides,
  } as TrustedAdmissionInputV1;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('MEM-003 live routing shadow inside the admission shadow attempt', () => {
  it.each([
    ['protected via detected sensitivity', { content: `token ${SECRET}` },
      { recommendedTier: 'protected', reasonCode: 'sensitivity-protected' }],
    ['semantic-candidate via approved decision', {},
      { recommendedTier: 'semantic-candidate', reasonCode: 'approved-decision-candidate' }],
    ['null-envelope episodic default', { memory_type: 'general' as const, outcome: undefined },
      { recommendedTier: 'episodic', reasonCode: 'features-unavailable-default' }],
  ])('records %s with the observation scope triple', async (_label, inputOverrides, expected) => {
    const obsSink = observationSink();
    const routing = routingSink();
    const runtime = runtimeWith(routing, obsSink);
    const { service: svc } = service([], runtime);

    const result = await svc.store({ ...input, ...inputOverrides });

    await vi.waitFor(() => { expect(routing.persist).toHaveBeenCalledOnce(); });
    expect(obsSink.persist).toHaveBeenCalledOnce();
    const [observationScope] = obsSink.persist.mock.calls[0]!;
    const [routingScope, recommendation] = routing.persist.mock.calls[0]!;
    expect(routingScope).toEqual(observationScope);
    expect(routingScope).toMatchObject({ episodeId: result.id, tenantId: 'tenant-test' });
    expect(recommendation).toMatchObject({
      ...expected,
      policyId: 'tier-routing-admission',
      contractVersion: '1.0.0',
    });
    await runtime.stopAndDrain();
  });

  it.each([
    ['rejected persist', vi.fn(async () => { throw new Error('routing-sink-down'); })],
    ['hostile synchronous throw', vi.fn(() => { throw new Error('routing-sink-hostile'); })],
  ])('contains a routing sink failure (%s) without touching the attempt or snapshot', async (_label, persist) => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const obsSink = observationSink();
    const runtime = runtimeWith({ persist: persist as never }, obsSink);
    const { service: svc, redisLayer } = service([], runtime);

    const result = await svc.store(input);
    expect(result).toEqual({ id: expect.any(String), duplicate: false });
    await vi.waitFor(() => { expect(consoleError).toHaveBeenCalled(); });

    expect(obsSink.persist).toHaveBeenCalledOnce();
    expect(redisLayer.dedup.unmark).not.toHaveBeenCalled();
    expect(runtime.snapshot()).toMatchObject({
      appended: 1,
      appendFailures: 0,
      timedOut: 0,
      lastFailureCode: null,
      health: 'healthy',
    });
    // Content-free failure line: no scope, tier, or error detail.
    expect(JSON.stringify(consoleError.mock.calls)).not.toMatch(/routing-sink|tenant-test|project:test/);
    await runtime.stopAndDrain();
  });

  it('never calls a routing sink when routing is not configured', async () => {
    const obsSink = observationSink();
    const unused = routingSink();
    const runtime = runtimeWith(undefined, obsSink);
    const { service: svc } = service([], runtime);

    await expect(svc.store(input)).resolves.toEqual({ id: expect.any(String), duplicate: false });
    await runtime.stopAndDrain();
    expect(obsSink.persist).toHaveBeenCalledOnce();
    expect(unused.persist).not.toHaveBeenCalled();
  });

  it('adds zero service-level events with routing ON (pinned 13-event trace equivalence)', async () => {
    const events: string[] = [];
    const runtime = runtimeWith(routingSink(), observationSink());
    const hook: AdmissionShadowHook = {
      enabled: true,
      begin: () => {
        events.push('begin');
        const attempt = runtime.begin();
        if (!attempt) return null;
        return {
          prepare: (raw) => { events.push('prepare'); return attempt.prepare(raw); },
          append: async (scope, observation) => { events.push('append'); return attempt.append(scope, observation); },
          cancel: () => attempt.cancel(),
        };
      },
    };
    const redisLayer = redis(events);
    const neo4jLayer = neo4j(events);
    const audit = { append: vi.fn(async () => { events.push('audit'); }) };
    const svc = new AMPService(
      redisLayer, neo4jLayer,
      { embed: vi.fn(async () => { events.push('embedding'); return [0.1]; }), embedBatch: vi.fn() },
      config(), undefined, audit, hook,
    );

    await svc.store({
      ...input,
      signals: [{ type: 'reinforcement', target_id: 'semantic-1', detail: 'confirmed' }],
    });
    await runtime.stopAndDrain();

    expect(events).toEqual([
      'dedup', 'begin', 'embedding', 'episode', 'cache',
      'signal-link', 'signal-publish', 'signal-cache', 'signal-score',
      'extraction', 'audit', 'prepare', 'append',
    ]);
  });

  it('calls the routing sink only after the observation sink resolves', async () => {
    const events: string[] = [];
    const obsSink = {
      persist: vi.fn(async (_scope: unknown, observation: unknown) => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        events.push('observation-resolved');
        return observation;
      }),
    };
    const routing = routingSink(events);
    const runtime = runtimeWith(routing, obsSink);
    const { service: svc } = service([], runtime);

    await svc.store(input);
    await vi.waitFor(() => { expect(routing.persist).toHaveBeenCalledOnce(); });
    expect(events).toEqual(['observation-resolved', 'routing-persist']);
    await runtime.stopAndDrain();
  });

  it('LATENCY containment: routing slower than the shadow timeout never times the attempt out', async () => {
    let resolveRouting!: () => void;
    const routingDone = new Promise<void>((resolve) => { resolveRouting = resolve; });
    const routing = { persist: vi.fn(() => routingDone) };
    const runtime = runtimeWith(routing, observationSink(), 20);

    const attempt = runtime.begin();
    expect(attempt).not.toBeNull();
    const observation = attempt!.prepare(trustedInput());
    expect(observation).not.toBeNull();
    const outcome = await attempt!.append(
      { tenantId: 'tenant-test', projectScope: 'project:test', episodeId: 'ep-slow-routing' },
      observation!,
    );

    // Under the raced-chain placement this is 'timed-out' with timedOut=1.
    expect(outcome).toBe('stored');
    // Let more than the shadow timeout elapse while routing is still pending.
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(routing.persist).toHaveBeenCalledOnce();
    expect(runtime.snapshot()).toMatchObject({
      appended: 1,
      timedOut: 0,
      appendFailures: 0,
      lastFailureCode: null,
      health: 'healthy',
    });
    resolveRouting();
    await runtime.stopAndDrain();
  });

  it('saturation containment: pending routing work consumes no begin() capacity', async () => {
    let resolveRouting!: () => void;
    const routingDone = new Promise<void>((resolve) => { resolveRouting = resolve; });
    const routing = { persist: vi.fn(() => routingDone) };
    const runtime = runtimeWith(routing, observationSink(), 20);

    const first = runtime.begin();
    const observation = first!.prepare(trustedInput());
    await expect(first!.append(
      { tenantId: 'tenant-test', projectScope: 'project:test', episodeId: 'ep-saturation' },
      observation!,
    )).resolves.toBe('stored');
    await vi.waitFor(() => { expect(routing.persist).toHaveBeenCalledOnce(); });

    // With routing still unresolved, the FULL in-flight budget must be free.
    const attempts = Array.from({ length: 32 }, () => runtime.begin());
    expect(attempts.every((candidate) => candidate !== null)).toBe(true);
    for (const candidate of attempts) candidate!.cancel();
    expect(runtime.snapshot()).toMatchObject({ capacityRejected: 0, inFlight: 0 });

    resolveRouting();
    await runtime.stopAndDrain();
  });
});
