// MEM-002 productionization: hosted live proof for the v3 candidate.
//
// Mirrors candidate/live.ts for the v3 packaging: build the canonical
// candidate-v3 image, run it exactly once under the frozen sandbox policy
// flags over the public dev+holdout v3 inputs, validate the bounded artifact,
// and write content-free evidence into the EXISTING
// ${RUNNER_TEMP}/memberry-admission-candidate-live directory so it rides the
// existing CI artifact upload (receipt v4 requires the single artifact name
// memberry-admission-candidate-live-<runId>-<attempt>). The evidence keeps
// evidenceSchemaVersion memberry.admission-feature-candidate-live-evidence.v1
// (receipt-v4.ts binding) under the v3-specific file name evidence-v3.json.

import { constants as fsConstants } from 'node:fs';
import { open } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { loadAdmissionFeatureInputsV3 } from '../inputs-v3.js';
import { parseAdmissionFeaturePredictionArtifactV3 } from '../prediction-artifact-v3.js';
import {
  ADMISSION_CANDIDATE_V3_ARGUMENTS,
  buildAdmissionFeatureCandidateV3ImageV1,
  type AdmissionCandidateV3BuildReceipt,
} from './build.js';
import {
  cleanupOwnedTemporaryDirectoryV1,
  createDockerCommandInvocationV1,
  createOwnedTemporaryDirectoryV1,
  readOwnedContainerIdFileV1,
  runDockerCommandV1,
  snapshotDockerCommandResultV1,
} from '../candidate/sandbox.js';

const EVIDENCE_PATH_ENV = 'MEMBERRY_ADMISSION_CANDIDATE_V3_LIVE_EVIDENCE_PATH';
const EVIDENCE_DIRECTORY = 'memberry-admission-candidate-live';
const EVIDENCE_FILENAME = 'evidence-v3.json';
const CONTAINER_ID_PATTERN = /^[0-9a-f]{64}$/;
const MAX_IO_BYTES = 32_768;
const DEV_SCENARIO_COUNT = 14;
const HOLDOUT_SCENARIO_COUNT = 6;

export type AdmissionFeatureCandidateV3LivePhase =
  | 'INPUTS' | 'BUILD' | 'SANDBOX' | 'PROTOCOL' | 'CLEANUP' | 'EVIDENCE';

class LiveFailure extends Error {
  constructor(readonly phase: AdmissionFeatureCandidateV3LivePhase) {
    super(`admission_candidate_v3_live:${phase}`);
    this.name = 'AdmissionFeatureCandidateV3LiveError';
  }
}

export interface AdmissionFeatureCandidateV3LiveEvidence {
  readonly schemaVersion: 'memberry.admission-feature-candidate-live-evidence.v1';
  readonly ok: true;
  readonly cleanupVerified: true;
  readonly scenarioCount: 20;
  readonly devScenarioCount: 14;
  readonly holdoutScenarioCount: 6;
  readonly producerId: AdmissionCandidateV3BuildReceipt['producerId'];
  readonly producerVersion: AdmissionCandidateV3BuildReceipt['producerVersion'];
  readonly baseImage: string;
  readonly candidateSha256: `sha256:${string}`;
  readonly sourceSha256: `sha256:${string}`;
  readonly imageSha256: `sha256:${string}`;
  readonly imageConfigSha256: `sha256:${string}`;
  readonly nodeSha256: `sha256:${string}`;
  readonly rootFsLayerSha256: readonly string[];
  readonly inputSha256: `sha256:${string}`;
  readonly outputSha256: `sha256:${string}`;
}

interface AdmissionFeatureCandidateV3LiveFailureEvidence {
  readonly schemaVersion: 'memberry.admission-feature-candidate-live-failure-phase.v1';
  readonly ok: false;
  readonly phase: AdmissionFeatureCandidateV3LivePhase | 'UNKNOWN';
}

function sha256(bytes: Uint8Array): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function bounded(invocation: ReturnType<typeof createDockerCommandInvocationV1>, timeoutMs: number) {
  return Object.freeze({ ...invocation, timeoutMs });
}

function successText(result: unknown): string {
  const snapshot = snapshotDockerCommandResultV1(result);
  if (snapshot.launchFailed || snapshot.timedOut || snapshot.outputExceeded
    || snapshot.stderrExceeded || snapshot.exitCode !== 0) {
    throw new LiveFailure('SANDBOX');
  }
  return new TextDecoder('utf-8', { fatal: true }).decode(snapshot.stdout);
}

async function runCandidateOnce(
  receipt: AdmissionCandidateV3BuildReceipt,
  inputBytes: Uint8Array,
): Promise<{ output: Uint8Array; cleanupVerified: true }> {
  const temporary = await createOwnedTemporaryDirectoryV1('admission-run');
  let id: string | undefined;
  let output: Uint8Array | undefined;
  let failure: LiveFailure | undefined;
  try {
    successText(await runDockerCommandV1(bounded(createDockerCommandInvocationV1([
      'container', 'create', '--interactive',
      `--cidfile=${temporary.cidFile}`,
      `--label=org.memberry.build-token=${temporary.runToken}`,
      '--network', 'none', '--user', '65532:65532', '--read-only',
      '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
      '--cpus', '0.5', '--memory', '128m', '--memory-swap', '128m', '--pids-limit', '32',
      '--env', 'LANG=C.UTF-8', '--env', 'LC_ALL=C.UTF-8', '--env', 'TZ=UTC',
      '--entrypoint', '/usr/local/bin/node',
      receipt.imageSha256,
      ...ADMISSION_CANDIDATE_V3_ARGUMENTS,
    ]), 60_000)));
    const cidId = await readOwnedContainerIdFileV1(temporary);
    if (!cidId || !CONTAINER_ID_PATTERN.test(cidId)) throw new LiveFailure('SANDBOX');
    id = cidId;
    const started = snapshotDockerCommandResultV1(await runDockerCommandV1(bounded(
      createDockerCommandInvocationV1(
        ['container', 'start', '--interactive', '--attach', id],
        inputBytes,
        MAX_IO_BYTES,
      ),
      60_000,
    )));
    if (started.launchFailed || started.timedOut || started.outputExceeded
      || started.stderrExceeded || started.exitCode !== 0
      || started.stderr.byteLength !== 0
      || started.stdout.byteLength < 1 || started.stdout.byteLength > MAX_IO_BYTES) {
      throw new LiveFailure('SANDBOX');
    }
    output = started.stdout;
  } catch (error) {
    failure = error instanceof LiveFailure ? error : new LiveFailure('SANDBOX');
  }
  let cleanupVerified = false;
  try {
    if (id !== undefined) {
      successText(await runDockerCommandV1(bounded(
        createDockerCommandInvocationV1(['container', 'rm', '-fv', id]), 60_000,
      )));
    }
    const remaining = successText(await runDockerCommandV1(bounded(createDockerCommandInvocationV1([
      'container', 'ls', '-a', '--no-trunc',
      `--filter=label=org.memberry.build-token=${temporary.runToken}`, '--format={{.ID}}',
    ]), 60_000)));
    cleanupVerified = remaining.replace(/\r\n?/g, '\n').split('\n').filter(Boolean).length === 0
      && await cleanupOwnedTemporaryDirectoryV1(temporary);
  } catch {
    cleanupVerified = false;
  }
  if (!cleanupVerified) throw new LiveFailure('CLEANUP');
  if (failure !== undefined || output === undefined) throw failure ?? new LiveFailure('SANDBOX');
  return { output, cleanupVerified: true };
}

export async function runAdmissionFeatureCandidateV3LiveCore(): Promise<AdmissionFeatureCandidateV3LiveEvidence> {
  let inputBytes: Uint8Array;
  try {
    const inputs = await loadAdmissionFeatureInputsV3(['dev', 'holdout']);
    const devScenarioCount = inputs.filter(({ split }) => split === 'dev').length;
    const holdoutScenarioCount = inputs.filter(({ split }) => split === 'holdout').length;
    if (devScenarioCount !== DEV_SCENARIO_COUNT || holdoutScenarioCount !== HOLDOUT_SCENARIO_COUNT) {
      throw new LiveFailure('INPUTS');
    }
    inputBytes = new TextEncoder().encode(JSON.stringify(inputs));
    if (inputBytes.byteLength < 2 || inputBytes.byteLength > MAX_IO_BYTES) throw new LiveFailure('INPUTS');
  } catch (error) {
    throw error instanceof LiveFailure ? error : new LiveFailure('INPUTS');
  }
  let receipt: AdmissionCandidateV3BuildReceipt;
  try {
    receipt = await buildAdmissionFeatureCandidateV3ImageV1();
  } catch {
    throw new LiveFailure('BUILD');
  }
  const { output } = await runCandidateOnce(receipt, inputBytes);
  try {
    const inputs = await loadAdmissionFeatureInputsV3(['dev', 'holdout']);
    parseAdmissionFeaturePredictionArtifactV3(output, inputs);
  } catch {
    throw new LiveFailure('PROTOCOL');
  }
  return Object.freeze({
    schemaVersion: 'memberry.admission-feature-candidate-live-evidence.v1',
    ok: true,
    cleanupVerified: true,
    scenarioCount: 20,
    devScenarioCount: 14,
    holdoutScenarioCount: 6,
    producerId: receipt.producerId,
    producerVersion: receipt.producerVersion,
    baseImage: receipt.baseImage,
    candidateSha256: receipt.candidateSha256,
    sourceSha256: receipt.sourceSha256,
    imageSha256: receipt.imageSha256,
    imageConfigSha256: receipt.imageConfigSha256,
    nodeSha256: receipt.nodeSha256,
    rootFsLayerSha256: Object.freeze([...receipt.rootFsLayers]),
    inputSha256: sha256(inputBytes),
    outputSha256: sha256(output),
  });
}

function evidencePath(): string {
  const runnerTemp = process.env['RUNNER_TEMP'];
  const requestedPath = process.env[EVIDENCE_PATH_ENV];
  if (typeof runnerTemp !== 'string' || runnerTemp.length === 0 || runnerTemp.includes('\0')
    || !isAbsolute(runnerTemp) || resolve(runnerTemp) !== runnerTemp) {
    throw new LiveFailure('EVIDENCE');
  }
  const path = join(runnerTemp, EVIDENCE_DIRECTORY, EVIDENCE_FILENAME);
  if (requestedPath !== path) throw new LiveFailure('EVIDENCE');
  return path;
}

async function writeEvidence(
  evidence: AdmissionFeatureCandidateV3LiveEvidence | AdmissionFeatureCandidateV3LiveFailureEvidence,
): Promise<void> {
  const path = evidencePath();
  const serialized = `${JSON.stringify(evidence)}\n`;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(
      path,
      fsConstants.O_NOFOLLOW | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY,
      0o600,
    );
    await handle.writeFile(serialized, { encoding: 'utf8' });
    await handle.sync();
  } catch {
    throw new LiveFailure('EVIDENCE');
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function main(): Promise<void> {
  const evidence = await runAdmissionFeatureCandidateV3LiveCore();
  await writeEvidence(evidence);
  process.stdout.write(`${JSON.stringify(evidence)}\n`);
}

const invokedPath = process.argv[1] === undefined ? undefined : resolve(process.argv[1]);
if (invokedPath === resolve(fileURLToPath(import.meta.url))) {
  void main().catch(async (error: unknown) => {
    const phase = error instanceof LiveFailure ? error.phase : 'UNKNOWN';
    try {
      await writeEvidence({
        schemaVersion: 'memberry.admission-feature-candidate-live-failure-phase.v1',
        ok: false,
        phase,
      });
    } catch {
      // The public failure remains fixed even when the phase artifact cannot be written.
    }
    process.stderr.write(`admission_candidate_v3_live:${phase}\n`);
    process.exitCode = 1;
  });
}
