import { describe, expect, it } from 'vitest';

import {
  BLINDED_HOLDOUT_CURRENT_CHECKOUT_CANDIDATE_SUBTREE_OID,
  BLINDED_HOLDOUT_HISTORICAL_CANDIDATE_SUBTREE_OID,
  BLINDED_HOLDOUT_ORACLE_SHA256,
  BLINDED_HOLDOUT_POLICY_RECEIPT_CANONICAL_BYTES_SHA256,
  BLINDED_HOLDOUT_POLICY_RECEIPT_SHA256,
  BLINDED_HOLDOUT_REPOSITORY_ROOT_TREE_OID,
  blindedHoldoutOneShotKeyV2,
  buildBlindedHoldoutReceiptV2,
  canonicalBlindedHoldoutReceiptV2,
  createBlindedHoldoutRuntimeEvidenceV2,
  parseBlindedHoldoutReceiptV2,
  type BlindedHoldoutAggregateV2,
} from '../blinded-holdout-artifact.js';

const SHA_A = `sha256:${'a'.repeat(64)}` as const;
const SHA_B = `sha256:${'b'.repeat(64)}` as const;
const SHA_C = `sha256:${'c'.repeat(64)}` as const;

function aggregate(overrides: Partial<BlindedHoldoutAggregateV2> = {}): BlindedHoldoutAggregateV2 {
  return {
    scenarioCount: 4,
    dimensionCount: 24,
    agreementCount: 24,
    agreementPermille: 1_000,
    availabilityMismatchCount: 0,
    valueMismatchCount: 0,
    passed: true,
    ...overrides,
  };
}

function runtime(nodeMajor: 20 | 22, value = aggregate()) {
  return createBlindedHoldoutRuntimeEvidenceV2({
    nodeMajor,
    evidenceMode: 'sealed-candidate-prediction',
    candidateRunCount: 1,
    candidateStoppedBeforeOracle: true,
    predictionSha256: SHA_A,
    aggregate: value,
  });
}

function receiptOptions() {
  return {
    evaluatedCommitSha: 'd'.repeat(40),
    scorerSha256: SHA_B,
    predictionSha256: SHA_A,
    startReceiptSha256: SHA_C,
    tombstone: {
      ref: `refs/tags/memberry-mem002c3-burn/${blindedHoldoutOneShotKeyV2().slice(7)}` as const,
      targetSha: 'd'.repeat(40),
      preexisting: false as const,
      creationStatus: 201 as const,
      verificationStatus: 200 as const,
    },
    workflowRunId: '123456789',
    workflowRunAttempt: 1 as const,
    priorAuthoritativeReceiptCount: 0 as const,
    candidateRunCount: 1 as const,
    runtimes: [runtime(20), runtime(22)] as const,
    cleanup: {
      candidateStopped: true,
      containerRemoved: true,
      imageRemoved: true,
      predictionRemoved: true,
      temporaryFilesRemoved: true,
      noRawArtifactsPublished: true,
    } as const,
  };
}

describe('MEM-002C3 blinded holdout aggregate-only receipt', () => {
  it('builds one canonical aggregate-only receipt with exact identities and matching runtimes', () => {
    const receipt = buildBlindedHoldoutReceiptV2(receiptOptions());
    const canonical = canonicalBlindedHoldoutReceiptV2(receipt);
    const decoded = JSON.parse(canonical) as Record<string, unknown>;

    expect(receipt.packetId).toBe('MEM-002C3');
    expect(receipt.schemaVersion).toBe('memberry.admission-feature-blinded-holdout-receipt.v2');
    expect(receipt.evidenceMode).toBe('blinded-holdout');
    expect(receipt.repositoryRootTreeOid).toBe(BLINDED_HOLDOUT_REPOSITORY_ROOT_TREE_OID);
    expect(receipt.historicalCandidateSubtreeOid).toBe(BLINDED_HOLDOUT_HISTORICAL_CANDIDATE_SUBTREE_OID);
    expect(receipt.currentCheckoutCandidateSubtreeOid).toBe(BLINDED_HOLDOUT_CURRENT_CHECKOUT_CANDIDATE_SUBTREE_OID);
    expect(receipt.oracleSha256).toBe(BLINDED_HOLDOUT_ORACLE_SHA256);
    expect(decoded.policyReceiptSha256).toBe(BLINDED_HOLDOUT_POLICY_RECEIPT_SHA256);
    expect(decoded.policyReceiptCanonicalBytesSha256).toBe(
      BLINDED_HOLDOUT_POLICY_RECEIPT_CANONICAL_BYTES_SHA256,
    );
    expect(receipt.tombstone).toEqual(receiptOptions().tombstone);
    expect(receipt.outcome).toBe('passed');
    expect(receipt.aggregate).toEqual(aggregate());
    expect(receipt.runtimes.map(({ nodeMajor }) => nodeMajor)).toEqual([20, 22]);
    expect(canonical.endsWith('\n')).toBe(true);
    expect(decoded).not.toHaveProperty('predictions');
    expect(decoded).not.toHaveProperty(`candidate${'Tree'}Oid`);
    expect(canonical).not.toMatch(/"scenarioId"|"features"|"dimensions"|"valuePermille"|"fixtureCode"|"stdout"|"stderr"|"raw/i);
  });

  it('reports an aggregate disagreement without case-specific evidence', () => {
    const mismatch = aggregate({
      agreementCount: 23,
      agreementPermille: 958,
      valueMismatchCount: 1,
      passed: false,
    });
    const options = receiptOptions();
    const receipt = buildBlindedHoldoutReceiptV2({
      ...options,
      runtimes: [runtime(20, mismatch), runtime(22, mismatch)],
    });

    expect(receipt.outcome).toBe('failed');
    expect(receipt.aggregate).toEqual(mismatch);
    expect(canonicalBlindedHoldoutReceiptV2(receipt)).not.toMatch(/af-(?:dev|holdout)-|case-[0-9]/);
  });

  it.each([
    [
      'runtime divergence',
      [
        runtime(20),
        runtime(
          22,
          aggregate({
            agreementCount: 23,
            agreementPermille: 958,
            valueMismatchCount: 1,
            passed: false,
          }),
        ),
      ],
    ],
    ['duplicate runtime', [runtime(20), runtime(20)]],
    ['self-proof evidence', [{ ...runtime(20), evidenceMode: 'scorer-conformance' }, runtime(22)]],
    ['candidate rerun', [{ ...runtime(20), candidateRunCount: 2 }, runtime(22)]],
  ])('rejects %s', (_name: string, runtimes: unknown) => {
    expect(() =>
      buildBlindedHoldoutReceiptV2({
        ...receiptOptions(),
        runtimes: runtimes as never,
      }),
    ).toThrow(/^mem002c3_artifact:/);
  });

  it('rejects incomplete cleanup and duplicate-attempt evidence', () => {
    const options = receiptOptions();
    expect(() =>
      buildBlindedHoldoutReceiptV2({
        ...options,
        cleanup: { ...options.cleanup, predictionRemoved: false } as never,
      }),
    ).toThrow('mem002c3_artifact:cleanup');
    expect(() =>
      buildBlindedHoldoutReceiptV2({
        ...options,
        priorAuthoritativeReceiptCount: 1 as never,
      }),
    ).toThrow('mem002c3_artifact:duplicate_attempt');
  });

  it('rejects missing, foreign, mutable, or wrong-target tombstone claims', () => {
    const options = receiptOptions();
    for (const tombstone of [
      { ...options.tombstone, ref: 'refs/tags/memberry-mem002c3-burn/foreign' },
      { ...options.tombstone, targetSha: 'e'.repeat(40) },
      { ...options.tombstone, preexisting: true },
      { ...options.tombstone, creationStatus: 200 },
      { ...options.tombstone, verificationStatus: 404 },
    ]) {
      expect(() => buildBlindedHoldoutReceiptV2({ ...options, tombstone } as never)).toThrow('mem002c3_artifact:tombstone');
    }
  });

  it('fails closed on forged, mutated, or noncanonical receipt bytes', () => {
    const receipt = buildBlindedHoldoutReceiptV2(receiptOptions());
    expect(() => canonicalBlindedHoldoutReceiptV2(structuredClone(receipt))).toThrow('mem002c3_artifact:unregistered');

    const canonical = canonicalBlindedHoldoutReceiptV2(receipt);
    const parsed = parseBlindedHoldoutReceiptV2(new TextEncoder().encode(canonical));
    expect(canonicalBlindedHoldoutReceiptV2(parsed)).toBe(canonical);

    const forged = JSON.parse(canonical) as Record<string, unknown>;
    forged.extra = true;
    expect(() => parseBlindedHoldoutReceiptV2(new TextEncoder().encode(`${JSON.stringify(forged)}\n`))).toThrow(/^mem002c3_artifact:/);
    const policyHashMutations = [
      (value: Record<string, unknown>) => delete value.policyReceiptSha256,
      (value: Record<string, unknown>) => delete value.policyReceiptCanonicalBytesSha256,
      (value: Record<string, unknown>) => {
        [value.policyReceiptSha256, value.policyReceiptCanonicalBytesSha256] = [
          value.policyReceiptCanonicalBytesSha256,
          value.policyReceiptSha256,
        ];
      },
      (value: Record<string, unknown>) => {
        value.policyReceiptSha256 = SHA_A;
      },
      (value: Record<string, unknown>) => {
        value.policyReceiptCanonicalBytesSha256 = SHA_A;
      },
    ];
    for (const mutate of policyHashMutations) {
      const value = JSON.parse(canonical) as Record<string, unknown>;
      mutate(value);
      expect(() => parseBlindedHoldoutReceiptV2(new TextEncoder().encode(`${JSON.stringify(value)}\n`))).toThrow(
        /^mem002c3_artifact:/,
      );
    }
    expect(() => parseBlindedHoldoutReceiptV2(new TextEncoder().encode(canonical.trimEnd()))).toThrow(/^mem002c3_artifact:/);
  });
});
