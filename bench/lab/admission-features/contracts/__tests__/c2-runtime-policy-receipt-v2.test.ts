import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { test } from 'vitest';

import { parseAdmissionC2RuntimePolicyReceiptV1 } from '../c2-runtime-policy-receipt.js';
import { parseAdmissionC2RuntimePolicyReceiptV2 } from '../c2-runtime-policy-receipt-v2.js';

const CONTRACT_ROOT = resolve('bench/lab/admission-features/contracts');
const V1_PATH = resolve(CONTRACT_ROOT, 'c2-runtime-policy-receipt.v1.json');
const V2_PATH = resolve(CONTRACT_ROOT, 'c2-runtime-policy-receipt.v2.json');
const V1_CANONICAL_BYTES_SHA256 =
  'sha256:c55c3b8f66d32e529d5467d90f079dc4027d5dc62b2fcd3fbd6ece0200e63c70';
const REPOSITORY_ROOT_TREE_OID = '94c75dd3a36a708ce6add1f10eaf606fa4ffea8d';
const CANDIDATE_SUBTREE_OID = '03d7c50515f6ab767fd41b7d41bd231531a4ab58';

function sha256(bytes: Uint8Array | string): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function mutateCanonicalReceipt(
  bytes: Uint8Array,
  mutate: (receipt: Record<string, any>) => void,
): Uint8Array {
  const receipt = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, any>;
  mutate(receipt);
  const { receiptSha256: _discarded, ...payload } = receipt;
  receipt.receiptSha256 = sha256(JSON.stringify(payload));
  return new TextEncoder().encode(`${JSON.stringify(receipt)}\n`);
}

async function canonicalBytes(): Promise<{ v1: Uint8Array; v2: Uint8Array }> {
  const [v1, v2] = await Promise.all([readFile(V1_PATH), readFile(V2_PATH)]);
  return { v1: new Uint8Array(v1), v2: new Uint8Array(v2) };
}

test('v2 names distinct repository-root and candidate-subtree identities and proves v1 equivalence', async () => {
  const { v1, v2 } = await canonicalBytes();
  assert.equal(sha256(v1), V1_CANONICAL_BYTES_SHA256);

  const legacy = parseAdmissionC2RuntimePolicyReceiptV1(v1);
  const receipt = parseAdmissionC2RuntimePolicyReceiptV2(v2, v1);

  assert.equal(receipt.binding.repositoryRootTreeOid, REPOSITORY_ROOT_TREE_OID);
  assert.equal(receipt.binding.candidateSubtreeOid, CANDIDATE_SUBTREE_OID);
  assert.notEqual(receipt.binding.repositoryRootTreeOid, receipt.binding.candidateSubtreeOid);
  assert.equal(receipt.legacyReceipt.receiptSha256, legacy.receiptSha256);
  assert.equal(receipt.legacyReceipt.canonicalBytesSha256, V1_CANONICAL_BYTES_SHA256);
  assert.deepEqual(receipt.policy, legacy.policy);
  assert.deepEqual(receipt.binding.hostedEvidence, legacy.binding.hostedEvidence);
  for (const key of [
    'candidateCommitSha', 'candidateSha256', 'sourceSha256', 'imageSha256',
    'imageConfigSha256', 'nodeSha256', 'rootFsLayerSha256', 'inputSha256', 'outputSha256',
  ] as const) {
    assert.deepEqual(receipt.binding[key], legacy.binding[key]);
  }
  assert.ok(Object.isFrozen(receipt));
  assert.ok(Object.isFrozen(receipt.binding));
  assert.ok(Object.isFrozen(receipt.policy));
});

test('v2 rejects substituted, missing, equal, malformed, coerced, and ambiguous tree identities', async () => {
  const { v1, v2 } = await canonicalBytes();
  const rejected: Uint8Array[] = [
    mutateCanonicalReceipt(v2, (value) => { value.binding.repositoryRootTreeOid = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'; }),
    mutateCanonicalReceipt(v2, (value) => { value.binding.candidateSubtreeOid = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'; }),
    mutateCanonicalReceipt(v2, (value) => { delete value.binding.candidateSubtreeOid; }),
    mutateCanonicalReceipt(v2, (value) => { value.binding.candidateSubtreeOid = REPOSITORY_ROOT_TREE_OID; }),
    mutateCanonicalReceipt(v2, (value) => { value.binding.candidateSubtreeOid = '03d7c5'; }),
    mutateCanonicalReceipt(v2, (value) => { value.binding.candidateSubtreeOid = 3; }),
    mutateCanonicalReceipt(v2, (value) => { value.binding.candidateTreeOid = REPOSITORY_ROOT_TREE_OID; }),
    mutateCanonicalReceipt(v2, (value) => { value.binding.unexpected = true; }),
  ];
  for (const bytes of rejected) {
    assert.throws(() => parseAdmissionC2RuntimePolicyReceiptV2(bytes, v1));
  }
});

test('v1 and v2 parsers cannot be crossed or used as fallbacks', async () => {
  const { v1, v2 } = await canonicalBytes();
  assert.throws(() => parseAdmissionC2RuntimePolicyReceiptV2(undefined, v1));
  assert.throws(() => parseAdmissionC2RuntimePolicyReceiptV2(v2, undefined));
  assert.throws(() => parseAdmissionC2RuntimePolicyReceiptV1(v2));
  assert.throws(() => parseAdmissionC2RuntimePolicyReceiptV2(v1, v1));
  assert.throws(() => parseAdmissionC2RuntimePolicyReceiptV2(v2, v2));
});

test('v2 rejects v1 byte/hash drift and unrelated policy or hosted-binding drift', async () => {
  const { v1, v2 } = await canonicalBytes();
  const driftedV1 = new Uint8Array([...v1.slice(0, -1), 0x20, 0x0a]);
  assert.throws(() => parseAdmissionC2RuntimePolicyReceiptV2(v2, driftedV1));

  const badLegacyHash = mutateCanonicalReceipt(v2, (value) => {
    value.legacyReceipt.receiptSha256 = 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  });
  const badLegacyBytesHash = mutateCanonicalReceipt(v2, (value) => {
    value.legacyReceipt.canonicalBytesSha256 = 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
  });
  const badCandidateHash = mutateCanonicalReceipt(v2, (value) => {
    value.binding.candidateSha256 = 'sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc';
  });
  const badHostedEvidence = mutateCanonicalReceipt(v2, (value) => {
    value.binding.hostedEvidence.artifactName = 'substituted';
  });
  const badPolicy = mutateCanonicalReceipt(v2, (value) => {
    value.policy.network = 'host';
  });
  for (const bytes of [badLegacyHash, badLegacyBytesHash, badCandidateHash, badHostedEvidence, badPolicy]) {
    assert.throws(() => parseAdmissionC2RuntimePolicyReceiptV2(bytes, v1));
  }
});

test('v2 accepts only canonical closed bytes and invokes no caller hooks', async () => {
  const { v1, v2 } = await canonicalBytes();
  assert.throws(() => parseAdmissionC2RuntimePolicyReceiptV2(new Proxy(v2, {}), v1));
  assert.throws(() => parseAdmissionC2RuntimePolicyReceiptV2(new TextEncoder().encode(` ${new TextDecoder().decode(v2)}`), v1));
  assert.throws(() => parseAdmissionC2RuntimePolicyReceiptV2(new TextEncoder().encode(new TextDecoder().decode(v2).replace(/\n$/, '\r\n')), v1));

  let invoked = false;
  const hookedLegacy = new Proxy(v1, {
    get() {
      invoked = true;
      throw new Error('hook invoked');
    },
  });
  assert.throws(() => parseAdmissionC2RuntimePolicyReceiptV2(v2, hookedLegacy));
  assert.equal(invoked, false);
});

test('v2 rejects ambient canonical-serialization drift without invoking prototype hooks', async () => {
  const { v1, v2 } = await canonicalBytes();
  const prototypes = [Object.prototype, Array.prototype] as const;
  for (const prototype of prototypes) {
    let invoked = 0;
    Object.defineProperty(prototype, 'toJSON', {
      configurable: true,
      value() {
        invoked += 1;
        throw new Error('ambient toJSON hook invoked');
      },
      writable: true,
    });
    try {
      assert.throws(() => parseAdmissionC2RuntimePolicyReceiptV2(v2, v1));
      assert.equal(invoked, 0);
    } finally {
      delete (prototype as { toJSON?: unknown }).toJSON;
    }
  }

  let getterInvoked = 0;
  Object.defineProperty(Object.prototype, 'toJSON', {
    configurable: true,
    get() {
      getterInvoked += 1;
      throw new Error('ambient toJSON getter invoked');
    },
  });
  try {
    assert.throws(() => parseAdmissionC2RuntimePolicyReceiptV2(v2, v1));
    assert.equal(getterInvoked, 0);
  } finally {
    delete (Object.prototype as { toJSON?: unknown }).toJSON;
  }

  const revoked = Proxy.revocable(() => undefined, {});
  Object.defineProperty(Array.prototype, 'toJSON', {
    configurable: true,
    value: revoked.proxy,
  });
  revoked.revoke();
  try {
    assert.throws(() => parseAdmissionC2RuntimePolicyReceiptV2(v2, v1));
  } finally {
    delete (Array.prototype as { toJSON?: unknown }).toJSON;
  }
});

test('v2 rejects accessor and proxied serialization intrinsics without invoking them', async () => {
  const { v1, v2 } = await canonicalBytes();
  const targets = [
    { owner: JSON, key: 'parse' },
    { owner: JSON, key: 'stringify' },
    { owner: Object, key: 'getOwnPropertyDescriptor' },
  ] as const;

  for (const { owner, key } of targets) {
    const original = Object.getOwnPropertyDescriptor(owner, key);
    assert.ok(original && 'value' in original && typeof original.value === 'function');
    let invoked = 0;
    let rejected = false;
    Object.defineProperty(owner, key, {
      configurable: true,
      get() {
        invoked += 1;
        throw new Error('ambient intrinsic getter invoked');
      },
    });
    try {
      try {
        parseAdmissionC2RuntimePolicyReceiptV2(v2, v1);
      } catch {
        rejected = true;
      }
    } finally {
      Object.defineProperty(owner, key, original);
    }
    assert.equal(rejected, true);
    assert.equal(invoked, 0);

    const proxied = new Proxy(original.value as (...args: unknown[]) => unknown, {
      apply() {
        invoked += 1;
        throw new Error('ambient intrinsic proxy invoked');
      },
    });
    Object.defineProperty(owner, key, { ...original, value: proxied });
    rejected = false;
    try {
      try {
        parseAdmissionC2RuntimePolicyReceiptV2(v2, v1);
      } catch {
        rejected = true;
      }
    } finally {
      Object.defineProperty(owner, key, original);
    }
    assert.equal(rejected, true);
    assert.equal(invoked, 0);
  }
});
