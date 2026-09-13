import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  parseReleaseGateReceipts,
  REQUIRED_RELEASE_GATE_STAGES,
} from '../release-gate-status.mjs';

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const RUNNER = resolve(TEST_DIR, '../release-gate-runner.sh').replaceAll('\\', '/');

function shellPath() {
  if (process.platform !== 'win32') return '/bin/sh';
  const candidates = [
    `${process.env.ProgramFiles ?? 'C:/Program Files'}/Git/bin/bash.exe`,
    `${process.env.ProgramFiles ?? 'C:/Program Files'}/Git/usr/bin/bash.exe`,
  ];
  return candidates.find(existsSync);
}

function receipts(overrides = new Map()) {
  return REQUIRED_RELEASE_GATE_STAGES.map(
    (stage) => `${stage}_EXIT=${overrides.get(stage) ?? 0}`,
  ).join('\n');
}

test('accepts exactly one successful receipt for every required stage', () => {
  const result = parseReleaseGateReceipts(receipts());
  assert.equal(result.ok, true);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.failedStages, []);
});

for (const stage of REQUIRED_RELEASE_GATE_STAGES) {
  test(`fails the aggregate when ${stage} fails`, () => {
    const result = parseReleaseGateReceipts(receipts(new Map([[stage, 17]])));
    assert.equal(result.ok, false);
    assert.deepEqual(result.errors, []);
    assert.deepEqual(result.failedStages, [stage]);
    assert.equal(result.receipts.size, REQUIRED_RELEASE_GATE_STAGES.length);
  });
}

test('fails closed on a missing receipt', () => {
  const result = parseReleaseGateReceipts(
    receipts().split('\n').filter((line) => !line.startsWith('BUILD_')).join('\n'),
  );
  assert.equal(result.ok, false);
  assert.deepEqual(result.failedStages, ['BUILD']);
  assert.deepEqual(result.errors, ['missing receipt for BUILD']);
});

test('fails closed on duplicate, malformed, unexpected, or invalid receipts', () => {
  for (const extra of [
    'BUILD_EXIT=0',
    'not-a-receipt',
    'SURPRISE_EXIT=0',
    'BUILD_EXIT=999',
  ]) {
    const result = parseReleaseGateReceipts(`${receipts()}\n${extra}`);
    assert.equal(result.ok, false, extra);
    assert.ok(result.errors.length > 0, extra);
  }
});

test('the production stage runner records every later stage after each injected failure', async (t) => {
  const shell = shellPath();
  if (!shell) {
    t.skip('POSIX shell unavailable');
    return;
  }
  const root = await mkdtemp(join(tmpdir(), 'memberry-release-gate-runner-'));
  try {
    for (const failedStage of REQUIRED_RELEASE_GATE_STAGES) {
      const runRoot = join(root, failedStage);
      const status = join(runRoot, 'status').replaceAll('\\', '/');
      const logRoot = runRoot.replaceAll('\\', '/');
      const stages = REQUIRED_RELEASE_GATE_STAGES.join(' ');
      const script = `
        set -eu
        mkdir -p '${logRoot}'
        : > '${status}'
        . '${RUNNER}'
        for stage in ${stages}; do
          if [ "$stage" = '${failedStage}' ]; then
            run_release_gate_stage '${status}' '${logRoot}' "$stage" "$stage.log" sh -c 'echo injected-failure; exit 17'
          else
            run_release_gate_stage '${status}' '${logRoot}' "$stage" "$stage.log" sh -c 'echo completed; exit 0'
          fi
        done
      `;
      const executed = spawnSync(shell, ['-c', script], { encoding: 'utf8' });
      assert.equal(executed.status, 0, executed.stderr);
      const parsed = parseReleaseGateReceipts(await readFile(status, 'utf8'));
      assert.equal(parsed.ok, false);
      assert.deepEqual(parsed.failedStages, [failedStage]);
      assert.equal(parsed.receipts.size, REQUIRED_RELEASE_GATE_STAGES.length);
      const logs = (await readdir(runRoot)).filter((name) => name.endsWith('.log'));
      assert.equal(logs.length, REQUIRED_RELEASE_GATE_STAGES.length);
      assert.match(await readFile(join(runRoot, `${failedStage}.log`), 'utf8'), /injected-failure/);
      assert.match(
        await readFile(join(runRoot, `${REQUIRED_RELEASE_GATE_STAGES.at(-1)}.log`), 'utf8'),
        failedStage === REQUIRED_RELEASE_GATE_STAGES.at(-1) ? /injected-failure/ : /completed/,
      );
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
