// MEM-002 productionization: v3 blinded-holdout identity core.
//
// The frozen blinded-holdout-artifact.ts constants back the consumed v2-era
// evidence chain and are never edited. This module carries the SAME append-only
// burn-tag namespace forward, retires ALL four prior one-shot keys (three
// burned pre-pass plus the consumed passing key), and derives the fresh v3
// attempt's one-shot key from a custodian-sealed identity record. The sealed
// identities (new integrated base commit, candidate/core subtree OIDs, v3
// input/oracle hashes) only exist after the implementation merges and the
// holdout corpus is sealed, so they are bound through parseBlindedHoldoutSealV3
// rather than fabricated constants — an unsealed dispatch fails loudly.

import { createHash } from 'node:crypto';
import { types as nodeUtilTypes } from 'node:util';

import {
  BLINDED_HOLDOUT_CANDIDATE_SHA256,
  BLINDED_HOLDOUT_INPUT_SHA256,
  BLINDED_HOLDOUT_ORACLE_SHA256,
  BLINDED_HOLDOUT_RETIRED_V1_ONE_SHOT_KEY,
  BLINDED_HOLDOUT_RETIRED_V2_ONE_SHOT_KEY,
  BLINDED_HOLDOUT_RETIRED_V3_ONE_SHOT_KEY,
} from './blinded-holdout-artifact.js';

const TRUSTED_IS_PROXY = nodeUtilTypes.isProxy;
const TRUSTED_GET_PROTOTYPE_OF = Object.getPrototypeOf;
const TRUSTED_GET_OWN_PROPERTY_DESCRIPTOR = Object.getOwnPropertyDescriptor;
const TRUSTED_OWN_KEYS = Reflect.ownKeys;
const TRUSTED_OBJECT_PROTOTYPE = Object.prototype;
const TRUSTED_REGEXP_TEST = Function.prototype.call.bind(RegExp.prototype.test) as (
  pattern: RegExp,
  value: string,
) => boolean;

export const BLINDED_HOLDOUT_V3_ARTIFACT_VERSION = '3.0.0' as const;
export const BLINDED_HOLDOUT_V3_KEY_SCHEMA_VERSION =
  'memberry.admission-feature-blinded-holdout-key.v4' as const;
export const BLINDED_HOLDOUT_V3_SEAL_SCHEMA_VERSION =
  'memberry.admission-feature-blinded-holdout-seal.v3' as const;
/** Same append-only namespace as every prior burn (scorer-only/blinded-holdout.ts:60). */
export const BLINDED_HOLDOUT_V3_TOMBSTONE_REF_PREFIX = 'refs/tags/memberry-mem002c3-burn/' as const;

// All four prior keys are retired authority for the v3 attempt: the three
// burned pre-pass keys plus the CONSUMED passing key of run 32698797178.
export { BLINDED_HOLDOUT_RETIRED_V1_ONE_SHOT_KEY } from './blinded-holdout-artifact.js';
export { BLINDED_HOLDOUT_RETIRED_V2_ONE_SHOT_KEY } from './blinded-holdout-artifact.js';
export { BLINDED_HOLDOUT_RETIRED_V3_ONE_SHOT_KEY } from './blinded-holdout-artifact.js';
export const BLINDED_HOLDOUT_RETIRED_V4_ONE_SHOT_KEY =
  'sha256:0f55163931d762cbe23f019ac85074be22638c2ea0aabf6b28726757fd62ef11' as const;

export const BLINDED_HOLDOUT_V3_RETIRED_ONE_SHOT_KEYS = Object.freeze([
  BLINDED_HOLDOUT_RETIRED_V1_ONE_SHOT_KEY,
  BLINDED_HOLDOUT_RETIRED_V2_ONE_SHOT_KEY,
  BLINDED_HOLDOUT_RETIRED_V3_ONE_SHOT_KEY,
  BLINDED_HOLDOUT_RETIRED_V4_ONE_SHOT_KEY,
] as const);

const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/;
const COMMIT_PATTERN = /^[0-9a-f]{40}$/;
const KEY_SCHEMA_PATTERN = /^memberry\.admission-feature-blinded-holdout-key\.v4$/;
const SEAL_MAX_BYTES = 4_096;

export class BlindedHoldoutArtifactV3Error extends Error {
  constructor(readonly code: string) {
    super(`mem002prod_artifact:${code}`);
    this.name = 'BlindedHoldoutArtifactV3Error';
  }
}

function fail(code: string): never {
  throw new BlindedHoldoutArtifactV3Error(code);
}

function sha256(value: string | Uint8Array): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

export interface BlindedHoldoutStablePairV3 {
  readonly schemaVersion: typeof BLINDED_HOLDOUT_V3_KEY_SCHEMA_VERSION;
  readonly candidateSubtreeOid: string;
  readonly candidateSha256: `sha256:${string}`;
  readonly inputSha256: `sha256:${string}`;
  readonly oracleSha256: `sha256:${string}`;
}

const STABLE_PAIR_KEYS = [
  'schemaVersion',
  'candidateSubtreeOid',
  'candidateSha256',
  'inputSha256',
  'oracleSha256',
] as const;

function snapshotStablePair(identity: unknown): BlindedHoldoutStablePairV3 {
  if (typeof identity !== 'object' || identity === null || TRUSTED_IS_PROXY(identity)) fail('identity');
  if (TRUSTED_GET_PROTOTYPE_OF(identity) !== TRUSTED_OBJECT_PROTOTYPE) fail('identity');
  const ownKeys = TRUSTED_OWN_KEYS(identity);
  if (ownKeys.length !== STABLE_PAIR_KEYS.length) fail('identity');
  for (const key of ownKeys) {
    if (typeof key !== 'string') fail('identity');
    let registered = false;
    for (const expected of STABLE_PAIR_KEYS) {
      if (key === expected) {
        registered = true;
        break;
      }
    }
    if (!registered) fail('identity');
  }
  const values: string[] = [];
  for (const key of STABLE_PAIR_KEYS) {
    const descriptor = TRUSTED_GET_OWN_PROPERTY_DESCRIPTOR(identity, key);
    if (!descriptor || descriptor.enumerable !== true || !('value' in descriptor) || typeof descriptor.value !== 'string') {
      fail('identity');
    }
    values.push(descriptor.value);
  }
  return {
    schemaVersion: values[0] as typeof BLINDED_HOLDOUT_V3_KEY_SCHEMA_VERSION,
    candidateSubtreeOid: values[1]!,
    candidateSha256: values[2] as `sha256:${string}`,
    inputSha256: values[3] as `sha256:${string}`,
    oracleSha256: values[4] as `sha256:${string}`,
  };
}

/**
 * Fresh one-shot key for the v3 attempt. Deliberately identical derivation
 * discipline to blindedHoldoutOneShotKeyV2 (stable pair only — no
 * infrastructure identities can reopen a burned attempt), with the schema
 * version bumped to v4 so no retired-era pair can collide. There is NO default
 * identity: the stable pair comes from the custodian seal.
 */
export function blindedHoldoutOneShotKeyV3(identity: unknown): `sha256:${string}` {
  const snapshot = snapshotStablePair(identity);
  if (
    !TRUSTED_REGEXP_TEST(KEY_SCHEMA_PATTERN, snapshot.schemaVersion) ||
    !TRUSTED_REGEXP_TEST(COMMIT_PATTERN, snapshot.candidateSubtreeOid) ||
    !TRUSTED_REGEXP_TEST(SHA256_PATTERN, snapshot.candidateSha256) ||
    !TRUSTED_REGEXP_TEST(SHA256_PATTERN, snapshot.inputSha256) ||
    !TRUSTED_REGEXP_TEST(SHA256_PATTERN, snapshot.oracleSha256)
  )
    fail('identity');
  const canonical = `{"schemaVersion":"${snapshot.schemaVersion}","candidateSubtreeOid":"${snapshot.candidateSubtreeOid}","candidateSha256":"${snapshot.candidateSha256}","inputSha256":"${snapshot.inputSha256}","oracleSha256":"${snapshot.oracleSha256}"}`;
  const key = sha256(canonical);
  for (const retired of BLINDED_HOLDOUT_V3_RETIRED_ONE_SHOT_KEYS) {
    if (key === retired) fail('retired_key');
  }
  return key;
}

/**
 * Custodian seal binding the post-merge identities the spec assigns to the v3
 * attempt. Canonical single-line JSON; every field is validated by pattern and
 * checked for non-reuse against the frozen v2-era corpus/candidate identities.
 */
export interface BlindedHoldoutSealV3 {
  readonly schemaVersion: typeof BLINDED_HOLDOUT_V3_SEAL_SCHEMA_VERSION;
  readonly integratedBaseSha: string;
  readonly candidateCommitSha: string;
  readonly repositoryRootTreeOid: string;
  /** Subtree OID of candidate-v3 at the evaluated commit. */
  readonly candidateSubtreeOid: string;
  /** Subtree OID of packages/core/src at the evaluated commit (the production module). */
  readonly coreSubtreeOid: string;
  readonly candidateSha256: `sha256:${string}`;
  readonly inputSha256: `sha256:${string}`;
  readonly oracleSha256: `sha256:${string}`;
}

const SEAL_KEYS = [
  'schemaVersion',
  'integratedBaseSha',
  'candidateCommitSha',
  'repositoryRootTreeOid',
  'candidateSubtreeOid',
  'coreSubtreeOid',
  'candidateSha256',
  'inputSha256',
  'oracleSha256',
] as const;

function snapshotBytes(value: unknown): Uint8Array {
  if (typeof value !== 'object' || value === null || nodeUtilTypes.isProxy(value)
    || Object.getPrototypeOf(value) !== Uint8Array.prototype) fail('seal_bytes');
  const bytes = value as Uint8Array;
  if (bytes.byteLength < 2 || bytes.byteLength > SEAL_MAX_BYTES) fail('seal_bytes');
  return Uint8Array.from(bytes);
}

export function parseBlindedHoldoutSealV3(bytes: unknown): BlindedHoldoutSealV3 {
  const copy = snapshotBytes(bytes);
  let raw: Record<string, unknown>;
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(copy);
    if (!text.endsWith('\n') || text.includes('\r') || text.slice(0, -1).includes('\n')) fail('seal');
    const value = JSON.parse(text.slice(0, -1)) as unknown;
    if (
      typeof value !== 'object' || value === null || Array.isArray(value)
      || nodeUtilTypes.isProxy(value) || Object.getPrototypeOf(value) !== Object.prototype
    )
      fail('seal');
    raw = value as Record<string, unknown>;
  } catch (error) {
    if (error instanceof BlindedHoldoutArtifactV3Error) throw error;
    fail('seal');
  }
  const ownKeys = Reflect.ownKeys(raw);
  if (ownKeys.length !== SEAL_KEYS.length
    || ownKeys.some((key) => typeof key !== 'string' || !(SEAL_KEYS as readonly string[]).includes(key))) {
    fail('seal');
  }
  if (raw.schemaVersion !== BLINDED_HOLDOUT_V3_SEAL_SCHEMA_VERSION) fail('seal');
  for (const key of ['integratedBaseSha', 'candidateCommitSha', 'repositoryRootTreeOid', 'candidateSubtreeOid', 'coreSubtreeOid'] as const) {
    if (typeof raw[key] !== 'string' || !COMMIT_PATTERN.test(raw[key] as string)) fail('seal');
  }
  for (const key of ['candidateSha256', 'inputSha256', 'oracleSha256'] as const) {
    if (typeof raw[key] !== 'string' || !SHA256_PATTERN.test(raw[key] as string)) fail('seal');
  }
  const seal = {
    schemaVersion: BLINDED_HOLDOUT_V3_SEAL_SCHEMA_VERSION,
    integratedBaseSha: raw.integratedBaseSha as string,
    candidateCommitSha: raw.candidateCommitSha as string,
    repositoryRootTreeOid: raw.repositoryRootTreeOid as string,
    candidateSubtreeOid: raw.candidateSubtreeOid as string,
    coreSubtreeOid: raw.coreSubtreeOid as string,
    candidateSha256: raw.candidateSha256 as `sha256:${string}`,
    inputSha256: raw.inputSha256 as `sha256:${string}`,
    oracleSha256: raw.oracleSha256 as `sha256:${string}`,
  } as const;
  // Trees must be distinct identities; the fresh corpus and candidate can
  // never reuse the consumed v2-era identities (a reuse would re-key onto a
  // burned attempt or a stale candidate).
  if (
    seal.repositoryRootTreeOid === seal.candidateSubtreeOid
    || seal.repositoryRootTreeOid === seal.coreSubtreeOid
    || seal.candidateSubtreeOid === seal.coreSubtreeOid
  )
    fail('seal_identity');
  if (
    seal.candidateSha256 === BLINDED_HOLDOUT_CANDIDATE_SHA256
    || seal.inputSha256 === BLINDED_HOLDOUT_INPUT_SHA256
    || seal.oracleSha256 === BLINDED_HOLDOUT_ORACLE_SHA256
  )
    fail('seal_reuse');
  const frozen = Object.freeze(seal);
  // The seal must derive a fresh, non-retired one-shot key.
  blindedHoldoutSealedOneShotKeyV3(frozen);
  return frozen;
}

/** One-shot key for a sealed identity record. */
export function blindedHoldoutSealedOneShotKeyV3(seal: BlindedHoldoutSealV3): `sha256:${string}` {
  return blindedHoldoutOneShotKeyV3({
    schemaVersion: BLINDED_HOLDOUT_V3_KEY_SCHEMA_VERSION,
    candidateSubtreeOid: seal.candidateSubtreeOid,
    candidateSha256: seal.candidateSha256,
    inputSha256: seal.inputSha256,
    oracleSha256: seal.oracleSha256,
  });
}

/**
 * Pre-start burn-authority verification for the v3 attempt: ALL four retired
 * keys plus the current key, in the shared append-only tag namespace. The
 * retired v2/v3/v4 keys have burned tags (200) with their bounded historical
 * evidence; the v1 key never burned (404, zero evidence); the current key must
 * be wholly absent.
 */
export function validateBlindedHoldoutBurnAuthorityAbsenceV3(options: {
  readonly retiredV1LookupStatus: number;
  readonly retiredV2LookupStatus: number;
  readonly retiredV3LookupStatus: number;
  readonly retiredV4LookupStatus: number;
  readonly currentLookupStatus: number;
  readonly retiredV1EvidenceArtifactCount: number;
  readonly retiredV2EvidenceArtifactCount: number;
  readonly retiredV3EvidenceArtifactCount: number;
  readonly retiredV4EvidenceArtifactCount: number;
  readonly currentEvidenceArtifactCount: number;
  readonly knownFailedV1RunArtifactCount: number;
  readonly knownFailedV2RunArtifactCount: number;
  readonly knownFailedV3RunArtifactCount: number;
}): true {
  const counts = [
    options.retiredV1EvidenceArtifactCount,
    options.retiredV2EvidenceArtifactCount,
    options.retiredV3EvidenceArtifactCount,
    options.retiredV4EvidenceArtifactCount,
    options.currentEvidenceArtifactCount,
    options.knownFailedV1RunArtifactCount,
    options.knownFailedV2RunArtifactCount,
    options.knownFailedV3RunArtifactCount,
  ];
  if (counts.some((count) => !Number.isSafeInteger(count) || count < 0)) fail('burn_authority');
  if (options.currentLookupStatus === 200) fail('burn_preexisting');
  if (options.retiredV1LookupStatus !== 404 || options.currentLookupStatus !== 404) fail('burn_lookup');
  if (
    options.retiredV2LookupStatus !== 200
    || options.retiredV3LookupStatus !== 200
    || options.retiredV4LookupStatus !== 200
  )
    fail('burn_lookup');
  if (options.retiredV1EvidenceArtifactCount !== 0 || options.currentEvidenceArtifactCount !== 0
    || options.knownFailedV1RunArtifactCount !== 0) fail('legacy_authority');
  if (options.retiredV2EvidenceArtifactCount > 1 || options.knownFailedV2RunArtifactCount > 1) {
    fail('legacy_authority');
  }
  if (options.retiredV3EvidenceArtifactCount > 2 || options.knownFailedV3RunArtifactCount > 2) {
    fail('legacy_authority');
  }
  // The consumed passing attempt (run 32698797178) published a burn receipt
  // and one aggregate result receipt under its key.
  if (options.retiredV4EvidenceArtifactCount > 2) fail('legacy_authority');
  return true;
}

export interface BlindedHoldoutAggregateV3 {
  readonly scenarioCount: number;
  readonly dimensionCount: number;
  readonly agreementCount: number;
  readonly agreementPermille: number;
  readonly availabilityMismatchCount: number;
  readonly valueMismatchCount: number;
  readonly passed: boolean;
}

/**
 * Aggregate contract for the narrowed three-dimension envelope: always
 * scenarioCount x 3 cells (4+ custodian-authored scenarios), promotion only at
 * zero mismatches and the exact frozen 1000-permille gate.
 */
export function parseBlindedHoldoutAggregateV3(value: BlindedHoldoutAggregateV3): BlindedHoldoutAggregateV3 {
  if (
    typeof value !== 'object' || value === null || Array.isArray(value)
    || nodeUtilTypes.isProxy(value) || Object.getPrototypeOf(value) !== Object.prototype
  )
    fail('aggregate');
  const keys = Reflect.ownKeys(value);
  const allowed = [
    'scenarioCount', 'dimensionCount', 'agreementCount', 'agreementPermille',
    'availabilityMismatchCount', 'valueMismatchCount', 'passed',
  ];
  if (keys.length !== allowed.length || keys.some((key) => typeof key !== 'string' || !allowed.includes(key))) {
    fail('aggregate');
  }
  const {
    scenarioCount, dimensionCount, agreementCount, agreementPermille,
    availabilityMismatchCount, valueMismatchCount, passed,
  } = value;
  const integers = [scenarioCount, dimensionCount, agreementCount, agreementPermille, availabilityMismatchCount, valueMismatchCount];
  if (integers.some((entry) => !Number.isSafeInteger(entry) || entry < 0)) fail('aggregate');
  if (scenarioCount < 4 || dimensionCount !== scenarioCount * 3) fail('aggregate');
  if (agreementCount > dimensionCount || agreementPermille > 1_000) fail('aggregate');
  const expectedPermille = Math.floor((agreementCount * 1_000) / dimensionCount);
  const exactPass = agreementCount === dimensionCount && agreementPermille === 1_000
    && availabilityMismatchCount === 0 && valueMismatchCount === 0;
  if (
    agreementPermille !== expectedPermille
    || availabilityMismatchCount + valueMismatchCount !== dimensionCount - agreementCount
    || typeof passed !== 'boolean'
    || passed !== exactPass
  )
    fail('aggregate');
  return Object.freeze({
    scenarioCount,
    dimensionCount,
    agreementCount,
    agreementPermille,
    availabilityMismatchCount,
    valueMismatchCount,
    passed,
  });
}
