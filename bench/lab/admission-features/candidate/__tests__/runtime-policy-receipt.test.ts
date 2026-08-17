import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  ADMISSION_SANDBOX_LIMITS_V1,
  buildAdmissionFeatureSandboxInvocationV1,
  buildAdmissionFeatureSandboxStartInvocationV1,
  prepareDockerSpawnV1,
} from '../sandbox.js';
import { validateAdmissionCandidateBuildAssetsV1 } from '../build.js';
import {
  parseAdmissionC2RuntimePolicyReceiptV1,
  verifyAdmissionC2HostedArtifactMetadataV1,
  verifyAdmissionC2HostedEvidenceV1,
} from '../../contracts/c2-runtime-policy-receipt.js';

const root = resolve(fileURLToPath(new URL('.', import.meta.url)), '../../../../..');
const receiptPath = resolve(
  root,
  'bench/lab/admission-features/contracts/c2-runtime-policy-receipt.v1.json',
);

async function loadReceipt() {
  return parseAdmissionC2RuntimePolicyReceiptV1(new Uint8Array(await readFile(receiptPath)));
}

describe('MEM-002C2 scorer-readable runtime-policy receipt', () => {
  it('is canonical, hash-bound, and closed over the hosted content-free identities', async () => {
    const receipt = await loadReceipt();
    expect(await readFile(resolve(
      root,
      'bench/lab/admission-features/contracts/.gitattributes',
    ), 'utf8')).toBe('.gitattributes text eol=lf\n*.json text eol=lf\n*.ts text eol=lf\n');
    expect(receipt.schemaVersion).toBe('memberry.admission-c2-runtime-policy-receipt.v1');
    expect(receipt.binding.candidateCommitSha).toBe('5a111761668d9370d5163f64e195f0dda44b55af');
    expect(receipt.binding.candidateTreeOid).toBe('94c75dd3a36a708ce6add1f10eaf606fa4ffea8d');
    expect(receipt.binding.hostedEvidence.workflowRunId).toBe('31988943734');
    expect(receipt.binding.hostedEvidence.workflowRunAttempt).toBe(1);
    expect(receipt.binding.hostedEvidence.artifactId).toBe('9274710637');
    expect(receipt.binding.hostedEvidence.artifactSha256)
      .toBe('sha256:f8144e3e6ac91322cf82738400d05415425284a3eac14aa4e6bdf4fe2c3a6ca3');
    expect(Object.isFrozen(receipt)).toBe(true);
    expect(Object.isFrozen(receipt.policy)).toBe(true);
    expect(Object.isFrozen(receipt.binding)).toBe(true);
  });

  it('fails closed on policy tamper, extra keys, and noncanonical bytes', async () => {
    const bytes = new Uint8Array(await readFile(receiptPath));
    const parsed = JSON.parse(new TextDecoder().decode(bytes)) as any;
    parsed.policy.limits.timeoutMs = 5_001;
    expect(() => parseAdmissionC2RuntimePolicyReceiptV1(
      new TextEncoder().encode(`${JSON.stringify(parsed)}\n`),
    )).toThrow();
    parsed.policy.limits.timeoutMs = 5_000;
    parsed.extra = true;
    expect(() => parseAdmissionC2RuntimePolicyReceiptV1(
      new TextEncoder().encode(`${JSON.stringify(parsed)}\n`),
    )).toThrow();
    delete parsed.extra;
    expect(() => parseAdmissionC2RuntimePolicyReceiptV1(
      new TextEncoder().encode(`${JSON.stringify(parsed, null, 2)}\n`),
    )).toThrow();
  });

  it('cannot drift from the validated candidate manifest or effective Docker invocation', async () => {
    const receipt = await loadReceipt();
    const manifest = JSON.parse(await readFile(resolve(
      root,
      'bench/lab/admission-features/candidate/container/manifest.json',
    ), 'utf8')) as any;
    const dockerfile = await readFile(resolve(
      root,
      'bench/lab/admission-features/candidate/container/Dockerfile',
    ), 'utf8');
    validateAdmissionCandidateBuildAssetsV1({ dockerfile, manifest });

    expect(receipt.policy).toMatchObject({
      platform: manifest.runtime.platform,
      baseImage: manifest.build.baseImage,
      pull: manifest.runtime.pull,
      network: manifest.runtime.network,
      user: manifest.runtime.user,
      environment: manifest.runtime.environment,
      rootFilesystem: manifest.runtime.rootFilesystem,
      capabilities: manifest.runtime.capabilities,
      noNewPrivileges: manifest.runtime.noNewPrivileges,
      limits: {
        cpu: manifest.runtime.cpus,
        memory: manifest.runtime.memory,
        memorySwap: manifest.runtime.memorySwap,
        pids: manifest.runtime.pids,
        timeoutMs: manifest.runtime.timeoutMs,
        stdinBytes: manifest.runtime.inputBytes,
        stdoutBytes: manifest.runtime.outputBytes,
        stderrBytes: manifest.runtime.stderrBytes,
      },
      mounts: { count: manifest.runtime.inputDelivery.mounts, tmpfs: [] },
      stop: { action: manifest.runtime.cleanup.runningAction, grace: 'none' },
      entrypoint: manifest.runtime.entrypoint,
      arguments: manifest.runtime.arguments,
    });

    expect(receipt.policy.limits).toEqual({
      cpu: ADMISSION_SANDBOX_LIMITS_V1.cpu,
      memory: ADMISSION_SANDBOX_LIMITS_V1.memory,
      memorySwap: ADMISSION_SANDBOX_LIMITS_V1.memory,
      pids: ADMISSION_SANDBOX_LIMITS_V1.pids,
      timeoutMs: ADMISSION_SANDBOX_LIMITS_V1.timeoutMs,
      stdinBytes: ADMISSION_SANDBOX_LIMITS_V1.inputBytes,
      stdoutBytes: ADMISSION_SANDBOX_LIMITS_V1.outputBytes,
      stderrBytes: ADMISSION_SANDBOX_LIMITS_V1.stderrBytes,
    });

    const runToken = 'a'.repeat(32);
    const cidFile = resolve(tmpdir(), `memberry-admission-run-${runToken}-ABC123`, 'container.cid');
    const invocation = buildAdmissionFeatureSandboxInvocationV1({
      image: receipt.binding.imageSha256,
      cidFile,
      runToken,
      hostEnvironment: Object.create(null),
    });
    expect(invocation.args).toEqual([
      'create', `--cidfile=${cidFile}`, '--pull=never',
      `--label=org.memberry.run-token=${runToken}`, '--network=none',
      '--read-only', '--interactive', '--user=65532:65532', '--cap-drop=ALL',
      '--security-opt=no-new-privileges:true', '--pids-limit=32', '--cpus=0.5',
      '--memory=128m', '--memory-swap=128m', '--env=LANG=C.UTF-8',
      '--env=LC_ALL=C.UTF-8', '--env=TZ=UTC', '--entrypoint=/usr/local/bin/node',
      '--platform=linux/amd64', receipt.binding.imageSha256, '--permission',
      '--allow-fs-write=/tmp/memberry-sandbox-write-probe', '--disable-proto=throw',
      '/app/worker.mjs', '-',
    ]);
    const start = prepareDockerSpawnV1(buildAdmissionFeatureSandboxStartInvocationV1(
      'a'.repeat(64),
      new Uint8Array(receipt.policy.limits.stdinBytes),
    ));
    expect(start.timeoutMs).toBe(receipt.policy.limits.timeoutMs);
    expect(start.stdoutLimit).toBe(receipt.policy.limits.stdoutBytes);
    expect(start.stderrLimit).toBe(receipt.policy.limits.stderrBytes);
  });

  it('lets a blind consumer verify hosted evidence without importing candidate code', async () => {
    const receipt = await loadReceipt();
    const verifierSource = await readFile(resolve(
      root,
      'bench/lab/admission-features/contracts/c2-runtime-policy-receipt.ts',
    ), 'utf8');
    expect(verifierSource).not.toMatch(/from\s+['"][^'"]*candidate/i);
    expect(verifyAdmissionC2HostedArtifactMetadataV1(receipt, {
      id: 9_274_710_637,
      name: 'memberry-admission-candidate-live-31988943734-1',
      digest: 'sha256:f8144e3e6ac91322cf82738400d05415425284a3eac14aa4e6bdf4fe2c3a6ca3',
      expired: false,
      workflow_run: {
        id: 31_988_943_734,
        head_sha: '5a111761668d9370d5163f64e195f0dda44b55af',
        head_branch: 'master',
      },
    })).toBe(true);
    const evidence = {
      schemaVersion: receipt.binding.hostedEvidence.evidenceSchemaVersion,
      ok: true,
      cleanupVerified: true,
      scenarioCount: 6,
      devScenarioCount: 3,
      holdoutScenarioCount: 3,
      baseImage: receipt.policy.baseImage,
      candidateSha256: receipt.binding.candidateSha256,
      sourceSha256: receipt.binding.sourceSha256,
      imageSha256: receipt.binding.imageSha256,
      imageConfigSha256: receipt.binding.imageConfigSha256,
      nodeSha256: receipt.binding.nodeSha256,
      rootFsLayerSha256: receipt.binding.rootFsLayerSha256,
      inputSha256: receipt.binding.inputSha256,
      outputSha256: receipt.binding.outputSha256,
    };
    const workflow = {
      repository: receipt.binding.hostedEvidence.repository,
      sha: receipt.binding.candidateCommitSha,
      run_id: receipt.binding.hostedEvidence.workflowRunId,
      run_attempt: String(receipt.binding.hostedEvidence.workflowRunAttempt),
    };
    expect(verifyAdmissionC2HostedEvidenceV1(
      receipt,
      new TextEncoder().encode(`${JSON.stringify(evidence)}\n`),
      new TextEncoder().encode(`${JSON.stringify(workflow)}\n`),
    )).toBe(true);
    evidence.outputSha256 = `sha256:${'0'.repeat(64)}`;
    expect(verifyAdmissionC2HostedEvidenceV1(
      receipt,
      new TextEncoder().encode(`${JSON.stringify(evidence)}\n`),
      new TextEncoder().encode(`${JSON.stringify(workflow)}\n`),
    )).toBe(false);
  });
});
