import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  AdmissionRoutingModeError,
  resolveAdmissionRoutingModeV1,
} from '../admission-routing.js';

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
import { createNeo4jDriver, AdmissionRoutingRecommendationStore } from '@memberry/neo4j';
import { createCoreServices } from '../services-factory.js';

const ROUTING_ENV = 'MEMBERRY_ADMISSION_ROUTING_V1';
const SHADOW_ENV = 'MEMBERRY_ADMISSION_SHADOW_ENABLED';

describe('resolveAdmissionRoutingModeV1', () => {
  it('defaults unset and empty to disabled and accepts only the exact tokens', () => {
    expect(resolveAdmissionRoutingModeV1({})).toBe('disabled');
    expect(resolveAdmissionRoutingModeV1({ [ROUTING_ENV]: '' })).toBe('disabled');
    expect(resolveAdmissionRoutingModeV1({ [ROUTING_ENV]: 'disabled' })).toBe('disabled');
    expect(resolveAdmissionRoutingModeV1({ [ROUTING_ENV]: 'shadow' })).toBe('shadow');
  });

  it('rejects the reserved served token with a typed error', () => {
    let error: unknown;
    try { resolveAdmissionRoutingModeV1({ [ROUTING_ENV]: 'served' }); } catch (caught) { error = caught; }
    expect(error).toBeInstanceOf(AdmissionRoutingModeError);
    expect(error).toMatchObject({ code: 'served_not_qualified' });
    expect(String(error)).toContain('admission_routing:served_not_qualified');
  });

  it.each(['SHADOW', ' shadow', 'shadow ', 'on', 'true', 'off', 'enabled'])(
    'rejects %j with a typed config error and never reflects the value',
    (raw) => {
      let error: unknown;
      try { resolveAdmissionRoutingModeV1({ [ROUTING_ENV]: raw }); } catch (caught) { error = caught; }
      expect(error).toBeInstanceOf(AdmissionRoutingModeError);
      expect(error).toMatchObject({ code: 'invalid_mode' });
      // Closed message: the supplied value is never reflected.
      expect((error as Error).message).toBe('admission_routing:invalid_mode');
    },
  );
});

describe('createCoreServices routing staging', () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of [ROUTING_ENV, SHADOW_ENV]) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
    vi.mocked(createRedisClient).mockClear();
    vi.mocked(createNeo4jDriver).mockClear();
    vi.mocked(AdmissionRoutingRecommendationStore).mockClear();
  });

  afterEach(() => {
    for (const key of [ROUTING_ENV, SHADOW_ENV]) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  it('fails loud on routing shadow without the admission shadow prerequisite, before any client allocation', () => {
    process.env[ROUTING_ENV] = 'shadow';
    let error: unknown;
    try { createCoreServices(); } catch (caught) { error = caught; }
    expect(error).toBeInstanceOf(AdmissionRoutingModeError);
    expect(error).toMatchObject({ code: 'prerequisite_unavailable' });
    expect(createRedisClient).not.toHaveBeenCalled();
    expect(createNeo4jDriver).not.toHaveBeenCalled();
  });

  it('rejects a malformed routing threshold in shadow mode before any client allocation', () => {
    process.env[ROUTING_ENV] = 'shadow';
    process.env[SHADOW_ENV] = 'true';
    process.env['MEMBERRY_ADMISSION_ROUTING_PROTECTED_SENSITIVITY_MIN_PERMILLE'] = 'not-a-number';
    try {
      expect(() => createCoreServices()).toThrow(/tier_routing_contract:invalid_number/);
      expect(createRedisClient).not.toHaveBeenCalled();
      expect(createNeo4jDriver).not.toHaveBeenCalled();
    } finally {
      delete process.env['MEMBERRY_ADMISSION_ROUTING_PROTECTED_SENSITIVITY_MIN_PERMILLE'];
    }
  });

  it('constructs the recommendation store only in shadow mode', async () => {
    const disabled = createCoreServices();
    expect(AdmissionRoutingRecommendationStore).not.toHaveBeenCalled();
    await disabled.close();

    process.env[ROUTING_ENV] = 'shadow';
    process.env[SHADOW_ENV] = 'true';
    const shadowed = createCoreServices();
    expect(AdmissionRoutingRecommendationStore).toHaveBeenCalledOnce();
    await shadowed.close();
  });
});
