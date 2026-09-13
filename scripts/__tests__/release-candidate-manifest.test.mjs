import assert from 'node:assert/strict';
import test from 'node:test';

import { createReleaseCandidateManifest } from '../release-candidate-manifest.mjs';
import { REQUIRED_RELEASE_GATE_STAGES } from '../release-gate-status.mjs';

const baseline = {
  id: 'historical-baseline',
  source: { commit: 'a'.repeat(40) },
  datasets: [{ id: 'set', version: '1', split: 'legacy-dev', sha256: 'b'.repeat(64) }],
};

function input(overrides = {}) {
  return {
    generatedAt: '2026-09-09T00:00:00.000Z',
    git: { branch: 'feat/test', commit: 'c'.repeat(40), dirty: false },
    baseline,
    baselineLock: { sha256: 'd'.repeat(64), hashMode: 'canonical-json' },
    baselineBytes: JSON.stringify(baseline),
    flagDefinitions: [
      { name: 'MEMBERRY_QUERY_PLANNER_V1', kind: 'bool', owner: 'mcp', default: '0' },
      { name: 'MEMBERRY_API_TOKEN', kind: 'secret', owner: 'mcp', default: '' },
    ],
    env: {},
    runtime: { node: 'v22.0.0', platform: 'linux', arch: 'x64' },
    ...overrides,
  };
}

test('labels historical and unrun evidence without promoting either', () => {
  const manifest = createReleaseCandidateManifest(input());
  assert.equal(manifest.evidence.historicalBaseline.status, 'recorded-elsewhere');
  assert.equal(manifest.evidence.offlineGate.status, 'not-run');
  assert.equal(manifest.evidence.releaseQualification.status, 'not-run');
  assert.equal(manifest.evidence.taskBenchmark.status, 'not-run');
  assert.equal(manifest.profile.embeddingIndex.qualification, 'not-inspected');
  assert.equal(manifest.profile.embeddingIndex.generation, 'scope-dependent');
});

test('labels only a complete successful gate as reproduced at this commit', () => {
  const gateReceipts = REQUIRED_RELEASE_GATE_STAGES.map((stage) => `${stage}_EXIT=0`).join('\n');
  const manifest = createReleaseCandidateManifest(input({ gateReceipts }));
  assert.equal(manifest.evidence.offlineGate.status, 'reproduced-at-this-commit');
  assert.equal(manifest.evidence.releaseQualification.status, 'not-run');
});

test('records failed or incomplete gates as not qualified', () => {
  const gateReceipts = REQUIRED_RELEASE_GATE_STAGES.slice(1).map((stage) => `${stage}_EXIT=0`).join('\n');
  const manifest = createReleaseCandidateManifest(input({ gateReceipts }));
  assert.equal(manifest.evidence.offlineGate.status, 'not-qualified');
  assert.deepEqual(manifest.evidence.offlineGate.failedStages, ['INSTALL']);
});

test('allowlists environment settings and never serializes credentials', () => {
  const manifest = createReleaseCandidateManifest(input({ env: {
    MEMBERRY_QUERY_PLANNER_V1: '1',
    MEMBERRY_API_TOKEN: 'do-not-serialize',
    OPENAI_API_KEY: 'do-not-serialize-either',
  } }));
  const serialized = JSON.stringify(manifest);
  assert.equal(manifest.profile.flags.find((flag) => flag.name === 'MEMBERRY_QUERY_PLANNER_V1').configured, true);
  const secretFlag = manifest.profile.flags.find((flag) => flag.name === 'MEMBERRY_API_TOKEN');
  assert.equal(secretFlag.configured, true);
  assert.equal(Object.hasOwn(secretFlag, 'configuredSha256'), false);
  assert.equal(Object.hasOwn(secretFlag, 'configuredLength'), false);
  assert.doesNotMatch(serialized, /do-not-serialize/);
  assert.doesNotMatch(serialized, /do-not-serialize-either/);
});

test('never calls dirty work reproduced evidence and applies runtime defaults to blank settings', () => {
  const gateReceipts = REQUIRED_RELEASE_GATE_STAGES.map((stage) => `${stage}_EXIT=0`).join('\n');
  const manifest = createReleaseCandidateManifest(input({
    git: { branch: 'feat/test', commit: 'c'.repeat(40), dirty: true },
    gateReceipts,
    env: { MEMBERRY_EMBEDDING_DIM: '', MEMBERRY_HOOK_TURN_TOKENS: 'invalid' },
  }));
  assert.equal(manifest.evidence.offlineGate.status, 'not-qualified');
  assert.equal(manifest.profile.embeddingIndex.dimensions, 1536);
  assert.equal(manifest.profile.tokenBudgets.hookTurn, 1500);
});

test('hashes hostile URL, path, string, and model values instead of serializing them', () => {
  const credentialUrl = 'https://alice:supersecret@example.invalid/mcp?token=alsosecret#fragment';
  const manifest = createReleaseCandidateManifest(input({
    flagDefinitions: [
      { name: 'MEMBERRY_MCP_URL', kind: 'string', owner: 'core', default: 'http://localhost/mcp' },
      { name: 'MEMBERRY_EXPORT_PATH', kind: 'path', owner: 'core', default: './.memberry' },
    ],
    env: {
      MEMBERRY_MCP_URL: credentialUrl,
      MEMBERRY_EXPORT_PATH: 'C:/private/password-value',
      MEMBERRY_MODEL_SYNTHESIS: 'model-name-containing-secret',
    },
  }));
  const serialized = JSON.stringify(manifest);
  assert.doesNotMatch(serialized, /alice|supersecret|alsosecret|password-value|model-name-containing-secret/);
  assert.equal(manifest.profile.flags[0].configuredSha256.length, 64);
  assert.equal(manifest.profile.models.synthesis.value, null);
});

test('records custom descriptor configuration without inventing a model or active generation', () => {
  const manifest = createReleaseCandidateManifest(input({ env: {
    OPENAI_API_KEY: 'private-key', MEMBERRY_EMBEDDING_DESCRIPTOR: '{"model":"private-model-label"}',
  } }));
  assert.equal(manifest.profile.models.embedding, null);
  assert.equal(manifest.profile.embeddingIndex.dimensions, null);
  assert.equal(manifest.profile.embeddingIndex.name, null);
  assert.equal(manifest.profile.embeddingIndex.qualification, 'not-inspected');
  assert.equal(manifest.profile.embeddingIndex.descriptorConfiguration.configuredSha256.length, 64);
  assert.doesNotMatch(JSON.stringify(manifest), /private-key|private-model-label/);
});
