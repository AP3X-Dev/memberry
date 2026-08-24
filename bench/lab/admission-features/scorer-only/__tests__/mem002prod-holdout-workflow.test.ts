// MEM-002 seal-time packet: dry structural binding of the new one-shot
// workflow (.github/workflows/mem002prod-holdout.yml) against the committed
// custodian seal and the v3 identity-core constants — every identity the yml
// pins must agree with the TypeScript constants and the sealed record, and the
// frozen mem002c3 workflow's discipline must carry forward with the enumerated
// v3 deltas only.

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  BLINDED_HOLDOUT_RETIRED_V1_ONE_SHOT_KEY,
  BLINDED_HOLDOUT_RETIRED_V2_ONE_SHOT_KEY,
  BLINDED_HOLDOUT_RETIRED_V3_ONE_SHOT_KEY,
  BLINDED_HOLDOUT_RETIRED_V4_ONE_SHOT_KEY,
  BLINDED_HOLDOUT_V3_RETIRED_ONE_SHOT_KEYS,
  blindedHoldoutSealedOneShotKeyV3,
  parseBlindedHoldoutSealV3,
} from '../blinded-holdout-artifact-v3.js';

const REPO_ROOT = join(import.meta.dirname, '..', '..', '..', '..', '..');
const WORKFLOW_PATH = join(REPO_ROOT, '.github', 'workflows', 'mem002prod-holdout.yml');
const SEAL_PATH = join(REPO_ROOT, 'bench', 'lab', 'admission-features', 'scorer-only', 'v3', 'seal.json');

async function workflowText(): Promise<string> {
  return readFile(WORKFLOW_PATH, 'utf8');
}

function envValue(workflow: string, name: string): string {
  const match = workflow.match(new RegExp(`^\\s{6}${name}: "?([^"\\n]+)"?$`, 'm'));
  expect(match, `env ${name}`).toBeTruthy();
  return match![1]!;
}

describe('MEM-002PROD one-shot workflow binding', () => {
  it('binds every identity env to the seal and the v3 identity-core constants', async () => {
    const workflow = await workflowText();
    expect(envValue(workflow, 'POLICY_RECEIPT'))
      .toBe('bench/lab/admission-features/contracts/c2-runtime-policy-receipt.v4.json');
    expect(envValue(workflow, 'SCORER_ENTRY'))
      .toBe('bench/lab/admission-features/scorer-only/blinded-holdout-v3.ts');
    expect(envValue(workflow, 'SEAL_PATH'))
      .toBe('bench/lab/admission-features/scorer-only/v3/seal.json');
    expect(`sha256:${envValue(workflow, 'RETIRED_V1_ONE_SHOT_KEY')}`)
      .toBe(BLINDED_HOLDOUT_RETIRED_V1_ONE_SHOT_KEY);
    expect(`sha256:${envValue(workflow, 'RETIRED_V2_ONE_SHOT_KEY')}`)
      .toBe(BLINDED_HOLDOUT_RETIRED_V2_ONE_SHOT_KEY);
    expect(`sha256:${envValue(workflow, 'RETIRED_V3_ONE_SHOT_KEY')}`)
      .toBe(BLINDED_HOLDOUT_RETIRED_V3_ONE_SHOT_KEY);
    expect(`sha256:${envValue(workflow, 'RETIRED_V4_ONE_SHOT_KEY')}`)
      .toBe(BLINDED_HOLDOUT_RETIRED_V4_ONE_SHOT_KEY);
    expect(envValue(workflow, 'RETIRED_V4_BURN_TARGET_SHA')).toMatch(/^[0-9a-f]{40}$/);
    expect(envValue(workflow, 'KNOWN_PASSED_V4_RUN_ID')).toBe('32698797178');
    expect(envValue(workflow, 'PLATFORM')).toBe('linux/amd64');
    expect(envValue(workflow, 'BASE_IMAGE'))
      .toBe('node@sha256:7eb2c0c4b8cf6fd761f0e6a7fed8d3b8ad59186848f0eee59744e546f1b6a3e9');
    // Identity comes from the seal, never from yml constants: the v2-era
    // identity envs and the prediction pre-pin must NOT exist.
    for (const retired of [
      'CANDIDATE_COMMIT_SHA:', 'REPOSITORY_ROOT_TREE_OID:',
      'HISTORICAL_CANDIDATE_SUBTREE_OID:', 'INPUT_SHA256:', 'OUTPUT_SHA256:',
    ]) {
      expect(workflow.includes(`      ${retired} `), retired).toBe(false);
    }
  });

  it('derives a fresh sealed one-shot key distinct from every retired key', async () => {
    const seal = parseBlindedHoldoutSealV3(new Uint8Array(await readFile(SEAL_PATH)));
    const key = blindedHoldoutSealedOneShotKeyV3(seal);
    expect(key).toMatch(/^sha256:[0-9a-f]{64}$/);
    for (const retired of BLINDED_HOLDOUT_V3_RETIRED_ONE_SHOT_KEYS) {
      expect(key).not.toBe(retired);
    }
  });

  it('keeps the one-shot discipline: manual, minimal permissions, distinct concurrency', async () => {
    const workflow = await workflowText();
    const frozen = await readFile(join(REPO_ROOT, '.github', 'workflows', 'mem002c3-holdout.yml'), 'utf8');
    expect(workflow).toMatch(/\bon:\s*\n\s+workflow_dispatch:/);
    expect(workflow).not.toMatch(/\n\s+(?:push|pull_request|schedule|workflow_call):/);
    expect(workflow).toMatch(/permissions:\s*\n\s+contents: write\s*\n\s+actions: read\s*\n\s*\n/);
    expect(workflow).toContain('group: memberry-mem002prod-blinded-holdout-v3');
    expect(frozen).toContain('group: memberry-mem002c3-blinded-holdout-v2');
    expect(workflow).not.toContain('group: memberry-mem002c3-blinded-holdout-v2');
    expect(workflow).toContain('persist-credentials: false');
    expect(workflow.match(/\$\{\{\s*github\.token\s*\}\}/g)?.length).toBe(2);
    expect(workflow).not.toMatch(/secrets\./);
  });

  it('sweeps all five key generations and pins the retired v4 burn authority', async () => {
    const workflow = await workflowText();
    expect(workflow).toContain('artifact.name === `memberry-mem002c3-burn-${process.env.RETIRED4_KEY}`');
    expect(workflow).toContain('artifact.name === `memberry-mem002c3-burn-${process.env.CURRENT_KEY}`');
    expect(workflow).toContain('[[ "$retired_v4_target_sha" == "$RETIRED_V4_BURN_TARGET_SHA" ]]');
    // Standalone known-passed v4 run assertion (the validator has no
    // known-passed slot): the consumed pass's own artifact count stays <= 2.
    expect(workflow).toContain('actions/runs/${KNOWN_PASSED_V4_RUN_ID}/artifacts');
    expect(workflow).toContain('[[ "$passed_v4_run_artifacts" -le 2 ]]');
    // 13-field burn-authority handoff into the seal-guarded validator.
    const authorize = workflow.match(/burn-authority-authorize \\\n(?:\s+"\$[a-z0-9_]+"[^\n]*\n)+/);
    expect(authorize).toBeTruthy();
    expect(authorize![0]!.match(/"\$[a-z0-9_]+"/g)).toHaveLength(13);
  });

  it('validates both sealed subtrees and binds the built candidate to the seal', async () => {
    const workflow = await workflowText();
    expect(workflow).toContain("jq -er '.repositoryRootTreeOid' \"$SEAL_PATH\"");
    expect(workflow).toContain(':bench/lab/admission-features/candidate-v3');
    expect(workflow).toContain(':packages/core/src');
    expect(workflow).toContain('[[ "$observed_core_subtree_oid" == "$seal_core_subtree_oid" ]]');
    expect(workflow).toContain('buildAdmissionFeatureCandidateV3ImageV1');
    expect(workflow).toContain('sealed_candidate_sha256="$(jq -er \'.candidateSha256\' "$SEAL_PATH")"');
    expect(workflow).toContain('[[ "$built_candidate_sha256" == "$sealed_candidate_sha256" ]]');
    expect(workflow).toContain('[[ "$observed" == "$(jq -er \'.inputSha256\' "$SEAL_PATH")" ]]');
  });

  it('keeps sole-run scoring on both node majors, custody removal, and v3 receipt secrecy', async () => {
    const workflow = await workflowText();
    expect(workflow.match(/docker container start --attach --interactive/g)).toHaveLength(1);
    expect(workflow).toContain('MEMBERRY_EXPECTED_NODE_MAJOR: "20"');
    expect(workflow).toContain('MEMBERRY_EXPECTED_NODE_MAJOR: "22"');
    expect(workflow).toContain('--network none --user 65532:65532 --read-only --cap-drop ALL');
    expect(workflow).not.toMatch(/--mount|--volume|--tmpfs/);
    expect(workflow).toContain('"$MEMBERRY_C3_SECRET_DIR/build-receipt.json" \\');
    expect(workflow).toContain('blinded-holdout-v3.ts \\');
    expect(workflow).toContain('blinded-holdout-artifact-v3.ts \\');
    expect(workflow).toContain('af3-(?:dev|holdout)-[0-9]');
    expect(workflow).not.toMatch(/--request DELETE|git push[^\n]*(?:--delete|:refs\/tags\/memberry-mem002c3-burn)/);
  });
});
