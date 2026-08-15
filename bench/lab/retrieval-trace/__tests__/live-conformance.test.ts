import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { describe, expect, it, vi } from 'vitest';

import {
  childEnvironment,
  classifyTraceReadiness,
  cleanupOwnedRedisKeys,
  compositionRootCommand,
  parseResidualCounts,
  readBoundedResponseText,
  resolveTraceConformanceConfig,
  runAbortableOperation,
  safeDiagnosticCode,
  tenantIsolationForbiddenValues,
  TraceMcpTransport,
  waitForTraceReadiness,
} from '../live-conformance.js';
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

describe('RET-001D live composition harness', () => {
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
      run: 'run-1',
      defaultContent: 'default-content',
      namedContent: 'named-content',
      decoyContent: 'decoy-content',
    };
    expect(tenantIsolationForbiddenValues('default', fixture)).toEqual(expect.arrayContaining([
      'ret001d-np-run-1', 'ret001d-nt-run-1', 'ret001d-ns-run-1', 'named-content',
      'ret001d-decoy-run-1', 'decoy-content',
    ]));
    expect(tenantIsolationForbiddenValues('named-tenant', fixture)).toEqual(expect.arrayContaining([
      'ret001d-dp-run-1', 'ret001d-dt-run-1', 'ret001d-dd-run-1', 'ret001d-da-run-1',
      'ret001d-ds-run-1', 'default-content', 'ret001d-decoy-run-1', 'decoy-content',
    ]));
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
