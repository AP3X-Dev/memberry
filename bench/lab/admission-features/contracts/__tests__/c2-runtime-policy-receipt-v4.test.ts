import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { parseAdmissionC2RuntimePolicyReceiptV3 } from '../c2-runtime-policy-receipt-v3.js';
import {
  parseAdmissionC2RuntimePolicyReceiptV4,
  type AdmissionC2RuntimePolicyReceiptV4,
} from '../c2-runtime-policy-receipt-v4.js';

const CONTRACTS_DIR = join(import.meta.dirname, '..');

function sha256(value: string | Uint8Array): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

async function chainBytes(): Promise<{ v3: Uint8Array; v2: Uint8Array; v1: Uint8Array }> {
  const [v3, v2, v1] = await Promise.all([
    readFile(join(CONTRACTS_DIR, 'c2-runtime-policy-receipt.v3.json')),
    readFile(join(CONTRACTS_DIR, 'c2-runtime-policy-receipt.v2.json')),
    readFile(join(CONTRACTS_DIR, 'c2-runtime-policy-receipt.v1.json')),
  ]);
  return { v3: new Uint8Array(v3), v2: new Uint8Array(v2), v1: new Uint8Array(v1) };
}

async function syntheticV4(
  mutate: (binding: Record<string, unknown>) => void = () => undefined,
): Promise<Uint8Array> {
  const { v3, v2, v1 } = await chainBytes();
  const retired = parseAdmissionC2RuntimePolicyReceiptV3(v3, v2, v1);
  const binding: Record<string, unknown> = {
    candidateCommitSha: 'a'.repeat(40),
    repositoryRootTreeOid: 'b'.repeat(40),
    candidateSubtreeOid: 'c'.repeat(40),
    candidateSha256: `sha256:${'1'.repeat(64)}`,
    sourceSha256: `sha256:${'2'.repeat(64)}`,
    imageSha256: `sha256:${'3'.repeat(64)}`,
    imageConfigSha256: `sha256:${'4'.repeat(64)}`,
    nodeSha256: retired.binding.nodeSha256,
    rootFsLayerSha256: retired.binding.rootFsLayerSha256,
    inputSha256: `sha256:${'5'.repeat(64)}`,
    outputSha256: `sha256:${'6'.repeat(64)}`,
    hostedEvidence: {
      repository: 'AP3X-Dev/memberry',
      workflowRunId: '99999999999',
      workflowRunAttempt: 1,
      artifactId: '123456789',
      artifactName: 'memberry-admission-candidate-live-99999999999-1',
      artifactSha256: `sha256:${'7'.repeat(64)}`,
      evidenceSchemaVersion: 'memberry.admission-feature-candidate-live-evidence.v1',
      evidenceFileSha256: `sha256:${'8'.repeat(64)}`,
      workflowFileSha256: `sha256:${'9'.repeat(64)}`,
      cleanupVerified: true,
    },
  };
  mutate(binding);
  const payload = {
    schemaVersion: 'memberry.admission-c2-runtime-policy-receipt.v4',
    receiptVersion: '4.0.0',
    hashScope: 'sha256-canonical-json-without-receiptSha256',
    retiredReceipt: {
      schemaVersion: 'memberry.admission-c2-runtime-policy-receipt.v3',
      receiptSha256: retired.receiptSha256,
      canonicalBytesSha256: sha256(v3),
    },
    policy: retired.policy,
    binding,
  };
  const receipt = { ...payload, receiptSha256: sha256(JSON.stringify(payload)) };
  return new TextEncoder().encode(`${JSON.stringify(receipt)}\n`);
}

async function parseSynthetic(bytes: Uint8Array): Promise<AdmissionC2RuntimePolicyReceiptV4> {
  const { v3, v2, v1 } = await chainBytes();
  return parseAdmissionC2RuntimePolicyReceiptV4(bytes, v3, v2, v1);
}

describe('MEM-002 productionization C2 runtime-policy receipt v4 contract', () => {
  it('parses a canonical v4 receipt chained over the exact frozen v3 bytes', async () => {
    const receipt = await parseSynthetic(await syntheticV4());
    expect(receipt.schemaVersion).toBe('memberry.admission-c2-runtime-policy-receipt.v4');
    expect(receipt.retiredReceipt.schemaVersion).toBe('memberry.admission-c2-runtime-policy-receipt.v3');
    // The unchanged runtime policy is carried byte-for-byte from the chain.
    const { v3, v2, v1 } = await chainBytes();
    const retired = parseAdmissionC2RuntimePolicyReceiptV3(v3, v2, v1);
    expect(JSON.stringify(receipt.policy)).toBe(JSON.stringify(retired.policy));
    expect(receipt.retiredReceipt.receiptSha256).toBe(retired.receiptSha256);
  });

  it('rejects every retired identity reuse', async () => {
    const { v3, v2, v1 } = await chainBytes();
    const retired = parseAdmissionC2RuntimePolicyReceiptV3(v3, v2, v1);
    for (const [mutation, message] of [
      [{ candidateSha256: retired.binding.candidateSha256 }, 'retired candidate identity reuse'],
      [{ sourceSha256: retired.binding.sourceSha256 }, 'retired candidate identity reuse'],
      [{ candidateCommitSha: retired.binding.candidateCommitSha }, 'retired candidate identity reuse'],
      [{ candidateSubtreeOid: retired.binding.candidateSubtreeOid }, 'retired candidate identity reuse'],
      [{ inputSha256: retired.binding.inputSha256 }, 'retired corpus identity reuse'],
      [{ outputSha256: retired.binding.outputSha256 }, 'retired corpus identity reuse'],
    ] as const) {
      const bytes = await syntheticV4((binding) => Object.assign(binding, mutation));
      await expect(parseSynthetic(bytes)).rejects.toThrow(message);
    }
  });

  it('pins the unchanged base-image node hash and rejects drift', async () => {
    const bytes = await syntheticV4((binding) => {
      binding.nodeSha256 = `sha256:${'f'.repeat(64)}`;
    });
    await expect(parseSynthetic(bytes)).rejects.toThrow('invalid SHA-256 identity');
  });

  it('rejects retired reused hosted-run identity and collapsed tree identities', async () => {
    const { v3, v2, v1 } = await chainBytes();
    const retired = parseAdmissionC2RuntimePolicyReceiptV3(v3, v2, v1);
    const reusedRun = await syntheticV4((binding) => {
      const hosted = binding.hostedEvidence as Record<string, unknown>;
      hosted.workflowRunId = retired.binding.hostedEvidence.workflowRunId;
      hosted.artifactName = `memberry-admission-candidate-live-${retired.binding.hostedEvidence.workflowRunId}-1`;
    });
    await expect(parseSynthetic(reusedRun)).rejects.toThrow('invalid hosted run identity');

    const collapsed = await syntheticV4((binding) => {
      binding.candidateSubtreeOid = binding.repositoryRootTreeOid;
    });
    await expect(parseSynthetic(collapsed)).rejects.toThrow('tree identities must be distinct');
  });

  it('never parses older chain bytes as v4', async () => {
    const { v3, v2, v1 } = await chainBytes();
    expect(() => parseAdmissionC2RuntimePolicyReceiptV4(v3, v3, v2, v1)).toThrow();
    expect(() => parseAdmissionC2RuntimePolicyReceiptV4(v2, v3, v2, v1)).toThrow();
  });

  it('rejects a tampered receipt hash', async () => {
    const bytes = await syntheticV4();
    const text = new TextDecoder().decode(bytes);
    const tampered = new TextEncoder().encode(
      text.replace(/"receiptSha256":"sha256:[0-9a-f]{4}/, (match) => `${match.slice(0, -4)}0000`),
    );
    expect(Buffer.from(tampered).equals(Buffer.from(bytes))).toBe(false);
    await expect(parseSynthetic(tampered)).rejects.toThrow();
  });
});
