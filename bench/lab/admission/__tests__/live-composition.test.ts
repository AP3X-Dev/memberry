import { describe, expect, it } from 'vitest';
import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import {
  assertContentFreeObservation,
  assertReadinessContract,
  acquireAdmissionLiveResources,
  childEnvironment,
  resolveAdmissionLiveConfig,
  runBoundedCleanupSteps,
  sanitizeAdmissionEvidence,
  stopChildProcessBounded,
} from '../live-composition.js';

const readiness = (enabled: boolean) => ({
  status: 'ready',
  admission_shadow: {
    schema_version: 1,
    enabled,
    mode: enabled ? 'shadow' : 'disabled',
    health: enabled ? 'healthy' : 'disabled',
    affects_readiness: false,
    delivery: 'best-effort-bounded-terminal',
    recovery: 'none',
    completeness: 'not-provable',
    durable_retry: false,
    self_healing: false,
    history_complete: false,
    history_scope: 'process-lifetime',
    crash_gap_possible: enabled,
    stopping: false,
    last_failure_code: null,
    registered_runtimes: 1,
    timeout_ms: [50],
    max_in_flight: 32,
    counters: {
      prepared: 0,
      preparation_failures: 0,
      append_attempts: 0,
      appended: 0,
      append_failures: 0,
      timed_out: 0,
      capacity_rejected: 0,
      shutdown_skipped: 0,
      late_appended: 0,
      late_failures: 0,
      reserved: 0,
      in_flight: 0,
    },
  },
});

describe('MEM-001D2 live composition evidence contract', () => {
  it('fails closed unless writes are explicitly disposable and every endpoint is loopback-only', () => {
    const valid = {
      MEMBERRY_ADMISSION_LIVE_ALLOW_WRITES: 'true',
      MEMBERRY_ADMISSION_LIVE_DISPOSABLE: 'true',
      MEMBERRY_ADMISSION_LIVE_API_TOKEN: 'fixture-token',
      MEMBERRY_ADMISSION_LIVE_MCP_URL: 'http://127.0.0.1:3311',
      MEMBERRY_ADMISSION_LIVE_REDIS_URL: 'redis://127.0.0.1:6379',
      MEMBERRY_ADMISSION_LIVE_NEO4J_URI: 'bolt://127.0.0.1:7687',
      MEMBERRY_ADMISSION_LIVE_NEO4J_USER: 'neo4j',
      MEMBERRY_ADMISSION_LIVE_NEO4J_PASSWORD: 'fixture-password',
    };
    expect(() => resolveAdmissionLiveConfig({ ...valid, MEMBERRY_ADMISSION_LIVE_ALLOW_WRITES: 'false' }))
      .toThrow(/ALLOW_WRITES=true/);
    expect(() => resolveAdmissionLiveConfig({ ...valid, MEMBERRY_ADMISSION_LIVE_DISPOSABLE: 'false' }))
      .toThrow(/DISPOSABLE=true/);
    expect(() => resolveAdmissionLiveConfig({ ...valid, MEMBERRY_ADMISSION_LIVE_NEO4J_URI: 'bolt:\/\/192.168.0.25:7687' }))
      .toThrow(/loopback/);
    const unsafeUrls: Array<[keyof typeof valid, string]> = [
      ['MEMBERRY_ADMISSION_LIVE_MCP_URL', 'http://127.0.0.1:3311/?token=topsecret'],
      ['MEMBERRY_ADMISSION_LIVE_REDIS_URL', 'redis://127.0.0.1:6379/#topsecret'],
      ['MEMBERRY_ADMISSION_LIVE_NEO4J_URI', 'bolt://user%3Asecret@127.0.0.1:7687'],
      ['MEMBERRY_ADMISSION_LIVE_MCP_URL', 'http://%31%32%37.0.0.1:3311'],
      ['MEMBERRY_ADMISSION_LIVE_MCP_URL', 'http://127.0.0.2:3311'],
      ['MEMBERRY_ADMISSION_LIVE_REDIS_URL', 'redis://localhost.evil.invalid:6379'],
      ['MEMBERRY_ADMISSION_LIVE_NEO4J_URI', 'bolt://[::ffff:127.0.0.1]:7687'],
      ['MEMBERRY_ADMISSION_LIVE_MCP_URL', 'http://127.0.0.1:3311/plain-path-secret'],
      ['MEMBERRY_ADMISSION_LIVE_REDIS_URL', 'redis://127.0.0.1:6379/plain-path-secret'],
      ['MEMBERRY_ADMISSION_LIVE_NEO4J_URI', 'bolt://127.0.0.1:7687/plain-path-secret'],
    ];
    for (const [name, url] of unsafeUrls) {
      let message = '';
      try { resolveAdmissionLiveConfig({ ...valid, [name]: url }); }
      catch (error) { message = error instanceof Error ? error.message : String(error); }
      expect(message, `${name} ${url}`).not.toBe('');
      expect(message, `${name} ${url}`).not.toContain('topsecret');
      expect(message, `${name} ${url}`).not.toContain('user:secret');
      expect(message, `${name} ${url}`).not.toContain('plain-path-secret');
    }

    expect(resolveAdmissionLiveConfig({
      ...valid,
      MEMBERRY_ADMISSION_LIVE_MCP_URL: 'http://localhost:3311',
      MEMBERRY_ADMISSION_LIVE_REDIS_URL: 'redis://[::1]:6379',
      MEMBERRY_ADMISSION_LIVE_NEO4J_URI: 'bolt://localhost:7687',
    }).host).toBe('localhost');

    const config = resolveAdmissionLiveConfig(valid);
    expect(config.safeConfig).toEqual({
      mcpUrl: 'http://127.0.0.1:3311',
      redisUrl: 'redis://127.0.0.1:6379',
      neo4jUri: 'bolt://127.0.0.1:7687',
      host: '127.0.0.1',
      port: 3311,
      timeoutMs: 50,
      startupTimeoutMs: 120000,
      writeAuthorization: 'explicit-disposable-only',
      modes: ['default-off', 'shadow-enabled'],
    });
    expect(JSON.stringify(config.safeConfig)).not.toContain('fixture-token');
    expect(JSON.stringify(config.safeConfig)).not.toContain('fixture-password');

    process.env.MEM001D2_UNRELATED_PARENT_SECRET = 'must-not-cross-process-boundary';
    try {
      const child = childEnvironment(config, true, 'C:\\fixture-export', 'mem001d2-fixture-tenant');
      expect(child.MEM001D2_UNRELATED_PARENT_SECRET).toBeUndefined();
      expect(child.OPENAI_API_KEY).toBe('');
      expect(child.MEMBERRY_ADMISSION_SHADOW_ENABLED).toBe('true');
      expect(child.MEMBERRY_TENANT_TOKENS).toBe('mem001d2-fixture-tenant:fixture-token');
      expect(child.MEMBERRY_API_TOKEN).toBeUndefined();
    } finally {
      delete process.env.MEM001D2_UNRELATED_PARENT_SECRET;
    }
  });

  it('requires readiness to report the exact default-off and enabled limitations', () => {
    expect(assertReadinessContract(readiness(false), false).mode).toBe('disabled');
    expect(assertReadinessContract(readiness(true), true)).toMatchObject({
      mode: 'shadow',
      delivery: 'best-effort-bounded-terminal',
      durable_retry: false,
      self_healing: false,
      history_complete: false,
      crash_gap_possible: true,
    });
    const dishonest = structuredClone(readiness(true));
    dishonest.admission_shadow.self_healing = true;
    expect(() => assertReadinessContract(dishonest, true)).toThrow(/self_healing/);
  });

  it('accepts only one correctly linked content-free observation', () => {
    const scope = { tenantId: 'default', projectScope: 'project:memberry-eval-live', episodeId: 'ep-1' };
    const properties = {
      id: 'admission-observation:sha256:abc', tenant_id: 'default', project_scope: scope.projectScope,
      contract_version: '1.0.0', capture_state: 'accepted-nonduplicate', memory_class: 'general', outcome: 'unspecified',
      tenant_scope: 'resolved', safe_project_scope: 'resolved', sensitivity: 'not-detected', redaction_configured: false,
      has_signals: false, has_entities: false, has_model: false, policy_id: 'baseline-parity-admission', policy_version: '1.0.0',
      recommended_tier: 'episodic', would_change_baseline: false,
      reason_code: 'baseline-parity-accepted-nonduplicate', observed_at: '2026-08-15T00:00:00.000Z',
    };
    expect(assertContentFreeObservation({ scope, properties, observationCount: 1, exactLinkCount: 1 })).toEqual(properties);
    expect(() => assertContentFreeObservation({
      scope,
      properties: { ...properties, content: 'forbidden fixture content' },
      observationCount: 1,
      exactLinkCount: 1,
    })).toThrow(/content-free/);
  });

  it('sanitizes evidence recursively without retaining configured credentials or fixture content', () => {
    expect(sanitizeAdmissionEvidence({
      authorization: 'Bearer fixture-token',
      password: 'fixture-password',
      result: { content: 'synthetic fixture prose', count: 1 },
    }, ['fixture-token', 'fixture-password', 'synthetic fixture prose'])).toEqual({
      authorization: '[REDACTED]',
      password: '[REDACTED]',
      result: { content: '[REDACTED]', count: 1 },
    });
  });

  it('canonicalizes sanitizer input without invoking accessors or accepting exotic containers', () => {
    expect(sanitizeAdmissionEvidence({ nested: [{ token: 'secret' }, { value: 'prefix-secret-suffix' }] }, ['secret']))
      .toEqual({ nested: [{ token: '[REDACTED]' }, { value: 'prefix-[REDACTED]-suffix' }] });

    let reads = 0;
    const accessor = {} as Record<string, unknown>;
    Object.defineProperty(accessor, 'authorization', {
      enumerable: true,
      get() { reads += 1; return 'Bearer secret'; },
    });
    expect(() => sanitizeAdmissionEvidence(accessor, ['secret'])).toThrow(/accessor/);
    expect(reads).toBe(0);
    expect(() => sanitizeAdmissionEvidence(new Proxy({ value: 'safe' }, {}), [])).toThrow(/proxy/);

    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => sanitizeAdmissionEvidence(circular, [])).toThrow(/circular/);

    const symbolKey = { value: 'safe' } as Record<PropertyKey, unknown>;
    symbolKey[Symbol('hidden')] = 'secret';
    expect(() => sanitizeAdmissionEvidence(symbolKey, ['secret'])).toThrow(/symbol/);
    expect(() => sanitizeAdmissionEvidence(new Date(), [])).toThrow(/plain records/);

    const prototypeKeys: Record<string, unknown> = {};
    Object.defineProperty(prototypeKeys, '__proto__', {
      value: { polluted: true }, enumerable: true, configurable: true, writable: true,
    });
    Object.defineProperty(prototypeKeys, 'constructor', {
      value: 'fixture-constructor', enumerable: true, configurable: true, writable: true,
    });
    Object.defineProperty(prototypeKeys, 'prototype', {
      value: 'fixture-prototype', enumerable: true, configurable: true, writable: true,
    });
    const canonical = sanitizeAdmissionEvidence(prototypeKeys, []) as Record<string, unknown>;
    expect(Object.getPrototypeOf(canonical)).toBe(Object.prototype);
    expect(Object.hasOwn(canonical, '__proto__')).toBe(true);
    expect(canonical.__proto__).toEqual({ polluted: true });
    expect(Object.hasOwn(canonical, 'constructor')).toBe(true);
    expect(canonical.constructor).toBe('fixture-constructor');
    expect(Object.hasOwn(canonical, 'prototype')).toBe(true);
    expect(canonical.prototype).toBe('fixture-prototype');
    expect((Object.prototype as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('conditionally releases every acquired initialization resource on git and temp failures', async () => {
    const calls: string[] = [];
    const driver = { close: async () => { calls.push('driver-close'); } };
    await expect(acquireAdmissionLiveResources({
      createDriver: () => driver,
      createTemp: async () => { calls.push('temp-create'); return 'fixture-temp'; },
      getGitState: async () => { throw new Error('git-state-injection'); },
      removeTemp: async (path) => { calls.push(`temp-remove:${path}`); },
    }, 20)).rejects.toThrow(/git-state-injection/);
    expect(calls).toEqual(['temp-create', 'driver-close', 'temp-remove:fixture-temp']);

    calls.length = 0;
    await expect(acquireAdmissionLiveResources({
      createDriver: () => driver,
      createTemp: async () => { throw new Error('mkdtemp-injection'); },
      getGitState: async () => ({ sha: 'a'.repeat(40), dirty: false }),
      removeTemp: async (path) => { calls.push(`temp-remove:${path}`); },
    }, 20)).rejects.toThrow(/mkdtemp-injection/);
    expect(calls).toEqual(['driver-close']);
  });

  it('bounds process exit and continues every cleanup step after stop failure or timeout', async () => {
    class FakeChild extends EventEmitter {
      exitCode: number | null = null;
      readonly signals: string[] = [];
      constructor(private readonly mode: 'never' | 'throw-term-exit-kill') { super(); }
      kill(signal?: NodeJS.Signals | number): boolean {
        this.signals.push(String(signal));
        if (this.mode === 'throw-term-exit-kill' && signal === 'SIGTERM') throw new Error('term injection');
        if (this.mode === 'throw-term-exit-kill' && signal === 'SIGKILL') {
          this.exitCode = 137;
          queueMicrotask(() => this.emit('exit', 137, 'SIGKILL'));
        }
        return true;
      }
    }

    const never = new FakeChild('never');
    await expect(stopChildProcessBounded(never, 5, 5)).rejects.toThrow(/confirmed exit/);
    expect(never.signals).toEqual(['SIGTERM', 'SIGKILL']);

    const injected = new FakeChild('throw-term-exit-kill');
    await expect(stopChildProcessBounded(injected, 5, 20)).rejects.toThrow(/term injection/);
    expect(injected.exitCode).toBe(137);

    const ran: string[] = [];
    const failures = await runBoundedCleanupSteps([
      { name: 'stop', run: () => Promise.reject(new Error('stop failed')) },
      { name: 'graph', run: () => new Promise<void>(() => {}) },
      { name: 'driver', run: async () => { ran.push('driver'); } },
      { name: 'temp', run: async () => { ran.push('temp'); } },
    ], 5);
    expect(failures.map(({ name }) => name)).toEqual(['stop', 'graph']);
    expect(ran).toEqual(['driver', 'temp']);
  });

  it('runs the full lab tests and lab typecheck in both Node unit matrix entries', async () => {
    const root = fileURLToPath(new URL('../../../../', import.meta.url));
    const workflow = await readFile(`${root}/.github/workflows/ci.yml`, 'utf8');
    const unitJob = workflow.slice(workflow.indexOf('  unit:'), workflow.indexOf('  # Full job:'));
    expect(unitJob).toContain('node-version: [20, 22]');
    expect(unitJob).toContain('run: npm run bench:lab:test');
    expect(unitJob).toContain('run: npm run bench:lab:typecheck');
  });

  it('deletes only exact auto-created project fixtures and residual-counts every same-name Entity', async () => {
    const source = await readFile(fileURLToPath(new URL('../live-composition.ts', import.meta.url)), 'utf8');
    expect(source).toContain('p.name IN $projectNames');
    expect(source).toContain("p.type = 'project'");
    expect(source).toContain('p.auto_created = true');
    expect(source).toContain("p.description = 'Auto-created from berry_store on first reference'");
    expect(source).toContain("p.id STARTS WITH 'auto-proj-'");
    expect(source).toContain('count(DISTINCT p) AS projectEntities');
    expect(source).toContain('cleanup.projectEntities !== 0');
  });
});
