// packages/mcp/src/__tests__/bootstrap.lifecycle-scheduler.test.ts
//
// Item 13a (audit A1/D2/D3): the MEM-006 lifecycle pass runs in-process
// behind MEMBERRY_LIFECYCLE_V1=live instead of only via the CLI/systemd
// timer nobody installs under Docker. Fake-timer tests pin the scheduler
// contract; source assertions pin the bootstrap wiring (bootstrap() itself
// needs live Neo4j/Redis, so it is not executed here).

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { startLifecycleScheduler } from '../bootstrap.js';

const BOOTSTRAP_SOURCE = fs.readFileSync(path.resolve(__dirname, '../bootstrap.ts'), 'utf-8');
const MIN = 60_000;
const HOUR = 3_600_000;

function summary() {
  return { run_id: 'r', started_at: 't', dry_run: false, scopes: [{}, {}], failures: [] };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('startLifecycleScheduler', () => {
  it('runs 5 minutes after boot, then once per interval, and logs the summary counts', async () => {
    const run = vi.fn(async () => summary());
    const log = vi.fn();
    const handle = startLifecycleScheduler({ run, intervalMs: HOUR, log });
    await vi.advanceTimersByTimeAsync(5 * MIN - 1);
    expect(run).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(run).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(HOUR);
    expect(run).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(HOUR);
    expect(run).toHaveBeenCalledTimes(3);
    expect(log).toHaveBeenCalledWith('[lifecycle] pass complete: scopes=2 failures=0');
    handle.stop();
  });

  it('skips a tick while the previous pass is still running', async () => {
    let release!: () => void;
    const run = vi.fn(() => new Promise<ReturnType<typeof summary>>((resolve) => { release = () => resolve(summary()); }));
    const log = vi.fn();
    const handle = startLifecycleScheduler({ run, intervalMs: HOUR, log });
    await vi.advanceTimersByTimeAsync(5 * MIN);
    expect(run).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(HOUR);
    expect(run).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith('[lifecycle] skipped: previous pass still running');
    release();
    await vi.advanceTimersByTimeAsync(HOUR);
    expect(run).toHaveBeenCalledTimes(2);
    handle.stop();
  });

  it('a thrown pass is logged by error class (never message) and the schedule continues', async () => {
    const run = vi.fn()
      .mockRejectedValueOnce(new RangeError('secret-bearing message'))
      .mockResolvedValue(summary());
    const log = vi.fn();
    const handle = startLifecycleScheduler({ run, intervalMs: HOUR, log });
    await vi.advanceTimersByTimeAsync(5 * MIN);
    expect(log).toHaveBeenCalledWith('[lifecycle] pass failed: RangeError');
    expect(log.mock.calls.flat().join('\n')).not.toContain('secret-bearing');
    await vi.advanceTimersByTimeAsync(HOUR);
    expect(run).toHaveBeenCalledTimes(2);
    handle.stop();
  });

  it('stop() clears both timers so nothing runs afterwards', async () => {
    const run = vi.fn(async () => summary());
    const handle = startLifecycleScheduler({ run, intervalMs: HOUR, log: () => {} });
    handle.stop();
    await vi.advanceTimersByTimeAsync(5 * MIN + 2 * HOUR);
    expect(run).not.toHaveBeenCalled();
    const handle2 = startLifecycleScheduler({ run, intervalMs: HOUR, log: () => {} });
    await vi.advanceTimersByTimeAsync(5 * MIN + HOUR);
    expect(run).toHaveBeenCalledTimes(2);
    handle2.stop();
    await vi.advanceTimersByTimeAsync(HOUR);
    expect(run).toHaveBeenCalledTimes(2);
  });
});

describe('bootstrap.ts lifecycle wiring', () => {
  it('constructs the scheduler only when MEMBERRY_LIFECYCLE_V1 resolves live, after the coordinator starts, on the shared core', () => {
    const start = BOOTSTRAP_SOURCE.indexOf('consolidationCoordinator.start();');
    const wiring = BOOTSTRAP_SOURCE.indexOf('resolveLifecycleConfig(defaultExportPath())');
    expect(start).toBeGreaterThan(0);
    expect(wiring).toBeGreaterThan(start);
    expect(BOOTSTRAP_SOURCE).toContain("lifecycleConfig.mode === 'live'");
    expect(BOOTSTRAP_SOURCE).toContain('runLifecyclePass(core, { config: lifecycleConfig })');
    expect(BOOTSTRAP_SOURCE).toContain("'MEMBERRY_LIFECYCLE_INTERVAL_MS'");
    expect(BOOTSTRAP_SOURCE).toContain('lifecycleScheduler?.stop()');
  });
});
