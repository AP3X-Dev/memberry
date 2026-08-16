import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { describe, expect, it, vi } from 'vitest';

import {
  childEnvironment,
  classifyTraceReadiness,
  cleanupOwnedRedisKeys,
  caseStageDiagnosticCode,
  classifySeededPresentation,
  compositionRootCommand,
  parseSeedReadback,
  parseResidualCounts,
  rankedFixtureMarkers,
  readBoundedResponseText,
  requiredPresentationIdForCase,
  resolveTraceConformanceConfig,
  runAbortableOperation,
  safeDiagnosticCode,
  seededMissingDiagnosticCode,
  tenantIsolationForbiddenValues,
  traceFixtureForbiddenValues,
  traceFixtureQueries,
  TraceMcpTransport,
  waitForTraceReadiness,
} from '../live-conformance.js';
import { observeOrderedMarkdownResultIds } from '../contract.js';
import { validateSystemRegistry } from '../../registry/validate.js';

const validEnv = {
  MEMBERRY_TRACE_LIVE_DISPOSABLE: 'true',
  MEMBERRY_TRACE_LIVE_DEFAULT_TOKEN: 'default-trace-token',
  MEMBERRY_TRACE_LIVE_NAMED_TOKEN: 'named-trace-token',
  MEMBERRY_TRACE_LIVE_MCP_URL: 'http://127.0.0.1:3411',
  MEMBERRY_TRACE_LIVE_REDIS_URL: 'redis://127.0.0.1:6379',
  MEMBERRY_TRACE_LIVE_NEO4J_URI: 'bolt://127.0.0.1:7687',
  MEMBERRY_TRACE_LIVE_NEO4J_USER: 'neo4j',
  MEMBERRY_TRACE_LIVE_NEO4J_PASSWORD: 'testpassword',
  MEMBERRY_TRACE_LIVE_REDIS_CONTAINER_ID: 'a'.repeat(64),
  MEMBERRY_TRACE_LIVE_REDIS_IMAGE_ID: `sha256:${'b'.repeat(64)}`,
  MEMBERRY_TRACE_LIVE_NEO4J_CONTAINER_ID: 'c'.repeat(64),
  MEMBERRY_TRACE_LIVE_NEO4J_IMAGE_ID: `sha256:${'d'.repeat(64)}`,
} as const;

const mappingFixture = {
  run: 'run-000000000001',
  default: {
    projectId: 'ret001d-dp-run-000000000001',
    projectName: 'ret001d-default-project-run-000000000001',
    projectTenant: 'default',
    targetId: 'ret001d-dt-run-000000000001',
    targetName: 'ret001d-default-target-run-000000000001',
    targetTenant: 'default',
    targetResponsibility: 'ret001ddrun000000000001',
  },
  named: {
    projectId: 'ret001d-np-run-000000000001',
    projectName: 'ret001d-named-project-run-000000000001',
    projectTenant: 'ret001d-named',
    targetId: 'ret001d-nt-run-000000000001',
    targetName: 'ret001d-named-target-run-000000000001',
    targetTenant: 'ret001d-named',
    targetResponsibility: 'ret001dnrun000000000001',
  },
} as const;

const seedFixture = {
  run: 'run-000000000001',
  defaultProject: 'ret001d-default-project-run-000000000001',
  defaultTarget: 'ret001d-default-target-run-000000000001',
  namedProject: 'ret001d-named-project-run-000000000001',
  namedTarget: 'ret001d-named-target-run-000000000001',
  defaultRankedMarker: 'ret001ddrun000000000001',
  namedRankedMarker: 'ret001dnrun000000000001',
} as const;

function seedRecord(values: Record<string, unknown>): { get(key: string): unknown } {
  return { get: (key: string) => values[key] };
}

function validSeedRecords(): Array<{ get(key: string): unknown }> {
  return [
    seedRecord({
      projectId: 'ret001d-dp-run-000000000001', projectName: seedFixture.defaultProject, projectTenant: 'default',
      targetId: 'ret001d-dt-run-000000000001', targetName: seedFixture.defaultTarget, targetTenant: 'default',
      targetResponsibility: seedFixture.defaultRankedMarker,
    }),
    seedRecord({
      projectId: 'ret001d-np-run-000000000001', projectName: seedFixture.namedProject, projectTenant: 'ret001d-named',
      targetId: 'ret001d-nt-run-000000000001', targetName: seedFixture.namedTarget, targetTenant: 'ret001d-named',
      targetResponsibility: seedFixture.namedRankedMarker,
    }),
  ];
}

function seedRecordsFor(
  run: string,
  defaultResponsibility: string,
  namedResponsibility: string,
): Array<{ get(key: string): unknown }> {
  return [
    seedRecord({
      projectId: `ret001d-dp-${run}`, projectName: seedFixture.defaultProject, projectTenant: 'default',
      targetId: `ret001d-dt-${run}`, targetName: seedFixture.defaultTarget, targetTenant: 'default',
      targetResponsibility: defaultResponsibility,
    }),
    seedRecord({
      projectId: `ret001d-np-${run}`, projectName: seedFixture.namedProject, projectTenant: 'ret001d-named',
      targetId: `ret001d-nt-${run}`, targetName: seedFixture.namedTarget, targetTenant: 'ret001d-named',
      targetResponsibility: namedResponsibility,
    }),
  ];
}

function presentationResult(
  id: string,
  task = 'fixture query',
  strategy: 'deterministic' | 'ranked' = 'deterministic',
): unknown {
  return { content: [{ type: 'text', text: [
    '# Unified Context',
    `**Task:** ${task}`,
    `**Strategy:** ${strategy} | **Tokens:** ~1 | **Sources:** arch_entity:1 | **IDs:** 1`,
    '',
    '## Architecture',
    '',
    `<!-- ${id} -->`,
    'seeded presentation',
  ].join('\n') }] };
}

describe('RET-001D live composition harness', () => {
  it.each([
    ['deterministic', 'target-ret001d-default-target-run-000000000001'],
    ['ranked', 'ret001d-dt-run-000000000001'],
    ['auto', 'target-ret001d-default-target-run-000000000001'],
    ['named-tenant-forced-ranked', 'ret001d-nt-run-000000000001'],
  ] as const)('maps %s to its exact seeded presentation ID', (id, expected) => {
    expect(requiredPresentationIdForCase(id, mappingFixture)).toBe(expected);
  });

  it('derives separate bounded alphanumeric ranked markers from the run', () => {
    const markers = rankedFixtureMarkers(seedFixture.run);
    expect(markers).toEqual({
      default: 'ret001ddrun000000000001',
      named: 'ret001dnrun000000000001',
    });
    expect(markers.default).not.toBe(markers.named);
    expect(markers.default).toMatch(/^[a-z0-9]+$/);
    expect(markers.named).toMatch(/^[a-z0-9]+$/);
    expect(markers.default.length).toBeLessThanOrEqual(64);
    expect(markers.named.length).toBeLessThanOrEqual(64);
  });

  it.each([
    ['minimum timestamp', '0-000000000000'],
    ['maximum timestamp', 'abcdefghijk-ffffffffffff'],
  ])('accepts the canonical live run grammar at the %s boundary', (_label, run) => {
    const markers = rankedFixtureMarkers(run);
    expect(markers.default).toMatch(/^[a-z0-9]{1,64}$/);
    expect(markers.named).toMatch(/^[a-z0-9]{1,64}$/);
  });

  it.each([
    'ab',
    'a-b',
    'a-b-c',
    'ab-c',
    '-000000000000',
    '00-000000000000',
    'abcdefghijkl-000000000000',
    'a-00000000000',
    'a-0000000000000',
    'a-00000000000A',
  ])('rejects non-canonical live run %j', (run) => {
    expect(() => rankedFixtureMarkers(run)).toThrow('RET001D_RANKED_MARKER_INVALID');
  });

  it.each([
    ['ab', 'a-b'],
    ['a-b-c', 'ab-c'],
    ['a-bbbbbbbbbbbb', 'ab-bbbbbbbbbbb'],
  ])('never accepts both members of the exact prior compacting collision pair %j / %j', (left, right) => {
    expect(left.replaceAll('-', '')).toBe(right.replaceAll('-', ''));
    const accepted = [left, right].flatMap((run) => {
      try { return [rankedFixtureMarkers(run)]; }
      catch { return []; }
    });
    expect(accepted.length).toBeLessThanOrEqual(1);
  });

  it('is injective across accepted live runs and marker families', () => {
    const runs = [
      '0-000000000000',
      'a-000000000000',
      'a-000000000001',
      'ab-000000000000',
      'abcdefghijk-ffffffffffff',
    ];
    const markers = runs.flatMap((run) => Object.values(rankedFixtureMarkers(run)));
    expect(new Set(markers)).toHaveLength(markers.length);
  });

  it('maps each ranked marker only to its intended target query while preserving deterministic and auto tasks', () => {
    expect(traceFixtureQueries({
      defaultTarget: seedFixture.defaultTarget,
      namedTarget: seedFixture.namedTarget,
      defaultRankedMarker: seedFixture.defaultRankedMarker,
      namedRankedMarker: seedFixture.namedRankedMarker,
    })).toEqual({
      deterministic: seedFixture.defaultTarget,
      ranked: seedFixture.defaultRankedMarker,
      auto: `what depends on ${seedFixture.defaultTarget}`,
      named: seedFixture.namedRankedMarker,
    });
  });

  it.each([
    ['missing default marker', { defaultRankedMarker: '' }],
    ['missing named marker', { namedRankedMarker: '' }],
    ['crossed identical markers', { namedRankedMarker: seedFixture.defaultRankedMarker }],
    ['non-alphanumeric marker', { defaultRankedMarker: 'ret001d-default-marker' }],
    ['oversized marker', { defaultRankedMarker: 'a'.repeat(65) }],
  ])('fails closed for %s', (_label, override) => {
    expect(() => traceFixtureQueries({
      defaultTarget: seedFixture.defaultTarget,
      namedTarget: seedFixture.namedTarget,
      defaultRankedMarker: seedFixture.defaultRankedMarker,
      namedRankedMarker: seedFixture.namedRankedMarker,
      ...override,
    })).toThrow('RET001D_RANKED_MARKER_INVALID');
  });

  it('accepts only the exact two truth-bound seeded containment rows', () => {
    expect(parseSeedReadback(validSeedRecords(), seedFixture)).toEqual(mappingFixture);
    expect(() => parseSeedReadback(validSeedRecords().slice(0, 1), seedFixture))
      .toThrow('RET001D_NEO4J_SEED_READBACK_CARDINALITY');
    expect(() => parseSeedReadback([...validSeedRecords(), validSeedRecords()[0]!], seedFixture))
      .toThrow('RET001D_NEO4J_SEED_READBACK_CARDINALITY');
  });

  it('rejects a same-marker readback even when the caller repeats that marker as expected truth', () => {
    const repeatedMarker = seedFixture.defaultRankedMarker;
    expect(() => parseSeedReadback(
      seedRecordsFor(seedFixture.run, repeatedMarker, repeatedMarker),
      { ...seedFixture, namedRankedMarker: repeatedMarker },
    )).toThrow('RET001D_NEO4J_SEED_READBACK_MISMATCH');
  });

  it.each([
    ['default', 'ret001ddforged000000000001', seedFixture.namedRankedMarker],
    ['named', seedFixture.defaultRankedMarker, 'ret001dnforged000000000001'],
  ])('rejects a caller-supplied %s marker that does not derive from the run', (
    _label, defaultRankedMarker, namedRankedMarker,
  ) => {
    expect(() => parseSeedReadback(
      seedRecordsFor(seedFixture.run, defaultRankedMarker, namedRankedMarker),
      { ...seedFixture, defaultRankedMarker, namedRankedMarker },
    )).toThrow('RET001D_NEO4J_SEED_READBACK_MISMATCH');
  });

  it('rejects run and marker truth copied from different canonical runs', () => {
    const run = 'abc-abcdefabcdef';
    expect(() => parseSeedReadback(
      seedRecordsFor(run, seedFixture.defaultRankedMarker, seedFixture.namedRankedMarker),
      { ...seedFixture, run },
    )).toThrow('RET001D_NEO4J_SEED_READBACK_MISMATCH');
  });

  it.each([
    ['get accessor', () => Object.defineProperty({}, 'get', {
      enumerable: true,
      get() { throw new Error('RET001D_SECRET_FIXTURE'); },
    })],
    ['proxied record', () => new Proxy(seedRecord({}), {
      get() { throw new Error('RET001D_SECRET_FIXTURE'); },
      getOwnPropertyDescriptor() { throw new Error('RET001D_SECRET_FIXTURE'); },
    })],
    ['throwing get invocation', () => ({
      get() { throw new Error('RET001D_SECRET_FIXTURE'); },
    })],
  ] as const)('maps a hostile seed read-back %s to one fixed content-free code', (_label, createRecord) => {
    let error: unknown;
    try { parseSeedReadback([createRecord() as never, validSeedRecords()[1]!], seedFixture); }
    catch (caught) { error = caught; }
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe('RET001D_NEO4J_SEED_READBACK_INVALID');
    expect((error as Error).message).not.toContain('SECRET_FIXTURE');
    expect(safeDiagnosticCode(error)).toBe('RET001D_NEO4J_SEED_READBACK_INVALID');
  });

  it.each([
    ['targetId', 'ret001d-unexpected-target'],
    ['targetName', 'ret001d-unexpected-name'],
    ['projectId', 'ret001d-unexpected-project'],
    ['projectName', 'ret001d-unexpected-project-name'],
    ['targetTenant', 'ret001d-unexpected-tenant'],
    ['projectTenant', 'ret001d-unexpected-tenant'],
    ['targetResponsibility', 'ret001dwrongmarker'],
  ] as const)('rejects a seeded read-back %s mismatch', (field, value) => {
    const records = validSeedRecords();
    const first = {
      projectId: 'ret001d-dp-run-000000000001', projectName: seedFixture.defaultProject, projectTenant: 'default',
      targetId: 'ret001d-dt-run-000000000001', targetName: seedFixture.defaultTarget, targetTenant: 'default',
      targetResponsibility: seedFixture.defaultRankedMarker,
      [field]: value,
    };
    records[0] = seedRecord(first);
    expect(() => parseSeedReadback(records, seedFixture)).toThrow('RET001D_NEO4J_SEED_READBACK_MISMATCH');
  });

  it.each([
    [['target-ret001d-default-target-run-000000000001'], 'expected', 1, 0, 0, 0],
    [['ret001d-dt-run-000000000001'], 'alternate', 0, 1, 0, 0],
    [['ret001d-dp-run-000000000001', 'target-ret001d-default-project-run-000000000001'], 'project-only', 0, 0, 2, 0],
    [['unrelated-result'], 'none', 0, 0, 0, 1],
  ] as const)('classifies seeded presentation evidence without returning identifiers: %j', (
    resultIds, classification, expectedCount, alternateCount, projectCount, otherCount,
  ) => {
    expect(classifySeededPresentation('deterministic', mappingFixture, resultIds)).toEqual({
      classification, expectedCount, alternateCount, projectCount, otherCount, totalCount: resultIds.length,
    });
  });

  it('bounds seeded-missing diagnostic counts', () => {
    expect(() => classifySeededPresentation(
      'deterministic', mappingFixture, Array.from({ length: 513 }, (_, index) => `id-${index}`),
    )).toThrow('RET001D_SEEDED_DIAGNOSTIC_BOUND');
  });

  it('reports alternate seeded presentation evidence using only bounded counts', () => {
    const secret = 'RET001D-secret-result-id';
    const observed = classifySeededPresentation('deterministic', mappingFixture, [
      mappingFixture.default.targetId,
      secret,
    ]);
    const code = seededMissingDiagnosticCode('deterministic', observed);
    expect(code).toBe(
      'RET001D_CASE_DETERMINISTIC_STAGE_ORDINARY_PRESENTATION_SEEDED_ALTERNATE_E0_A1_P0_O1_T2',
    );
    expect(code).not.toContain(secret);
    expect(code).not.toContain(mappingFixture.default.targetId);
    expect(safeDiagnosticCode(new Error(code))).toBe(code);
  });

  it.each([
    ['missing key', {
      classification: 'none', expectedCount: 0, alternateCount: 0, projectCount: 0, totalCount: 0,
    }],
    ['extra key', {
      classification: 'none', expectedCount: 0, alternateCount: 0, projectCount: 0, otherCount: 0, totalCount: 0,
      secret: 'RET001D_SECRET_FIXTURE',
    }],
    ['invalid classification', {
      classification: 'RET001D_SECRET_FIXTURE', expectedCount: 0, alternateCount: 0,
      projectCount: 0, otherCount: 0, totalCount: 0,
    }],
    ['non-integer count', {
      classification: 'none', expectedCount: 0.5, alternateCount: 0, projectCount: 0, otherCount: 0, totalCount: 0.5,
    }],
    ['negative count', {
      classification: 'none', expectedCount: 0, alternateCount: 0, projectCount: 0, otherCount: -1, totalCount: -1,
    }],
    ['oversized count', {
      classification: 'none', expectedCount: 0, alternateCount: 0, projectCount: 0, otherCount: 513, totalCount: 513,
    }],
    ['inconsistent sum', {
      classification: 'none', expectedCount: 0, alternateCount: 0, projectCount: 0, otherCount: 1, totalCount: 0,
    }],
    ['inconsistent expected class', {
      classification: 'alternate', expectedCount: 1, alternateCount: 1, projectCount: 0, otherCount: 0, totalCount: 2,
    }],
    ['inconsistent alternate class', {
      classification: 'project-only', expectedCount: 0, alternateCount: 1, projectCount: 1, otherCount: 0, totalCount: 2,
    }],
    ['inconsistent project class', {
      classification: 'none', expectedCount: 0, alternateCount: 0, projectCount: 1, otherCount: 0, totalCount: 1,
    }],
  ] as const)('rejects forged seeded diagnostic evidence: %s', (_label, forged) => {
    let error: unknown;
    try { seededMissingDiagnosticCode('deterministic', forged as never); }
    catch (caught) { error = caught; }
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe('RET001D_SEEDED_DIAGNOSTIC_INVALID');
    expect((error as Error).message).not.toContain('SECRET_FIXTURE');
    expect(safeDiagnosticCode(error)).toBe('RET001D_SEEDED_DIAGNOSTIC_INVALID');
  });

  it('rejects proxied seeded diagnostic evidence without invoking its traps', () => {
    const forged = new Proxy({
      classification: 'none', expectedCount: 0, alternateCount: 0,
      projectCount: 0, otherCount: 0, totalCount: 0,
    }, {
      ownKeys() { throw new Error('RET001D_SECRET_FIXTURE'); },
      get() { throw new Error('RET001D_SECRET_FIXTURE'); },
    });
    expect(() => seededMissingDiagnosticCode('deterministic', forged as never))
      .toThrow('RET001D_SEEDED_DIAGNOSTIC_INVALID');
  });

  it.each([
    ['case', 'RET001D_SECRET_FIXTURE', 'ordinary-call'],
    ['stage', 'deterministic', 'RET001D_SECRET_FIXTURE'],
  ] as const)('rejects an invalid diagnostic %s using one fixed code', (_label, id, stage) => {
    let error: unknown;
    try { caseStageDiagnosticCode(id as never, stage as never, new Error('RET001D_SECRET_FIXTURE')); }
    catch (caught) { error = caught; }
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe('RET001D_CASE_STAGE_DIAGNOSTIC_INVALID');
    expect((error as Error).message).not.toContain('SECRET_FIXTURE');
    expect(safeDiagnosticCode(error)).toBe('RET001D_CASE_STAGE_DIAGNOSTIC_INVALID');
  });

  it.each([
    'ordinary-call',
    'ordinary-presentation',
    'ordinary-inspection',
    'false-call',
    'false-inspection',
    'traced-call',
    'traced-inspection',
    'false-parity',
    'traced-parity',
    'tenant-isolation',
  ] as const)('emits a closed content-free diagnostic for every case at stage %s', (stage) => {
    const secret = 'RET001D secret fixture/query body';
    for (const id of ['deterministic', 'ranked', 'auto', 'named-tenant-forced-ranked'] as const) {
      const code = caseStageDiagnosticCode(id, stage, new Error(secret));
      expect(code).toMatch(/^RET001D_CASE_[A-Z0-9_]+_STAGE_[A-Z0-9_]+$/);
      expect(code).not.toContain(secret);
      expect(safeDiagnosticCode(new Error(code))).toBe(code);
    }
  });

  it('rejects cross-algorithm presentation-ID substitution', () => {
    const deterministicId = requiredPresentationIdForCase('deterministic', mappingFixture);
    const rankedId = requiredPresentationIdForCase('ranked', mappingFixture);
    expect(deterministicId).not.toBe(rankedId);
    expect(() => observeOrderedMarkdownResultIds(presentationResult(deterministicId), {
      expectedTask: 'fixture query', expectedStrategy: 'deterministic', requiredResultIds: [rankedId],
    })).toThrow('RET001D_SEEDED_RESULT_MISSING');
  });

  it('fails closed when the seeded presentation ID is missing', () => {
    const required = requiredPresentationIdForCase('deterministic', mappingFixture);
    expect(() => observeOrderedMarkdownResultIds(presentationResult('unrelated-result'), {
      expectedTask: 'fixture query', expectedStrategy: 'deterministic', requiredResultIds: [required],
    })).toThrow('RET001D_SEEDED_RESULT_MISSING');
  });

  it('is loopback/disposable fail-closed and exposes only sanitized config', () => {
    const config = resolveTraceConformanceConfig(validEnv);
    expect(config.safeConfig).toEqual({
      host: '127.0.0.1',
      port: 3411,
      transport: 'streamable-http-mcp',
      requestTimeoutMs: 10_000,
      startupTimeoutMs: 300_000,
      responseByteLimit: 4_194_304,
    });
    expect(() => resolveTraceConformanceConfig({ ...validEnv, MEMBERRY_TRACE_LIVE_DISPOSABLE: 'false' }))
      .toThrow('RET-001D live evidence is fail-closed');
    expect(() => resolveTraceConformanceConfig({ ...validEnv, MEMBERRY_TRACE_LIVE_MCP_URL: 'http://192.168.0.25:3411' }))
      .toThrow(/loopback/);
    expect(() => resolveTraceConformanceConfig({ ...validEnv, MEMBERRY_TRACE_LIVE_REDIS_IMAGE_ID: 'redis:7-alpine' }))
      .toThrow(/exact immutable identity/);
    expect(JSON.stringify(config.safeConfig)).not.toContain(config.defaultToken);
    expect(JSON.stringify(config.safeConfig)).not.toContain(config.namedToken);
    expect(JSON.stringify(config.safeConfig)).not.toContain(config.neo4jPassword);
  });

  it('starts the real composition root with a narrow child environment', () => {
    expect(compositionRootCommand()).toEqual({
      executable: process.execPath,
      args: ['--import', 'tsx', 'packages/mcp/src/server.ts'],
    });
    const config = resolveTraceConformanceConfig(validEnv);
    const env = childEnvironment(config, 'single-default', 'C:\\fixture\\export');
    expect(env).toMatchObject({
      NODE_ENV: 'test',
      PORT: '3411',
      MCP_PORT: '3411',
      MEMBERRY_HOST: '127.0.0.1',
      MEMBERRY_API_TOKEN: 'default-trace-token',
      MEMBERRY_CONSOLIDATION_ENABLED: 'false',
      MEMBERRY_WIKI_AUTOREFRESH: 'false',
      OPENAI_API_KEY: '',
    });
    expect(env.MEMBERRY_TENANT_TOKENS).toBeUndefined();
    const named = childEnvironment(config, 'named-tenant', 'C:\\fixture\\export');
    expect(named.MEMBERRY_API_TOKEN).toBeUndefined();
    expect(named.MEMBERRY_TENANT_TOKENS).toBe(`ret001d-named:${config.namedToken}`);
  });

  it('bounds streamed bodies before retaining oversized evidence', async () => {
    const cancel = vi.fn();
    const response = new Response(new ReadableStream({ cancel }), { headers: { 'content-length': '33' } });
    await expect(readBoundedResponseText(response, 32)).rejects.toThrow('RET001D_HTTP_BODY_TOO_LARGE');
    expect(cancel).toHaveBeenCalledOnce();
  });

  it.each([
    ['mismatched id', { jsonrpc: '2.0', id: 999 }],
    ['wrong jsonrpc version', { jsonrpc: '1.0', id: 1 }],
  ])('rejects an initialize response with %s', async (_label, correlation) => {
    const config = resolveTraceConformanceConfig(validEnv);
    const fetchImpl = vi.fn(async (_input: URL | RequestInfo, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body)) as { id?: number; method: string };
      if (request.method === 'notifications/initialized') return new Response(null, { status: 202 });
      const result = request.method === 'initialize'
        ? { protocolVersion: '2025-03-26' }
        : { content: [{ type: 'text', text: 'ok' }] };
      return new Response(JSON.stringify({ ...correlation, result }), {
        headers: { 'content-type': 'application/json', 'mcp-session-id': 'session-1' },
      });
    }) as unknown as typeof fetch;
    await expect(new TraceMcpTransport(config, config.defaultToken, fetchImpl).call('berry_tools', { action: 'list' }))
      .rejects.toThrow('RET001D_MCP_CORRELATION_INVALID');
  });

  it('correlates the tool response itself, not only initialization', async () => {
    const config = resolveTraceConformanceConfig(validEnv);
    const fetchImpl = vi.fn(async (_input: URL | RequestInfo, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body)) as { id?: number; method: string };
      if (request.method === 'notifications/initialized') return new Response(null, { status: 202 });
      const result = request.method === 'initialize'
        ? { protocolVersion: '2025-03-26' }
        : { content: [{ type: 'text', text: 'ok' }] };
      return new Response(JSON.stringify({
        jsonrpc: '2.0', id: request.method === 'tools/call' ? Number(request.id) + 1 : request.id, result,
      }), { headers: { 'content-type': 'application/json', 'mcp-session-id': 'session-1' } });
    }) as unknown as typeof fetch;
    await expect(new TraceMcpTransport(config, config.defaultToken, fetchImpl).call('berry_tools', { action: 'list' }))
      .rejects.toThrow('RET001D_MCP_CORRELATION_INVALID');
  });

  it('keeps the request timeout active through a bounded streaming body read', async () => {
    vi.useFakeTimers();
    try {
      const config = resolveTraceConformanceConfig({
        ...validEnv, MEMBERRY_TRACE_LIVE_REQUEST_TIMEOUT_MS: '100',
      });
      let calls = 0;
      const fetchImpl = vi.fn(async () => {
        calls += 1;
        if (calls > 1) return new Response(null, { status: 202 });
        const body = new ReadableStream<Uint8Array>({
          start(value) {
            value.enqueue(new TextEncoder().encode('{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2025-03-26"}}'));
          },
        });
        return new Response(body, {
          headers: { 'content-type': 'application/json', 'mcp-session-id': 'session-1' },
        });
      }) as unknown as typeof fetch;
      const pending = new TraceMcpTransport(config, config.defaultToken, fetchImpl)
        .call('berry_tools', { action: 'list' });
      const outcome = pending.then(() => 'resolved', (error: Error) => error.message);
      await vi.advanceTimersByTimeAsync(200);
      expect(await outcome).toBe('RET001D_MCP_TIMEOUT');
      await pending.catch(() => undefined);
    } finally {
      vi.useRealTimers();
    }
  });

  it('aborts and drains a timed mutation so it cannot fire after cleanup or recount', async () => {
    vi.useFakeTimers();
    try {
      let delayedMutations = 0;
      let cleanupCompleted = false;
      let mutationAfterCleanup = false;
      const pending = runAbortableOperation(
        (signal) => new Promise<void>((resolvePromise, rejectPromise) => {
          const delayed = setTimeout(() => {
            delayedMutations += 1;
            mutationAfterCleanup ||= cleanupCompleted;
            resolvePromise();
          }, 250);
          signal.addEventListener('abort', () => {
            clearTimeout(delayed);
            rejectPromise(new Error('aborted-and-drained'));
          }, { once: true });
        }),
        100,
        'RET001D_NEO4J_PREFLIGHT_TIMEOUT',
        'RET001D_NEO4J_PREFLIGHT_FAILED',
      );
      const rejection = expect(pending).rejects.toThrow('RET001D_NEO4J_PREFLIGHT_TIMEOUT');
      await vi.advanceTimersByTimeAsync(101);
      await rejection;
      cleanupCompleted = true;
      await vi.advanceTimersByTimeAsync(500);
      expect(delayedMutations).toBe(0);
      expect(mutationAfterCleanup).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('builds explicit cross-tenant and decoy forbidden sets for every live case', () => {
    const fixture = {
      run: 'run-000000000001',
      defaultContent: 'default-content',
      namedContent: 'named-content',
      decoyContent: 'decoy-content',
      defaultRankedMarker: seedFixture.defaultRankedMarker,
      namedRankedMarker: seedFixture.namedRankedMarker,
    };
    expect(tenantIsolationForbiddenValues('default', fixture)).toEqual(expect.arrayContaining([
      'ret001d-np-run-000000000001', 'ret001d-nt-run-000000000001',
      'ret001d-ns-run-000000000001', 'named-content',
      seedFixture.namedRankedMarker, 'ret001d-decoy-run-000000000001', 'decoy-content',
    ]));
    expect(tenantIsolationForbiddenValues('named-tenant', fixture)).toEqual(expect.arrayContaining([
      'ret001d-dp-run-000000000001', 'ret001d-dt-run-000000000001',
      'ret001d-dd-run-000000000001', 'ret001d-da-run-000000000001',
      'ret001d-ds-run-000000000001', 'default-content', seedFixture.defaultRankedMarker,
      'ret001d-decoy-run-000000000001', 'decoy-content',
    ]));
  });

  it('fails strict seed and isolation checks for missing or cross-tenant ranked markers', () => {
    const queries = traceFixtureQueries({
      defaultTarget: seedFixture.defaultTarget,
      namedTarget: seedFixture.namedTarget,
      defaultRankedMarker: seedFixture.defaultRankedMarker,
      namedRankedMarker: seedFixture.namedRankedMarker,
    });
    expect(() => observeOrderedMarkdownResultIds(presentationResult('unrelated-result', queries.ranked, 'ranked'), {
      expectedTask: queries.ranked, expectedStrategy: 'ranked',
      requiredResultIds: [mappingFixture.default.targetId],
    })).toThrow('RET001D_SEEDED_RESULT_MISSING');
    expect(tenantIsolationForbiddenValues('default', {
      run: seedFixture.run, defaultContent: 'default-content', namedContent: 'named-content',
      decoyContent: 'decoy-content', defaultRankedMarker: seedFixture.defaultRankedMarker,
      namedRankedMarker: seedFixture.namedRankedMarker,
    })).toContain(seedFixture.namedRankedMarker);
  });

  it('places both ranked markers in trace and artifact forbidden values', () => {
    const queries = traceFixtureQueries({
      defaultTarget: seedFixture.defaultTarget,
      namedTarget: seedFixture.namedTarget,
      defaultRankedMarker: seedFixture.defaultRankedMarker,
      namedRankedMarker: seedFixture.namedRankedMarker,
    });
    const forbidden = traceFixtureForbiddenValues(['token-a', 'token-b'], {
      defaultContent: 'default-content', namedContent: 'named-content', decoyContent: 'decoy-content',
      defaultRankedMarker: seedFixture.defaultRankedMarker, namedRankedMarker: seedFixture.namedRankedMarker,
    }, queries);
    expect(forbidden).toEqual(expect.arrayContaining([
      seedFixture.defaultRankedMarker, seedFixture.namedRankedMarker,
    ]));
    const evidence = JSON.stringify({ packet: 'RET-001D', cases: [{ id: 'ranked', trace: { candidateCount: 1 } }] });
    expect(forbidden.some((value) => evidence.includes(value))).toBe(false);
  });

  it('requires an explicit single residual row and never defaults missing Neo4j evidence to clean', () => {
    expect(() => parseResidualCounts([])).toThrow('RET001D_NEO4J_RESIDUAL_INVALID');
    expect(() => parseResidualCounts([{ get: () => undefined }])).toThrow('RET001D_NEO4J_RESIDUAL_INVALID');
    expect(parseResidualCounts([{ get: (key: string) => key === 'nodes' ? 0 : 0 }])).toEqual({
      nodes: 0, relationships: 0,
    });
  });

  it('deletes only exact declared Redis ownership keys and reports concurrent foreign keys', async () => {
    const ownedKey = 'memberry:lab:ret001d:test-run:ownership';
    const keys = new Set(['baseline', ownedKey, 'concurrent:foreign']);
    const deleted: string[] = [];
    const redis = {
      scan: vi.fn(async () => ['0', [...keys]]),
      del: vi.fn(async (...values: string[]) => {
        deleted.push(...values);
        for (const value of values) keys.delete(value);
        return values.length;
      }),
    };
    await expect(cleanupOwnedRedisKeys(
      redis as never,
      new Set(['baseline']),
      [ownedKey],
      1_000,
    )).resolves.toEqual({ ownedRemaining: 0, unexpectedNewKeys: 1 });
    expect(deleted).toEqual([ownedKey]);
    expect(keys.has('concurrent:foreign')).toBe(true);
  });

  it('reduces arbitrary fixture/query failures to closed content-free diagnostics', () => {
    const fixture = 'RET001D secret fixture/query body';
    expect(safeDiagnosticCode(new Error(fixture))).toBe('RET001D_INTERNAL_FAILURE');
    expect(safeDiagnosticCode(new Error('RET001D_MCP_TIMEOUT'))).toBe('RET001D_MCP_TIMEOUT');
    expect(safeDiagnosticCode(new AggregateError([new Error(fixture)], fixture))).not.toContain(fixture);
  });

  it.each([
    ['message accessor', () => Object.defineProperty(Object.create(Error.prototype), 'message', {
      get() { throw new Error('RET001D_SECRET_FIXTURE'); },
    })],
    ['error proxy', () => new Proxy(new Error('RET001D_MCP_TIMEOUT'), {
      get() { throw new Error('RET001D_SECRET_FIXTURE'); },
      getOwnPropertyDescriptor() { throw new Error('RET001D_SECRET_FIXTURE'); },
    })],
    ['revoked error proxy', () => {
      const pair = Proxy.revocable(new Error('RET001D_MCP_TIMEOUT'), {});
      pair.revoke();
      return pair.proxy;
    }],
  ] as const)('never throws or reflects a hostile diagnostic %s', (_label, createError) => {
    let code: string | undefined;
    expect(() => { code = safeDiagnosticCode(createError()); }).not.toThrow();
    expect(code).toBe('RET001D_INTERNAL_FAILURE');
    expect(code).not.toContain('SECRET_FIXTURE');
  });

  it.each([
    'RET001D_SECRET_FIXTURE',
    `RET001D_${'A'.repeat(300)}`,
    'RET001D_MCP_HTTP_99',
    'RET001D_MCP_HTTP_600',
    'RET001D_MCP_HTTP_4O4',
    'RET001D_CASE_UNKNOWN_STAGE_ORDINARY_CALL',
    'RET001D_CASE_DETERMINISTIC_STAGE_UNKNOWN',
    'RET001D_CASE_DETERMINISTIC_STAGE_ORDINARY_CALL_SEEDED_NONE_E0_A0_P0_O0_T0',
    'RET001D_CASE_DETERMINISTIC_STAGE_ORDINARY_PRESENTATION_SEEDED_UNKNOWN_E0_A0_P0_O0_T0',
    'RET001D_CASE_DETERMINISTIC_STAGE_ORDINARY_PRESENTATION_SEEDED_NONE_E0_A0_P0_O513_T513',
    'RET001D_CASE_DETERMINISTIC_STAGE_ORDINARY_PRESENTATION_SEEDED_NONE_E0_A0_P0_O1_T0',
    'RET001D_READINESS_TIMEOUT__RET001D_SECRET_FIXTURE',
  ])('rejects unknown or malformed diagnostic code %s', (code) => {
    expect(safeDiagnosticCode(new Error(code))).toBe('RET001D_INTERNAL_FAILURE');
  });

  it.each([
    'RET001D_CASE_STAGE_DIAGNOSTIC_INVALID',
    'RET001D_CLEANUP_OR_CASE_COUNT_INVALID',
    'RET001D_COMPOSITION_ROOT_EXITED',
    'RET001D_COMPOSITION_ROOT_STOP_TIMEOUT',
    'RET001D_EVIDENCE_FAILED',
    'RET001D_EVIDENCE_WRITE_FAILED',
    'RET001D_EVIDENCE_WRITE_TIMEOUT',
    'RET001D_FALSE_PARITY_MISMATCH',
    'RET001D_GIT_DIRTY',
    'RET001D_GIT_STATE_FAILED',
    'RET001D_HTTP_BODY_ABORTED',
    'RET001D_HTTP_BODY_READ_FAILED',
    'RET001D_HTTP_BODY_TOO_LARGE',
    'RET001D_INTERNAL_FAILURE',
    'RET001D_MANIFEST_FORBIDDEN_VALUE',
    'RET001D_MCP_CORRELATION_INVALID',
    'RET001D_MCP_ENVELOPE_INVALID',
    'RET001D_MCP_INITIALIZE_INVALID',
    'RET001D_MCP_NETWORK',
    'RET001D_MCP_RPC_ERROR',
    'RET001D_MCP_TIMEOUT',
    'RET001D_MCP_TOOL_RESPONSE_INVALID',
    'RET001D_NEO4J_CLEANUP_FAILED',
    'RET001D_NEO4J_CLOSE_FAILED',
    'RET001D_NEO4J_PREFLIGHT_FAILED',
    'RET001D_NEO4J_RESIDUAL_INVALID',
    'RET001D_NEO4J_RESIDUAL_QUERY_FAILED',
    'RET001D_NEO4J_SEED_FAILED',
    'RET001D_NEO4J_SEED_READBACK_CARDINALITY',
    'RET001D_NEO4J_SEED_READBACK_FAILED',
    'RET001D_NEO4J_SEED_READBACK_INVALID',
    'RET001D_NEO4J_SEED_READBACK_MISMATCH',
    'RET001D_NEO4J_SESSION_CLOSE_FAILED',
    'RET001D_NEO4J_VERSION_FAILED',
    'RET001D_NEO4J_VERSION_INVALID',
    'RET001D_READINESS_INVALID',
    'RET001D_READINESS_NETWORK',
    'RET001D_READINESS_TIMEOUT__RET001D_READINESS_NETWORK',
    'RET001D_READINESS_UNKNOWN',
    'RET001D_RANKED_MARKER_INVALID',
    'RET001D_REDIS_CLEANUP_FAILED',
    'RET001D_REDIS_KEY_BOUND',
    'RET001D_REDIS_OWNERSHIP_FAILED',
    'RET001D_REDIS_OWNERSHIP_INVALID',
    'RET001D_REDIS_PREFLIGHT_FAILED',
    'RET001D_REDIS_SCAN_FAILED',
    'RET001D_REDIS_VERSION_FAILED',
    'RET001D_REDIS_VERSION_INVALID',
    'RET001D_SEEDED_DIAGNOSTIC_BOUND',
    'RET001D_SEEDED_DIAGNOSTIC_INVALID',
    'RET001D_SEEDED_RESULT_MISSING',
    'RET001D_SERVICE_IDENTITY_MISSING',
    'RET001D_TEMP_CREATE_FAILED',
    'RET001D_TENANT_ISOLATION_FAILURE',
    'RET001D_TRACE_BLOCK_COUNT',
    'RET001D_TRACED_PARITY_MISMATCH',
  ])('accepts legitimate static runner diagnostic %s', (code) => {
    expect(safeDiagnosticCode(new Error(code))).toBe(code);
  });

  it.each(['100', '200', '404', '599'])('accepts bounded MCP HTTP diagnostic %s', (status) => {
    const code = `RET001D_MCP_HTTP_${status}`;
    expect(safeDiagnosticCode(new Error(code))).toBe(code);
  });

  it.each([
    ['expected', 1, 0, 0, 511, 512],
    ['alternate', 0, 1, 0, 511, 512],
    ['project-only', 0, 0, 1, 511, 512],
    ['none', 0, 0, 0, 512, 512],
  ] as const)('accepts legitimate seeded dynamic family %s', (
    classification, expectedCount, alternateCount, projectCount, otherCount, totalCount,
  ) => {
    const code = seededMissingDiagnosticCode('named-tenant-forced-ranked', {
      classification, expectedCount, alternateCount, projectCount, otherCount, totalCount,
    });
    expect(safeDiagnosticCode(new Error(code))).toBe(code);
  });

  it('times out readiness deterministically and never retries structural failures', async () => {
    let now = 0;
    const sleep = vi.fn(async () => { now += 250; });
    await expect(waitForTraceReadiness(
      async () => { throw new Error('RET001D_READINESS_NETWORK'); },
      500,
      { now: () => now, sleep },
    )).rejects.toThrow('RET001D_READINESS_TIMEOUT__RET001D_READINESS_NETWORK');
    expect(sleep).toHaveBeenCalledTimes(2);
    await expect(waitForTraceReadiness(
      async () => { throw new Error('RET001D_READINESS_INVALID'); },
      500,
      { now: () => 0, sleep },
    )).rejects.toThrow('RET001D_READINESS_INVALID');
  });

  it('accepts only the exact named-tenant degradation class, never an arbitrary 503', () => {
    const limitation = 'shared logical multi-tenant consolidation and wiki publication are disabled to prevent cross-tenant disclosure';
    const body = {
      status: 'ready',
      service: 'memberry-mcp',
      transport: 'sse',
      active_sessions: 0,
      registered_sessions: 0,
      auth_required: true,
      uptime_ms: 12,
      admission_shadow: {},
      consolidation_automation: {
        enabled: false,
        unhealthy: true,
        degraded: true,
        limitations: [`default: ${limitation}; provider unavailable`],
        workers: [{ name: 'default', enabled: false, health: 'unhealthy', limitation }],
      },
    };
    expect(classifyTraceReadiness(503, body, 'named-tenant')).toEqual({
      status: 503,
      classification: 'expected-logical-multitenant-degraded',
    });
    expect(() => classifyTraceReadiness(503, { status: 'unhealthy' }, 'named-tenant'))
      .toThrow('RET001D_READINESS_INVALID');
    expect(() => classifyTraceReadiness(200, body, 'named-tenant'))
      .toThrow('RET001D_READINESS_INVALID');
  });

  it('wires the trace runner into package scripts, CI, and a fixed live registry entry', async () => {
    const [pkg, workflow, systems, validator] = await Promise.all([
      readFile(fileURLToPath(new URL('../../../../package.json', import.meta.url)), 'utf8'),
      readFile(fileURLToPath(new URL('../../../../.github/workflows/ci.yml', import.meta.url)), 'utf8'),
      readFile(fileURLToPath(new URL('../../registry/systems.json', import.meta.url)), 'utf8'),
      readFile(fileURLToPath(new URL('../../registry/validate.ts', import.meta.url)), 'utf8'),
    ]);
    expect(pkg).toContain('"bench:lab:retrieval-trace:live"');
    expect(workflow).toContain('Retrieval trace live conformance evidence');
    expect(workflow).toContain('memberry-retrieval-trace-live-conformance-');
    expect(workflow).toContain('Capture exact service container identities');
    expect(workflow).toContain("docker inspect --format='{{.Image}}'");
    expect(workflow).toContain('MEMBERRY_TRACE_LIVE_REDIS_IMAGE_ID');
    expect(workflow).toContain('MEMBERRY_TRACE_LIVE_NEO4J_IMAGE_ID');
    expect(systems).toContain('memberry-retrieval-trace-live-conformance-v1');
    expect(validator).toContain("system.contract === 'retrieval-trace-live-conformance-v1'");
  });

  it('binds ranked fixture markers to the actual architecture fulltext index fields, never entity name', async () => {
    const schema = await readFile(
      fileURLToPath(new URL('../../../../packages/arch/src/schema.ts', import.meta.url)), 'utf8',
    );
    expect(schema).toContain(
      "ON EACH [e.responsibility, e.interface_desc, e.internals]",
    );
    expect(schema).not.toMatch(/entity_arch_content[^\n]+e\.name/);
  });

  it('rejects relabeled or redirected trace conformance registrations', async () => {
    const registry = JSON.parse(await readFile(
      fileURLToPath(new URL('../../registry/systems.json', import.meta.url)), 'utf8',
    )) as { systems: Array<Record<string, unknown>> };
    const system = registry.systems.find(({ id }) => id === 'memberry-retrieval-trace-live-conformance-v1')!;
    system.mode = 'fixture';
    system.fidelityDetail = 'production-core / fixture-persistence';
    system.adapter = 'bench/lab/adapters/memberry-live.ts';
    const errors = validateSystemRegistry(registry);
    expect(errors.some((error) => error.includes('must use live fidelity'))).toBe(true);
    expect(errors.some((error) => error.includes('composition-root / live-disposable-persistence'))).toBe(true);
    expect(errors.some((error) => error.includes('adapter path is fixed'))).toBe(true);
  });
});
