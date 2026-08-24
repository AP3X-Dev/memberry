import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  parseAdmissionC2RuntimePolicyReceiptV3,
  verifyAdmissionC2HostedEvidenceV3,
} from '../c2-runtime-policy-receipt-v3.js';

const root = resolve(import.meta.dirname, '../../../../..');
const contracts = 'bench/lab/admission-features/contracts';

async function bytes(path: string): Promise<Uint8Array> {
  return new Uint8Array(await readFile(resolve(root, path)));
}

async function receiptFixture() {
  const [v3, v2, v1] = await Promise.all([
    bytes(`${contracts}/c2-runtime-policy-receipt.v3.json`),
    bytes(`${contracts}/c2-runtime-policy-receipt.v2.json`),
    bytes(`${contracts}/c2-runtime-policy-receipt.v1.json`),
  ]);
  return { v3, v2, v1 };
}

function sha256(value: Uint8Array | string): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function mutate(v3: Uint8Array, change: (value: any) => void): Uint8Array {
  const value = JSON.parse(new TextDecoder().decode(v3)) as any;
  change(value);
  return new TextEncoder().encode(`${JSON.stringify(value)}\n`);
}

describe('MEM-002C2 corpus-v2 runtime policy receipt v3', () => {
  it('parses the committed canonical v3 receipt against the retired v2 chain', async () => {
    const { v3, v2, v1 } = await receiptFixture();
    const receipt = parseAdmissionC2RuntimePolicyReceiptV3(v3, v2, v1);

    expect(receipt.schemaVersion).toBe('memberry.admission-c2-runtime-policy-receipt.v3');
    expect(receipt.receiptVersion).toBe('3.0.0');
    expect(receipt.retiredReceipt.receiptSha256).toBe(
      'sha256:ff9d0df0e9e5e47da0e34e56294b713ba8a8ce9b216b6bec590b8826f5818f01',
    );
    expect(receipt.retiredReceipt.canonicalBytesSha256).toBe(sha256(v2));
    expect(receipt.binding.candidateCommitSha).toBe('ee4723bf0dccff5ffc7ba05ec5c6ba8ee9ed9bce');
    expect(receipt.binding.candidateSubtreeOid).toBe('08ce328eca824de833d9f762950b4b008a13f723');
    expect(receipt.binding.candidateSha256).toBe(
      'sha256:778331a12e3720b1373c600f49ef7bd6299946ed10ddfde465b61f2f5c9ec982',
    );
    expect(receipt.binding.sourceSha256).toBe(
      'sha256:6f8dd8edaecc6de8003a29e760f695847682938007ea8342ac315f064b80d457',
    );
    expect(receipt.binding.inputSha256).toBe(
      'sha256:457d5483b8c22f62415f5952ffa743936f0b34348cf72bafe315dd8432448428',
    );
    expect(receipt.binding.outputSha256).toBe(
      'sha256:c5611f810d34fcecce7c2ed9ab1c258d0cea2e855526a10730993b73f7d92d3a',
    );
    expect(receipt.binding.nodeSha256).toBe(
      'sha256:34347794817b8e5d2ac54e93131ac8456f2c37cf1e752dcd6ec8e8314c7ae4a4',
    );
    expect(receipt.binding.hostedEvidence.workflowRunId).toBe('32693462156');
    expect(receipt.binding.hostedEvidence.artifactId).toBe('9508151579');
    expect(receipt.binding.hostedEvidence.artifactName).toBe(
      'memberry-admission-candidate-live-32693462156-1',
    );
    expect(receipt.policy.baseImage).toBe(
      'node@sha256:7eb2c0c4b8cf6fd761f0e6a7fed8d3b8ad59186848f0eee59744e546f1b6a3e9',
    );
    expect(receipt.receiptSha256).toBe(
      'sha256:2a87f47eed1236fbc41b368ca146597993f0d6ed787637f3fb951e029d9422b5',
    );
    expect(sha256(v3)).toBe(
      'sha256:f8c5ade63a13b24c5abfd39432f358651cf4fc9acf9ec50b33b2e482c9b5ab3c',
    );
    expect(Object.isFrozen(receipt)).toBe(true);
    expect(Object.isFrozen(receipt.binding)).toBe(true);
    expect(Object.isFrozen(receipt.binding.hostedEvidence)).toBe(true);
  });

  it('never parses v1 or v2 bytes as v3 and rejects a broken retirement chain', async () => {
    const { v3, v2, v1 } = await receiptFixture();
    expect(() => parseAdmissionC2RuntimePolicyReceiptV3(v2, v2, v1)).toThrow();
    expect(() => parseAdmissionC2RuntimePolicyReceiptV3(v1, v2, v1)).toThrow();
    expect(() => parseAdmissionC2RuntimePolicyReceiptV3(v3, v1, v1)).toThrow();
    expect(() => parseAdmissionC2RuntimePolicyReceiptV3(v3, v3, v1)).toThrow();
    expect(() => parseAdmissionC2RuntimePolicyReceiptV3(v3, v2, v2)).toThrow();
  });

  it.each([
    ['schema substitution', (value: any) => { value.schemaVersion = 'memberry.admission-c2-runtime-policy-receipt.v2'; }],
    ['retired receipt hash drift', (value: any) => { value.retiredReceipt.receiptSha256 = `sha256:${'0'.repeat(64)}`; }],
    ['policy drift', (value: any) => { value.policy.limits.pids = 64; }],
    ['candidate commit drift', (value: any) => { value.binding.candidateCommitSha = '5a111761668d9370d5163f64e195f0dda44b55af'; }],
    ['subtree drift', (value: any) => { value.binding.candidateSubtreeOid = '03d7c50515f6ab767fd41b7d41bd231531a4ab58'; }],
    ['retired candidate identity reuse', (value: any) => { value.binding.candidateSha256 = 'sha256:474459f8359fe8a117547453dc1e728b4aab9a69f69f7faa4cf188e27e4742ca'; }],
    ['retired corpus input reuse', (value: any) => { value.binding.inputSha256 = 'sha256:41ef02bbe9df03e4f7b4f95b248265a71635aefa7cbe69c585a1eb8647936b24'; }],
    ['retired corpus output reuse', (value: any) => { value.binding.outputSha256 = 'sha256:5b43576a3b7b2f19c8dc8280b4259783c53643a2f620aa35abea7dfaa8586a83'; }],
    ['node binary drift', (value: any) => { value.binding.nodeSha256 = `sha256:${'1'.repeat(64)}`; }],
    ['artifact name drift', (value: any) => { value.binding.hostedEvidence.artifactName = 'memberry-admission-candidate-live-1-1'; }],
    ['retired run reuse', (value: any) => { value.binding.hostedEvidence.workflowRunId = '31988943734'; value.binding.hostedEvidence.artifactName = 'memberry-admission-candidate-live-31988943734-1'; }],
    ['cleanup falsification', (value: any) => { value.binding.hostedEvidence.cleanupVerified = false; }],
    ['unknown root metadata', (value: any) => { value.metadata = {}; }],
    ['receipt hash drift', (value: any) => { value.receiptSha256 = `sha256:${'2'.repeat(64)}`; }],
  ])('rejects %s', async (_name, change) => {
    const { v3, v2, v1 } = await receiptFixture();
    expect(() => parseAdmissionC2RuntimePolicyReceiptV3(mutate(v3, change), v2, v1)).toThrow();
  });

  it.each([
    ['pretty JSON', (v3: Uint8Array) => new TextEncoder().encode(`${JSON.stringify(JSON.parse(new TextDecoder().decode(v3)), null, 2)}\n`)],
    ['missing trailing newline', (v3: Uint8Array) => v3.slice(0, -1)],
    ['carriage return', (v3: Uint8Array) => new TextEncoder().encode(new TextDecoder().decode(v3).replace(/\n$/, '\r\n'))],
  ])('rejects noncanonical bytes: %s', async (_name, transform) => {
    const { v3, v2, v1 } = await receiptFixture();
    expect(() => parseAdmissionC2RuntimePolicyReceiptV3(transform(v3), v2, v1)).toThrow();
  });

  it('verifies reconstructed hosted evidence and workflow bytes and fails closed on drift', async () => {
    const { v3, v2, v1 } = await receiptFixture();
    const receipt = parseAdmissionC2RuntimePolicyReceiptV3(v3, v2, v1);
    const evidence = {
      schemaVersion: receipt.binding.hostedEvidence.evidenceSchemaVersion,
      ok: true,
      cleanupVerified: true,
      scenarioCount: 13,
      devScenarioCount: 9,
      holdoutScenarioCount: 4,
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
    const encode = (value: unknown) => new TextEncoder().encode(`${JSON.stringify(value)}\n`);

    expect(sha256(encode(evidence))).toBe(receipt.binding.hostedEvidence.evidenceFileSha256);
    expect(sha256(encode(workflow))).toBe(receipt.binding.hostedEvidence.workflowFileSha256);
    expect(verifyAdmissionC2HostedEvidenceV3(receipt, encode(evidence), encode(workflow))).toBe(true);

    expect(verifyAdmissionC2HostedEvidenceV3(
      receipt,
      encode({ ...evidence, outputSha256: `sha256:${'0'.repeat(64)}` }),
      encode(workflow),
    )).toBe(false);
    expect(verifyAdmissionC2HostedEvidenceV3(
      receipt,
      encode({ ...evidence, scenarioCount: 6, devScenarioCount: 3, holdoutScenarioCount: 3 }),
      encode(workflow),
    )).toBe(false);
    expect(verifyAdmissionC2HostedEvidenceV3(
      receipt,
      encode(evidence),
      encode({ ...workflow, sha: '5a111761668d9370d5163f64e195f0dda44b55af' }),
    )).toBe(false);
    expect(verifyAdmissionC2HostedEvidenceV3(
      { ...receipt } as never,
      encode(evidence),
      encode(workflow),
    )).toBe(false);
  });
});
