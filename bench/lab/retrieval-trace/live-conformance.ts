#!/usr/bin/env tsx

import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import type { Driver, QueryResult, Session } from 'neo4j-driver';
import type Redis from 'ioredis';

import { createNeo4jDriver } from '../../../packages/neo4j/src/driver.js';
import { createRedisClient } from '../../../packages/redis/src/client.js';
import type { RetrievalTraceAlgorithmVersion } from '../../../packages/retrieval/src/index.js';
import {
  assertTraceConformanceManifest,
  inspectTraceToolResult,
  sanitizeTraceConformanceManifest,
  observeOrderedMarkdownResultIds,
  type TraceInspectionSummary,
} from './contract.js';

const execFileAsync = promisify(execFile);
const MCP_PROTOCOL_VERSION = '2025-03-26';
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const DEFAULT_STARTUP_TIMEOUT_MS = 300_000;
const MAX_HTTP_RESPONSE_BYTES = 4_194_304;
const NAMED_TENANT = 'ret001d-named';

type JsonRecord = Record<string, unknown>;

export interface TraceConformanceConfig {
  readonly defaultToken: string;
  readonly namedToken: string;
  readonly neo4jUser: string;
  readonly neo4jPassword: string;
  readonly mcpUrl: string;
  readonly redisUrl: string;
  readonly neo4jUri: string;
  readonly host: '127.0.0.1' | '::1' | 'localhost';
  readonly port: number;
  readonly requestTimeoutMs: number;
  readonly startupTimeoutMs: number;
  readonly evidencePath?: string;
  readonly redisContainerId: string;
  readonly redisImageId: string;
  readonly neo4jContainerId: string;
  readonly neo4jImageId: string;
  readonly safeConfig: Readonly<Record<string, unknown>>;
}

function required(env: Readonly<Record<string, string | undefined>>, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`RET-001D live evidence requires ${name}`);
  return value;
}

function loopbackUrl(raw: string, protocols: readonly string[], name: string): URL {
  if (/%[0-9a-f]{2}/i.test(raw)) throw new Error(`${name} must not contain encoded components`);
  let parsed: URL;
  try { parsed = new URL(raw); }
  catch { throw new Error(`${name} must be a valid loopback URL`); }
  const host = parsed.hostname.replace(/^\[|\]$/g, '');
  if (!protocols.includes(parsed.protocol) || !['127.0.0.1', '::1', 'localhost'].includes(host)) {
    throw new Error(`${name} must be loopback-only and use ${protocols.join(' or ')}`);
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash
    || (parsed.pathname !== '' && parsed.pathname !== '/')) throw new Error(`${name} must use a credential-free root URL`);
  return parsed;
}

function boundedInteger(raw: string | undefined, fallback: number, min: number, max: number, name: string): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  if (!/^\d+$/.test(raw.trim())) throw new Error(`${name} must be an integer`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`${name} is out of bounds`);
  return value;
}

function exactIdentity(raw: string, pattern: RegExp, name: string): string {
  if (!pattern.test(raw)) throw new Error(`${name} must be an exact immutable identity`);
  return raw;
}

export function resolveTraceConformanceConfig(
  env: Readonly<Record<string, string | undefined>> = process.env,
): TraceConformanceConfig {
  if (env.MEMBERRY_TRACE_LIVE_DISPOSABLE?.trim().toLowerCase() !== 'true') {
    throw new Error('RET-001D live evidence is fail-closed; set MEMBERRY_TRACE_LIVE_DISPOSABLE=true');
  }
  const defaultToken = required(env, 'MEMBERRY_TRACE_LIVE_DEFAULT_TOKEN');
  const namedToken = required(env, 'MEMBERRY_TRACE_LIVE_NAMED_TOKEN');
  if (defaultToken === namedToken) throw new Error('RET-001D live evidence requires distinct tenant tokens');
  const mcp = loopbackUrl(required(env, 'MEMBERRY_TRACE_LIVE_MCP_URL'), ['http:'], 'MCP URL');
  const redis = loopbackUrl(required(env, 'MEMBERRY_TRACE_LIVE_REDIS_URL'), ['redis:', 'rediss:'], 'Redis URL');
  const neo4j = loopbackUrl(required(env, 'MEMBERRY_TRACE_LIVE_NEO4J_URI'), ['bolt:', 'neo4j:'], 'Neo4j URI');
  const requestTimeoutMs = boundedInteger(
    env.MEMBERRY_TRACE_LIVE_REQUEST_TIMEOUT_MS, DEFAULT_REQUEST_TIMEOUT_MS, 100, 60_000,
    'MEMBERRY_TRACE_LIVE_REQUEST_TIMEOUT_MS',
  );
  const startupTimeoutMs = boundedInteger(
    env.MEMBERRY_TRACE_LIVE_STARTUP_TIMEOUT_MS, DEFAULT_STARTUP_TIMEOUT_MS, 1_000, 600_000,
    'MEMBERRY_TRACE_LIVE_STARTUP_TIMEOUT_MS',
  );
  const port = Number(mcp.port || '80');
  if (!Number.isSafeInteger(port) || port < 1024 || port > 65_535) throw new Error('MCP URL port is out of bounds');
  const safeConfig = Object.freeze({
    host: mcp.hostname.replace(/^\[|\]$/g, ''),
    port,
    transport: 'streamable-http-mcp',
    requestTimeoutMs,
    startupTimeoutMs,
    responseByteLimit: MAX_HTTP_RESPONSE_BYTES,
  });
  return Object.freeze({
    defaultToken,
    namedToken,
    neo4jUser: required(env, 'MEMBERRY_TRACE_LIVE_NEO4J_USER'),
    neo4jPassword: required(env, 'MEMBERRY_TRACE_LIVE_NEO4J_PASSWORD'),
    redisContainerId: exactIdentity(required(env, 'MEMBERRY_TRACE_LIVE_REDIS_CONTAINER_ID'), /^[0-9a-f]{64}$/, 'Redis container ID'),
    redisImageId: exactIdentity(required(env, 'MEMBERRY_TRACE_LIVE_REDIS_IMAGE_ID'), /^sha256:[0-9a-f]{64}$/, 'Redis image ID'),
    neo4jContainerId: exactIdentity(required(env, 'MEMBERRY_TRACE_LIVE_NEO4J_CONTAINER_ID'), /^[0-9a-f]{64}$/, 'Neo4j container ID'),
    neo4jImageId: exactIdentity(required(env, 'MEMBERRY_TRACE_LIVE_NEO4J_IMAGE_ID'), /^sha256:[0-9a-f]{64}$/, 'Neo4j image ID'),
    mcpUrl: mcp.toString(),
    redisUrl: redis.toString(),
    neo4jUri: neo4j.toString(),
    host: safeConfig.host as TraceConformanceConfig['host'],
    port,
    requestTimeoutMs,
    startupTimeoutMs,
    ...(env.MEMBERRY_TRACE_LIVE_EVIDENCE_PATH?.trim()
      ? { evidencePath: resolve(env.MEMBERRY_TRACE_LIVE_EVIDENCE_PATH.trim()) }
      : {}),
    safeConfig,
  });
}

async function readChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal?: AbortSignal,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  if (!signal) return reader.read();
  if (signal.aborted) throw new Error('RET001D_HTTP_BODY_ABORTED');
  const pendingRead = reader.read();
  return new Promise((resolvePromise, rejectPromise) => {
    let settled = false;
    let aborting = false;
    const settle = (action: () => void) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      action();
    };
    const onAbort = () => {
      aborting = true;
      // Cancellation is not fire-and-forget: drain the pending read before the
      // request is allowed to reject and its finally block can continue.
      void (async () => {
        await reader.cancel().catch(() => undefined);
        await pendingRead.catch(() => undefined);
        settle(() => rejectPromise(new Error('RET001D_HTTP_BODY_ABORTED')));
      })();
    };
    signal.addEventListener('abort', onAbort, { once: true });
    pendingRead.then(
      (result) => { if (!aborting) settle(() => resolvePromise(result)); },
      () => { if (!aborting) settle(() => rejectPromise(new Error('RET001D_HTTP_BODY_READ_FAILED'))); },
    );
  });
}

export async function readBoundedResponseText(
  response: Response,
  limit = MAX_HTTP_RESPONSE_BYTES,
  signal?: AbortSignal,
): Promise<string> {
  const declared = response.headers.get('content-length');
  if (declared && /^\d+$/.test(declared) && Number(declared) > limit) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error('RET001D_HTTP_BODY_TOO_LARGE');
  }
  if (!response.body) return '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let text = '';
  try {
    while (true) {
      const { value, done } = await readChunk(reader, signal);
      if (done) break;
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel();
        throw new Error('RET001D_HTTP_BODY_TOO_LARGE');
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return text;
  } finally {
    reader.releaseLock();
  }
}

function parseEnvelope(contentType: string, raw: string): JsonRecord | undefined {
  if (!raw.trim()) return undefined;
  let json = raw;
  if (contentType.toLowerCase().includes('text/event-stream')) {
    const events = raw.split(/\r?\n\r?\n/).flatMap((event) => {
      const data = event.split(/\r?\n/).filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trimStart()).join('\n').trim();
      return data ? [data] : [];
    });
    if (events.length !== 1) throw new Error('RET001D_MCP_ENVELOPE_INVALID');
    json = events[0]!;
  }
  let value: unknown;
  try { value = JSON.parse(json); }
  catch { throw new Error('RET001D_MCP_ENVELOPE_INVALID'); }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('RET001D_MCP_ENVELOPE_INVALID');
  return value as JsonRecord;
}

export class TraceMcpTransport {
  private sessionId?: string;
  private nextId = 1;

  constructor(
    private readonly config: TraceConformanceConfig,
    private readonly token: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private headers(withSession: boolean): Record<string, string> {
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.token}`,
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
    };
    if (withSession && this.sessionId) {
      headers['mcp-session-id'] = this.sessionId;
      headers['mcp-protocol-version'] = MCP_PROTOCOL_VERSION;
    }
    return headers;
  }

  private async request(body: JsonRecord, withSession = true): Promise<JsonRecord | undefined> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.requestTimeoutMs);
    try {
      const response = await this.fetchImpl(new URL('/mcp', this.config.mcpUrl), {
        method: 'POST', headers: this.headers(withSession), body: JSON.stringify(body), signal: controller.signal,
      });
      const raw = await readBoundedResponseText(response, MAX_HTTP_RESPONSE_BYTES, controller.signal);
      if (controller.signal.aborted) throw new Error('RET001D_MCP_TIMEOUT');
      if (!response.ok) throw new Error(`RET001D_MCP_HTTP_${response.status}`);
      const envelope = parseEnvelope(response.headers.get('content-type') ?? '', raw);
      const requestId = Object.prototype.hasOwnProperty.call(body, 'id') ? body.id : undefined;
      if (requestId !== undefined) {
        if (!Number.isSafeInteger(requestId) || !envelope || envelope.jsonrpc !== '2.0'
          || !Object.prototype.hasOwnProperty.call(envelope, 'id') || envelope.id !== requestId) {
          throw new Error('RET001D_MCP_CORRELATION_INVALID');
        }
      } else if (envelope !== undefined) {
        throw new Error('RET001D_MCP_CORRELATION_INVALID');
      }
      if (envelope?.error !== undefined) throw new Error('RET001D_MCP_RPC_ERROR');
      const pendingSession = response.headers.get('mcp-session-id');
      if (pendingSession) this.sessionId = pendingSession;
      return envelope;
    } catch (error) {
      if (controller.signal.aborted) throw new Error('RET001D_MCP_TIMEOUT');
      if (safeDiagnosticCode(error) !== 'RET001D_INTERNAL_FAILURE') throw error;
      throw new Error('RET001D_MCP_NETWORK');
    } finally {
      clearTimeout(timer);
    }
  }

  private async initialize(): Promise<void> {
    if (this.sessionId) return;
    const envelope = await this.request({
      jsonrpc: '2.0', id: this.nextId++, method: 'initialize', params: {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'memberry-retrieval-trace-live-conformance', version: '1.0.0' },
      },
    }, false);
    const result = envelope?.result as JsonRecord | undefined;
    if (!result || result.protocolVersion !== MCP_PROTOCOL_VERSION || !this.sessionId) {
      throw new Error('RET001D_MCP_INITIALIZE_INVALID');
    }
    await this.request({ jsonrpc: '2.0', method: 'notifications/initialized' });
  }

  async call(tool: string, args: JsonRecord): Promise<unknown> {
    await this.initialize();
    const envelope = await this.request({
      jsonrpc: '2.0', id: this.nextId++, method: 'tools/call', params: { name: tool, arguments: args },
    });
    if (!envelope || !('result' in envelope)) throw new Error('RET001D_MCP_TOOL_RESPONSE_INVALID');
    return envelope.result;
  }
}

export interface ReadinessDependencies {
  now(): number;
  sleep(ms: number): Promise<void>;
}

const READINESS_DEPS: ReadinessDependencies = {
  now: Date.now,
  sleep: (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms)),
};

export function safeDiagnosticCode(error: unknown): string {
  return error instanceof Error && /^RET001D_[A-Z0-9_]+(?:_[0-9]{3})?$/.test(error.message)
    ? error.message
    : 'RET001D_INTERNAL_FAILURE';
}

export async function runAbortableOperation<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  timeoutCode: string,
  failureCode: string,
): Promise<T> {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  try {
    const result = await operation(controller.signal);
    if (timedOut) throw new Error(timeoutCode);
    return result;
  } catch {
    throw new Error(timedOut ? timeoutCode : failureCode);
  } finally {
    clearTimeout(timer);
  }
}

function readinessErrorCode(error: unknown): string {
  const code = safeDiagnosticCode(error);
  return code === 'RET001D_INTERNAL_FAILURE' ? 'RET001D_READINESS_UNKNOWN' : code;
}

export async function waitForTraceReadiness<T>(
  probe: () => Promise<T>,
  timeoutMs: number,
  dependencies: ReadinessDependencies = READINESS_DEPS,
): Promise<T> {
  const deadline = dependencies.now() + timeoutMs;
  let last = 'RET001D_READINESS_NETWORK';
  while (dependencies.now() < deadline) {
    try { return await probe(); }
    catch (error) {
      const code = readinessErrorCode(error);
      if (code !== 'RET001D_READINESS_NETWORK') throw new Error(code);
      last = code;
      await dependencies.sleep(250);
    }
  }
  throw new Error(`RET001D_READINESS_TIMEOUT__${last}`);
}

const LOGICAL_MULTI_TENANT_LIMITATION =
  'shared logical multi-tenant consolidation and wiki publication are disabled to prevent cross-tenant disclosure';

function exactStringKeys(value: JsonRecord, keys: readonly string[]): boolean {
  const actual = Reflect.ownKeys(value);
  return actual.length === keys.length && actual.every((key) => typeof key === 'string' && keys.includes(key));
}

function expectedNamedDegradation(body: JsonRecord): boolean {
  if (!exactStringKeys(body, [
    'status', 'service', 'transport', 'active_sessions', 'registered_sessions',
    'auth_required', 'uptime_ms', 'consolidation_automation', 'admission_shadow',
  ]) || body.status !== 'ready' || body.service !== 'memberry-mcp' || body.transport !== 'sse'
    || body.auth_required !== true || !Number.isSafeInteger(body.active_sessions)
    || !Number.isSafeInteger(body.registered_sessions) || body.active_sessions !== body.registered_sessions
    || typeof body.uptime_ms !== 'number' || !Number.isFinite(body.uptime_ms) || body.uptime_ms < 0
    || typeof body.admission_shadow !== 'object' || body.admission_shadow === null
    || Array.isArray(body.admission_shadow)) return false;
  if (typeof body.consolidation_automation !== 'object' || body.consolidation_automation === null
    || Array.isArray(body.consolidation_automation)) return false;
  const automation = body.consolidation_automation as JsonRecord;
  if (!exactStringKeys(automation, ['enabled', 'unhealthy', 'degraded', 'limitations', 'workers'])
    || automation.enabled !== false || automation.unhealthy !== true || automation.degraded !== true
    || !Array.isArray(automation.limitations) || automation.limitations.length !== 1
    || typeof automation.limitations[0] !== 'string'
    || !automation.limitations[0].includes(LOGICAL_MULTI_TENANT_LIMITATION)
    || !Array.isArray(automation.workers) || automation.workers.length !== 1) return false;
  const worker = automation.workers[0];
  return typeof worker === 'object' && worker !== null && !Array.isArray(worker)
    && (worker as JsonRecord).name === 'default'
    && (worker as JsonRecord).enabled === false
    && (worker as JsonRecord).health === 'unhealthy'
    && typeof (worker as JsonRecord).limitation === 'string'
    && String((worker as JsonRecord).limitation).includes(LOGICAL_MULTI_TENANT_LIMITATION);
}

export function classifyTraceReadiness(
  status: number,
  body: unknown,
  mode: 'single-default' | 'named-tenant',
): { status: number; classification: 'ready' | 'expected-logical-multitenant-degraded' } {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) throw new Error('RET001D_READINESS_INVALID');
  const record = body as JsonRecord;
  if (mode === 'single-default' && status === 200 && record.status === 'ready'
    && record.service === 'memberry-mcp' && record.auth_required === true) {
    return { status: 200, classification: 'ready' };
  }
  if (mode === 'named-tenant' && status === 503 && expectedNamedDegradation(record)) {
    return { status: 503, classification: 'expected-logical-multitenant-degraded' };
  }
  throw new Error('RET001D_READINESS_INVALID');
}

async function readiness(
  config: TraceConformanceConfig,
  token: string,
  mode: 'single-default' | 'named-tenant',
): Promise<{ status: number; classification: 'ready' | 'expected-logical-multitenant-degraded' }> {
  const signal = AbortSignal.timeout(config.requestTimeoutMs);
  let response: Response;
  try {
    response = await fetch(new URL('/readyz', config.mcpUrl), {
      headers: { authorization: `Bearer ${token}` }, signal,
    });
  } catch { throw new Error('RET001D_READINESS_NETWORK'); }
  let raw: string;
  try { raw = await readBoundedResponseText(response, 256 * 1024, signal); }
  catch { throw new Error(signal.aborted ? 'RET001D_READINESS_NETWORK' : 'RET001D_READINESS_INVALID'); }
  let body: JsonRecord;
  try { body = JSON.parse(raw) as JsonRecord; }
  catch { throw new Error('RET001D_READINESS_INVALID'); }
  return classifyTraceReadiness(response.status, body, mode);
}

export function compositionRootCommand(): { readonly executable: string; readonly args: readonly string[] } {
  return { executable: process.execPath, args: ['--import', 'tsx', 'packages/mcp/src/server.ts'] };
}

export function childEnvironment(
  config: TraceConformanceConfig,
  mode: 'single-default' | 'named-tenant',
  exportPath: string,
): NodeJS.ProcessEnv {
  const inherited = Object.fromEntries(
    ['SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'PATH', 'PATHEXT', 'COMSPEC']
      .flatMap((key) => process.env[key] === undefined ? [] : [[key, process.env[key]!]]),
  );
  return {
    ...inherited,
    NODE_ENV: 'test',
    PORT: String(config.port),
    MCP_PORT: String(config.port),
    MEMBERRY_HOST: config.host,
    REDIS_URL: config.redisUrl,
    NEO4J_URI: config.neo4jUri,
    NEO4J_USER: config.neo4jUser,
    NEO4J_PASSWORD: config.neo4jPassword,
    ...(mode === 'single-default'
      ? { MEMBERRY_API_TOKEN: config.defaultToken }
      : { MEMBERRY_TENANT_TOKENS: `${NAMED_TENANT}:${config.namedToken}` }),
    MEMBERRY_EXPORT_PATH: exportPath,
    MEMBERRY_CONSOLIDATION_ENABLED: 'false',
    MEMBERRY_WIKI_AUTOREFRESH: 'false',
    OPENAI_API_KEY: '',
  };
}

function waitForChildExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  return new Promise((resolvePromise) => {
    let settled = false;
    const finish = (exited: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.removeListener('exit', onExit);
      resolvePromise(exited);
    };
    const onExit = () => finish(true);
    const timer = setTimeout(() => finish(false), timeoutMs);
    child.once('exit', onExit);
    if (child.exitCode !== null) finish(true);
  });
}

async function stopChild(child: ChildProcess, timeoutMs = 10_000): Promise<void> {
  if (child.exitCode !== null) return;
  child.kill('SIGTERM');
  const exited = await waitForChildExit(child, timeoutMs);
  if (exited) return;
  child.kill('SIGKILL');
  const killed = await waitForChildExit(child, 5_000);
  if (!killed) throw new Error('RET001D_COMPOSITION_ROOT_STOP_TIMEOUT');
}

class CompositionRoot {
  private readonly child: ChildProcess;

  constructor(
    private readonly config: TraceConformanceConfig,
    private readonly mode: 'single-default' | 'named-tenant',
    exportPath: string,
  ) {
    const command = compositionRootCommand();
    this.child = spawn(command.executable, command.args, {
      cwd: process.cwd(), env: childEnvironment(config, mode, exportPath), stdio: 'ignore',
    });
  }

  async waitUntilReady(): Promise<{ status: number; classification: 'ready' | 'expected-logical-multitenant-degraded' }> {
    const token = this.mode === 'single-default' ? this.config.defaultToken : this.config.namedToken;
    try {
      const evidence = await waitForTraceReadiness(async () => {
        if (this.child.exitCode !== null) throw new Error('RET001D_COMPOSITION_ROOT_EXITED');
        return readiness(this.config, token, this.mode);
      }, this.config.startupTimeoutMs);
      const probe = new TraceMcpTransport(this.config, token);
      await probe.call('berry_tools', { action: 'list' });
      return evidence;
    } catch (error) {
      throw new Error(readinessErrorCode(error));
    }
  }

  stop(): Promise<void> { return stopChild(this.child); }
}

interface FixtureIdentity {
  readonly run: string;
  readonly defaultProject: string;
  readonly defaultTarget: string;
  readonly namedProject: string;
  readonly namedTarget: string;
  readonly defaultContent: string;
  readonly namedContent: string;
  readonly decoyContent: string;
}

export function tenantIsolationForbiddenValues(
  scope: 'default' | 'named-tenant',
  fixture: Pick<FixtureIdentity, 'run' | 'defaultContent' | 'namedContent' | 'decoyContent'>,
): readonly string[] {
  const decoy = [`ret001d-decoy-${fixture.run}`, fixture.decoyContent];
  if (scope === 'default') {
    return Object.freeze([
      `ret001d-np-${fixture.run}`, `ret001d-nt-${fixture.run}`, `ret001d-ns-${fixture.run}`,
      `ret001d-named-project-${fixture.run}`, `ret001d-named-target-${fixture.run}`,
      fixture.namedContent, ...decoy,
    ]);
  }
  return Object.freeze([
    `ret001d-dp-${fixture.run}`, `ret001d-dt-${fixture.run}`, `ret001d-dd-${fixture.run}`,
    `ret001d-da-${fixture.run}`, `ret001d-ds-${fixture.run}`,
    `ret001d-default-project-${fixture.run}`, `ret001d-default-target-${fixture.run}`,
    `ret001d-dependency-${fixture.run}`, fixture.defaultContent, ...decoy,
  ]);
}

async function neo4jRun(
  session: Session,
  query: string,
  params: Record<string, unknown>,
  timeoutMs: number,
  failureCode: string,
): Promise<QueryResult> {
  try {
    return await session.run(query, params, { timeout: timeoutMs });
  } catch {
    throw new Error(failureCode);
  }
}

async function seedFixtures(driver: Driver, fixture: FixtureIdentity, timeoutMs: number): Promise<void> {
  const session = driver.session();
  try {
    await neo4jRun(session,
      `CREATE (dp:Entity {id:$dpid, name:$defaultProject, type:'project', category:'project', tenant_id:'default', ret001d_run:$run, created_at:$now})
       CREATE (dt:Entity {id:$dtid, name:$defaultTarget, type:'service', category:'service', tenant_id:'default', ret001d_run:$run, responsibility:'synthetic trace target', created_at:$now})
       CREATE (dd:Entity {id:$ddid, name:$defaultDependency, type:'module', category:'module', tenant_id:'default', ret001d_run:$run, interface_desc:'synthetic interface', created_at:$now})
       CREATE (da:Aspect {id:$daid, name:'ret001d-safety', stability_tier:'protocol', description:'synthetic trace aspect', ret001d_run:$run})
       CREATE (ds:Semantic {id:$dsid, content:$defaultContent, confidence:0.91, signal_count:1, created_at:$now, updated_at:$now, decay_class:'stable', memory_type:'architecture', tags:[$defaultScope], scope:$defaultScope, tenant_id:'default', ret001d_run:$run})
       CREATE (dp)-[:CONTAINS {ret001d_run:$run}]->(dt)
       CREATE (dt)-[:USES {ret001d_run:$run}]->(dd)
       CREATE (da)-[:APPLIES_TO {ret001d_run:$run}]->(dt)
       CREATE (ds)-[:ABOUT {ret001d_run:$run}]->(dt)
       CREATE (np:Entity {id:$npid, name:$namedProject, type:'project', category:'project', tenant_id:$namedTenant, ret001d_run:$run, created_at:$now})
       CREATE (nt:Entity {id:$ntid, name:$namedTarget, type:'service', category:'service', tenant_id:$namedTenant, ret001d_run:$run, responsibility:'synthetic named trace target', created_at:$now})
       CREATE (ns:Semantic {id:$nsid, content:$namedContent, confidence:0.89, signal_count:1, created_at:$now, updated_at:$now, decay_class:'stable', memory_type:'architecture', tags:[$namedScope], scope:$namedScope, tenant_id:$namedTenant, ret001d_run:$run})
       CREATE (np)-[:CONTAINS {ret001d_run:$run}]->(nt)
       CREATE (ns)-[:ABOUT {ret001d_run:$run}]->(nt)
       CREATE (:Semantic {id:$decoyId, content:$decoyContent, confidence:0.99, signal_count:9, created_at:$now, updated_at:$now, decay_class:'stable', memory_type:'architecture', tags:['project:ret001d-decoy'], scope:'project:ret001d-decoy', tenant_id:'ret001d-decoy', ret001d_run:$run})`,
      {
        run: fixture.run, now: new Date().toISOString(), namedTenant: NAMED_TENANT,
        dpid: `ret001d-dp-${fixture.run}`, dtid: `ret001d-dt-${fixture.run}`, ddid: `ret001d-dd-${fixture.run}`,
        daid: `ret001d-da-${fixture.run}`, dsid: `ret001d-ds-${fixture.run}`,
        npid: `ret001d-np-${fixture.run}`, ntid: `ret001d-nt-${fixture.run}`, nsid: `ret001d-ns-${fixture.run}`,
        decoyId: `ret001d-decoy-${fixture.run}`,
        defaultProject: fixture.defaultProject, defaultTarget: fixture.defaultTarget,
        defaultDependency: `ret001d-dependency-${fixture.run}`, defaultScope: `project:${fixture.defaultProject}`,
        namedProject: fixture.namedProject, namedTarget: fixture.namedTarget, namedScope: `project:${fixture.namedProject}`,
        defaultContent: fixture.defaultContent, namedContent: fixture.namedContent, decoyContent: fixture.decoyContent,
      }, timeoutMs, 'RET001D_NEO4J_SEED_FAILED');
  } finally {
    await session.close().catch(() => { throw new Error('RET001D_NEO4J_SESSION_CLOSE_FAILED'); });
  }
}

interface ResidualRecord { get(key: string): unknown }

function exactResidualNumber(value: unknown): number {
  let resolved = value;
  if (typeof value === 'object' && value !== null) {
    const method = (value as { toNumber?: unknown }).toNumber;
    if (typeof method !== 'function') throw new Error('RET001D_NEO4J_RESIDUAL_INVALID');
    resolved = method.call(value);
  }
  if (!Number.isSafeInteger(resolved) || Number(resolved) < 0) throw new Error('RET001D_NEO4J_RESIDUAL_INVALID');
  return Number(resolved);
}

export function parseResidualCounts(records: readonly ResidualRecord[]): { nodes: number; relationships: number } {
  if (records.length !== 1 || typeof records[0]?.get !== 'function') {
    throw new Error('RET001D_NEO4J_RESIDUAL_INVALID');
  }
  return {
    nodes: exactResidualNumber(records[0].get('nodes')),
    relationships: exactResidualNumber(records[0].get('relationships')),
  };
}

async function cleanupFixtures(
  driver: Driver,
  run: string,
  timeoutMs: number,
): Promise<{ nodes: number; relationships: number }> {
  const session = driver.session();
  try {
    await neo4jRun(session, 'MATCH (n {ret001d_run:$run}) DETACH DELETE n', { run },
      timeoutMs, 'RET001D_NEO4J_CLEANUP_FAILED');
    const result = await neo4jRun(session,
      `CALL {
         MATCH (n) WHERE n.ret001d_run = $run
         RETURN count(n) AS nodes
       }
       CALL {
         MATCH ()-[r]->() WHERE r.ret001d_run = $run
         RETURN count(r) AS relationships
       }
       RETURN nodes, relationships`,
      { run }, timeoutMs, 'RET001D_NEO4J_RESIDUAL_QUERY_FAILED');
    return parseResidualCounts(result.records);
  } finally {
    await session.close().catch(() => { throw new Error('RET001D_NEO4J_SESSION_CLOSE_FAILED'); });
  }
}

async function scanKeys(redis: Redis, timeoutMs: number): Promise<Set<string>> {
  void timeoutMs; // ioredis enforces the configured native commandTimeout.
  const keys = new Set<string>();
  let cursor = '0';
  do {
    let scan: [string, string[]];
    try { scan = await redis.scan(cursor, 'COUNT', 200); }
    catch { throw new Error('RET001D_REDIS_SCAN_FAILED'); }
    const [next, page] = scan;
    cursor = next;
    for (const key of page) {
      keys.add(key);
      if (keys.size > 4_096) throw new Error('RET001D_REDIS_KEY_BOUND');
    }
  } while (cursor !== '0');
  return keys;
}

export async function cleanupOwnedRedisKeys(
  redis: Redis,
  before: ReadonlySet<string>,
  ownedKeys: readonly string[],
  timeoutMs: number,
): Promise<{ ownedRemaining: number; unexpectedNewKeys: number }> {
  if (ownedKeys.length === 0 || new Set(ownedKeys).size !== ownedKeys.length
    || ownedKeys.some((key) => !/^memberry:lab:ret001d:[a-z0-9-]+:ownership$/.test(key))) {
    throw new Error('RET001D_REDIS_OWNERSHIP_INVALID');
  }
  try { await redis.del(...ownedKeys); }
  catch { throw new Error('RET001D_REDIS_CLEANUP_FAILED'); }
  const residual = await scanKeys(redis, timeoutMs);
  const owned = new Set(ownedKeys);
  return {
    ownedRemaining: [...owned].filter((key) => residual.has(key)).length,
    unexpectedNewKeys: [...residual].filter((key) => !before.has(key) && !owned.has(key)).length,
  };
}

interface LiveCase {
  readonly id: 'deterministic' | 'ranked' | 'auto' | 'named-tenant-forced-ranked';
  readonly requestedStrategy: 'deterministic' | 'ranked' | 'auto';
  readonly expectedAlgorithm: RetrievalTraceAlgorithmVersion;
  readonly authScope: 'default' | 'named-tenant';
  readonly task: string;
  readonly projectName: string;
  readonly expectedStrategy: 'deterministic' | 'ranked';
  readonly requiredPresentationId: string;
}

export function requiredPresentationIdForCase(
  id: LiveCase['id'],
  fixture: Pick<FixtureIdentity, 'run' | 'defaultTarget'>,
): string {
  switch (id) {
    case 'deterministic':
    case 'auto':
      return `target-${fixture.defaultTarget}`;
    case 'ranked':
      return `ret001d-dt-${fixture.run}`;
    case 'named-tenant-forced-ranked':
      return `ret001d-nt-${fixture.run}`;
  }
}

async function executeCase(
  transport: TraceMcpTransport,
  liveCase: LiveCase,
  forbidden: readonly string[],
  isolationForbidden: readonly string[],
): Promise<JsonRecord> {
  const baseArgs = {
    task: liveCase.task,
    strategy: liveCase.requestedStrategy,
    include_code: false,
    include_arch: true,
    include_memory: true,
    max_tokens: 4_000,
    project_name: liveCase.projectName,
  };
  const ordinaryResult = await transport.call('berry_context', baseArgs);
  const expectedResultIds = observeOrderedMarkdownResultIds(ordinaryResult, {
    expectedTask: liveCase.task,
    expectedStrategy: liveCase.expectedStrategy,
    requiredResultIds: [liveCase.requiredPresentationId],
  });
  const responseExpectation = {
    expectedTask: liveCase.task,
    expectedStrategy: liveCase.expectedStrategy,
    expectedResultIds,
  } as const;
  const omitted = inspectTraceToolResult(ordinaryResult, {
    mode: 'omitted', ...responseExpectation,
  });
  const explicitFalse = inspectTraceToolResult(await transport.call('berry_context', { ...baseArgs, include_trace: false }), {
    mode: 'false', ...responseExpectation,
  });
  const traced = inspectTraceToolResult(await transport.call('berry_context', { ...baseArgs, include_trace: true }), {
    mode: 'true', expectedAlgorithm: liveCase.expectedAlgorithm, forbiddenValues: forbidden, ...responseExpectation,
  });
  if (!('trace' in traced)) throw new Error('RET001D_TRACE_BLOCK_COUNT');
  if (omitted.markdown !== explicitFalse.markdown) throw new Error('RET001D_FALSE_PARITY_MISMATCH');
  if (omitted.markdown !== traced.markdown) throw new Error('RET001D_TRACED_PARITY_MISMATCH');
  if (isolationForbidden.some((value) => traced.markdown.includes(value))) {
    throw new Error('RET001D_TENANT_ISOLATION_FAILURE');
  }
  const summary: TraceInspectionSummary = traced.trace;
  return {
    id: liveCase.id,
    requestedStrategy: liveCase.requestedStrategy,
    actualAlgorithm: summary.algorithmVersion,
    authScope: liveCase.authScope,
    contentBlocks: { omitted: 1, false: 1, traced: 2 },
    parity: { falseEqualsOmitted: true, tracedMarkdownEqualsOrdinary: true },
    trace: summary,
  };
}

async function gitState(timeoutMs: number): Promise<{ sha: string; dirty: false }> {
  const [{ stdout: sha }, { stdout: status }] = await Promise.all([
    execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: process.cwd(), timeout: timeoutMs }),
    execFileAsync('git', ['status', '--porcelain'], { cwd: process.cwd(), timeout: timeoutMs }),
  ]);
  if (status.trim().length > 0) throw new Error('RET001D_GIT_DIRTY');
  return { sha: sha.trim(), dirty: false };
}

async function observeRedisVersion(redis: Redis): Promise<string> {
  let info: string;
  try { info = await redis.info('server'); }
  catch { throw new Error('RET001D_REDIS_VERSION_FAILED'); }
  const matches = [...info.matchAll(/^redis_version:([^\r\n]+)$/gm)];
  if (matches.length !== 1 || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(matches[0]![1]!)) {
    throw new Error('RET001D_REDIS_VERSION_INVALID');
  }
  return matches[0]![1]!;
}

async function observeNeo4jVersion(driver: Driver, timeoutMs: number): Promise<string> {
  const session = driver.session();
  try {
    const result = await neo4jRun(session,
      `CALL dbms.components() YIELD name, versions WHERE name = 'Neo4j Kernel' RETURN versions`,
      {}, timeoutMs, 'RET001D_NEO4J_VERSION_FAILED');
    if (result.records.length !== 1) throw new Error('RET001D_NEO4J_VERSION_INVALID');
    const versions = result.records[0]!.get('versions');
    if (!Array.isArray(versions) || versions.length !== 1 || typeof versions[0] !== 'string'
      || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(versions[0])) {
      throw new Error('RET001D_NEO4J_VERSION_INVALID');
    }
    return versions[0];
  } finally {
    await session.close().catch(() => { throw new Error('RET001D_NEO4J_SESSION_CLOSE_FAILED'); });
  }
}

export async function runTraceLiveConformanceEvidence(config: TraceConformanceConfig): Promise<JsonRecord> {
  const run = `${Date.now().toString(36)}-${randomUUID().replaceAll('-', '').slice(0, 12)}`.toLowerCase();
  const ownedRedisKeys = [`memberry:lab:ret001d:${run}:ownership`];
  const fixture: FixtureIdentity = {
    run,
    defaultProject: `ret001d-default-project-${run}`,
    defaultTarget: `ret001d-default-target-${run}`,
    namedProject: `ret001d-named-project-${run}`,
    namedTarget: `ret001d-named-target-${run}`,
    defaultContent: `RET001D ${run} default synthetic semantic content`,
    namedContent: `RET001D ${run} named synthetic semantic content`,
    decoyContent: `RET001D ${run} cross-tenant decoy must never appear`,
  };
  const queries = {
    deterministic: fixture.defaultTarget,
    ranked: `describe ${fixture.defaultTarget}`,
    auto: `what depends on ${fixture.defaultTarget}`,
    named: `describe ${fixture.namedTarget}`,
  };
  const forbidden = [
    config.defaultToken, config.namedToken, config.neo4jPassword,
    fixture.defaultContent, fixture.namedContent, fixture.decoyContent,
    ...Object.values(queries),
  ];
  let driver: Driver | undefined;
  let redis: Redis | undefined;
  let tempPath: string | undefined;
  let redisBefore = new Set<string>();
  let redisSnapshotEstablished = false;
  let active: CompositionRoot | undefined;
  let childProcessesStopped = false;
  let tempRemoved = false;
  let graphResidual = { nodes: -1, relationships: -1 };
  let redisResidual = { ownedRemaining: -1, unexpectedNewKeys: -1 };
  let executionError: Error | undefined;
  let observedServices: JsonRecord | undefined;
  const cases: JsonRecord[] = [];
  const readinessEvidence: Array<{ mode: string; status: number; classification: string }> = [];

  try {
    try { tempPath = await mkdtemp(resolve(tmpdir(), 'memberry-ret001d-')); }
    catch { throw new Error('RET001D_TEMP_CREATE_FAILED'); }
    const exportPath = resolve(tempPath, 'export');
    driver = createNeo4jDriver(config.neo4jUri, config.neo4jUser, config.neo4jPassword);
    redis = createRedisClient(config.redisUrl, {
      connectTimeout: config.requestTimeoutMs,
      commandTimeout: config.requestTimeoutMs,
      maxRetriesPerRequest: 0,
      retryStrategy: () => null,
    });
    // The shared wrapper logs only when it is the sole error listener. This second,
    // content-free listener keeps infrastructure errors out of evidence artifacts.
    redis.on('error', () => undefined);
    redisBefore = await scanKeys(redis, config.requestTimeoutMs);
    redisSnapshotEstablished = true;
    try { await driver.getServerInfo(); }
    catch { throw new Error('RET001D_NEO4J_PREFLIGHT_FAILED'); }
    try { await redis.ping(); }
    catch { throw new Error('RET001D_REDIS_PREFLIGHT_FAILED'); }
    observedServices = {
      redis: {
        containerId: config.redisContainerId,
        imageId: config.redisImageId,
        version: await observeRedisVersion(redis),
      },
      neo4j: {
        containerId: config.neo4jContainerId,
        imageId: config.neo4jImageId,
        version: await observeNeo4jVersion(driver, config.requestTimeoutMs),
      },
    };
    try { await redis.set(ownedRedisKeys[0]!, 'owned', 'EX', 900); }
    catch { throw new Error('RET001D_REDIS_OWNERSHIP_FAILED'); }
    await seedFixtures(driver, fixture, config.requestTimeoutMs);
    active = new CompositionRoot(config, 'single-default', exportPath);
    readinessEvidence.push({ mode: 'single-default', ...await active.waitUntilReady() });
    const defaultTransport = new TraceMcpTransport(config, config.defaultToken);
    const defaultIsolation = tenantIsolationForbiddenValues('default', fixture);
    cases.push(await executeCase(defaultTransport, {
      id: 'deterministic', requestedStrategy: 'deterministic', expectedAlgorithm: 'deterministic-v2',
      authScope: 'default', task: queries.deterministic, projectName: fixture.defaultProject,
      expectedStrategy: 'deterministic',
      requiredPresentationId: requiredPresentationIdForCase('deterministic', fixture),
    }, [...forbidden, ...defaultIsolation], defaultIsolation));
    cases.push(await executeCase(defaultTransport, {
      id: 'ranked', requestedStrategy: 'ranked', expectedAlgorithm: 'ranked-v1',
      authScope: 'default', task: queries.ranked, projectName: fixture.defaultProject,
      expectedStrategy: 'ranked', requiredPresentationId: requiredPresentationIdForCase('ranked', fixture),
    }, [...forbidden, ...defaultIsolation], defaultIsolation));
    cases.push(await executeCase(defaultTransport, {
      id: 'auto', requestedStrategy: 'auto', expectedAlgorithm: 'deterministic-v2',
      authScope: 'default', task: queries.auto, projectName: fixture.defaultProject,
      expectedStrategy: 'deterministic', requiredPresentationId: requiredPresentationIdForCase('auto', fixture),
    }, [...forbidden, ...defaultIsolation], defaultIsolation));
    await active.stop();
    active = undefined;

    active = new CompositionRoot(config, 'named-tenant', exportPath);
    readinessEvidence.push({ mode: 'named-tenant', ...await active.waitUntilReady() });
    const namedTransport = new TraceMcpTransport(config, config.namedToken);
    const namedIsolation = tenantIsolationForbiddenValues('named-tenant', fixture);
    cases.push(await executeCase(namedTransport, {
      id: 'named-tenant-forced-ranked', requestedStrategy: 'deterministic', expectedAlgorithm: 'ranked-v1',
      authScope: 'named-tenant', task: queries.named, projectName: fixture.namedProject,
      expectedStrategy: 'ranked',
      requiredPresentationId: requiredPresentationIdForCase('named-tenant-forced-ranked', fixture),
    }, [...forbidden, ...namedIsolation], namedIsolation));
    await active.stop();
    active = undefined;
    childProcessesStopped = true;
  } catch (error) {
    executionError = new Error(safeDiagnosticCode(error));
  } finally {
    const cleanupErrors: Error[] = [];
    try { if (active) await active.stop(); childProcessesStopped = true; }
    catch (error) { cleanupErrors.push(new Error(safeDiagnosticCode(error))); }
    try {
      if (driver) graphResidual = await cleanupFixtures(driver, run, config.requestTimeoutMs);
    } catch (error) { cleanupErrors.push(new Error(safeDiagnosticCode(error))); }
    try {
      if (redis && redisSnapshotEstablished) {
        redisResidual = await cleanupOwnedRedisKeys(redis, redisBefore, ownedRedisKeys, config.requestTimeoutMs);
      } else if (redis) {
        await redis.del(...ownedRedisKeys).catch(() => { throw new Error('RET001D_REDIS_CLEANUP_FAILED'); });
      }
    } catch (error) { cleanupErrors.push(new Error(safeDiagnosticCode(error))); }
    try {
      if (driver) await driver.close().catch(() => { throw new Error('RET001D_NEO4J_CLOSE_FAILED'); });
    } catch (error) { cleanupErrors.push(new Error(safeDiagnosticCode(error))); }
    try {
      if (redis) redis.disconnect();
    } catch (error) { cleanupErrors.push(new Error(safeDiagnosticCode(error))); }
    try {
      if (tempPath) {
        await rm(tempPath, { recursive: true, force: true });
      }
      tempRemoved = true;
    } catch (error) { cleanupErrors.push(new Error(safeDiagnosticCode(error))); }
    if (cleanupErrors.length) {
      const errors = [...(executionError ? [executionError] : []), ...cleanupErrors];
      throw new AggregateError(errors, 'RET001D_EVIDENCE_FAILED');
    }
  }

  if (executionError) throw executionError;
  if (cases.length !== 4 || graphResidual.nodes !== 0 || graphResidual.relationships !== 0
    || redisResidual.ownedRemaining !== 0 || redisResidual.unexpectedNewKeys !== 0) {
    throw new Error('RET001D_CLEANUP_OR_CASE_COUNT_INVALID');
  }
  if (!observedServices) throw new Error('RET001D_SERVICE_IDENTITY_MISSING');
  let observedGit: { sha: string; dirty: false };
  try { observedGit = await gitState(config.requestTimeoutMs); }
  catch { throw new Error('RET001D_GIT_STATE_FAILED'); }
  const manifestTruth = {
    git: observedGit,
    runtime: { node: process.version, platform: process.platform, arch: process.arch },
    config: config.safeConfig,
    services: observedServices,
  } as const;
  const manifest = sanitizeTraceConformanceManifest({
    schemaVersion: 1,
    packet: 'RET-001D',
    generatedAt: new Date().toISOString(),
    git: manifestTruth.git,
    runtime: manifestTruth.runtime,
    config: config.safeConfig,
    services: observedServices,
    result: {
      fidelity: 'composition-root / live-disposable-persistence',
      cases,
      readiness: {
        singleDefault: {
          httpStatus: readinessEvidence.find(({ mode }) => mode === 'single-default')?.status,
          classification: readinessEvidence.find(({ mode }) => mode === 'single-default')?.classification,
        },
        namedTenant: {
          httpStatus: readinessEvidence.find(({ mode }) => mode === 'named-tenant')?.status,
          classification: readinessEvidence.find(({ mode }) => mode === 'named-tenant')?.classification,
        },
      },
      invariants: {
        canonicalValidation: true,
        replayResultOrder: true,
        noTraceParity: true,
        secretContentSafety: true,
        boundedExecution: true,
        tenantIsolation: true,
      },
    },
    cleanup: {
      fixtureNodesRemaining: graphResidual.nodes,
      fixtureRelationshipsRemaining: graphResidual.relationships,
      redisKeysRemaining: redisResidual.ownedRemaining + redisResidual.unexpectedNewKeys,
      childProcessesStopped,
      temporaryExportPathRemoved: tempRemoved,
      disposableServiceOwnership: 'caller-provided-loopback-services',
    },
  }, forbidden, manifestTruth) as JsonRecord;
  assertTraceConformanceManifest(manifest, manifestTruth);
  const serialized = `${JSON.stringify(manifest, null, 2)}\n`;
  for (const value of forbidden) if (value && serialized.includes(value)) throw new Error('RET001D_MANIFEST_FORBIDDEN_VALUE');
  if (config.evidencePath) {
    try {
      await mkdir(dirname(config.evidencePath), { recursive: true });
      await runAbortableOperation(
        (signal) => writeFile(config.evidencePath!, serialized, { encoding: 'utf8', signal }),
        config.requestTimeoutMs, 'RET001D_EVIDENCE_WRITE_TIMEOUT', 'RET001D_EVIDENCE_WRITE_FAILED',
      );
    } catch (error) {
      if (safeDiagnosticCode(error) !== 'RET001D_INTERNAL_FAILURE') throw error;
      throw new Error('RET001D_EVIDENCE_WRITE_FAILED');
    }
  }
  return manifest;
}

async function main(): Promise<void> {
  const evidence = await runTraceLiveConformanceEvidence(resolveTraceConformanceConfig());
  console.log(JSON.stringify({
    ok: true,
    packet: evidence.packet,
    sha: (evidence.git as JsonRecord).sha,
    caseCount: ((evidence.result as JsonRecord).cases as unknown[]).length,
    cleanup: evidence.cleanup,
  }));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(safeDiagnosticCode(error));
    process.exitCode = 1;
  });
}
