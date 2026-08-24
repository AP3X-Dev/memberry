// MEM-002 seal-time packet: the canonical committed .v4.json instance must
// parse through the closed four-instance chain and carry exactly the sealed
// candidate identity (the v3 protocol driver rejects any policy receipt whose
// binding drifts from the seal).

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { parseAdmissionC2RuntimePolicyReceiptV4 } from '../c2-runtime-policy-receipt-v4.js';
import { parseBlindedHoldoutSealV3 } from '../../scorer-only/blinded-holdout-artifact-v3.js';

const CONTRACTS_DIR = join(import.meta.dirname, '..');
const SEAL_PATH = join(CONTRACTS_DIR, '..', 'scorer-only', 'v3', 'seal.json');

describe('MEM-002 productionization C2 runtime-policy receipt v4 instance', () => {
  it('parses the committed instance through the exact frozen v3/v2/v1 chain and matches the seal', async () => {
    const [v4, v3, v2, v1, sealBytes] = await Promise.all([
      readFile(join(CONTRACTS_DIR, 'c2-runtime-policy-receipt.v4.json')),
      readFile(join(CONTRACTS_DIR, 'c2-runtime-policy-receipt.v3.json')),
      readFile(join(CONTRACTS_DIR, 'c2-runtime-policy-receipt.v2.json')),
      readFile(join(CONTRACTS_DIR, 'c2-runtime-policy-receipt.v1.json')),
      readFile(SEAL_PATH),
    ]);
    const receipt = parseAdmissionC2RuntimePolicyReceiptV4(
      new Uint8Array(v4), new Uint8Array(v3), new Uint8Array(v2), new Uint8Array(v1),
    );
    const seal = parseBlindedHoldoutSealV3(new Uint8Array(sealBytes));

    // The same four identity equalities the v3 protocol driver enforces
    // before trusting the policy receipt (blinded-holdout-v3.ts
    // loadPolicyReceiptV4), plus the live-proof input identity.
    expect(receipt.binding.candidateCommitSha).toBe(seal.candidateCommitSha);
    expect(receipt.binding.repositoryRootTreeOid).toBe(seal.repositoryRootTreeOid);
    expect(receipt.binding.candidateSubtreeOid).toBe(seal.candidateSubtreeOid);
    expect(receipt.binding.candidateSha256).toBe(seal.candidateSha256);
    expect(receipt.binding.inputSha256).toBe(seal.inputSha256);

    // Hosted attestation identity: the M1 post-master CI run, attempt 1.
    expect(receipt.binding.hostedEvidence.workflowRunId).toBe('32773103347');
    expect(receipt.binding.hostedEvidence.workflowRunAttempt).toBe(1);
    expect(receipt.binding.hostedEvidence.artifactName).toBe(
      'memberry-admission-candidate-live-32773103347-1',
    );
    expect(receipt.binding.hostedEvidence.cleanupVerified).toBe(true);
  });
});
