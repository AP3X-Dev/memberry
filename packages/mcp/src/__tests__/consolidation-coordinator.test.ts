import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ConsolidationCoordinator,
  getConsolidationAutomationHealth,
  recoverEpisodeScopes,
  type ConsolidationCoordinatorConfig,
} from '../consolidation-coordinator.js';

const baseConfig: ConsolidationCoordinatorConfig = {
  enabled: true,
  readonly: false,
  startupDelayMs: 100,
  debounceMs: 50,
  catchupIntervalMs: 1_000,
  retryBaseMs: 10,
  retryMaxMs: 40,
  maxRetries: 3,
  healthGraceMs: 100,
  staleAfterMs: 5_000,
};

const active: ConsolidationCoordinator[] = [];

function create(options: Partial<ConstructorParameters<typeof ConsolidationCoordinator>[0]> = {}) {
  const coordinator = new ConsolidationCoordinator({
    name: `test-${active.length}`,
    config: baseConfig,
    run: vi.fn().mockResolvedValue({ skipped: false, applied: [] }),
    discoverScopes: vi.fn().mockResolvedValue([]),
    logger: { error: vi.fn() },
    ...options,
  });
  active.push(coordinator);
  return coordinator;
}

beforeEach(() => vi.useFakeTimers());

afterEach(async () => {
  await Promise.all(active.splice(0).map((coordinator) => coordinator.stop()));
  vi.useRealTimers();
});

describe('ConsolidationCoordinator', () => {
  it('debounces stores per project scope and globally serializes runs', async () => {
    let concurrent = 0;
    let maxConcurrent = 0;
    const run = vi.fn(async () => {
      concurrent += 1;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await new Promise((resolve) => setTimeout(resolve, 20));
      concurrent -= 1;
      return { skipped: false, applied: [] };
    });
    const coordinator = create({ run });
    coordinator.start();

    coordinator.schedule('project:Alpha');
    coordinator.schedule('project:alpha');
    coordinator.schedule('project:beta');
    await vi.advanceTimersByTimeAsync(100);

    expect(run.mock.calls.map(([scope]) => scope)).toEqual(['project:alpha', 'project:beta']);
    expect(maxConcurrent).toBe(1);
  });

  it('runs startup and periodic catch-up for any concrete scope but never global', async () => {
    const run = vi.fn().mockResolvedValue({ skipped: false, applied: [] });
    const discoverScopes = vi.fn().mockResolvedValue([
      'project:alpha',
      'global',
      '',
      'project:beta',
      'agent:research',
    ]);
    const coordinator = create({ run, discoverScopes });
    coordinator.start();

    await vi.advanceTimersByTimeAsync(100);
    expect(run.mock.calls.map(([scope]) => scope)).toEqual([
      'project:alpha', 'project:beta', 'agent:research',
    ]);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(discoverScopes).toHaveBeenCalledTimes(2);
    expect(run).toHaveBeenCalledTimes(6);
    expect(run).not.toHaveBeenCalledWith('global');
  });

  it('recovers legacy project attribution from tags and task/content prefixes', () => {
    expect(recoverEpisodeScopes([
      { scope: 'agent:research' },
      { tags: ['backend', 'Project:Memberry'] },
      { task: '[project:Legacy.Task] completed migration' },
      { content: '[PROJECT:Content-Fallback] decision' },
      { scope: 'global', tags: ['misc'] },
      { scope: 'PROJECT:MEMBERRY' },
    ])).toEqual([
      'agent:research',
      'project:content-fallback',
      'project:legacy.task',
      'project:memberry',
    ]);
  });

  it('retries failed work with bounded exponential backoff and publishes applied mutations', async () => {
    const run = vi.fn()
      .mockRejectedValueOnce(new Error('redis unavailable'))
      .mockRejectedValueOnce(new Error('redis unavailable'))
      .mockResolvedValue({ skipped: false, applied: ['proposal-1'] });
    const onMutation = vi.fn().mockResolvedValue(undefined);
    const coordinator = create({ run, onMutation });
    coordinator.start();
    coordinator.schedule('project:alpha');

    await vi.advanceTimersByTimeAsync(50);
    expect(run).toHaveBeenCalledTimes(1);
    expect(coordinator.snapshot().pending_retries[0]).toMatchObject({ attempt: 1 });
    await vi.advanceTimersByTimeAsync(10);
    expect(run).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(20);
    expect(run).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(50);
    expect(onMutation).toHaveBeenCalledTimes(1);
    expect(coordinator.snapshot().pending_retries).toEqual([]);
    expect(coordinator.snapshot().last_success_at).not.toBeNull();
    expect(coordinator.snapshot().last_error).toBeNull();
  });

  it('retries publication without re-running the applied graph mutation', async () => {
    const run = vi.fn().mockResolvedValue({ skipped: false, applied: ['proposal-1'] });
    const onMutation = vi.fn()
      .mockRejectedValueOnce(new Error('disk unavailable'))
      .mockResolvedValue(undefined);
    const coordinator = create({ run, onMutation });
    coordinator.start();
    coordinator.schedule('project:alpha');

    await vi.advanceTimersByTimeAsync(50);
    expect(run).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(50);
    expect(onMutation).toHaveBeenCalledTimes(1);
    expect(coordinator.snapshot().publication.pending_retry).toMatchObject({ attempt: 1 });
    await vi.advanceTimersByTimeAsync(10);
    expect(onMutation).toHaveBeenCalledTimes(2);
    expect(run).toHaveBeenCalledTimes(1);
    expect(coordinator.snapshot().publication.last_error).toBeNull();
  });

  it('becomes unhealthy only after retry exhaustion and startup grace', async () => {
    const coordinator = create({
      config: { ...baseConfig, maxRetries: 1, startupDelayMs: 10_000 },
      onMutation: vi.fn().mockRejectedValue(new Error('read-only filesystem')),
    });
    coordinator.start();
    await coordinator.schedulePublication();

    await vi.advanceTimersByTimeAsync(50);
    expect(coordinator.snapshot().health).toBe('recovering');
    await vi.advanceTimersByTimeAsync(10);
    expect(coordinator.snapshot().publication.exhausted_failure).toBe(true);
    expect(coordinator.snapshot().health).toBe('recovering');
    await vi.advanceTimersByTimeAsync(40);
    expect(coordinator.snapshot().health).toBe('unhealthy');
    expect((getConsolidationAutomationHealth() as { unhealthy: boolean }).unhealthy).toBe(true);
  });

  it('does not let successful scope discovery erase an exhausted run failure', async () => {
    const coordinator = create({
      config: { ...baseConfig, maxRetries: 0, startupDelayMs: 10_000 },
      run: vi.fn().mockRejectedValue(new Error('neo4j unavailable')),
      discoverScopes: vi.fn().mockResolvedValue([]),
    });
    coordinator.start();
    coordinator.schedule('agent:research');
    await vi.advanceTimersByTimeAsync(50);
    expect(coordinator.snapshot().exhausted_failure).toBe(true);

    await coordinator.catchUp();
    expect(coordinator.snapshot().exhausted_failure).toBe(true);
    expect(coordinator.snapshot().last_error).toContain('neo4j unavailable');
  });

  it('persists dirty publication intent across shutdown and repairs it on startup', async () => {
    let dirty = 0;
    let published = 0;
    const publicationState = {
      markDirty: vi.fn(async () => ++dirty),
      versions: vi.fn(async () => ({ dirty, published })),
      markPublished: vi.fn(async (version: number) => { published = version; }),
    };
    const first = create({ onMutation: vi.fn(), publicationState });
    first.start();
    await first.schedulePublication();
    expect(dirty).toBe(1);
    await first.stop(); // debounce is cancelled, durable version is not
    expect(published).toBe(0);

    const compile = vi.fn().mockResolvedValue(undefined);
    const recovered = create({ onMutation: compile, publicationState });
    recovered.start();
    await vi.advanceTimersByTimeAsync(100);
    expect(compile).toHaveBeenCalledTimes(1);
    expect(published).toBe(1);
    // Startup catch-up immediately records a second conservative reconciliation
    // in case graph commit preceded dirty-intent persistence before the restart.
    expect(recovered.snapshot().publication.dirty_version).toBe(2);
    expect(recovered.snapshot().publication.published_version).toBe(1);
    await vi.advanceTimersByTimeAsync(50);
    expect(compile).toHaveBeenCalledTimes(2);
    expect(published).toBe(2);
  });

  it('recompiles on startup even when counters look clean after a graph-before-dirty crash', async () => {
    let dirty = 4;
    let published = 4;
    const compile = vi.fn().mockResolvedValue(undefined);
    const publicationState = {
      markDirty: vi.fn(async () => ++dirty),
      versions: vi.fn(async () => ({ dirty, published })),
      markPublished: vi.fn(async (version: number) => { published = version; }),
    };
    const recovered = create({ onMutation: compile, publicationState });
    recovered.start();

    await vi.advanceTimersByTimeAsync(150);

    expect(publicationState.markDirty).toHaveBeenCalledOnce();
    expect(compile).toHaveBeenCalledOnce();
    expect(published).toBe(5);
  });

  it('is a timer-free no-op in read-only mode and exposes status safely', async () => {
    const run = vi.fn();
    const discoverScopes = vi.fn();
    const coordinator = create({
      config: { ...baseConfig, readonly: true },
      run,
      discoverScopes,
      limitation: 'tenant-qualified runs unavailable',
    });
    coordinator.start();
    coordinator.schedule('project:alpha');
    await vi.advanceTimersByTimeAsync(10_000);

    expect(run).not.toHaveBeenCalled();
    expect(discoverScopes).not.toHaveBeenCalled();
    const status = getConsolidationAutomationHealth() as {
      enabled: boolean;
      degraded: boolean;
      limitations: string[];
      workers: Array<{ readonly: boolean; running_scope: string | null }>;
    };
    expect(status.enabled).toBe(false);
    expect(status.degraded).toBe(true);
    expect(status.limitations[0]).toContain('tenant-qualified runs unavailable');
    expect(status.workers).toEqual([
      expect.objectContaining({ readonly: true, running_scope: null }),
    ]);
  });

  it('stops timers and waits for an in-flight run before shutdown resolves', async () => {
    let finish!: () => void;
    const run = vi.fn(() => new Promise<{ skipped: boolean; applied: string[] }>((resolve) => {
      finish = () => resolve({ skipped: false, applied: [] });
    }));
    const coordinator = create({ run });
    coordinator.start();
    coordinator.schedule('project:alpha');
    await vi.advanceTimersByTimeAsync(50);
    expect(run).toHaveBeenCalledTimes(1);

    let stopped = false;
    const stopping = coordinator.stop().then(() => { stopped = true; });
    await Promise.resolve();
    expect(stopped).toBe(false);
    finish();
    await stopping;
    expect(stopped).toBe(true);
  });
});
