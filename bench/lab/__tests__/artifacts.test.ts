import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ScopeAwareBm25ControlAdapter } from '../adapters/baselines.js';
import { MemBerryProxyAdapter } from '../adapters/memberry-proxy.js';
import { createRunManifest, writeComparisonArtifacts } from '../artifacts.js';
import { renderComparisonMarkdown } from '../artifacts.js';
import type { ComparisonReport, LabContextAccounting } from '../contracts/report.js';
import { TEMPORAL_ISOLATION_SCENARIOS } from '../fixtures/temporal-isolation.js';
import { compareAdapters } from '../runner.js';
import type { LabBootstrapInterval } from '../stats.js';

const temporaryRoots: string[] = [];

afterEach(async () => {
  for (const root of temporaryRoots.splice(0)) await rm(root, { recursive: true, force: true });
});

function manifest() {
  return createRunManifest({
    runId: 'atomic-artifact-run',
    createdAt: '2026-08-14T12:00:00.000Z',
    gitCommit: 'abcdef1234567890',
    baselineCommit: '7a31231',
    gitDirty: true,
    datasetId: 'temporal-isolation-v1',
    datasetHash: '1'.repeat(64),
    configHash: `sha256:${'2'.repeat(64)}`,
    config: { model: 'fixture', credentials: false, authorization: 'Bearer secret', nested: { api_key: 'secret' } },
    seed: 42,
    controlAdapter: 'scope-aware-bm25-control-v1',
    candidateAdapter: 'memberry-proxy-v1',
  });
}

describe('run artifacts', () => {
  it('normalizes hashes and recursively redacts secret configuration', () => {
    const value = manifest();
    expect(value.datasetHash).toBe(`sha256:${'1'.repeat(64)}`);
    expect(value.configHash).toBe(`sha256:${'2'.repeat(64)}`);
    expect(value.config).toEqual({ model: 'fixture', credentials: false, authorization: '[REDACTED]', nested: { api_key: '[REDACTED]' } });
    expect(value.gitDirty).toBe(true);
    expect(() => createRunManifest({ ...value, datasetHash: 'not-a-hash' })).toThrow('datasetHash');
  });

  it('atomically publishes one immutable artifact directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'memberry-lab-artifacts-'));
    temporaryRoots.push(root);
    const destination = join(root, 'run');
    const comparison = await compareAdapters({
      runId: 'artifact-comparison',
      control: new ScopeAwareBm25ControlAdapter(),
      candidate: new MemBerryProxyAdapter(),
      scenarios: TEMPORAL_ISOLATION_SCENARIOS,
    });
    const value = manifest();
    const paths = await writeComparisonArtifacts(destination, comparison, value);
    expect((await readdir(destination)).sort()).toEqual(['comparison.json', 'comparison.md', 'manifest.json']);
    expect(JSON.parse(await readFile(paths.manifest, 'utf8'))).toEqual(value);
    expect(await readFile(paths.markdown, 'utf8')).toContain('Baseline commit: `7a31231`');

    await expect(writeComparisonArtifacts(destination, comparison, value)).rejects.toThrow();
    expect((await readdir(root)).filter((name) => name.startsWith('.atomic-artifact-run.tmp-'))).toEqual([]);
  });
});

function measuredAccounting(taskSuccessTotal: number, contextTokens: number): LabContextAccounting {
  return {
    estimatorId: 'chars-div-4-ceil-v1',
    scoredProbes: 10,
    contextTokens,
    taskSuccessTotal,
    outcome: 'measured',
    taskSuccessPer1kTokens: (1000 * taskSuccessTotal) / contextTokens,
  };
}

async function comparisonReport(): Promise<ComparisonReport> {
  return compareAdapters({
    runId: 'efficiency-artifact-comparison',
    control: new ScopeAwareBm25ControlAdapter(),
    candidate: new MemBerryProxyAdapter(),
    scenarios: TEMPORAL_ISOLATION_SCENARIOS,
  });
}

describe('context efficiency rendering', () => {
  it('renders the measured shape with the proxy sentence and integer token totals', async () => {
    const interval: LabBootstrapInterval = {
      outcome: 'measured',
      pairedProbes: 10,
      resamples: 2000,
      level: 0.95,
      seed: 1234567,
      point: 1.5,
      lower: -0.25,
      upper: 3.25,
      oneSidedLower: 0.125,
    };
    const report: ComparisonReport = {
      ...(await comparisonReport()),
      efficiency: {
        metric: 'taskSuccessPer1kTokens',
        control: measuredAccounting(8, 525),
        candidate: measuredAccounting(9, 500),
        delta: (1000 * 9) / 500 - (1000 * 8) / 525,
        interval,
      },
    };
    const markdown = renderComparisonMarkdown(report, manifest());
    expect(markdown).toContain('## Context efficiency (deterministic-lab proxy)');
    expect(markdown).toContain('deterministic-lab proxy for PRP §6.5');
    expect(markdown).toContain('not a claim about agent task success');
    expect(markdown).toContain('525 tokens');
    expect(markdown).toContain('500 tokens');
    expect(markdown).toContain('pairedProbes 10, resamples 2000, seed 1234567');
    expect(markdown).toContain('one-sided 95% lower bound');
    const section = markdown.slice(markdown.indexOf('## Context efficiency'));
    expect(section).not.toContain('[REDACTED]');
    // Existing metric table rows are untouched by the new section.
    expect(markdown).toContain('| isolationLeakRate |');
  });

  it('renders unsupported arms and intervals with their typed reasons', async () => {
    const base = await comparisonReport();
    const report: ComparisonReport = {
      ...base,
      efficiency: {
        metric: 'taskSuccessPer1kTokens',
        control: {
          estimatorId: 'chars-div-4-ceil-v1',
          scoredProbes: 0,
          contextTokens: 0,
          taskSuccessTotal: 0,
          outcome: 'unsupported',
          unsupportedReason: 'no-scored-probes',
          taskSuccessPer1kTokens: null,
        },
        candidate: {
          estimatorId: 'chars-div-4-ceil-v1',
          scoredProbes: 5,
          contextTokens: 0,
          taskSuccessTotal: 0,
          outcome: 'unsupported',
          unsupportedReason: 'zero-context-tokens',
          taskSuccessPer1kTokens: null,
        },
        delta: null,
        interval: {
          outcome: 'unsupported',
          unsupportedReason: 'insufficient-paired-probes',
          pairedProbes: 5,
          resamples: 2000,
          level: 0.95,
          seed: 42,
          point: null,
          lower: null,
          upper: null,
          oneSidedLower: null,
        },
      },
    };
    const markdown = renderComparisonMarkdown(report, manifest());
    expect(markdown).toContain('unsupported (no-scored-probes)');
    expect(markdown).toContain('unsupported (zero-context-tokens)');
    expect(markdown).toContain('unsupported (insufficient-paired-probes; pairedProbes 5, resamples 2000, seed 42)');
    expect(markdown).toContain('Delta: unsupported');
  });

  it('adds no new manifest.config key and leaves redaction untouched', () => {
    const value = manifest();
    expect(Object.keys(value.config ?? {}).sort()).toEqual(['authorization', 'credentials', 'model', 'nested']);
    expect(JSON.stringify(value)).not.toContain('contextAccounting');
  });
});
