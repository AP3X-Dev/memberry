import { access, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { parseAdmissionC2RuntimePolicyReceiptV1 } from '../../contracts/c2-runtime-policy-receipt.js';
import type {
  AdmissionFeatureAgreementReportV1,
  AdmissionFeatureAgreementMetricsV1,
} from '../../scorer.js';
import {
  assertBlindedHoldoutPromotionV1,
  BlindedHoldoutProtocolError,
  buildBlindedHoldoutDockerCreateArgs,
  buildBlindedHoldoutStartReceiptV1,
  buildBlindedHoldoutTombstoneSpecV1,
  removeBlindedHoldoutPrivateEvidenceV1,
  scoreSealedBlindedHoldoutV1,
  validateBlindedHoldoutTombstoneAbsenceV1,
  validateBlindedHoldoutPreflightV1,
  verifyBlindedHoldoutTombstoneCreationV1,
} from '../blinded-holdout.js';

const REPO_ROOT = process.cwd();
const POLICY_PATH = `${REPO_ROOT}/bench/lab/admission-features/contracts/c2-runtime-policy-receipt.v1.json`;
const SHA_A = `sha256:${'a'.repeat(64)}` as const;

async function policyReceipt() {
  return parseAdmissionC2RuntimePolicyReceiptV1(new Uint8Array(await readFile(POLICY_PATH)));
}

function preflightOptions(receipt: Awaited<ReturnType<typeof policyReceipt>>) {
  return {
    receipt,
    eventName: 'workflow_dispatch',
    repository: 'AP3X-Dev/memberry',
    workflowRunId: '123456789',
    workflowRunAttempt: 1,
    priorAuthoritativeReceiptCount: 0,
    evaluatedCommitSha: 'd'.repeat(40),
    integratedBaseIsAncestor: true,
    candidateSubtreeClean: true,
    candidateContextOnly: true,
    observedPlatform: 'linux/amd64',
    observedBaseImage: receipt.policy.baseImage,
    observedCandidateCommitSha: receipt.binding.candidateCommitSha,
    observedCandidateTreeOid: receipt.binding.candidateTreeOid,
    observedInputSha256: receipt.binding.inputSha256,
  };
}

function counts(overrides: Partial<AdmissionFeatureAgreementMetricsV1> = {}): AdmissionFeatureAgreementMetricsV1 {
  return {
    scenarioCount: 3,
    dimensionCount: 18,
    agreementCount: 18,
    agreementPermille: 1_000,
    availableLabelCount: 12,
    unavailableLabelCount: 6,
    availableAgreementCount: 12,
    unavailableAgreementCount: 6,
    availabilityMismatchCount: 0,
    valueMismatchCount: 0,
    ...overrides,
  };
}

function report(holdout = counts()): AdmissionFeatureAgreementReportV1 {
  return {
    contractVersion: '1.0.0',
    policy: { requiredAgreementPermille: 1_000 },
    metrics: counts({
      scenarioCount: 6,
      dimensionCount: 36,
      agreementCount: holdout.agreementCount + 18,
      availableLabelCount: holdout.availableLabelCount + 12,
      unavailableLabelCount: holdout.unavailableLabelCount + 6,
      availableAgreementCount: holdout.availableAgreementCount + 12,
      unavailableAgreementCount: holdout.unavailableAgreementCount + 6,
      availabilityMismatchCount: holdout.availabilityMismatchCount,
      valueMismatchCount: holdout.valueMismatchCount,
      agreementPermille: holdout.agreementPermille === 1_000 ? 1_000 : 972,
    } as never),
    splits: { dev: counts(), holdout },
    failures: holdout.agreementPermille === 1_000 ? [] : ['aggregate disagreement'],
    passed: holdout.agreementPermille === 1_000,
  };
}

describe('MEM-002C3 scorer-owned one-shot protocol', () => {
  it('never treats missing or deleted artifacts as authority to reopen a durable burned key', () => {
    const targetSha = 'e'.repeat(40);
    const spec = buildBlindedHoldoutTombstoneSpecV1(targetSha);

    expect(() => validateBlindedHoldoutTombstoneAbsenceV1({
      spec,
      lookupStatus: 200,
      priorEvidenceArtifactCount: 0,
    })).toThrow('mem002c3_protocol:tombstone_preexisting');
    expect(() => validateBlindedHoldoutTombstoneAbsenceV1({
      spec,
      lookupStatus: 500,
      priorEvidenceArtifactCount: 0,
    })).toThrow('mem002c3_protocol:tombstone_lookup');
    expect(validateBlindedHoldoutTombstoneAbsenceV1({
      spec,
      lookupStatus: 404,
      priorEvidenceArtifactCount: 0,
    })).toEqual(spec);
  });

  it('accepts only an atomic exact-ref/exact-target tombstone create and verification pair', () => {
    const targetSha = 'e'.repeat(40);
    const spec = buildBlindedHoldoutTombstoneSpecV1(targetSha);
    const exactResponse = {
      ref: spec.ref,
      object: { type: 'commit', sha: targetSha },
    };
    const evidence = verifyBlindedHoldoutTombstoneCreationV1({
      spec,
      createStatus: 201,
      createResponse: exactResponse,
      verificationStatus: 200,
      verificationResponse: exactResponse,
    });

    expect(spec.ref).toMatch(/^refs\/tags\/memberry-mem002c3-burn\/[0-9a-f]{64}$/);
    expect(evidence).toMatchObject({ creationStatus: 201, verificationStatus: 200, targetSha });
    expect(() => verifyBlindedHoldoutTombstoneCreationV1({
      spec,
      createStatus: 422,
      createResponse: exactResponse,
      verificationStatus: 200,
      verificationResponse: exactResponse,
    })).toThrow('mem002c3_protocol:tombstone_race');
    for (const response of [
      { ref: 'refs/tags/memberry-mem002c3-burn/foreign', object: exactResponse.object },
      { ref: spec.ref, object: { type: 'commit', sha: 'f'.repeat(40) } },
      { ref: spec.ref, object: { type: 'tag', sha: targetSha } },
      { ref: spec.ref },
    ]) {
      expect(() => verifyBlindedHoldoutTombstoneCreationV1({
        spec,
        createStatus: 201,
        createResponse: response,
        verificationStatus: 200,
        verificationResponse: exactResponse,
      })).toThrow('mem002c3_protocol:tombstone_response');
    }
  });

  it('accepts only the exact neutral C2 authority and creates a burned start receipt', async () => {
    const receipt = await policyReceipt();
    const preflight = validateBlindedHoldoutPreflightV1(preflightOptions(receipt));
    const spec = buildBlindedHoldoutTombstoneSpecV1(preflight.evaluatedCommitSha);
    const response = { ref: spec.ref, object: { type: 'commit', sha: spec.targetSha } };
    const tombstone = verifyBlindedHoldoutTombstoneCreationV1({
      spec,
      createStatus: 201,
      createResponse: response,
      verificationStatus: 200,
      verificationResponse: response,
    });
    const start = buildBlindedHoldoutStartReceiptV1(preflight, tombstone);

    expect(preflight.oneShotKey).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(preflight.policy).toEqual(receipt.policy);
    expect(start.state).toBe('burned-before-candidate-start');
    expect(start.candidateRunCount).toBe(0);
    expect(start.workflowRunAttempt).toBe(1);
    expect(start.tombstoneTargetSha).toBe(preflight.evaluatedCommitSha);
    expect(start.tombstoneCreationStatus).toBe(201);
  });

  it.each([
    ['identity', { observedCandidateTreeOid: '0'.repeat(40) }],
    ['dirty', { candidateSubtreeClean: false }],
    ['base ancestry', { integratedBaseIsAncestor: false }],
    ['context escape', { candidateContextOnly: false }],
    ['platform', { observedPlatform: 'linux/arm64' }],
    ['base image', { observedBaseImage: 'node:latest' }],
    ['corpus', { observedInputSha256: SHA_A }],
    ['event', { eventName: 'push' }],
    ['attempt', { workflowRunAttempt: 2 }],
    ['duplicate receipt', { priorAuthoritativeReceiptCount: 1 }],
  ])('fails closed on %s mismatch', async (_name: string, mutation: Record<string, unknown>) => {
    const receipt = await policyReceipt();
    expect(() => validateBlindedHoldoutPreflightV1({ ...preflightOptions(receipt), ...mutation }))
      .toThrow(BlindedHoldoutProtocolError);
  });

  it('materializes the exact inherited network, mount, user, privilege, resource, stdin, and process policy', async () => {
    const receipt = await policyReceipt();
    const args = buildBlindedHoldoutDockerCreateArgs(receipt, 'memberry-mem002c3@sha256:sealed');

    expect(args).toEqual([
      'container', 'create', '--interactive', '--network', 'none', '--user', '65532:65532',
      '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
      '--cpus', '0.5', '--memory', '128m', '--memory-swap', '128m', '--pids-limit', '32',
      '--env', 'LANG=C.UTF-8', '--env', 'LC_ALL=C.UTF-8', '--env', 'TZ=UTC',
      '--entrypoint', '/usr/local/bin/node', 'memberry-mem002c3@sha256:sealed',
      '--permission', '--allow-fs-write=/tmp/memberry-sandbox-write-probe',
      '--disable-proto=throw', '/app/worker.mjs', '-',
    ]);
    expect(args).not.toContain('--mount');
    expect(args).not.toContain('--volume');
    expect(args).not.toContain('--tmpfs');
  });

  it('rejects neutral-policy network and mount drift without consulting candidate internals', async () => {
    const receipt = await policyReceipt();
    for (const drifted of [
      { ...receipt, policy: { ...receipt.policy, network: 'bridge' } },
      { ...receipt, policy: { ...receipt.policy, mounts: { count: 1, tmpfs: [] } } },
      { ...receipt, policy: { ...receipt.policy, noNewPrivileges: false } },
    ]) {
      expect(() => validateBlindedHoldoutPreflightV1({
        ...preflightOptions(receipt),
        receipt: drifted as never,
      })).toThrow('mem002c3_protocol:policy_authority');
    }
  });

  it('validates and hashes sealed bytes only after candidate stop and before opening synthetic oracles', async () => {
    const events: string[] = [];
    const loadOracles = vi.fn(async () => {
      events.push('oracle');
      return Object.freeze([]);
    });
    const evidence = await scoreSealedBlindedHoldoutV1({
      nodeMajor: 20,
      candidateRunCount: 1,
      candidateStopped: true,
      evidenceMode: 'sealed-candidate-prediction',
      predictionBytes: new TextEncoder().encode('{"synthetic":true}'),
      loadInputs: async () => {
        events.push('inputs');
        return Object.freeze([]);
      },
      parsePrediction: (bytes) => {
        events.push('prediction');
        expect(bytes).toBeInstanceOf(Uint8Array);
        return Object.freeze({ predictions: Object.freeze([]) });
      },
      loadOracles,
      score: () => {
        events.push('score');
        return report();
      },
    });

    expect(events).toEqual(['inputs', 'prediction', 'oracle', 'score']);
    expect(loadOracles).toHaveBeenCalledOnce();
    expect(evidence.aggregate).toEqual({
      scenarioCount: 3,
      dimensionCount: 18,
      agreementCount: 18,
      agreementPermille: 1_000,
      availabilityMismatchCount: 0,
      valueMismatchCount: 0,
      passed: true,
    });
  });

  it.each([
    ['candidate not stopped', { candidateStopped: false }],
    ['candidate rerun', { candidateRunCount: 2 }],
    ['self proof substitution', { evidenceMode: 'scorer-conformance' }],
  ])('rejects %s before synthetic oracle access', async (_name: string, mutation: Record<string, unknown>) => {
    const loadOracles = vi.fn(async () => Object.freeze([]));
    await expect(scoreSealedBlindedHoldoutV1({
      nodeMajor: 22,
      candidateRunCount: 1,
      candidateStopped: true,
      evidenceMode: 'sealed-candidate-prediction',
      predictionBytes: new TextEncoder().encode('{}'),
      loadInputs: async () => Object.freeze([]),
      parsePrediction: () => Object.freeze({ predictions: Object.freeze([]) }),
      loadOracles,
      score: () => report(),
      ...mutation,
    } as never)).rejects.toThrow(/^mem002c3_protocol:/);
    expect(loadOracles).not.toHaveBeenCalled();
  });

  it('keeps oracle access at zero for bounded-output, schema, corpus, order, and substitution failures', async () => {
    for (const code of ['output', 'schema', 'corpus', 'order', 'substitution']) {
      const loadOracles = vi.fn(async () => Object.freeze([]));
      await expect(scoreSealedBlindedHoldoutV1({
        nodeMajor: 22,
        candidateRunCount: 1,
        candidateStopped: true,
        evidenceMode: 'sealed-candidate-prediction',
        predictionBytes: new TextEncoder().encode('{}'),
        loadInputs: async () => Object.freeze([]),
        parsePrediction: () => { throw new Error(`sensitive-${code}`); },
        loadOracles,
        score: () => report(),
      })).rejects.toThrow('mem002c3_protocol:prediction_validation');
      expect(loadOracles).not.toHaveBeenCalled();
    }
  });

  it('keeps the scorer custody module behind the post-validation oracle callback', async () => {
    const source = await readFile(
      `${REPO_ROOT}/bench/lab/admission-features/scorer-only/blinded-holdout.ts`,
      'utf8',
    );
    expect(source).not.toMatch(/^import .*['"]\.\/load\.js['"];?$/m);
    expect(source.indexOf("loadOracles: async () => {")).toBeGreaterThan(source.indexOf('parsePrediction:'));
    expect(source.indexOf("await import('./load.js')")).toBeGreaterThan(source.indexOf("loadOracles: async () => {"));
  });

  it('rejects oversized candidate output before synthetic oracle access', async () => {
    const loadOracles = vi.fn(async () => Object.freeze([]));
    await expect(scoreSealedBlindedHoldoutV1({
      nodeMajor: 22,
      candidateRunCount: 1,
      candidateStopped: true,
      evidenceMode: 'sealed-candidate-prediction',
      predictionBytes: new Uint8Array(32_769),
      loadInputs: async () => Object.freeze([]),
      parsePrediction: () => Object.freeze({ predictions: Object.freeze([]) }),
      loadOracles,
      score: () => report(),
    })).rejects.toThrow('mem002c3_protocol:prediction_validation');
    expect(loadOracles).not.toHaveBeenCalled();
  });

  it('returns only aggregate disagreement and fixed failure text', async () => {
    const mismatch = counts({
      agreementCount: 17,
      agreementPermille: 944,
      availableAgreementCount: 11,
      valueMismatchCount: 1,
    });
    const evidence = await scoreSealedBlindedHoldoutV1({
      nodeMajor: 22,
      candidateRunCount: 1,
      candidateStopped: true,
      evidenceMode: 'sealed-candidate-prediction',
      predictionBytes: new TextEncoder().encode('{}'),
      loadInputs: async () => Object.freeze([]),
      parsePrediction: () => Object.freeze({ predictions: Object.freeze([]) }),
      loadOracles: async () => Object.freeze([]),
      score: () => report(mismatch),
    });
    expect(evidence.aggregate).toEqual({
      scenarioCount: 3,
      dimensionCount: 18,
      agreementCount: 17,
      agreementPermille: 944,
      availabilityMismatchCount: 0,
      valueMismatchCount: 1,
      passed: false,
    });
    expect(JSON.stringify(evidence)).not.toMatch(/scenarioId|features|dimensions|valuePermille|availableLabelCount|unavailableLabelCount/);
    expect(() => assertBlindedHoldoutPromotionV1({ outcome: 'failed' }))
      .toThrow('mem002c3_protocol:agreement');
  });

  it('prevalidates exact custody paths and proves private evidence cleanup before receipt creation', async () => {
    const custody = await mkdtemp(join(tmpdir(), 'memberry-mem002c3-custody-'));
    const paths = {
      node20Path: join(custody, 'node20.json'),
      node22Path: join(custody, 'node22.json'),
      preflightPath: join(custody, 'preflight.json'),
    };
    try {
      await Promise.all(Object.values(paths).map((path) => writeFile(path, '{}\n')));
      await expect(removeBlindedHoldoutPrivateEvidenceV1({
        custodyDirectory: custody,
        ...paths,
        node22Path: join(custody, 'not-node22.json'),
      })).rejects.toThrow('mem002c3_protocol:cleanup');
      await access(paths.node20Path);

      await removeBlindedHoldoutPrivateEvidenceV1({ custodyDirectory: custody, ...paths });
      expect(await readdir(custody)).toEqual([]);
    } finally {
      await rm(custody, { recursive: true, force: true });
    }
  });

  it('keeps the dedicated workflow manual, one-shot, policy-exact, post-stop scored, and aggregate-only', async () => {
    const workflow = await readFile(`${REPO_ROOT}/.github/workflows/mem002c3-holdout.yml`, 'utf8');
    const startIndex = workflow.indexOf('Burn one-shot key before sole candidate start');
    const tombstoneIndex = workflow.indexOf('Create durable atomic tombstone before candidate start');
    const persistedBurnIndex = workflow.indexOf('Persist burn receipt as non-authoritative evidence');
    const candidateIndex = workflow.indexOf('Run frozen candidate exactly once before oracle access');
    const node20Index = workflow.indexOf('Score sealed bytes under Node 20');
    const node22Index = workflow.indexOf('Score the same sealed bytes under Node 22 without candidate rerun');

    expect(workflow).toMatch(/\bon:\s*\n\s+workflow_dispatch:/);
    expect(workflow).not.toMatch(/\n\s+(?:push|pull_request):/);
    expect(workflow.match(/docker container start --attach --interactive/g)).toHaveLength(1);
    expect(startIndex).toBeGreaterThan(0);
    expect(tombstoneIndex).toBeGreaterThan(0);
    expect(startIndex).toBeGreaterThan(tombstoneIndex);
    expect(persistedBurnIndex).toBeGreaterThan(startIndex);
    expect(candidateIndex).toBeGreaterThan(persistedBurnIndex);
    expect(node20Index).toBeGreaterThan(candidateIndex);
    expect(node22Index).toBeGreaterThan(node20Index);
    expect(workflow).toContain('--network none --user 65532:65532 --read-only --cap-drop ALL');
    expect(workflow).toContain('--security-opt no-new-privileges --cpus 0.5 --memory 128m');
    expect(workflow).toContain('--memory-swap 128m --pids-limit 32');
    expect(workflow).not.toMatch(/--mount|--volume|--tmpfs/);
    expect(workflow).toContain('timeout --signal=KILL 5s');
    expect(workflow).toContain('head -c 32769');
    expect(workflow).toContain('head -c 1025');
    expect(workflow).toContain("-le 32768");
    expect(workflow).toContain("-le 1024");
    expect(workflow).not.toContain('run.log');
    expect(workflow).toContain('select(.name == env.ARTIFACT_NAME)');
    expect(workflow).not.toContain('expired == false');
    expect(workflow).toContain('Upload only aggregate receipt evidence');
    expect(workflow).toContain('path: ${{ env.MEMBERRY_C3_PUBLIC_DIR }}/start.json');
    expect(workflow).toContain('path: ${{ env.MEMBERRY_C3_PUBLIC_DIR }}/receipt.json');
    expect(workflow).toContain('if: ${{ always() }}');
    expect(workflow).toMatch(/permissions:\s*\n\s+contents: write\s*\n\s+actions: read/);
    expect(workflow).toContain('tags/memberry-mem002c3-burn/${MEMBERRY_ONE_SHOT_KEY}');
    expect(workflow).toContain('--request POST');
    expect(workflow).not.toMatch(/--request DELETE|git push[^\n]*(?:--delete|:refs\/tags\/memberry-mem002c3-burn)/);
  });
});
