import {
  chmod,
  link,
  mkdir,
  mkdtemp,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AdmissionFeatureScenarioInputV1 } from '../../contract.js';

const buildReceipt = Object.freeze({
  receiptVersion: 'memberry.admission-build-receipt.v1',
  candidateSha256: `sha256:${'1'.repeat(64)}`,
  sourceSha256: `sha256:${'2'.repeat(64)}`,
  imageSha256: `sha256:${'3'.repeat(64)}`,
  baseImage: `node@sha256:${'4'.repeat(64)}`,
  rootFsLayers: Object.freeze([`sha256:${'5'.repeat(64)}`]),
  imageConfigSha256: `sha256:${'6'.repeat(64)}`,
  nodeSha256: `sha256:${'7'.repeat(64)}`,
});

const success = Object.freeze({
  ok: true as const,
  output: new Uint8Array([123, 125]),
  hashes: Object.freeze({
    candidateSha256: buildReceipt.candidateSha256,
    sourceSha256: buildReceipt.sourceSha256,
    imageSha256: buildReceipt.imageSha256,
    inputSha256: `sha256:${'8'.repeat(64)}`,
    outputSha256: `sha256:${'9'.repeat(64)}`,
  }),
});

const mocks = vi.hoisted(() => ({
  buildImage: vi.fn(),
  classifyBuildFailure: vi.fn(),
  runSandbox: vi.fn(),
}));

vi.mock('../build.js', () => ({
  buildAdmissionFeatureCandidateImageV1: mocks.buildImage,
  classifyAdmissionCandidateBuildFailurePhaseV1: mocks.classifyBuildFailure,
}));
vi.mock('../sandbox.js', () => ({
  runAdmissionFeatureSandboxV1: mocks.runSandbox,
}));

import {
  admissionFeatureCandidateLiveFailureEvidenceV1,
  classifyAdmissionFeatureCandidateLiveFailureV1,
  classifyAdmissionFeatureCandidateLiveFailurePhaseV1,
  formatAdmissionFeatureCandidateLiveFailureV1,
  hasExactEvidenceParentPermissionsV1,
  runAdmissionFeatureCandidateLiveCoreV1,
  writeAdmissionFeatureCandidateLiveFailureEvidenceV1,
  writeAdmissionFeatureCandidateLiveEvidenceTestCoreV1,
  writeAdmissionFeatureCandidateLiveEvidenceV1,
} from '../live.js';

const signals = Object.freeze({
  priority: 'none' as const,
  noveltyEvidence: 'none' as const,
  retentionHorizon: 'transient' as const,
  evidenceSupport: 'none' as const,
  scopeBinding: 'missing' as const,
  sensitivitySignal: 'none' as const,
});
const inputs: readonly AdmissionFeatureScenarioInputV1[] = Object.freeze([
  ...Array.from({ length: 9 }, (_, index) => Object.freeze({
    datasetId: 'memberry.synthetic-admission-feature-labels' as const,
    datasetVersion: '2.0.0' as const,
    scenarioId: `af-dev-00${index + 1}`,
    split: 'dev' as const,
    fixtureCode: `case-00${index + 1}`,
    signals,
  })),
  ...Array.from({ length: 4 }, (_, index) => Object.freeze({
    datasetId: 'memberry.synthetic-admission-feature-labels' as const,
    datasetVersion: '2.0.0' as const,
    scenarioId: `af-holdout-00${index + 1}`,
    split: 'holdout' as const,
    fixtureCode: `case-10${index + 1}`,
    signals,
  })),
]);

describe('MEM-002C2 value-free live CLI orchestration', () => {
  beforeEach(() => {
    mocks.buildImage.mockReset().mockResolvedValue(buildReceipt);
    mocks.classifyBuildFailure.mockReset().mockReturnValue('UNKNOWN');
    mocks.runSandbox.mockReset().mockResolvedValue(success);
  });

  it('binds one real-shaped build receipt to one sandbox run and returns only metadata and hashes', async () => {
    const evidence = await runAdmissionFeatureCandidateLiveCoreV1(inputs);

    expect(mocks.buildImage).toHaveBeenCalledOnce();
    expect(mocks.buildImage).toHaveBeenCalledWith();
    expect(mocks.runSandbox).toHaveBeenCalledOnce();
    expect(mocks.runSandbox).toHaveBeenCalledWith({ receipt: buildReceipt, inputs });
    expect(mocks.buildImage.mock.invocationCallOrder[0])
      .toBeLessThan(mocks.runSandbox.mock.invocationCallOrder[0]!);
    expect(evidence).toEqual({
      schemaVersion: 'memberry.admission-feature-candidate-live-evidence.v1',
      ok: true,
      cleanupVerified: true,
      scenarioCount: 13,
      devScenarioCount: 9,
      holdoutScenarioCount: 4,
      baseImage: buildReceipt.baseImage,
      candidateSha256: buildReceipt.candidateSha256,
      sourceSha256: buildReceipt.sourceSha256,
      imageSha256: buildReceipt.imageSha256,
      imageConfigSha256: buildReceipt.imageConfigSha256,
      nodeSha256: buildReceipt.nodeSha256,
      rootFsLayerSha256: buildReceipt.rootFsLayers,
      inputSha256: success.hashes.inputSha256,
      outputSha256: success.hashes.outputSha256,
    });
    const serialized = JSON.stringify(evidence);
    expect(serialized).not.toMatch(/scenarioId|fixtureCode|signals|predictions|features|output\"|oracle|label/i);
  });

  it('fails closed without producing successful evidence when the sandbox rejects execution', async () => {
    mocks.runSandbox.mockResolvedValueOnce(Object.freeze({ ok: false, failureCode: 'CLEANUP_FAILED' }));
    const error = await runAdmissionFeatureCandidateLiveCoreV1(inputs).catch((failure: unknown) => failure);
    expect(classifyAdmissionFeatureCandidateLiveFailureV1(error)).toBe('CLEANUP_FAILED');
    expect(classifyAdmissionFeatureCandidateLiveFailurePhaseV1(error)).toBe('SANDBOX');
    expect(formatAdmissionFeatureCandidateLiveFailureV1(error))
      .toBe('admission_candidate_live:CLEANUP_FAILED');
  });

  it.each([
    'REQUEST_INVALID', 'SOURCE_UNAVAILABLE', 'ATTESTATION_INVALID', 'EXECUTOR_UNAVAILABLE',
    'CLEANUP_FAILED', 'TIME_LIMIT', 'MEMORY_LIMIT', 'OUTPUT_LIMIT', 'STDERR_LIMIT',
    'PROTOCOL_STDERR', 'PROTOCOL_INVALID', 'PROCESS_FAILED',
  ] as const)('preserves the fixed value-free %s sandbox failure', async (failureCode) => {
    mocks.runSandbox.mockResolvedValueOnce(Object.freeze({ ok: false, failureCode }));
    const error = await runAdmissionFeatureCandidateLiveCoreV1(inputs).catch((failure: unknown) => failure);
    expect(formatAdmissionFeatureCandidateLiveFailureV1(error))
      .toBe(`admission_candidate_live:${failureCode}`);
  });

  it('classifies an unexpected sandbox exception without retaining its text', async () => {
    mocks.runSandbox.mockRejectedValueOnce(new Error('secret-bearing sandbox failure'));
    const error = await runAdmissionFeatureCandidateLiveCoreV1(inputs).catch((failure: unknown) => failure);
    expect(classifyAdmissionFeatureCandidateLiveFailureV1(error)).toBe('FAILED');
    expect(classifyAdmissionFeatureCandidateLiveFailurePhaseV1(error)).toBe('SANDBOX');
    expect(formatAdmissionFeatureCandidateLiveFailureV1(error)).toBe('admission_candidate_live:FAILED');
    expect(JSON.stringify(admissionFeatureCandidateLiveFailureEvidenceV1(error))).not.toContain('secret');
  });

  it('maps unknown failures to one generic code without retaining exception text', async () => {
    mocks.buildImage.mockRejectedValueOnce(new Error('secret-bearing Docker failure'));
    mocks.classifyBuildFailure.mockReturnValueOnce('BASE_PROOF');
    const error = await runAdmissionFeatureCandidateLiveCoreV1(inputs).catch((failure: unknown) => failure);
    expect(classifyAdmissionFeatureCandidateLiveFailureV1(error)).toBe('FAILED');
    expect(classifyAdmissionFeatureCandidateLiveFailurePhaseV1(error)).toBe('BASE_PROOF');
    expect(formatAdmissionFeatureCandidateLiveFailureV1(error)).toBe('admission_candidate_live:FAILED');
    expect(formatAdmissionFeatureCandidateLiveFailureV1(error)).not.toContain('secret');
    expect(admissionFeatureCandidateLiveFailureEvidenceV1(error)).toEqual({
      schemaVersion: 'memberry.admission-feature-candidate-live-failure-phase.v1',
      ok: false,
      phase: 'BASE_PROOF',
    });
    expect(JSON.stringify(admissionFeatureCandidateLiveFailureEvidenceV1(error))).not.toContain('secret');
  });
});

const linuxOnly = process.platform === 'linux' ? it : it.skip;
const originalRunnerTemp = process.env['RUNNER_TEMP'];
const originalEvidencePath = process.env['MEMBERRY_ADMISSION_CANDIDATE_LIVE_EVIDENCE_PATH'];
const temporaryRoots: string[] = [];

async function evidenceAuthority(): Promise<Readonly<{
  runnerTemp: string;
  parent: string;
  evidencePath: string;
}>> {
  const runnerTemp = await mkdtemp(join(tmpdir(), 'memberry-candidate-live-'));
  temporaryRoots.push(runnerTemp);
  const parent = join(runnerTemp, 'memberry-admission-candidate-live');
  await mkdir(parent, { mode: 0o700 });
  await chmod(parent, 0o700);
  const evidencePath = join(parent, 'evidence.json');
  process.env['RUNNER_TEMP'] = runnerTemp;
  process.env['MEMBERRY_ADMISSION_CANDIDATE_LIVE_EVIDENCE_PATH'] = evidencePath;
  return { runnerTemp, parent, evidencePath };
}

async function sampleEvidence() {
  return runAdmissionFeatureCandidateLiveCoreV1(inputs);
}

async function failureCode(work: Promise<unknown>): Promise<string> {
  const error = await work.then(
    () => new Error('unexpected success'),
    (failure: unknown) => failure,
  );
  return classifyAdmissionFeatureCandidateLiveFailureV1(error);
}

afterEach(async () => {
  if (originalRunnerTemp === undefined) delete process.env['RUNNER_TEMP'];
  else process.env['RUNNER_TEMP'] = originalRunnerTemp;
  if (originalEvidencePath === undefined) {
    delete process.env['MEMBERRY_ADMISSION_CANDIDATE_LIVE_EVIDENCE_PATH'];
  } else {
    process.env['MEMBERRY_ADMISSION_CANDIDATE_LIVE_EVIDENCE_PATH'] = originalEvidencePath;
  }
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('MEM-002C2 evidence-file authority', () => {
  it('accepts exactly 0700 parent permissions and rejects looser or special-bit modes', () => {
    expect(hasExactEvidenceParentPermissionsV1(0o40700n)).toBe(true);
    for (const mode of [0o40755n, 0o40711n, 0o41700n, 0o42700n, 0o44700n]) {
      expect(hasExactEvidenceParentPermissionsV1(mode), mode.toString(8)).toBe(false);
    }
  });

  it('requires RUNNER_TEMP and its one exact evidence leaf', async () => {
    const evidence = await sampleEvidence();
    delete process.env['RUNNER_TEMP'];
    delete process.env['MEMBERRY_ADMISSION_CANDIDATE_LIVE_EVIDENCE_PATH'];
    expect(await failureCode(writeAdmissionFeatureCandidateLiveEvidenceV1(evidence)))
      .toBe('EVIDENCE_PATH_INVALID');

    const authority = await evidenceAuthority();
    process.env['MEMBERRY_ADMISSION_CANDIDATE_LIVE_EVIDENCE_PATH'] = join(authority.parent, 'other.json');
    expect(await failureCode(writeAdmissionFeatureCandidateLiveEvidenceV1(evidence)))
      .toBe('EVIDENCE_PATH_INVALID');
  });

  it('fails closed on platforms without the required no-follow file authority', async () => {
    if (process.platform === 'linux') return;
    await evidenceAuthority();
    expect(await failureCode(writeAdmissionFeatureCandidateLiveEvidenceV1(await sampleEvidence())))
      .toBe('EVIDENCE_PLATFORM_UNSUPPORTED');
  });

  linuxOnly('creates one exclusive mode-0600 evidence file without creating its parent', async () => {
    const authority = await evidenceAuthority();
    const evidence = await sampleEvidence();
    await writeAdmissionFeatureCandidateLiveEvidenceV1(evidence);
    const content = await import('node:fs/promises').then(({ readFile }) => readFile(authority.evidencePath, 'utf8'));
    expect(JSON.parse(content)).toEqual(evidence);
  });

  linuxOnly('writes only one fixed phase for a failed live build', async () => {
    const authority = await evidenceAuthority();
    mocks.buildImage.mockRejectedValueOnce(new Error('secret-bearing Docker failure'));
    mocks.classifyBuildFailure.mockReturnValueOnce('CANDIDATE_BUILD');
    const error = await runAdmissionFeatureCandidateLiveCoreV1(inputs).catch((failure: unknown) => failure);
    await writeAdmissionFeatureCandidateLiveFailureEvidenceV1(error);
    const content = await import('node:fs/promises').then(({ readFile }) => readFile(authority.evidencePath, 'utf8'));
    expect(JSON.parse(content)).toEqual({
      schemaVersion: 'memberry.admission-feature-candidate-live-failure-phase.v1',
      ok: false,
      phase: 'CANDIDATE_BUILD',
    });
    expect(content).not.toContain('secret');
  });

  linuxOnly('rejects an existing regular final leaf', async () => {
    const authority = await evidenceAuthority();
    await writeFile(authority.evidencePath, 'existing');
    expect(await failureCode(writeAdmissionFeatureCandidateLiveEvidenceV1(await sampleEvidence())))
      .toBe('EVIDENCE_EXISTS');
  });

  linuxOnly('rejects a final symlink without following it', async () => {
    const authority = await evidenceAuthority();
    await symlink(join(authority.runnerTemp, 'foreign'), authority.evidencePath);
    expect(await failureCode(writeAdmissionFeatureCandidateLiveEvidenceV1(await sampleEvidence())))
      .toBe('EVIDENCE_LEAF_LINK');
  });

  linuxOnly('rejects a preexisting hard-linked final leaf', async () => {
    const authority = await evidenceAuthority();
    const source = join(authority.runnerTemp, 'foreign');
    await writeFile(source, 'foreign');
    await link(source, authority.evidencePath);
    expect(await failureCode(writeAdmissionFeatureCandidateLiveEvidenceV1(await sampleEvidence())))
      .toBe('EVIDENCE_LEAF_HARDLINK');
  });

  linuxOnly('rejects a symlinked parent directory', async () => {
    const authority = await evidenceAuthority();
    const realParent = join(authority.runnerTemp, 'real-parent');
    await rm(authority.parent, { recursive: true });
    await mkdir(realParent);
    await symlink(realParent, authority.parent, 'dir');
    expect(await failureCode(writeAdmissionFeatureCandidateLiveEvidenceV1(await sampleEvidence())))
      .toBe('EVIDENCE_PARENT_INVALID');
  });

  linuxOnly('requires the exact parent to preexist as an owner-only-writable directory', async () => {
    const authority = await evidenceAuthority();
    await rm(authority.parent, { recursive: true });
    expect(await failureCode(writeAdmissionFeatureCandidateLiveEvidenceV1(await sampleEvidence())))
      .toBe('EVIDENCE_PARENT_INVALID');

    await mkdir(authority.parent, { mode: 0o777 });
    await chmod(authority.parent, 0o777);
    expect(await failureCode(writeAdmissionFeatureCandidateLiveEvidenceV1(await sampleEvidence())))
      .toBe('EVIDENCE_PARENT_INVALID');
  });

  linuxOnly.each([0o755, 0o711, 0o1700])(
    'rejects evidence parent mode %s',
    async (mode) => {
      const authority = await evidenceAuthority();
      await chmod(authority.parent, mode);
      expect(await failureCode(writeAdmissionFeatureCandidateLiveEvidenceV1(await sampleEvidence())))
        .toBe('EVIDENCE_PARENT_INVALID');
    },
  );

  linuxOnly('detects a parent-directory identity swap after exclusive open', async () => {
    const authority = await evidenceAuthority();
    const displaced = join(authority.runnerTemp, 'displaced-parent');
    const evidence = await sampleEvidence();
    expect(await failureCode(writeAdmissionFeatureCandidateLiveEvidenceTestCoreV1(evidence, async () => {
      await rename(authority.parent, displaced);
      await mkdir(authority.parent, { mode: 0o700 });
      await chmod(authority.parent, 0o700);
    }))).toBe('EVIDENCE_PARENT_CHANGED');
  });

  linuxOnly('detects a concurrent hard link after exclusive open', async () => {
    const authority = await evidenceAuthority();
    const evidence = await sampleEvidence();
    expect(await failureCode(writeAdmissionFeatureCandidateLiveEvidenceTestCoreV1(evidence, async () => {
      await link(authority.evidencePath, join(authority.parent, 'foreign-link'));
    }))).toBe('EVIDENCE_LEAF_HARDLINK');
  });
});
