import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  blindedHoldoutSealedOneShotKeyV3,
  parseBlindedHoldoutSealV3,
  type BlindedHoldoutAggregateV3,
} from '../blinded-holdout-artifact-v3.js';
import {
  assertBlindedHoldoutSecretSafeV3,
  assertSealedInputBytesV3,
  assertSealedOracleBytesV3,
  buildBlindedHoldoutReceiptV3,
  canonicalBlindedHoldoutReceiptV3,
  canonicalBlindedHoldoutRuntimeEvidenceV3,
  createBlindedHoldoutRuntimeEvidenceV3,
  parseBlindedHoldoutReceiptV3,
  parseBlindedHoldoutRuntimeEvidenceV3,
  sealedAdmissionFeatureInputBytesV3,
} from '../blinded-holdout-v3.js';
import { sealedAdmissionFeatureOracleBytesV3 } from '../load-v3.js';

function sha256(value: string | Uint8Array): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function sealFor(overrides: Record<string, unknown> = {}) {
  return parseBlindedHoldoutSealV3(new TextEncoder().encode(`${JSON.stringify({
    schemaVersion: 'memberry.admission-feature-blinded-holdout-seal.v3',
    integratedBaseSha: 'b'.repeat(40),
    candidateCommitSha: 'c'.repeat(40),
    repositoryRootTreeOid: 'd'.repeat(40),
    candidateSubtreeOid: 'a'.repeat(40),
    coreSubtreeOid: 'e'.repeat(40),
    candidateSha256: `sha256:${'1'.repeat(64)}`,
    inputSha256: `sha256:${'2'.repeat(64)}`,
    oracleSha256: `sha256:${'3'.repeat(64)}`,
    ...overrides,
  })}\n`));
}

function aggregate(scenarioCount: number, agreementCount?: number): BlindedHoldoutAggregateV3 {
  const dimensionCount = scenarioCount * 3;
  const agreed = agreementCount ?? dimensionCount;
  return {
    scenarioCount,
    dimensionCount,
    agreementCount: agreed,
    agreementPermille: Math.floor((agreed * 1_000) / dimensionCount),
    availabilityMismatchCount: 0,
    valueMismatchCount: dimensionCount - agreed,
    passed: agreed === dimensionCount,
  };
}

function runtimeEvidence(nodeMajor: 20 | 22, predictionSha256: `sha256:${string}`, holdout = aggregate(6)) {
  return createBlindedHoldoutRuntimeEvidenceV3({
    nodeMajor,
    evidenceMode: 'sealed-candidate-prediction',
    candidateRunCount: 1,
    candidateStoppedBeforeOracle: true,
    predictionSha256,
    devAggregate: aggregate(14),
    holdoutAggregate: holdout,
  });
}

describe('MEM-002 productionization v3 blinded-holdout protocol driver', () => {
  it('round-trips runtime evidence and the aggregate-only receipt through canonical bytes', () => {
    const seal = sealFor();
    const oneShotKey = blindedHoldoutSealedOneShotKeyV3(seal);
    const predictionSha256 = sha256('prediction');
    const node20 = runtimeEvidence(20, predictionSha256);
    const node22 = runtimeEvidence(22, predictionSha256);
    const reparsedEvidence = parseBlindedHoldoutRuntimeEvidenceV3(
      new TextEncoder().encode(canonicalBlindedHoldoutRuntimeEvidenceV3(node20)),
    );
    expect(reparsedEvidence.evidenceSha256).toBe(node20.evidenceSha256);
    expect(reparsedEvidence.devAggregate.dimensionCount).toBe(42);
    expect(reparsedEvidence.holdoutAggregate.dimensionCount).toBe(18);

    const receipt = buildBlindedHoldoutReceiptV3({
      seal,
      policyReceiptSha256: sha256('policy'),
      policyReceiptCanonicalBytesSha256: sha256('policy-bytes'),
      evaluatedCommitSha: 'f'.repeat(40),
      scorerSha256: sha256('scorer'),
      predictionSha256,
      startReceiptSha256: sha256('start'),
      tombstone: {
        ref: `refs/tags/memberry-mem002c3-burn/${oneShotKey.slice(7)}`,
        targetSha: 'f'.repeat(40),
        preexisting: false,
        creationStatus: 201,
        verificationStatus: 200,
      },
      workflowRunId: '12345',
      workflowRunAttempt: 1,
      priorAuthoritativeReceiptCount: 0,
      candidateRunCount: 1,
      runtimes: [node20, node22],
      cleanup: {
        candidateStopped: true,
        containerRemoved: true,
        imageRemoved: true,
        predictionRemoved: true,
        temporaryFilesRemoved: true,
        noRawArtifactsPublished: true,
      },
    });
    expect(receipt.outcome).toBe('passed');
    expect(receipt.oneShotKey).toBe(oneShotKey);
    expect(receipt.devAggregate.dimensionCount).toBe(42);
    expect(receipt.holdoutAggregate.dimensionCount).toBe(18);
    const canonical = canonicalBlindedHoldoutReceiptV3(receipt);
    const reparsed = parseBlindedHoldoutReceiptV3(seal, new TextEncoder().encode(canonical));
    expect(reparsed.receiptSha256).toBe(receipt.receiptSha256);
    expect(canonicalBlindedHoldoutReceiptV3(reparsed)).toBe(canonical);
  });

  it('fails the receipt outcome when either split misses the frozen gate', () => {
    const seal = sealFor();
    const oneShotKey = blindedHoldoutSealedOneShotKeyV3(seal);
    const predictionSha256 = sha256('prediction');
    const failedHoldout = aggregate(6, 17);
    const receipt = buildBlindedHoldoutReceiptV3({
      seal,
      policyReceiptSha256: sha256('policy'),
      policyReceiptCanonicalBytesSha256: sha256('policy-bytes'),
      evaluatedCommitSha: 'f'.repeat(40),
      scorerSha256: sha256('scorer'),
      predictionSha256,
      startReceiptSha256: sha256('start'),
      tombstone: {
        ref: `refs/tags/memberry-mem002c3-burn/${oneShotKey.slice(7)}`,
        targetSha: 'f'.repeat(40),
        preexisting: false,
        creationStatus: 201,
        verificationStatus: 200,
      },
      workflowRunId: '12345',
      workflowRunAttempt: 1,
      priorAuthoritativeReceiptCount: 0,
      candidateRunCount: 1,
      runtimes: [
        runtimeEvidence(20, predictionSha256, failedHoldout),
        runtimeEvidence(22, predictionSha256, failedHoldout),
      ],
      cleanup: {
        candidateStopped: true,
        containerRemoved: true,
        imageRemoved: true,
        predictionRemoved: true,
        temporaryFilesRemoved: true,
        noRawArtifactsPublished: true,
      },
    });
    expect(receipt.outcome).toBe('failed');
  });

  it('fails loudly on seal mismatch before any custody surface is touched', () => {
    const seal = sealFor();
    const bytes = new TextEncoder().encode('sealed-material');
    expect(() => assertSealedInputBytesV3(seal, bytes)).toThrow('mem002prod_protocol:input_identity');
    expect(() => assertSealedOracleBytesV3(seal, bytes)).toThrow('mem002prod_protocol:oracle_identity');
    const matching = sealFor({ inputSha256: sha256(bytes), oracleSha256: sha256(bytes) });
    expect(() => assertSealedInputBytesV3(matching, bytes)).not.toThrow();
    expect(() => assertSealedOracleBytesV3(matching, bytes)).not.toThrow();
    // A receipt canonicalized against one seal never parses against another.
    const reKeyed = sealFor({ candidateSha256: `sha256:${'4'.repeat(64)}` });
    expect(blindedHoldoutSealedOneShotKeyV3(reKeyed)).not.toBe(blindedHoldoutSealedOneShotKeyV3(seal));
  });

  it('rejects every content-bearing surface in canonical receipts, including v3 scenario ids', () => {
    expect(() => assertBlindedHoldoutSecretSafeV3('{"agreementPermille":1000}')).not.toThrow();
    for (const leak of [
      '{"scenarioId":"x"}',
      '{"predictions":[]}',
      '{"dimensions":{}}',
      'af-dev-001',
      'af3-dev-001',
      'af3-holdout-006',
      'case-015',
    ]) {
      expect(() => assertBlindedHoldoutSecretSafeV3(leak)).toThrow('mem002prod_protocol:secret_safety');
    }
  });

  it('serializes the dev+holdout input corpus to stable bounded bytes', async () => {
    const first = await sealedAdmissionFeatureInputBytesV3();
    const second = await sealedAdmissionFeatureInputBytesV3();
    expect(first.byteLength).toBeGreaterThan(2);
    expect(first.byteLength).toBeLessThanOrEqual(32_768);
    expect(sha256(first)).toBe(sha256(second));
  });

  it('defines the oracle bytes as raw dev bytes followed by raw holdout bytes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'memberry-oracle-bytes-'));
    const custody = join(root, 'bench', 'lab', 'admission-features', 'scorer-only', 'v3');
    await mkdir(join(custody, 'dev'), { recursive: true });
    await mkdir(join(custody, 'holdout'), { recursive: true });
    // Synthetic stand-in bytes only; the function is a raw concatenation and
    // never parses or prints custody content.
    const devBytes = 'dev-bytes\n';
    const holdoutBytes = 'holdout-bytes\n';
    await writeFile(join(custody, 'dev', 'oracle.jsonl'), devBytes, 'utf8');
    await writeFile(join(custody, 'holdout', 'oracle.jsonl'), holdoutBytes, 'utf8');
    const bytes = await sealedAdmissionFeatureOracleBytesV3(root);
    expect(new TextDecoder().decode(bytes)).toBe(`${devBytes}${holdoutBytes}`);
    expect(sha256(bytes)).toBe(sha256(new TextEncoder().encode(`${devBytes}${holdoutBytes}`)));
  });
});
