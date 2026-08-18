import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'vitest';

import { compareQualityReports } from '../compare-quality.js';
import { loadComparisonPolicy } from '../compare-quality.js';
import { requireGateResult } from '../ci-gate.js';
import { loadAndVerifyBaseline, validateBaselineManifest, verifyBaselineCommands, verifyBaselineGitArtifacts } from '../verify.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const BASELINE_PATH = resolve(HERE, '..', 'memberry-7a31231.json');
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

test('the immutable baseline manifest is structurally valid and its git artifacts match', async () => {
  const manifest = JSON.parse(await readFile(BASELINE_PATH, 'utf8'));
  assert.deepEqual(validateBaselineManifest(manifest), []);
  await assert.doesNotReject(verifyBaselineGitArtifacts(manifest, REPO_ROOT));
  await assert.doesNotReject(loadAndVerifyBaseline(
    BASELINE_PATH,
    resolve(HERE, '..', 'baseline.lock.json'),
    REPO_ROOT,
  ));
});

test('CI jobs that verify immutable Git baselines fetch complete history', async () => {
  const workflow = (await readFile(resolve(REPO_ROOT, '.github', 'workflows', 'ci.yml'), 'utf8'))
    .replace(/\r\n?/g, '\n');
  const gateJobs = workflow
    .split(/\n(?= {2}[A-Za-z0-9_-]+:\s*\n)/)
    .filter((block) => block.includes('run: npm run bench:lab:ci'));

  assert.ok(gateJobs.length > 0, 'CI must execute the deterministic evaluation-lab gate');
  for (const job of gateJobs) {
    assert.match(
      job,
      /- uses: actions\/checkout@v4\s*\n\s+with:\s*\n(?:\s*#.*\n)*\s+fetch-depth:\s*0(?:\s|$)/,
      'immutable baseline verification requires actions/checkout fetch-depth: 0',
    );
  }
});

test('quality comparison passes an identical candidate', async () => {
  const manifest = JSON.parse(await readFile(BASELINE_PATH, 'utf8'));
  const candidate = {
    corpusSize: manifest.results.quality.corpusSize,
    queryCount: manifest.results.quality.queryCount,
    passed: true,
    metrics: { ...manifest.results.quality.metrics },
  };
  const comparison = compareQualityReports(manifest, candidate);
  assert.equal(comparison.passed, true);
  assert.deepEqual(comparison.failures, []);
});

test('quality comparison explains regressions and rejects missing metrics', async () => {
  const manifest = JSON.parse(await readFile(BASELINE_PATH, 'utf8'));
  const candidate = {
    corpusSize: manifest.results.quality.corpusSize,
    queryCount: manifest.results.quality.queryCount,
    passed: true,
    metrics: { ...manifest.results.quality.metrics, recallAt10: 0.5 },
  };
  delete candidate.metrics.mrr;

  const comparison = compareQualityReports(manifest, candidate);
  assert.equal(comparison.passed, false);
  assert.ok(comparison.failures.some((failure) => failure.includes('recallAt10')));
  assert.ok(comparison.failures.some((failure) => failure.includes('mrr') && failure.includes('missing')));
});

test('required CI gates cannot silently return no result', () => {
  assert.throws(() => requireGateResult('quality', undefined), /refusing to skip/);
  assert.throws(() => requireGateResult('comparison', null), /refusing to skip/);
});

test('the package CI entrypoint cannot silently exit before publishing structural evidence', () => {
  const npmCli = process.env['npm_execpath'];
  assert.ok(npmCli, 'npm_execpath is required to execute the package CI gate');
  const output = execFileSync(process.execPath, [npmCli, 'run', 'bench:lab:ci'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env: { ...process.env, REDIS_URL: '', NEO4J_URI: '' },
    timeout: 30_000,
  });
  assert.match(output, /Evaluation-lab deterministic gate passed/);
  assert.match(output, /Admission structural artifact:/);
}, 35_000);

test('baseline verification rejects a recorded command that never existed', async () => {
  const manifest = JSON.parse(await readFile(BASELINE_PATH, 'utf8'));
  manifest.commands = ['npm run bench:does-not-exist'];
  await assert.rejects(
    verifyBaselineCommands(manifest, REPO_ROOT),
    /nonexistent npm script/,
  );
});

test('minImprovement requires a material gain, not parity or a near miss', async () => {
  const manifest = JSON.parse(await readFile(BASELINE_PATH, 'utf8'));
  const policy = {
    schemaVersion: 1,
    baseline: manifest.id,
    requireCandidatePass: true,
    requireSameCorpus: true,
    rules: [{ metric: 'precisionAt5', direction: 'higher' as const, allowedRegression: 0, minImprovement: 0.05 }],
  };
  const candidateAt = (precisionAt5: number) => ({
    corpusSize: manifest.results.quality.corpusSize,
    queryCount: manifest.results.quality.queryCount,
    passed: true,
    metrics: { ...manifest.results.quality.metrics, precisionAt5 },
  });
  // Baseline precisionAt5 is 0.4000: +0.0 and +0.049 fail; +0.05 passes.
  assert.equal(manifest.results.quality.metrics.precisionAt5, 0.39999999999999997);
  assert.equal(compareQualityReports(manifest, candidateAt(0.4), policy).passed, false);
  assert.equal(compareQualityReports(manifest, candidateAt(0.449), policy).passed, false);
  assert.equal(compareQualityReports(manifest, candidateAt(0.45), policy).passed, true);
});

test('minImprovement on a lower-direction metric requires a material reduction', async () => {
  const manifest = JSON.parse(await readFile(BASELINE_PATH, 'utf8'));
  const synthetic = JSON.parse(JSON.stringify(manifest));
  synthetic.results.quality.metrics.staleLeakRate = 0.2;
  const policy = {
    schemaVersion: 1,
    baseline: synthetic.id,
    requireCandidatePass: true,
    requireSameCorpus: true,
    rules: [{ metric: 'staleLeakRate', direction: 'lower' as const, allowedRegression: 0, minImprovement: 0.1 }],
  };
  const candidateAt = (staleLeakRate: number) => ({
    corpusSize: synthetic.results.quality.corpusSize,
    queryCount: synthetic.results.quality.queryCount,
    passed: true,
    metrics: { ...synthetic.results.quality.metrics, staleLeakRate },
  });
  assert.equal(compareQualityReports(synthetic, candidateAt(0.1), policy).passed, true);
  assert.equal(compareQualityReports(synthetic, candidateAt(0.15), policy).passed, false);
});

test('the committed comparison policy stays inert: g2Thresholds declared, rules unarmed', async () => {
  const manifest = JSON.parse(await readFile(BASELINE_PATH, 'utf8'));
  const policy = await loadComparisonPolicy();
  assert.deepEqual(policy.g2Thresholds, {
    precisionAt5: { minImprovement: 0.05, armed: false, armsWith: 'RET-006' },
  });
  assert.ok(policy.rules.every((rule) => !('minImprovement' in rule)), 'no committed rule may be armed');
  const candidate = {
    corpusSize: manifest.results.quality.corpusSize,
    queryCount: manifest.results.quality.queryCount,
    passed: true,
    metrics: { ...manifest.results.quality.metrics },
  };
  // Rule outcomes with the committed policy are identical to the no-policy default.
  assert.deepEqual(
    compareQualityReports(manifest, candidate, policy),
    compareQualityReports(manifest, candidate),
  );
});
