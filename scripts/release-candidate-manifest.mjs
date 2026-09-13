import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { parseReleaseGateReceipts } from './release-gate-status.mjs';

const MODEL_DEFAULTS = Object.freeze({
  embedding: 'text-embedding-3-small',
  extraction: 'gpt-4o-mini',
  synthesis: 'gpt-4o',
  dream: 'gpt-4o',
});

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function nonblank(value, fallback) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : fallback;
}

function boundedInteger(value, fallback, minimum, maximum) {
  const parsed = typeof value === 'string' && /^\d+$/.test(value.trim())
    ? Number(value.trim())
    : Number.NaN;
  return Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : fallback;
}

function flagSnapshot(env, definitions = []) {
  return definitions.map((flag) => {
    const configured = nonblank(env[flag.name], '');
    if (flag.kind === 'secret') {
      return {
        name: flag.name,
        kind: flag.kind,
        owner: flag.owner,
        configured: configured !== '',
        source: configured === '' ? 'not-configured' : 'environment',
      };
    }
    return {
      name: flag.name,
      kind: flag.kind,
      owner: flag.owner,
      configured: configured !== '',
      ...(configured === '' ? {} : {
        configuredSha256: sha256(configured),
        configuredLength: Buffer.byteLength(configured, 'utf8'),
      }),
      declaredDefault: flag.default,
      source: configured === '' ? 'declared-default' : 'environment',
      interpretation: 'runtime-specific-value-not-serialized',
    };
  });
}

function modelSetting(env, name, fallback) {
  const configured = nonblank(env[name], '');
  if (configured === '') return { source: 'declared-default', value: fallback };
  return {
    source: 'environment',
    value: null,
    configuredSha256: sha256(configured),
    configuredLength: Buffer.byteLength(configured, 'utf8'),
  };
}

export function createReleaseCandidateManifest(input) {
  const gate = input.gateReceipts === undefined
    ? undefined
    : parseReleaseGateReceipts(input.gateReceipts);
  const sourceQualified = input.git.dirty === false;
  const stageEvidence = gate === undefined
    ? { status: 'not-run', failedStages: [], errors: [] }
    : {
        status: gate.ok && sourceQualified ? 'reproduced-at-this-commit' : 'not-qualified',
        failedStages: [...gate.failedStages],
        errors: [...gate.errors],
        receiptSha256: sha256(input.gateReceipts),
        stages: [...gate.receipts].map(([name, exitCode]) => ({
          name,
          required: true,
          exitCode,
          status: exitCode === 0 ? 'passed' : 'failed',
        })),
      };
  return {
    schemaVersion: 1,
    id: `memberry-release-candidate-${input.git.commit.slice(0, 12)}`,
    generatedAt: input.generatedAt,
    source: {
      repository: 'AP3X-Dev/memberry',
      branch: input.git.branch,
      commit: input.git.commit,
      dirty: input.git.dirty,
    },
    evidence: {
      offlineGate: stageEvidence,
      releaseQualification: {
        status: 'not-run',
        reason: 'requires successful hosted offline matrix and disposable integration on the same clean SHA',
      },
      historicalBaseline: {
        status: 'recorded-elsewhere',
        id: input.baseline.id,
        commit: input.baseline.source.commit,
        manifestRawSha256: sha256(input.baselineBytes),
        lockSha256: input.baselineLock.sha256,
        lockHashMode: input.baselineLock.hashMode,
      },
      taskBenchmark: { status: 'not-run', ownerPacket: 'PR-05' },
      liveRuntime: { status: 'not-run', ownerPacket: 'PR-06' },
    },
    runtime: {
      node: input.runtime.node,
      platform: input.runtime.platform,
      arch: input.runtime.arch,
      environment: input.runtime.environment ?? 'local',
    },
    profile: {
      flags: flagSnapshot(input.env, input.flagDefinitions),
      models: {
        embeddingProvider: nonblank(input.env.OPENAI_API_KEY, '') === '' ? 'zero-vector' : 'openai',
        embedding: nonblank(input.env.OPENAI_API_KEY, '') === '' || nonblank(input.env.MEMBERRY_EMBEDDING_DESCRIPTOR, '') !== '' ? null : MODEL_DEFAULTS.embedding,
        extraction: modelSetting(input.env, 'MEMBERRY_MODEL_EXTRACTION', MODEL_DEFAULTS.extraction),
        synthesis: modelSetting(input.env, 'MEMBERRY_MODEL_SYNTHESIS', MODEL_DEFAULTS.synthesis),
        dream: modelSetting(input.env, 'MEMBERRY_MODEL_DREAM', MODEL_DEFAULTS.dream),
      },
      tokenBudgets: {
        loadDefault: 4096,
        hookTurn: boundedInteger(input.env.MEMBERRY_HOOK_TURN_TOKENS, 1500, 200, 1_000_000),
      },
      embeddingIndex: {
        name: null,
        dimensions: nonblank(input.env.MEMBERRY_EMBEDDING_DESCRIPTOR, '') === ''
          ? boundedInteger(input.env.MEMBERRY_EMBEDDING_DIM, 1536, 8, 12288) : null,
        descriptor: null,
        descriptorConfiguration: modelSetting(input.env, 'MEMBERRY_EMBEDDING_DESCRIPTOR', 'unversioned-provider-alias'),
        generation: 'scope-dependent',
        qualification: 'not-inspected',
        statusCommand: 'npx tsx scripts/embedding-generation.mts command.json',
      },
    },
    datasets: input.baseline.datasets.map((dataset) => ({
      id: dataset.id,
      version: dataset.version,
      split: dataset.split,
      sha256: dataset.sha256,
      evidenceStatus: 'recorded-elsewhere',
    })),
    notes: [
      'Historical benchmark values are preserved, not reproduced at this commit.',
      'The held-out coding-task corpus and release profile qualification belong to PR-05.',
      'Generation implementation does not qualify any live tenant/project index; inspect scoped generation status separately.',
    ],
  };
}

function git(repo, ...args) {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
}

export async function generateReleaseCandidateManifest({ repo, output, statusPath, env = process.env }) {
  const baselinePath = resolve(repo, 'bench/lab/baselines/memberry-7a31231.json');
  const baselineLockPath = resolve(repo, 'bench/lab/baselines/baseline.lock.json');
  const baselineBytes = await readFile(baselinePath, 'utf8');
  const baseline = JSON.parse(baselineBytes);
  const baselineLock = JSON.parse(await readFile(baselineLockPath, 'utf8'));
  const flagsSource = await readFile(resolve(repo, 'packages/core/src/config/flags.ts'), 'utf8');
  const flagDefinitions = [];
  const flagPattern = /f\(\s*'([^']+)'\s*,\s*'([^']+)'\s*,\s*'([^']*)'\s*,\s*'([^']+)'/g;
  for (const match of flagsSource.matchAll(flagPattern)) {
    flagDefinitions.push({ name: match[1], kind: match[2], default: match[3], owner: match[4] });
  }
  if (flagDefinitions.length === 0) throw new Error('Memberry flag inventory could not be read');
  let gateReceipts;
  if (statusPath) {
    try {
      gateReceipts = await readFile(statusPath, 'utf8');
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
  const manifest = createReleaseCandidateManifest({
    generatedAt: new Date().toISOString(),
    git: {
      branch: git(repo, 'branch', '--show-current'),
      commit: git(repo, 'rev-parse', 'HEAD'),
      dirty: git(repo, 'status', '--porcelain=v1', '--untracked-files=all') !== '',
    },
    baseline,
    baselineLock,
    baselineBytes,
    flagDefinitions,
    gateReceipts,
    env,
    runtime: {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      environment: nonblank(env.GITHUB_ACTIONS, '') === 'true' ? 'github-actions' : 'local',
    },
  });
  await mkdir(dirname(output), { recursive: true });
  const temporary = `${output}.tmp-${process.pid}`;
  await writeFile(temporary, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  await rename(temporary, output);
  return manifest;
}

async function main() {
  const repo = resolve(process.argv[2] ?? process.cwd());
  const output = resolve(process.argv[3] ?? resolve(repo, '.release-candidate-manifest.json'));
  const statusPath = process.argv[4] ? resolve(process.argv[4]) : undefined;
  const manifest = await generateReleaseCandidateManifest({ repo, output, statusPath });
  console.log(`release manifest: ${output}`);
  console.log(`release candidate: ${manifest.source.commit}${manifest.source.dirty ? ' (dirty)' : ''}`);
  console.log(`offline gate: ${manifest.evidence.offlineGate.status}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
