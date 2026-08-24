import { describe, expect, it } from 'vitest';

import {
  BLINDED_HOLDOUT_V3_KEY_SCHEMA_VERSION,
  BLINDED_HOLDOUT_V3_RETIRED_ONE_SHOT_KEYS,
  BLINDED_HOLDOUT_V3_TOMBSTONE_REF_PREFIX,
  BLINDED_HOLDOUT_RETIRED_V4_ONE_SHOT_KEY,
  blindedHoldoutOneShotKeyV3,
  blindedHoldoutSealedOneShotKeyV3,
  parseBlindedHoldoutAggregateV3,
  parseBlindedHoldoutSealV3,
  validateBlindedHoldoutBurnAuthorityAbsenceV3,
} from '../blinded-holdout-artifact-v3.js';
import {
  BLINDED_HOLDOUT_CANDIDATE_SHA256,
  BLINDED_HOLDOUT_INPUT_SHA256,
  blindedHoldoutOneShotKeyV2,
} from '../blinded-holdout-artifact.js';

const STABLE_PAIR = {
  schemaVersion: 'memberry.admission-feature-blinded-holdout-key.v4' as const,
  candidateSubtreeOid: 'a'.repeat(40),
  candidateSha256: `sha256:${'1'.repeat(64)}` as const,
  inputSha256: `sha256:${'2'.repeat(64)}` as const,
  oracleSha256: `sha256:${'3'.repeat(64)}` as const,
};

function sealBytes(overrides: Record<string, unknown> = {}): Uint8Array {
  return new TextEncoder().encode(`${JSON.stringify({
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
  })}\n`);
}

describe('MEM-002 productionization v3 blinded-holdout identity core', () => {
  it('carries all four retired one-shot keys forward, including the consumed passing key', () => {
    expect(BLINDED_HOLDOUT_V3_RETIRED_ONE_SHOT_KEYS).toEqual([
      'sha256:334f7e05460d405878a758a6172057fbc1fdac5d3696fc5a8dbe17b8ab070935',
      'sha256:e500407fcd48106f66131f75a3e6ee2f127758ae0c6f8b37835c968672c9bc98',
      'sha256:af2a1940244599d61fe2ab48a922a08966fcad6549f792c4feee4f9d0979305b',
      'sha256:0f55163931d762cbe23f019ac85074be22638c2ea0aabf6b28726757fd62ef11',
    ]);
    // The consumed passing key is exactly the frozen v2 default derivation.
    expect(BLINDED_HOLDOUT_RETIRED_V4_ONE_SHOT_KEY).toBe(blindedHoldoutOneShotKeyV2());
    expect(BLINDED_HOLDOUT_V3_TOMBSTONE_REF_PREFIX).toBe('refs/tags/memberry-mem002c3-burn/');
  });

  it('derives a stable v4-schema key over the stable pair only', () => {
    const key = blindedHoldoutOneShotKeyV3(STABLE_PAIR);
    expect(key).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(blindedHoldoutOneShotKeyV3({ ...STABLE_PAIR })).toBe(key);
    expect(BLINDED_HOLDOUT_V3_RETIRED_ONE_SHOT_KEYS).not.toContain(key);

    for (const mutation of [
      { ...STABLE_PAIR, candidateSubtreeOid: 'f'.repeat(40) },
      { ...STABLE_PAIR, candidateSha256: `sha256:${'4'.repeat(64)}` },
      { ...STABLE_PAIR, inputSha256: `sha256:${'5'.repeat(64)}` },
      { ...STABLE_PAIR, oracleSha256: `sha256:${'6'.repeat(64)}` },
    ]) {
      expect(blindedHoldoutOneShotKeyV3(mutation as never)).not.toBe(key);
    }

    // Only the v4 schema derives; the retired v3 schema is rejected outright.
    expect(() => blindedHoldoutOneShotKeyV3({
      ...STABLE_PAIR,
      schemaVersion: 'memberry.admission-feature-blinded-holdout-key.v3',
    } as never)).toThrow('mem002prod_artifact:identity');

    const keySource = blindedHoldoutOneShotKeyV3.toString();
    expect(keySource).not.toContain('repositoryRootTreeOid');
    expect(keySource).not.toContain('candidateCommitSha');
    expect(keySource).not.toContain('integratedBaseSha');
  });

  it('never invokes hostile object hooks during derivation', () => {
    let hooks = 0;
    const proxy = new Proxy(STABLE_PAIR, {
      get: () => { hooks += 1; return 'poison'; },
      getOwnPropertyDescriptor: () => { hooks += 1; return undefined; },
      ownKeys: () => { hooks += 1; return []; },
    });
    expect(() => blindedHoldoutOneShotKeyV3(proxy as never)).toThrow('mem002prod_artifact:identity');
    expect(hooks).toBe(0);

    const getterIdentity = {};
    Object.defineProperties(
      getterIdentity,
      Object.fromEntries(Object.entries(STABLE_PAIR).map(([key, value]) => [
        key,
        { enumerable: true, configurable: true, get: () => { hooks += 1; return value; } },
      ])),
    );
    expect(() => blindedHoldoutOneShotKeyV3(getterIdentity as never)).toThrow('mem002prod_artifact:identity');
    expect(hooks).toBe(0);

    expect(() => blindedHoldoutOneShotKeyV3({ ...STABLE_PAIR, extra: true } as never))
      .toThrow('mem002prod_artifact:identity');
  });

  it('checks all four retired keys and the current authority before any start', () => {
    const clean = {
      retiredV1LookupStatus: 404,
      retiredV2LookupStatus: 200,
      retiredV3LookupStatus: 200,
      retiredV4LookupStatus: 200,
      currentLookupStatus: 404,
      retiredV1EvidenceArtifactCount: 0,
      retiredV2EvidenceArtifactCount: 1,
      retiredV3EvidenceArtifactCount: 2,
      retiredV4EvidenceArtifactCount: 2,
      currentEvidenceArtifactCount: 0,
      knownFailedV1RunArtifactCount: 0,
      knownFailedV2RunArtifactCount: 1,
      knownFailedV3RunArtifactCount: 2,
    };
    expect(validateBlindedHoldoutBurnAuthorityAbsenceV3(clean)).toBe(true);

    for (const mutation of [
      { retiredV1LookupStatus: 200 },
      { retiredV2LookupStatus: 404 },
      { retiredV3LookupStatus: 404 },
      { retiredV4LookupStatus: 404 },
      { currentLookupStatus: 200 },
      { retiredV1EvidenceArtifactCount: 1 },
      { retiredV2EvidenceArtifactCount: 2 },
      { retiredV3EvidenceArtifactCount: 3 },
      { retiredV4EvidenceArtifactCount: 3 },
      { currentEvidenceArtifactCount: 1 },
      { knownFailedV1RunArtifactCount: 1 },
      { knownFailedV2RunArtifactCount: 2 },
      { knownFailedV3RunArtifactCount: 3 },
    ]) {
      expect(() => validateBlindedHoldoutBurnAuthorityAbsenceV3({ ...clean, ...mutation }))
        .toThrow(/^mem002prod_artifact:/);
    }
  });

  it('parses a canonical custodian seal and derives its one-shot key', () => {
    const seal = parseBlindedHoldoutSealV3(sealBytes());
    expect(seal.schemaVersion).toBe('memberry.admission-feature-blinded-holdout-seal.v3');
    const key = blindedHoldoutSealedOneShotKeyV3(seal);
    expect(key).toBe(blindedHoldoutOneShotKeyV3({
      schemaVersion: BLINDED_HOLDOUT_V3_KEY_SCHEMA_VERSION,
      candidateSubtreeOid: seal.candidateSubtreeOid,
      candidateSha256: seal.candidateSha256,
      inputSha256: seal.inputSha256,
      oracleSha256: seal.oracleSha256,
    }));
  });

  it('rejects seals that reuse consumed v2-era identities or collapse tree identities', () => {
    expect(() => parseBlindedHoldoutSealV3(sealBytes({ candidateSha256: BLINDED_HOLDOUT_CANDIDATE_SHA256 })))
      .toThrow('mem002prod_artifact:seal_reuse');
    expect(() => parseBlindedHoldoutSealV3(sealBytes({ inputSha256: BLINDED_HOLDOUT_INPUT_SHA256 })))
      .toThrow('mem002prod_artifact:seal_reuse');
    expect(() => parseBlindedHoldoutSealV3(sealBytes({ coreSubtreeOid: 'a'.repeat(40) })))
      .toThrow('mem002prod_artifact:seal_identity');
    expect(() => parseBlindedHoldoutSealV3(sealBytes({ schemaVersion: 'memberry.other' })))
      .toThrow('mem002prod_artifact:seal');
    expect(() => parseBlindedHoldoutSealV3(sealBytes({ extra: true })))
      .toThrow('mem002prod_artifact:seal');
    // Noncanonical bytes (missing trailing newline) are rejected.
    const canonical = sealBytes();
    expect(() => parseBlindedHoldoutSealV3(canonical.slice(0, -1))).toThrow('mem002prod_artifact:seal');
  });

  it('accepts only exact scenarioCount x 3 aggregates at the frozen promotion gate', () => {
    const pass = {
      scenarioCount: 4,
      dimensionCount: 12,
      agreementCount: 12,
      agreementPermille: 1_000,
      availabilityMismatchCount: 0,
      valueMismatchCount: 0,
      passed: true,
    };
    expect(parseBlindedHoldoutAggregateV3(pass)).toEqual(pass);
    const fail = {
      ...pass,
      agreementCount: 11,
      agreementPermille: 916,
      valueMismatchCount: 1,
      passed: false,
    };
    expect(parseBlindedHoldoutAggregateV3(fail)).toEqual(fail);
    expect(parseBlindedHoldoutAggregateV3({
      ...pass, scenarioCount: 6, dimensionCount: 18, agreementCount: 18,
    })).toMatchObject({ passed: true });

    for (const mutation of [
      { scenarioCount: 3, dimensionCount: 9, agreementCount: 9 },
      { dimensionCount: 24 },
      { agreementCount: 11 },
      { passed: false },
      { ...fail, passed: true },
      { agreementPermille: 999 },
    ]) {
      expect(() => parseBlindedHoldoutAggregateV3({ ...pass, ...mutation }))
        .toThrow('mem002prod_artifact:aggregate');
    }
  });
});
