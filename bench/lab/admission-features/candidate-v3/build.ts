// MEM-002 productionization: canonical networkless builder for the v3
// candidate image.
//
// The scored surface is the PRODUCTION module packages/core/src/
// admission-feature-producer.ts behind the candidate-v3 worker adapter. The
// builder captures the exact executed source closure (verified byte-for-byte
// against the committed Git blobs, never a dirty worktree), transpiles it with
// the repository's pinned TypeScript compiler into a deterministic /app module
// tree, and builds over a canonical content-addressed tar context streamed on
// stdin — mirroring the frozen candidate/build.ts discipline. Identity pins:
// content hashes and Git blob identities only, never image or image-config IDs
// (do-not-retry #2); every docker create/cp/rm proof phase runs under a
// bounded 60s timeout (do-not-retry #3); the build receipt is generated,
// returned in memory, and never committed (do-not-retry #1).

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Buffer } from 'node:buffer';

import ts from 'typescript';

import { APPROVED_NODE_BASE_IMAGE_V1 } from '../candidate/protocol.js';
import { snapshotSuccessfulDockerCommandBytesV1 } from '../candidate/build.js';
import {
  canonicalImageConfigSha256V1,
  cleanupOwnedTemporaryDirectoryV1,
  createDockerCommandInvocationV1,
  createOwnedTemporaryDirectoryV1,
  gitBlobObjectIdV1,
  hasExactCandidateRootFsExtensionV1,
  inspectDockerCopyArchiveV1,
  readOwnedContainerIdFileV1,
  runDockerCommandV1,
  type DockerCommandRunnerV1,
  type DockerCommandResultV1,
} from '../candidate/sandbox.js';

export const ADMISSION_CANDIDATE_V3_PRODUCER_ID = 'memberry.safe-facts-feature-producer' as const;
export const ADMISSION_CANDIDATE_V3_PRODUCER_VERSION = '1.0.0' as const;

const IMAGE_PATTERN = /^sha256:[0-9a-f]{64}$/;
const CONTAINER_ID_PATTERN = /^[0-9a-f]{64}$/;
const PRELOAD_ENV_PATTERN = /^(?:NODE_OPTIONS|NODE_PATH|LD_PRELOAD|LD_LIBRARY_PATH|DYLD_.+|BASH_ENV|ENV)=/;
export const ADMISSION_CANDIDATE_V3_WORKER_CONTAINER_PATH = '/app/bench/lab/admission-features/candidate-v3/worker.mjs' as const;
const WORKER_CONTAINER_PATH = ADMISSION_CANDIDATE_V3_WORKER_CONTAINER_PATH;
export const ADMISSION_CANDIDATE_V3_ARGUMENTS = Object.freeze([
  '--permission', '--allow-fs-read=/app/',
  '--allow-fs-write=/tmp/memberry-sandbox-write-probe',
  '--disable-proto=throw', WORKER_CONTAINER_PATH, '-',
]);
const CANDIDATE_ARGUMENTS_V3 = ADMISSION_CANDIDATE_V3_ARGUMENTS;

/**
 * The exact runtime module closure executed inside the container: the v3
 * worker adapter, the v3 evaluation contract, and the production modules it
 * imports. Type-only imports (packages/core/src/types.ts) are erased at
 * transpile time; the whole packages/core/src subtree identity is separately
 * pinned by the custodian seal's coreSubtreeOid.
 */
const SOURCE_FILES_V3 = Object.freeze([
  'bench/lab/admission-features/candidate-v3/container/Dockerfile',
  'bench/lab/admission-features/candidate-v3/worker.ts',
  'bench/lab/admission-features/contract-v3.ts',
  'packages/core/src/admission-feature-producer.ts',
  'packages/core/src/admission.ts',
  'packages/core/src/admission-features.ts',
  'packages/core/src/admission-features-v2.ts',
  'packages/core/src/redact.ts',
] as const);

export interface AdmissionCandidateV3BuildReceipt {
  readonly receiptVersion: 'memberry.admission-candidate-v3-build-receipt.v1';
  readonly producerId: typeof ADMISSION_CANDIDATE_V3_PRODUCER_ID;
  readonly producerVersion: typeof ADMISSION_CANDIDATE_V3_PRODUCER_VERSION;
  readonly candidateSha256: `sha256:${string}`;
  readonly sourceSha256: `sha256:${string}`;
  readonly imageSha256: `sha256:${string}`;
  readonly imageConfigSha256: `sha256:${string}`;
  readonly nodeSha256: `sha256:${string}`;
  readonly baseImage: typeof APPROVED_NODE_BASE_IMAGE_V1;
  readonly rootFsLayers: readonly string[];
}

const RECEIPTS_V3 = new WeakMap<object, AdmissionCandidateV3BuildReceipt>();

export function readAdmissionCandidateV3BuildReceipt(value: unknown): AdmissionCandidateV3BuildReceipt {
  if (typeof value !== 'object' || value === null) throw new Error('invalid build receipt');
  const record = RECEIPTS_V3.get(value);
  if (!record) throw new Error('invalid build receipt');
  return record;
}

function sha256(bytes: Uint8Array | string): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function repositoryRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
}

function gitText(root: string, args: readonly string[]): string {
  return execFileSync('git', [...args], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
}

/**
 * Read every closure file from the worktree and prove each one byte-identical
 * to its committed Git blob at HEAD — the builder never packages uncommitted
 * content. Returns the file map plus the closure content hash.
 */
async function captureCandidateV3SourceSnapshot(): Promise<Readonly<{
  files: ReadonlyMap<string, Uint8Array>;
  sourceSha256: `sha256:${string}`;
}>> {
  const root = repositoryRoot();
  const files = new Map<string, Uint8Array>();
  for (const relativePath of SOURCE_FILES_V3) {
    const bytes = new Uint8Array(await readFile(resolve(root, relativePath)));
    if (bytes.byteLength < 1 || bytes.byteLength > 1_048_576) throw new Error('candidate source out of bounds');
    const committedOid = gitText(root, ['rev-parse', `HEAD:${relativePath}`]);
    if (!/^[0-9a-f]{40}$/.test(committedOid) || gitBlobObjectIdV1(bytes) !== committedOid) {
      throw new Error('candidate source is not the committed content');
    }
    files.set(relativePath, bytes);
  }
  const hash = createHash('sha256');
  for (const relativePath of SOURCE_FILES_V3) {
    const bytes = files.get(relativePath)!;
    hash.update(String(Buffer.byteLength(relativePath, 'utf8')));
    hash.update(':');
    hash.update(relativePath, 'utf8');
    hash.update(':');
    hash.update(String(bytes.byteLength));
    hash.update(':');
    hash.update(bytes);
  }
  return Object.freeze({ files, sourceSha256: `sha256:${hash.digest('hex')}` as const });
}

function transpileClosure(files: ReadonlyMap<string, Uint8Array>): ReadonlyMap<string, Uint8Array> {
  const emitted = new Map<string, Uint8Array>();
  const encoder = new TextEncoder();
  for (const [relativePath, bytes] of files) {
    if (!relativePath.endsWith('.ts')) continue;
    const output = ts.transpileModule(new TextDecoder('utf-8', { fatal: true }).decode(bytes), {
      compilerOptions: {
        module: ts.ModuleKind.ESNext,
        target: ts.ScriptTarget.ES2022,
        removeComments: false,
      },
      fileName: relativePath,
    });
    // The worker entry point keeps the frozen .mjs naming (and stays outside
    // any import graph); every imported module keeps the .js name its ESM
    // specifiers reference.
    const emittedPath = relativePath === 'bench/lab/admission-features/candidate-v3/worker.ts'
      ? 'bench/lab/admission-features/candidate-v3/worker.mjs'
      : relativePath.replace(/\.ts$/, '.js');
    emitted.set(emittedPath, encoder.encode(output.outputText));
  }
  // Closure completeness: every relative import in the emitted tree must
  // resolve inside the tree, and only node: builtins may cross it.
  const decoder = new TextDecoder('utf-8', { fatal: true });
  for (const [emittedPath, bytes] of emitted) {
    const text = decoder.decode(bytes);
    for (const match of text.matchAll(/(?:from|import)\s*\(?\s*["']([^"']+)["']\s*\)?/g)) {
      const specifier = match[1]!;
      if (specifier.startsWith('node:')) continue;
      if (!specifier.startsWith('.')) throw new Error('candidate closure escape');
      const segments = emittedPath.split('/');
      segments.pop();
      for (const segment of specifier.split('/')) {
        if (segment === '.') continue;
        if (segment === '..') {
          if (segments.length === 0) throw new Error('candidate closure escape');
          segments.pop();
        } else {
          segments.push(segment);
        }
      }
      if (!emitted.has(segments.join('/'))) throw new Error('candidate closure incomplete');
    }
  }
  return emitted;
}

function tarHeader(path: string, size: number): Uint8Array {
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

function canonicalContext(entries: ReadonlyMap<string, Uint8Array>): Uint8Array {
  const sorted = [...entries.keys()].sort();
  const chunks: Uint8Array[] = [];
  for (const path of sorted) {
    const bytes = entries.get(path)!;
    chunks.push(tarHeader(path, bytes.byteLength), Uint8Array.from(bytes));
    const padding = Math.ceil(bytes.byteLength / 512) * 512 - bytes.byteLength;
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

function boundedInvocation(
  args: readonly string[],
  stdin?: Uint8Array,
  stdoutLimit?: number,
): ReturnType<typeof createDockerCommandInvocationV1> {
  return Object.freeze({
    ...createDockerCommandInvocationV1(args, stdin, stdoutLimit),
    timeoutMs: 60_000,
  });
}

function safeText(result: DockerCommandResultV1, allowStderr = false): string {
  return new TextDecoder('utf-8', { fatal: true }).decode(snapshotSuccessfulDockerCommandBytesV1(result, allowStderr));
}

function rootFsLayers(inspection: any): readonly string[] {
  const layers = inspection?.RootFS?.Layers;
  if (inspection?.RootFS?.Type !== 'layers' || !Array.isArray(layers) || layers.length < 1
    || layers.length > 256 || layers.some((layer: unknown) => typeof layer !== 'string'
      || !IMAGE_PATTERN.test(layer))) throw new Error('invalid image rootfs');
  return Object.freeze([...layers]);
}

async function withStoppedProof<T>(
  requestedImage: string,
  expectedImageId: string,
  runner: DockerCommandRunnerV1,
  inspect: (id: string) => Promise<T>,
): Promise<T> {
  const temporary = await createOwnedTemporaryDirectoryV1('admission-build');
  let id: string | undefined;
  let outcome: T | undefined;
  let failed = false;
  try {
    snapshotSuccessfulDockerCommandBytesV1(await runner(boundedInvocation([
      'create', `--cidfile=${temporary.cidFile}`, '--platform=linux/amd64', '--pull=never',
      `--label=org.memberry.build-token=${temporary.runToken}`, '--entrypoint=/usr/local/bin/node',
      requestedImage, '--version',
    ])), true);
    const cidId = await readOwnedContainerIdFileV1(temporary);
    if (!cidId || !CONTAINER_ID_PATTERN.test(cidId)) throw new Error('proof identity mismatch');
    id = cidId;
    const inspected = JSON.parse(safeText(await runner(boundedInvocation([
      'container', 'inspect', '--format={{json .}}', id,
    ])))) as any;
    if (inspected?.Id !== id || inspected?.Image !== expectedImageId
      || inspected?.Config?.Labels?.['org.memberry.build-token'] !== temporary.runToken
      || !Array.isArray(inspected?.Mounts) || inspected.Mounts.length !== 0) {
      throw new Error('proof ownership mismatch');
    }
    outcome = await inspect(id);
  } catch {
    failed = true;
  }
  let containersClean = false;
  try {
    if (id !== undefined) {
      safeText(await runner(boundedInvocation(['container', 'rm', '-fv', id])));
    }
    const remaining = safeText(await runner(boundedInvocation([
      'container', 'ls', '-a', '--no-trunc',
      `--filter=label=org.memberry.build-token=${temporary.runToken}`, '--format={{.ID}}',
    ])));
    containersClean = remaining.replace(/\r\n?/g, '\n').split('\n').filter(Boolean).length === 0;
  } catch {
    containersClean = false;
  }
  const hostClean = containersClean && await cleanupOwnedTemporaryDirectoryV1(temporary);
  if (failed || !containersClean || !hostClean || outcome === undefined) throw new Error('build proof failed');
  return outcome;
}

function verifyImageConfig(
  base: any,
  image: any,
  imageId: string,
  candidate: string,
  source: string,
): void {
  const config = image?.Config;
  if (!Array.isArray(base?.RepoDigests) || !base.RepoDigests.includes(APPROVED_NODE_BASE_IMAGE_V1)
    || base?.Os !== 'linux' || base?.Architecture !== 'amd64'
    || image?.Id !== imageId || image?.Os !== 'linux' || image?.Architecture !== 'amd64'
    || typeof config !== 'object' || config === null) throw new Error('image inspection mismatch');
  if (!hasExactCandidateRootFsExtensionV1(rootFsLayers(base), rootFsLayers(image))) {
    throw new Error('image rootfs mismatch');
  }
  const env = config.Env;
  if (!Array.isArray(env)
    || env.some((entry: unknown) => typeof entry !== 'string' || PRELOAD_ENV_PATTERN.test(entry))
    || !env.includes('LANG=C.UTF-8') || !env.includes('LC_ALL=C.UTF-8') || !env.includes('TZ=UTC')) {
    throw new Error('image environment mismatch');
  }
  const exact = (value: unknown, expected: readonly string[]) => Array.isArray(value)
    && value.length === expected.length && value.every((entry, index) => entry === expected[index]);
  if (config.User !== '65532:65532' || config.WorkingDir !== '/app'
    || !exact(config.Entrypoint, ['/usr/local/bin/node'])
    || !exact(config.Cmd, CANDIDATE_ARGUMENTS_V3)
    || config.Volumes != null || config.Healthcheck != null || config.Shell != null
    || config.ExposedPorts != null || config.StopSignal != null) {
    throw new Error('image config mismatch');
  }
  const labels = config.Labels ?? {};
  if (Object.keys(labels).length !== 5
    || labels['org.memberry.candidate.sha256'] !== candidate
    || labels['org.memberry.source.sha256'] !== source
    || labels['org.memberry.base.image'] !== APPROVED_NODE_BASE_IMAGE_V1
    || labels['org.memberry.producer.id'] !== ADMISSION_CANDIDATE_V3_PRODUCER_ID
    || labels['org.memberry.producer.version'] !== ADMISSION_CANDIDATE_V3_PRODUCER_VERSION) {
    throw new Error('image label mismatch');
  }
}

async function buildWithRunner(runner: DockerCommandRunnerV1): Promise<AdmissionCandidateV3BuildReceipt> {
  const snapshot = await captureCandidateV3SourceSnapshot();
  const dockerfileBytes = snapshot.files.get('bench/lab/admission-features/candidate-v3/container/Dockerfile')!;
  const dockerfile = new TextDecoder('utf-8', { fatal: true }).decode(dockerfileBytes).replace(/\r\n?/g, '\n');
  const fromLines = dockerfile.split('\n').filter((line) => line.startsWith('FROM '));
  if (fromLines.length !== 1 || fromLines[0] !== `FROM ${APPROVED_NODE_BASE_IMAGE_V1} AS candidate`
    || /^RUN\b/m.test(dockerfile)
    || !dockerfile.includes('ENTRYPOINT ["/usr/local/bin/node"]')
    || !dockerfile.includes(`CMD [${CANDIDATE_ARGUMENTS_V3.map((entry) => JSON.stringify(entry)).join(', ')}]`)) {
    throw new Error('Dockerfile policy mismatch');
  }

  const modules = transpileClosure(snapshot.files);
  const appFiles = new Map<string, Uint8Array>();
  appFiles.set('app/package.json', new TextEncoder().encode('{"type":"module"}\n'));
  for (const [emittedPath, bytes] of modules) appFiles.set(`app/${emittedPath}`, bytes);
  const candidateHash = createHash('sha256');
  for (const path of [...appFiles.keys()].sort()) {
    const bytes = appFiles.get(path)!;
    candidateHash.update(String(Buffer.byteLength(path, 'utf8')));
    candidateHash.update(':');
    candidateHash.update(path, 'utf8');
    candidateHash.update(':');
    candidateHash.update(String(bytes.byteLength));
    candidateHash.update(':');
    candidateHash.update(bytes);
  }
  const candidateSha256 = `sha256:${candidateHash.digest('hex')}` as const;

  const baseInspection = JSON.parse(safeText(await runner(boundedInvocation([
    'image', 'inspect', '--format={{json .}}', APPROVED_NODE_BASE_IMAGE_V1,
  ])))) as any;
  rootFsLayers(baseInspection);
  if (!Array.isArray(baseInspection?.RepoDigests)
    || !baseInspection.RepoDigests.includes(APPROVED_NODE_BASE_IMAGE_V1)
    || typeof baseInspection?.Id !== 'string' || !IMAGE_PATTERN.test(baseInspection.Id)
    || baseInspection?.Os !== 'linux' || baseInspection?.Architecture !== 'amd64') {
    throw new Error('approved base inspection mismatch');
  }
  const baseNode = await withStoppedProof(
    APPROVED_NODE_BASE_IMAGE_V1, baseInspection.Id, runner,
    async (id) => inspectDockerCopyArchiveV1(snapshotSuccessfulDockerCommandBytesV1(
      await runner(boundedInvocation(['container', 'cp', `${id}:/usr/local/bin/node`, '-'], undefined, 134_219_776)),
    ), 'node'),
  );
  const nodeSha256 = sha256(baseNode);

  const attestation = new TextEncoder().encode(JSON.stringify({
    baseImage: APPROVED_NODE_BASE_IMAGE_V1,
    producerId: ADMISSION_CANDIDATE_V3_PRODUCER_ID,
    producerVersion: ADMISSION_CANDIDATE_V3_PRODUCER_VERSION,
    candidateSha256,
    sourceSha256: snapshot.sourceSha256,
    nodeSha256,
  }));
  const context = new Map<string, Uint8Array>([
    ['container/Dockerfile', dockerfileBytes],
    ['app/attestation.json', attestation],
    ...appFiles,
  ]);

  const built = await runner(Object.freeze({
    ...createDockerCommandInvocationV1([
      'build', '--quiet', '--platform=linux/amd64', '--pull=false', '--network=none', '--target=candidate',
      `--build-arg=CANDIDATE_SHA256=${candidateSha256}`,
      `--build-arg=SOURCE_SHA256=${snapshot.sourceSha256}`,
      '--file=container/Dockerfile', '-',
    ], canonicalContext(context), 1_048_576),
    timeoutMs: 60_000,
    stderrLimit: 32_768,
  }));
  const imageSha256 = safeText(built, true).trim();
  if (!IMAGE_PATTERN.test(imageSha256)) throw new Error('invalid built image ID');

  const imageInspection = JSON.parse(safeText(await runner(boundedInvocation([
    'image', 'inspect', '--format={{json .}}', imageSha256,
  ])))) as any;
  verifyImageConfig(baseInspection, imageInspection, imageSha256, candidateSha256, snapshot.sourceSha256);
  const layers = rootFsLayers(imageInspection);
  const imageConfigSha256 = canonicalImageConfigSha256V1(imageInspection.Config);

  await withStoppedProof(imageSha256, imageSha256, runner, async (id) => {
    const copiedWorker = inspectDockerCopyArchiveV1(snapshotSuccessfulDockerCommandBytesV1(
      await runner(boundedInvocation(['container', 'cp', `${id}:${WORKER_CONTAINER_PATH}`, '-'], undefined, 1_048_576)),
    ), 'worker.mjs');
    if (!Buffer.from(copiedWorker).equals(Buffer.from(
      appFiles.get('app/bench/lab/admission-features/candidate-v3/worker.mjs')!,
    ))) throw new Error('built worker mismatch');
    const copiedAttestation = inspectDockerCopyArchiveV1(snapshotSuccessfulDockerCommandBytesV1(
      await runner(boundedInvocation(['container', 'cp', `${id}:/app/attestation.json`, '-'], undefined, 1_048_576)),
    ), 'attestation.json');
    if (!Buffer.from(copiedAttestation).equals(Buffer.from(attestation))) {
      throw new Error('built attestation mismatch');
    }
    const copiedNode = inspectDockerCopyArchiveV1(snapshotSuccessfulDockerCommandBytesV1(
      await runner(boundedInvocation(['container', 'cp', `${id}:/usr/local/bin/node`, '-'], undefined, 134_219_776)),
    ), 'node');
    if (sha256(copiedNode) !== nodeSha256) throw new Error('candidate Node binary mismatch');
    return true;
  });

  const receipt = Object.freeze(Object.assign(Object.create(null), {
    receiptVersion: 'memberry.admission-candidate-v3-build-receipt.v1' as const,
    producerId: ADMISSION_CANDIDATE_V3_PRODUCER_ID,
    producerVersion: ADMISSION_CANDIDATE_V3_PRODUCER_VERSION,
    candidateSha256,
    sourceSha256: snapshot.sourceSha256,
    imageSha256: imageSha256 as `sha256:${string}`,
    imageConfigSha256,
    nodeSha256,
    baseImage: APPROVED_NODE_BASE_IMAGE_V1,
    rootFsLayers: layers,
  })) as AdmissionCandidateV3BuildReceipt;
  RECEIPTS_V3.set(receipt, receipt);
  return receipt;
}

/**
 * Zero-argument canonical builder (mirror of the frozen
 * buildAdmissionFeatureCandidateImageV1 override rejection): no runner,
 * source, or policy override surface exists.
 */
export async function buildAdmissionFeatureCandidateV3ImageV1(
  ...rejectedOverrides: readonly unknown[]
): Promise<AdmissionCandidateV3BuildReceipt> {
  if (rejectedOverrides.length !== 0) throw new Error('build overrides are forbidden');
  return buildWithRunner(runDockerCommandV1);
}
