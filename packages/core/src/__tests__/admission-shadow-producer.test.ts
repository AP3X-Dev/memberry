import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@memberry/redis', () => ({
  createRedisClient: vi.fn(() => ({ quit: vi.fn(async () => undefined) })),
  ContextCache: vi.fn(),
  EmbeddingCache: vi.fn(),
  DedupChecker: vi.fn(),
  SignalStream: vi.fn(),
  ConsolidationQueue: vi.fn(),
  ExtractionQueue: vi.fn(),
  DistributedLock: vi.fn(),
  BlockStore: vi.fn(),
}));

vi.mock('@memberry/neo4j', () => ({
  createNeo4jDriver: vi.fn(() => ({ session: vi.fn(), close: vi.fn(async () => undefined) })),
  EpisodicStore: vi.fn(),
  SemanticStore: vi.fn(),
  ScopedQuery: vi.fn(),
  FactStore: vi.fn(),
  AuditLogStore: vi.fn(),
  AdmissionObservationStore: vi.fn(),
  AdmissionRoutingRecommendationStore: vi.fn(),
  BlockStore: vi.fn(),
}));

import { createRedisClient } from '@memberry/redis';
import { createNeo4jDriver } from '@memberry/neo4j';
import { AdmissionShadowRuntime, type AdmissionShadowRuntimeOptions } from '../admission-shadow.js';
import { DEFAULT_TIER_ROUTING_CONFIG } from '../admission-routing.js';
import { AdmissionFeatureProducerModeError } from '../admission-features-v2.js';
import { produceAdmissionFeatureEnvelopeV2 } from '../admission-feature-producer.js';
import { createCoreServices } from '../services-factory.js';
import type { TrustedAdmissionInputV1 } from '../admission.js';

const SHADOW_ENV = 'MEMBERRY_ADMISSION_SHADOW_ENABLED';
const ROUTING_ENV = 'MEMBERRY_ADMISSION_ROUTING_V1';
const PRODUCER_ENV = 'MEMBERRY_ADMISSION_FEATURE_PRODUCER_V1';

const SCOPE = { tenantId: 'tenant-test', projectScope: 'project:test', episodeId: 'ep-producer' };

function trustedInput(overrides: Partial<TrustedAdmissionInputV1> = {}): TrustedAdmissionInputV1 {
  return {
    captureState: 'accepted-nonduplicate',
    task: 'store a convention',
    content: 'the corroborated convention',
    tags: ['project:test'],
    scope: 'project:test',
    tenantId: 'tenant-test',
    redactionConfigured: false,
    memoryType: 'convention',
    hasSignals: true,
    hasEntities: true,
    hasModel: false,
    ...overrides,
  } as TrustedAdmissionInputV1;
}

function observationSink() {
  return { persist: vi.fn(async (_scope: unknown, observation: unknown) => observation) };
}

function routingSink() {
  return { persist: vi.fn(async () => undefined) };
}

function runtimeWith(
  routing: NonNullable<AdmissionShadowRuntimeOptions['routing']> | undefined,
  obsSink: ReturnType<typeof observationSink>,
): AdmissionShadowRuntime {
  return new AdmissionShadowRuntime({
    enabled: true,
    timeoutMs: 250,
    sink: obsSink as never,
    ...(routing ? { routing } : {}),
  });
}

async function storeOnce(runtime: AdmissionShadowRuntime, overrides: Partial<TrustedAdmissionInputV1> = {}) {
  const attempt = runtime.begin();
  expect(attempt).not.toBeNull();
  const observation = attempt!.prepare(trustedInput(overrides));
  expect(observation).not.toBeNull();
  return attempt!.append(SCOPE, observation!);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('MEM-002 live producer inside the routing continuation', () => {
  it('feeds the routing sink an envelope-driven recommendation for the observation scope, only after stored', async () => {
    const obsSink = observationSink();
    const routing = routingSink();
    const runtime = runtimeWith(
      { config: DEFAULT_TIER_ROUTING_CONFIG, sink: routing as never, produceEnvelope: produceAdmissionFeatureEnvelopeV2 },
      obsSink,
    );

    await expect(storeOnce(runtime)).resolves.toBe('stored');
    await vi.waitFor(() => { expect(routing.persist).toHaveBeenCalledOnce(); });
    await runtime.stopAndDrain();

    expect(obsSink.persist).toHaveBeenCalledOnce();
    const [routingScope, recommendation] = (routing.persist as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(routingScope).toEqual(obsSink.persist.mock.calls[0]![0]);
    // convention + both markers: durability 800, evidenceQuality 1000 → rule 5.
    expect(recommendation).toMatchObject({
      recommendedTier: 'semantic-candidate',
      reasonCode: 'feature-candidate',
    });
  });

  it('never routes when the observation persist fails', async () => {
    const routing = routingSink();
    const runtime = runtimeWith(
      { config: DEFAULT_TIER_ROUTING_CONFIG, sink: routing as never, produceEnvelope: produceAdmissionFeatureEnvelopeV2 },
      { persist: vi.fn(async () => { throw new Error('observation-down'); }) } as never,
    );

    await expect(storeOnce(runtime)).resolves.toBe('failed');
    await runtime.stopAndDrain();
    expect(routing.persist).not.toHaveBeenCalled();
  });

  it('degrades a throwing producer to the null-envelope path with the snapshot untouched', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const obsSink = observationSink();
    const routing = routingSink();
    const runtime = runtimeWith(
      {
        config: DEFAULT_TIER_ROUTING_CONFIG,
        sink: routing as never,
        produceEnvelope: () => { throw new Error('producer-detail-must-not-leak'); },
      },
      obsSink,
    );

    await expect(storeOnce(runtime)).resolves.toBe('stored');
    await vi.waitFor(() => { expect(routing.persist).toHaveBeenCalledOnce(); });
    await runtime.stopAndDrain();

    const [, recommendation] = (routing.persist as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(recommendation).toMatchObject({
      recommendedTier: 'episodic',
      reasonCode: 'features-unavailable-default',
    });
    expect(runtime.snapshot()).toMatchObject({
      appended: 1,
      appendFailures: 0,
      timedOut: 0,
      lastFailureCode: null,
      health: 'healthy',
    });
    // Content-free fixed failure line: no scope or error detail.
    expect(consoleError).toHaveBeenCalledWith('[admission-features] live producer failed');
    expect(JSON.stringify(consoleError.mock.calls)).not.toMatch(/producer-detail|tenant-test|project:test/);
  });

  it('contains a garbage-returning producer in the continuation catch with the snapshot untouched', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const obsSink = observationSink();
    const routing = routingSink();
    const runtime = runtimeWith(
      {
        config: DEFAULT_TIER_ROUTING_CONFIG,
        sink: routing as never,
        produceEnvelope: (() => ({ hostile: true })) as never,
      },
      obsSink,
    );

    await expect(storeOnce(runtime)).resolves.toBe('stored');
    await vi.waitFor(() => { expect(consoleError).toHaveBeenCalled(); });
    await runtime.stopAndDrain();

    expect(routing.persist).not.toHaveBeenCalled();
    expect(runtime.snapshot()).toMatchObject({
      appended: 1,
      appendFailures: 0,
      timedOut: 0,
      lastFailureCode: null,
      health: 'healthy',
    });
  });

  it('without produceEnvelope the seam is byte-equal to the null-envelope path', async () => {
    const routing = routingSink();
    const runtime = runtimeWith(
      { config: DEFAULT_TIER_ROUTING_CONFIG, sink: routing as never },
      observationSink(),
    );

    await expect(storeOnce(runtime)).resolves.toBe('stored');
    await vi.waitFor(() => { expect(routing.persist).toHaveBeenCalledOnce(); });
    await runtime.stopAndDrain();

    const [, recommendation] = (routing.persist as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(recommendation).toMatchObject({
      recommendedTier: 'episodic',
      reasonCode: 'features-unavailable-default',
    });
  });
});

describe('createCoreServices producer staging', () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of [SHADOW_ENV, ROUTING_ENV, PRODUCER_ENV]) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
    vi.mocked(createRedisClient).mockClear();
    vi.mocked(createNeo4jDriver).mockClear();
  });

  afterEach(() => {
    for (const key of [SHADOW_ENV, ROUTING_ENV, PRODUCER_ENV]) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  it('fails loud on live producer without the routing shadow prerequisite, before any client allocation', () => {
    process.env[PRODUCER_ENV] = 'live';
    let error: unknown;
    try { createCoreServices(); } catch (caught) { error = caught; }
    expect(error).toBeInstanceOf(AdmissionFeatureProducerModeError);
    expect(error).toMatchObject({ code: 'prerequisite_unavailable' });
    expect(String(error)).toContain('admission_feature_producer:prerequisite_unavailable');
    expect(createRedisClient).not.toHaveBeenCalled();
    expect(createNeo4jDriver).not.toHaveBeenCalled();
  });

  it('constructs cleanly with the full staging ladder live', async () => {
    process.env[SHADOW_ENV] = 'true';
    process.env[ROUTING_ENV] = 'shadow';
    process.env[PRODUCER_ENV] = 'live';
    const services = createCoreServices();
    expect(services.admissionShadow.enabled).toBe(true);
    await services.close();
  });
});
