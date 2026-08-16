import { createHash } from 'node:crypto';
import { types as nodeUtilTypes } from 'node:util';

import { APPROVED_NODE_BASE_IMAGE_V1 } from './protocol.js';
import {
  canonicalImageConfigSha256V1,
  captureAdmissionCandidateSnapshotV1,
  cleanupOwnedTemporaryDirectoryV1,
  createDockerCommandInvocationV1,
  createOwnedTemporaryDirectoryV1,
  inspectDockerCopyArchiveV1,
  readOwnedContainerIdFileV1,
  runDockerCommandV1,
  selectCidFileCleanupAuthorityV1,
  snapshotExactUint8ArrayV1,
  snapshotDockerCommandResultV1,
  type AdmissionSandboxAttestationV1,
  type DockerCommandResultV1,
  type DockerCommandRunnerV1,
} from './sandbox.js';

export { APPROVED_NODE_BASE_IMAGE_V1 } from './protocol.js';

const BUILD_ASSET_KEYS = Object.freeze(['dockerfile', 'manifest'] as const);
const IMAGE_PATTERN = /^sha256:[0-9a-f]{64}$/;
const CONTAINER_ID_PATTERN = /^[0-9a-f]{64}$/;
const CANDIDATE_ARGUMENTS = Object.freeze([
  '--permission', '--allow-fs-read=/run/input.json',
  '--allow-fs-write=/tmp/memberry-sandbox-write-probe',
  '--disable-proto=throw', '/app/worker.mjs', '/run/input.json',
]);
const PRELOAD_ENV_PATTERN = /^(?:NODE_OPTIONS|NODE_PATH|LD_PRELOAD|LD_LIBRARY_PATH|DYLD_.+|BASH_ENV|ENV)=/;
const EXPECTED_DOCKERIGNORE_V1 = '**\n!container/\n!container/Dockerfile\n!container/worker.mjs\n!container/manifest.json\n!container/attestation.json\n';
const EXPECTED_DOCKERFILE_V1 = `# Frozen linux/amd64 Node 22.22.0 Alpine 3.22 image approved for MEM-002C2.
FROM ${APPROVED_NODE_BASE_IMAGE_V1} AS candidate

ARG CANDIDATE_SHA256
ARG SOURCE_SHA256
LABEL org.memberry.candidate.sha256=\${CANDIDATE_SHA256} \\
      org.memberry.source.sha256=\${SOURCE_SHA256} \\
      org.memberry.base.image="${APPROVED_NODE_BASE_IMAGE_V1}"

WORKDIR /app
COPY --chown=65532:65532 container/worker.mjs container/attestation.json /app/

USER 65532:65532
ENV LANG=C.UTF-8 LC_ALL=C.UTF-8 TZ=UTC

ENTRYPOINT ["/usr/local/bin/node"]
CMD ["--permission", "--allow-fs-read=/run/input.json", "--allow-fs-write=/tmp/memberry-sandbox-write-probe", "--disable-proto=throw", "/app/worker.mjs", "/run/input.json"]
`;

export interface AdmissionCandidateBuildReceiptV1 extends AdmissionSandboxAttestationV1 {
  readonly receiptVersion: 'memberry.admission-build-receipt.v1';
}

const RECEIPTS_V1 = new WeakMap<object, AdmissionCandidateBuildReceiptV1>();

function immutableReceiptV1(value: Omit<AdmissionCandidateBuildReceiptV1, 'receiptVersion'>): AdmissionCandidateBuildReceiptV1 {
  const receipt = Object.freeze(Object.assign(Object.create(null), {
    receiptVersion: 'memberry.admission-build-receipt.v1' as const,
    candidateSha256: value.candidateSha256,
    sourceSha256: value.sourceSha256,
    imageSha256: value.imageSha256,
    baseImage: value.baseImage,
    rootFsLayers: Object.freeze([...value.rootFsLayers]),
    imageConfigSha256: value.imageConfigSha256,
    nodeSha256: value.nodeSha256,
  })) as AdmissionCandidateBuildReceiptV1;
  RECEIPTS_V1.set(receipt, receipt);
  return receipt;
}

export function readAdmissionCandidateBuildReceiptV1(value: unknown): AdmissionCandidateBuildReceiptV1 {
  if (typeof value !== 'object' || value === null || nodeUtilTypes.isProxy(value)) {
    throw new Error('invalid build receipt');
  }
  const record = RECEIPTS_V1.get(value);
  if (!record) throw new Error('invalid build receipt');
  return record;
}

function assertDescriptorSafeJsonTree(value: unknown, seen = new Set<object>()): void {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('invalid manifest value');
    return;
  }
  if (typeof value !== 'object' || nodeUtilTypes.isProxy(value) || seen.has(value)) {
    throw new Error('invalid manifest value');
  }
  seen.add(value);
  const prototype = Object.getPrototypeOf(value);
  const keys = Reflect.ownKeys(value);
  if (Array.isArray(value)) {
    if (prototype !== Array.prototype || keys.length !== value.length + 1
      || keys.some((key) => key !== 'length'
        && (typeof key !== 'string' || !/^(?:0|[1-9][0-9]*)$/.test(key)
          || Number(key) >= value.length))) throw new Error('invalid manifest array');
  } else if (prototype !== Object.prototype && prototype !== null) {
    throw new Error('invalid manifest object');
  }
  for (const key of keys) {
    if (key === 'length') continue;
    if (typeof key !== 'string') throw new Error('invalid manifest key');
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')
      || descriptor.enumerable !== true) throw new Error('invalid manifest descriptor');
    assertDescriptorSafeJsonTree(descriptor.value, seen);
  }
  seen.delete(value);
}

function closedRecord(value: unknown, keys: readonly string[]): Readonly<Record<string, unknown>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value) || nodeUtilTypes.isProxy(value)) {
    throw new Error('invalid build assets');
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new Error('invalid build assets');
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.length !== keys.length || ownKeys.some((key) => typeof key !== 'string' || !keys.includes(key))) {
    throw new Error('invalid build assets');
  }
  const result = Object.create(null) as Record<string, unknown>;
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
      throw new Error('invalid build assets');
    }
    result[key] = descriptor.value;
  }
  return result;
}

function exactArray(value: unknown, expected: readonly unknown[]): boolean {
  return Array.isArray(value) && value.length === expected.length
    && expected.every((entry, index) => Object.getOwnPropertyDescriptor(value, String(index))?.value === entry);
}

export function validateAdmissionCandidateBuildAssetsV1(value: unknown): Readonly<{
  baseImage: typeof APPROVED_NODE_BASE_IMAGE_V1;
}> {
  const assets = closedRecord(value, BUILD_ASSET_KEYS);
  if (typeof assets.dockerfile !== 'string') throw new Error('invalid Dockerfile');
  assertDescriptorSafeJsonTree(assets.manifest);
  const manifest = closedRecord(assets.manifest, [
    'manifestVersion', 'candidateId', 'candidateVersion', 'build', 'runtime', 'forbidden',
  ]);
  const build = closedRecord(manifest.build, [
    'context', 'dockerfile', 'platform', 'immutableContextPolicy', 'baseImage',
    'baseImagePolicy', 'runtimeImagePolicy', 'includedPaths', 'attestationLabels', 'contentProof',
  ]);
  const runtime = closedRecord(manifest.runtime, [
    'platform', 'network', 'pull', 'user', 'rootFilesystem', 'capabilities', 'noNewPrivileges',
    'pids', 'cpus', 'memory', 'memorySwap', 'timeoutMs', 'inputBytes', 'outputBytes',
    'stderrBytes', 'inputDelivery', 'environment', 'executable', 'entrypoint', 'arguments',
    'inspectionAssertions', 'runtimeAssertions', 'cleanup',
  ]);
  const inputDelivery = closedRecord(runtime.inputDelivery, [
    'transport', 'path', 'uid', 'gid', 'mode', 'runtimeRoot', 'mounts',
  ]);
  const environment = closedRecord(runtime.environment, ['LANG', 'LC_ALL', 'TZ']);
  const cleanup = closedRecord(runtime.cleanup, [
    'identity', 'runningAction', 'removalAction', 'absenceProof', 'hostResidueProof',
  ]);
  const dockerfile = assets.dockerfile.replace(/\r\n?/g, '\n');
  const fromLines = dockerfile.split('\n').filter((line) => line.startsWith('FROM '));
  const argLines = dockerfile.split('\n').filter((line) => line.startsWith('ARG '));
  if (fromLines.length !== 1 || fromLines[0] !== `FROM ${APPROVED_NODE_BASE_IMAGE_V1} AS candidate`
    || JSON.stringify(argLines) !== JSON.stringify(['ARG CANDIDATE_SHA256', 'ARG SOURCE_SHA256'])
    || /\$\{?NODE_IMAGE|FROM\s+node:/i.test(dockerfile)
    || /^RUN\b/m.test(dockerfile)
    || !dockerfile.includes('ENTRYPOINT ["/usr/local/bin/node"]')
    || !dockerfile.includes(`CMD [${CANDIDATE_ARGUMENTS.map((entry) => JSON.stringify(entry)).join(', ')}]`)) {
    throw new Error('Dockerfile policy mismatch');
  }
  if (manifest.manifestVersion !== '1.0.0'
    || manifest.candidateId !== 'memberry.precomputed-feature-signals'
    || manifest.candidateVersion !== '1.0.0'
    || build.context !== 'bench/lab/admission-features/candidate'
    || build.dockerfile !== 'container/Dockerfile'
    || build.baseImage !== APPROVED_NODE_BASE_IMAGE_V1
    || build.platform !== 'linux/amd64'
    || build.immutableContextPolicy !== 'canonical-content-addressed-tar-stdin'
    || build.baseImagePolicy !== 'exact-digest'
    || build.runtimeImagePolicy !== 'private-build-receipt-required'
    || !exactArray(build.includedPaths, [
      'container/Dockerfile', 'container/worker.mjs', 'container/manifest.json',
      'container/attestation.json (generated from the immutable snapshot)',
    ])
    || !exactArray(build.attestationLabels, [
      'org.memberry.candidate.sha256', 'org.memberry.source.sha256', 'org.memberry.base.image',
    ])
    || !exactArray(build.contentProof, [
      'candidate source and build assets match exact stored Git blob object IDs and SHA256 digests',
      'Git object bytes are authoritative for hashes and build context after exact worktree equality',
      'Git pointer gitdir commondir config and object paths are pinned before and after every command',
      'trusted absolute Git uses explicit gitdir with closed config alternate replacement and prompt controls',
      'candidate-local attributes pin every manifested text asset to LF',
      'host orchestration treats candidate source and worker bundle as bytes and never imports them',
      'approved base RepoDigest and rootfs layer prefix', '/app/worker.mjs exact bytes',
      '/app/attestation.json canonical base candidate source and node hashes',
      '/usr/local/bin/node exact bytes equal in approved base and candidate',
    ])) throw new Error('manifest build policy mismatch');
  if (runtime.platform !== 'linux/amd64' || runtime.network !== 'none' || runtime.pull !== 'never'
    || runtime.user !== '65532:65532' || runtime.rootFilesystem !== 'read-only'
    || !exactArray(runtime.capabilities, []) || runtime.noNewPrivileges !== true
    || runtime.pids !== 32 || runtime.cpus !== '0.5' || runtime.memory !== '128m'
    || runtime.memorySwap !== '128m' || runtime.timeoutMs !== 5_000
    || runtime.inputBytes !== 32_768 || runtime.outputBytes !== 32_768 || runtime.stderrBytes !== 1_024
    || inputDelivery.transport !== 'stopped-container-tar-copy' || inputDelivery.path !== '/run/input.json'
    || inputDelivery.uid !== 65_532 || inputDelivery.gid !== 65_532 || inputDelivery.mode !== '0400'
    || inputDelivery.runtimeRoot !== 'read-only' || inputDelivery.mounts !== 0
    || environment.LANG !== 'C.UTF-8' || environment.LC_ALL !== 'C.UTF-8' || environment.TZ !== 'UTC'
    || runtime.executable !== 'node' || runtime.entrypoint !== '/usr/local/bin/node'
    || !exactArray(runtime.arguments, CANDIDATE_ARGUMENTS)
    || cleanup.identity !== 'bounded nofollow owned cidfile is sole deletion authority; label is residue proof only'
    || cleanup.runningAction !== 'docker container kill by inspected ID'
    || cleanup.removalAction !== 'docker container rm -fv by inspected ID'
    || cleanup.absenceProof !== 'empty label-scoped docker container ls'
    || cleanup.hostResidueProof !== 'pinned sentinel exact nonrecursive unlink and run directory ENOENT; disposable host contains residual path race'
    || !exactArray(runtime.inspectionAssertions, [
      'image labels equal current candidate and source hashes as supplemental metadata',
      'approved base RepoDigest and rootfs layer prefix are inspected independently',
      'worker node binary and canonical attestation bytes are copied from stopped proof containers and rehashed',
      'full image RootFS layers and effective Config are bound into a private build receipt',
      'container image equals attested local image ID',
      'network mode is none', 'mount list is empty', 'root filesystem is read-only',
      'user is 65532:65532', 'capabilities are dropped', 'no-new-privileges is enabled',
      'PID CPU and memory bounds are exact', 'entrypoint and arguments are exact',
      'stdout artifact is validated by independent closed host protocol with exact input hash identity and order bindings',
    ])
    || !exactArray(runtime.runtimeAssertions, [
      'environment is reduced to LANG LC_ALL TZ', 'write to world-writable tmp fails with EROFS',
      'Node permission model denies child processes with ERR_ACCESS_DENIED',
      'Node permission model denies worker threads with ERR_ACCESS_DENIED',
      'external socket is denied by the permission model or Docker network none',
    ])
    || !exactArray(manifest.forbidden, [
      'network', 'repository mount', '.git mount', 'scorer mount', 'oracle mount', 'Docker socket',
      'shell', 'additional environment', 'additional command arguments',
    ])) throw new Error('manifest runtime policy mismatch');
  return Object.freeze({ baseImage: APPROVED_NODE_BASE_IMAGE_V1 });
}

function safeResultV1(result: DockerCommandResultV1, allowStderr = false): Uint8Array {
  result = snapshotDockerCommandResultV1(result);
  if (result.launchFailed || result.timedOut || result.outputExceeded || result.stderrExceeded
    || result.exitCode !== 0 || (!allowStderr && result.stderr.byteLength !== 0)) {
    throw new Error('candidate image command failed');
  }
  return new Uint8Array(result.stdout);
}

function safeTextV1(result: DockerCommandResultV1, allowStderr = false): string {
  return new TextDecoder('utf-8', { fatal: true }).decode(safeResultV1(result, allowStderr));
}

function sha256(bytes: Uint8Array): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function tarHeaderV1(path: string, size: number): Uint8Array {
  if (!/^[.A-Za-z0-9/_-]{1,99}$/.test(path) || !Number.isSafeInteger(size) || size < 1) {
    throw new Error('invalid build context entry');
  }
  const header = new Uint8Array(512);
  const put = (offset: number, width: number, value: string) => {
    const bytes = new TextEncoder().encode(value);
    if (bytes.byteLength > width) throw new Error('tar field overflow');
    header.set(bytes, offset);
  };
  const octal = (value: number, width: number) => `${value.toString(8).padStart(width - 1, '0')}\0`;
  put(0, 100, path);
  put(100, 8, octal(0o444, 8));
  put(108, 8, octal(0, 8));
  put(116, 8, octal(0, 8));
  put(124, 12, octal(size, 12));
  put(136, 12, octal(0, 12));
  header.fill(0x20, 148, 156);
  header[156] = 0x30;
  put(257, 6, 'ustar\0');
  put(263, 2, '00');
  put(148, 8, `${header.reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6, '0')}\0 `);
  return header;
}

export function createCanonicalBuildContextV1(
  entries: readonly Readonly<{ path: string; bytes: Uint8Array }>[],
): Uint8Array {
  if (typeof entries !== 'object' || entries === null || nodeUtilTypes.isProxy(entries)
    || !Array.isArray(entries) || Object.getPrototypeOf(entries) !== Array.prototype) {
    throw new Error('invalid build context');
  }
  const lengthDescriptor = Object.getOwnPropertyDescriptor(entries, 'length');
  const arrayKeys = Reflect.ownKeys(entries);
  if (!lengthDescriptor || !Object.prototype.hasOwnProperty.call(lengthDescriptor, 'value')
    || lengthDescriptor.value !== 5 || arrayKeys.length !== 6
    || arrayKeys.some((key) => key !== 'length'
      && (typeof key !== 'string' || !/^[0-4]$/.test(key)))) {
    throw new Error('invalid build context');
  }
  const snapshots: Array<{ path: string; bytes: Uint8Array }> = [];
  for (let index = 0; index < 5; index += 1) {
    const element = Object.getOwnPropertyDescriptor(entries, String(index));
    if (!element || !Object.prototype.hasOwnProperty.call(element, 'value')) {
      throw new Error('invalid build context');
    }
    const entry = element.value as unknown;
    if (typeof entry !== 'object' || entry === null || nodeUtilTypes.isProxy(entry)
      || (Object.getPrototypeOf(entry) !== Object.prototype && Object.getPrototypeOf(entry) !== null)) {
      throw new Error('invalid build context entry');
    }
    const keys = Reflect.ownKeys(entry);
    if (keys.length !== 2 || keys.some((key) => key !== 'path' && key !== 'bytes')) {
      throw new Error('invalid build context entry');
    }
    const pathDescriptor = Object.getOwnPropertyDescriptor(entry, 'path');
    const bytesDescriptor = Object.getOwnPropertyDescriptor(entry, 'bytes');
    if (!pathDescriptor || !Object.prototype.hasOwnProperty.call(pathDescriptor, 'value')
      || typeof pathDescriptor.value !== 'string'
      || !bytesDescriptor || !Object.prototype.hasOwnProperty.call(bytesDescriptor, 'value')) {
      throw new Error('invalid build context entry');
    }
    const bytes = snapshotExactUint8ArrayV1(bytesDescriptor.value, 1, 1_048_576);
    snapshots.push({ path: pathDescriptor.value, bytes });
  }
  const expected = [
    '.dockerignore', 'container/Dockerfile', 'container/attestation.json',
    'container/manifest.json', 'container/worker.mjs',
  ];
  const sorted = snapshots.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  if (!sorted.every((entry, index) => entry.path === expected[index])) {
    throw new Error('invalid build context');
  }
  const chunks: Uint8Array[] = [];
  for (const entry of sorted) {
    chunks.push(tarHeaderV1(entry.path, entry.bytes.byteLength), new Uint8Array(entry.bytes));
    const padding = Math.ceil(entry.bytes.byteLength / 512) * 512 - entry.bytes.byteLength;
    if (padding) chunks.push(new Uint8Array(padding));
  }
  chunks.push(new Uint8Array(1_024));
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  if (total > 2_097_152) throw new Error('build context too large');
  const archive = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    archive.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return archive;
}

function rootFsLayersV1(value: any): readonly string[] {
  const layers = value?.RootFS?.Layers;
  if (value?.RootFS?.Type !== 'layers' || !Array.isArray(layers) || layers.length < 1
    || layers.length > 256 || layers.some((layer: unknown) => typeof layer !== 'string'
      || !IMAGE_PATTERN.test(layer))) throw new Error('invalid image rootfs');
  return Object.freeze([...layers]);
}

function exactStrings(value: unknown, expected: readonly string[]): boolean {
  return Array.isArray(value) && value.length === expected.length
    && value.every((entry, index) => entry === expected[index]);
}

function expectedCandidateEnvironmentV1(base: any): readonly string[] {
  if (!Array.isArray(base?.Config?.Env) || base.Config.Env.some((entry: unknown) =>
    typeof entry !== 'string' || entry.includes('\0') || PRELOAD_ENV_PATTERN.test(entry))) {
    throw new Error('unsafe approved base environment');
  }
  const retained = base.Config.Env.filter((entry: string) => !/^(?:LANG|LC_ALL|TZ)=/.test(entry));
  return Object.freeze([...retained, 'LANG=C.UTF-8', 'LC_ALL=C.UTF-8', 'TZ=UTC']);
}

function verifyImageV1(base: any, image: any, imageId: string, candidate: string, source: string): readonly string[] {
  const baseLayers = rootFsLayersV1(base);
  const layers = rootFsLayersV1(image);
  const config = image?.Config;
  const allowedConfigKeys = new Set([
    'User', 'Env', 'Entrypoint', 'Cmd', 'WorkingDir', 'Labels', 'Volumes', 'Healthcheck',
    'Shell', 'OnBuild', 'ExposedPorts', 'StopSignal',
  ]);
  if (!Array.isArray(base?.RepoDigests) || !base.RepoDigests.includes(APPROVED_NODE_BASE_IMAGE_V1)
    || base?.Os !== 'linux' || base?.Architecture !== 'amd64'
    || image?.Id !== imageId || image?.Os !== 'linux' || image?.Architecture !== 'amd64'
    || layers.length !== baseLayers.length + 1 || !baseLayers.every((layer, index) => layers[index] === layer)
    || typeof config !== 'object' || config === null || Object.keys(config).some((key) => !allowedConfigKeys.has(key))
    || config.User !== '65532:65532' || !exactStrings(config.Env, expectedCandidateEnvironmentV1(base))
    || config.Env.some((entry: string) => PRELOAD_ENV_PATTERN.test(entry))
    || !exactStrings(config.Entrypoint, ['/usr/local/bin/node']) || !exactStrings(config.Cmd, CANDIDATE_ARGUMENTS)
    || config.WorkingDir !== '/app' || config.Volumes != null || config.Healthcheck != null
    || config.Shell != null || (config.OnBuild != null && !exactStrings(config.OnBuild, []))
    || config.ExposedPorts != null || config.StopSignal != null
    || Object.keys(config.Labels ?? {}).length !== 3
    || config.Labels?.['org.memberry.candidate.sha256'] !== candidate
    || config.Labels?.['org.memberry.source.sha256'] !== source
    || config.Labels?.['org.memberry.base.image'] !== APPROVED_NODE_BASE_IMAGE_V1) {
    throw new Error('built image policy mismatch');
  }
  return layers;
}

async function discoverProofV1(token: string, runner: DockerCommandRunnerV1): Promise<readonly string[]> {
  const text = safeTextV1(await runner(createDockerCommandInvocationV1([
    'container', 'ls', '-a', '--no-trunc', `--filter=label=org.memberry.build-token=${token}`,
    '--format={{.ID}}',
  ])));
  const ids = text.replace(/\r\n?/g, '\n').split('\n').filter(Boolean);
  if (ids.some((id) => !CONTAINER_ID_PATTERN.test(id)) || new Set(ids).size !== ids.length) {
    throw new Error('invalid proof discovery');
  }
  return ids;
}

export function validateStoppedProofInspectionV1(
  inspected: any,
  id: string,
  requestedImage: string,
  expectedImageId: string,
  token: string,
): any {
  if (!CONTAINER_ID_PATTERN.test(id) || !IMAGE_PATTERN.test(expectedImageId)
    || (requestedImage !== APPROVED_NODE_BASE_IMAGE_V1 && !IMAGE_PATTERN.test(requestedImage))
    || inspected?.Id !== id || inspected?.Image !== expectedImageId
    || inspected?.Config?.Image !== requestedImage
    || inspected?.Config?.Labels?.['org.memberry.build-token'] !== token
    || inspected?.Config?.Volumes != null
    || !Array.isArray(inspected?.Mounts) || inspected.Mounts.length !== 0) {
    throw new Error('proof ownership mismatch');
  }
  return inspected;
}

async function inspectOwnedProofV1(
  id: string,
  requestedImage: string,
  expectedImageId: string,
  token: string,
  runner: DockerCommandRunnerV1,
): Promise<any> {
  const inspected = JSON.parse(safeTextV1(await runner(createDockerCommandInvocationV1([
    'container', 'inspect', '--format={{json .}}', id,
  ]))));
  return validateStoppedProofInspectionV1(inspected, id, requestedImage, expectedImageId, token);
}

async function cleanupProofV1(
  requestedImage: string, expectedImageId: string,
  temporary: Awaited<ReturnType<typeof createOwnedTemporaryDirectoryV1>>,
  runner: DockerCommandRunnerV1, authoritativeId: string | undefined,
  creationAttempted: boolean, createStdout: string | undefined,
): Promise<boolean> {
  try {
    let id = authoritativeId;
    const cidId = await readOwnedContainerIdFileV1(temporary);
    const discovered = await discoverProofV1(temporary.runToken, runner);
    if (!id) {
      if (!creationAttempted) return discovered.length === 0;
      id = selectCidFileCleanupAuthorityV1(cidId, createStdout, discovered);
      if (!id) return false;
    }
    if (selectCidFileCleanupAuthorityV1(cidId, createStdout, discovered) !== id) return false;
    await inspectOwnedProofV1(id, requestedImage, expectedImageId, temporary.runToken, runner);
    safeTextV1(await runner(createDockerCommandInvocationV1(['container', 'rm', '-fv', id])));
    return (await discoverProofV1(temporary.runToken, runner)).length === 0;
  } catch {
    return false;
  }
}

async function withStoppedProofV1<T>(
  requestedImage: string,
  expectedImageId: string,
  runner: DockerCommandRunnerV1,
  inspect: (id: string) => Promise<T>,
): Promise<T> {
  const temporary = await createOwnedTemporaryDirectoryV1('admission-build');
  let id: string | undefined;
  let creationAttempted = false;
  let outcome: T | undefined;
  let failed = false;
  let createStdout: string | undefined;
  try {
    creationAttempted = true;
    const created = await runner(createDockerCommandInvocationV1([
      'create', `--cidfile=${temporary.cidFile}`, '--platform=linux/amd64', '--pull=never',
      `--label=org.memberry.build-token=${temporary.runToken}`, '--entrypoint=/usr/local/bin/node',
      requestedImage, '--version',
    ]));
    const createdSnapshot = snapshotDockerCommandResultV1(created);
    try {
      createStdout = new TextDecoder('utf-8', { fatal: true }).decode(createdSnapshot.stdout).trim();
    } catch {
      createStdout = undefined;
    }
    safeResultV1(createdSnapshot);
    const cidId = await readOwnedContainerIdFileV1(temporary);
    if (!cidId || (createStdout !== undefined && createStdout.length > 0 && createStdout !== cidId)) {
      throw new Error('proof identity mismatch');
    }
    id = cidId;
    await inspectOwnedProofV1(id, requestedImage, expectedImageId, temporary.runToken, runner);
    outcome = await inspect(id);
  } catch {
    failed = true;
  }
  const containersClean = await cleanupProofV1(
    requestedImage, expectedImageId, temporary, runner, id, creationAttempted, createStdout,
  );
  const hostClean = containersClean && await cleanupOwnedTemporaryDirectoryV1(temporary);
  if (failed || !containersClean || !hostClean || outcome === undefined) throw new Error('build proof failed');
  return outcome;
}

async function buildAdmissionFeatureCandidateImageWithRunnerV1(
  runner: DockerCommandRunnerV1,
): Promise<Omit<AdmissionCandidateBuildReceiptV1, 'receiptVersion'>> {
  const snapshot = await captureAdmissionCandidateSnapshotV1();
  const dockerfile = new TextDecoder('utf-8', { fatal: true }).decode(snapshot.files.get('container/Dockerfile')!);
  const dockerignore = new TextDecoder('utf-8', { fatal: true })
    .decode(snapshot.files.get('.dockerignore')!).replace(/\r\n?/g, '\n');
  if (dockerfile.replace(/\r\n?/g, '\n') !== EXPECTED_DOCKERFILE_V1
    || dockerignore !== EXPECTED_DOCKERIGNORE_V1) throw new Error('build assets are not exact');
  const manifest = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(
    snapshot.files.get('container/manifest.json')!,
  )) as unknown;
  validateAdmissionCandidateBuildAssetsV1({ dockerfile, manifest });

  const baseInspection = JSON.parse(safeTextV1(await runner(createDockerCommandInvocationV1([
    'image', 'inspect', '--format={{json .}}', APPROVED_NODE_BASE_IMAGE_V1,
  ]))));
  rootFsLayersV1(baseInspection);
  if (!Array.isArray(baseInspection?.RepoDigests)
    || !baseInspection.RepoDigests.includes(APPROVED_NODE_BASE_IMAGE_V1)
    || typeof baseInspection?.Id !== 'string' || !IMAGE_PATTERN.test(baseInspection.Id)
    || baseInspection?.Os !== 'linux' || baseInspection?.Architecture !== 'amd64') {
    throw new Error('approved base inspection mismatch');
  }
  const baseNode = await withStoppedProofV1(
    APPROVED_NODE_BASE_IMAGE_V1, baseInspection.Id, runner, async (id) => {
      const copied = await runner(createDockerCommandInvocationV1([
        'container', 'cp', `${id}:/usr/local/bin/node`, '-',
      ], undefined, 134_219_776));
      return inspectDockerCopyArchiveV1(safeResultV1(copied), 'node');
    },
  );
  const nodeSha256 = sha256(baseNode);
  const contentAttestation = new TextEncoder().encode(JSON.stringify({
    baseImage: APPROVED_NODE_BASE_IMAGE_V1,
    candidateSha256: snapshot.candidateSha256,
    sourceSha256: snapshot.sourceSha256,
    nodeSha256,
  }));
  const context = createCanonicalBuildContextV1([
    { path: '.dockerignore', bytes: snapshot.files.get('.dockerignore')! },
    { path: 'container/Dockerfile', bytes: snapshot.files.get('container/Dockerfile')! },
    { path: 'container/attestation.json', bytes: contentAttestation },
    { path: 'container/manifest.json', bytes: snapshot.files.get('container/manifest.json')! },
    { path: 'container/worker.mjs', bytes: snapshot.files.get('container/worker.mjs')! },
  ]);
  const built = await runner(Object.freeze({
    ...createDockerCommandInvocationV1([
      'build', '--quiet', '--platform=linux/amd64', '--pull=false', '--network=none', '--target=candidate',
      `--build-arg=CANDIDATE_SHA256=${snapshot.candidateSha256}`,
      `--build-arg=SOURCE_SHA256=${snapshot.sourceSha256}`,
      '--file=container/Dockerfile', '-',
    ], context),
    timeoutMs: 60_000,
    stdoutLimit: 1_048_576,
    stderrLimit: 32_768,
  }));
  const imageSha256 = safeTextV1(built, true).trim();
  if (!IMAGE_PATTERN.test(imageSha256)) throw new Error('invalid built image ID');
  const imageInspection = JSON.parse(safeTextV1(await runner(createDockerCommandInvocationV1([
    'image', 'inspect', '--format={{json .}}', imageSha256,
  ]))));
  const rootFsLayers = verifyImageV1(
    baseInspection, imageInspection, imageSha256, snapshot.candidateSha256, snapshot.sourceSha256,
  );
  const imageConfigSha256 = canonicalImageConfigSha256V1(imageInspection.Config);

  await withStoppedProofV1(imageSha256, imageSha256, runner, async (id) => {
    const copiedWorker = inspectDockerCopyArchiveV1(safeResultV1(await runner(
      createDockerCommandInvocationV1(['container', 'cp', `${id}:/app/worker.mjs`, '-'], undefined, 1_048_576),
    )), 'worker.mjs');
    if (!Buffer.from(copiedWorker).equals(Buffer.from(snapshot.files.get('container/worker.mjs')!))) {
      throw new Error('built worker mismatch');
    }
    const copiedAttestation = inspectDockerCopyArchiveV1(safeResultV1(await runner(
      createDockerCommandInvocationV1(['container', 'cp', `${id}:/app/attestation.json`, '-'], undefined, 1_048_576),
    )), 'attestation.json');
    if (!Buffer.from(copiedAttestation).equals(Buffer.from(contentAttestation))) {
      throw new Error('built attestation mismatch');
    }
    const copiedNode = inspectDockerCopyArchiveV1(safeResultV1(await runner(
      createDockerCommandInvocationV1(
        ['container', 'cp', `${id}:/usr/local/bin/node`, '-'], undefined, 134_219_776,
      ),
    )), 'node');
    if (sha256(copiedNode) !== nodeSha256) throw new Error('candidate Node binary mismatch');
    return true;
  });

  return Object.freeze({
    imageSha256: imageSha256 as `sha256:${string}`,
    candidateSha256: snapshot.candidateSha256,
    sourceSha256: snapshot.sourceSha256,
    baseImage: APPROVED_NODE_BASE_IMAGE_V1,
    rootFsLayers,
    imageConfigSha256,
    nodeSha256,
  });
}

export async function buildAdmissionFeatureCandidateImageV1(
  ...rejectedOverrides: readonly unknown[]
): Promise<AdmissionCandidateBuildReceiptV1> {
  if (rejectedOverrides.length !== 0) throw new Error('build overrides are forbidden');
  return immutableReceiptV1(await buildAdmissionFeatureCandidateImageWithRunnerV1(runDockerCommandV1));
}
