import { describe, expect, it } from 'vitest';

import {
  BLINDED_HOLDOUT_ORACLE_SHA256,
  blindedHoldoutOneShotKeyV1,
  buildBlindedHoldoutReceiptV1,
  canonicalBlindedHoldoutReceiptV1,
  createBlindedHoldoutRuntimeEvidenceV1,
  parseBlindedHoldoutReceiptV1,
  type BlindedHoldoutAggregateV1,
} from '../blinded-holdout-artifact.js';

const SHA_A = `sha256:${'a'.repeat(64)}` as const;
const SHA_B = `sha256:${'b'.repeat(64)}` as const;
const SHA_C = `sha256:${'c'.repeat(64)}` as const;

function aggregate(overrides: Partial<BlindedHoldoutAggregateV1> = {}): BlindedHoldoutAggregateV1 {
  return {
    scenarioCount: 3,
    dimensionCount: 18,
    agreementCount: 18,
    agreementPermille: 1_000,
    availabilityMismatchCount: 0,
    valueMismatchCount: 0,
    passed: true,
    ...overrides,
  };
}

function runtime(nodeMajor: 20 | 22, value = aggregate()) {
  return createBlindedHoldoutRuntimeEvidenceV1({
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
      ref: `refs/tags/memberry-mem002c3-burn/${blindedHoldoutOneShotKeyV1().slice(7)}` as const,
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
    const receipt = buildBlindedHoldoutReceiptV1(receiptOptions());
    const canonical = canonicalBlindedHoldoutReceiptV1(receipt);
    const decoded = JSON.parse(canonical) as Record<string, unknown>;

    expect(receipt.packetId).toBe('MEM-002C3');
    expect(receipt.evidenceMode).toBe('blinded-holdout');
    expect(receipt.oracleSha256).toBe(BLINDED_HOLDOUT_ORACLE_SHA256);
    expect(receipt.tombstone).toEqual(receiptOptions().tombstone);
    expect(receipt.outcome).toBe('passed');
    expect(receipt.aggregate).toEqual(aggregate());
    expect(receipt.runtimes.map(({ nodeMajor }) => nodeMajor)).toEqual([20, 22]);
    expect(canonical.endsWith('\n')).toBe(true);
    expect(decoded).not.toHaveProperty('predictions');
    expect(canonical).not.toMatch(/"scenarioId"|"features"|"dimensions"|"valuePermille"|"fixtureCode"|"stdout"|"stderr"|"raw/i);
  });

  it('reports an aggregate disagreement without case-specific evidence', () => {
    const mismatch = aggregate({
      agreementCount: 17,
      agreementPermille: 944,
      valueMismatchCount: 1,
      passed: false,
    });
    const options = receiptOptions();
    const receipt = buildBlindedHoldoutReceiptV1({
      ...options,
      runtimes: [runtime(20, mismatch), runtime(22, mismatch)],
    });

    expect(receipt.outcome).toBe('failed');
    expect(receipt.aggregate).toEqual(mismatch);
    expect(canonicalBlindedHoldoutReceiptV1(receipt)).not.toMatch(/af-(?:dev|holdout)-|case-[0-9]/);
  });

  it.each([
    ['runtime divergence', [runtime(20), runtime(22, aggregate({ agreementCount: 17, agreementPermille: 944, valueMismatchCount: 1, passed: false }))]],
    ['duplicate runtime', [runtime(20), runtime(20)]],
    ['self-proof evidence', [
      { ...runtime(20), evidenceMode: 'scorer-conformance' },
      runtime(22),
    ]],
    ['candidate rerun', [
      { ...runtime(20), candidateRunCount: 2 },
      runtime(22),
    ]],
  ])('rejects %s', (_name: string, runtimes: unknown) => {
    expect(() => buildBlindedHoldoutReceiptV1({
      ...receiptOptions(),
      runtimes: runtimes as never,
    })).toThrow(/^mem002c3_artifact:/);
  });

  it('rejects incomplete cleanup and duplicate-attempt evidence', () => {
    const options = receiptOptions();
    expect(() => buildBlindedHoldoutReceiptV1({
      ...options,
      cleanup: { ...options.cleanup, predictionRemoved: false } as never,
    })).toThrow('mem002c3_artifact:cleanup');
    expect(() => buildBlindedHoldoutReceiptV1({
      ...options,
      priorAuthoritativeReceiptCount: 1 as never,
    })).toThrow('mem002c3_artifact:duplicate_attempt');
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
      expect(() => buildBlindedHoldoutReceiptV1({ ...options, tombstone } as never))
        .toThrow('mem002c3_artifact:tombstone');
    }
  });

  it('fails closed on forged, mutated, or noncanonical receipt bytes', () => {
    const receipt = buildBlindedHoldoutReceiptV1(receiptOptions());
    expect(() => canonicalBlindedHoldoutReceiptV1(structuredClone(receipt)))
      .toThrow('mem002c3_artifact:unregistered');

    const canonical = canonicalBlindedHoldoutReceiptV1(receipt);
    const parsed = parseBlindedHoldoutReceiptV1(new TextEncoder().encode(canonical));
    expect(canonicalBlindedHoldoutReceiptV1(parsed)).toBe(canonical);

    const forged = JSON.parse(canonical) as Record<string, unknown>;
    forged.extra = true;
    expect(() => parseBlindedHoldoutReceiptV1(new TextEncoder().encode(`${JSON.stringify(forged)}\n`)))
      .toThrow(/^mem002c3_artifact:/);
    expect(() => parseBlindedHoldoutReceiptV1(new TextEncoder().encode(canonical.trimEnd())))
      .toThrow(/^mem002c3_artifact:/);
  });
});
