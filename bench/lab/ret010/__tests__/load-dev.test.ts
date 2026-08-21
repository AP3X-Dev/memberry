import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import ts from 'typescript';
import { afterEach, describe, expect, it } from 'vitest';

import { MemBerryRetrievalCoreAdapter } from '../../adapters/memberry-retrieval-core.js';
import { validateScenario } from '../../contracts/scenario.js';
import { loadRet010DevScenarios } from '../load-dev.js';

const REPO_ROOT = resolve(import.meta.dirname, '..', '..', '..', '..');
const LOAD_DEV = resolve(REPO_ROOT, 'bench/lab/ret010/load-dev.ts');
const INPUT_RELATIVE = 'bench/lab/datasets/ret010/v1/dev/input.jsonl';
const ORACLE_RELATIVE = 'bench/lab/datasets/ret010/v1/dev/oracle.jsonl';
const REGISTRY_RELATIVE = 'bench/lab/registry/datasets.json';
const DATASET_ID = 'memberry-ret010-dev-v1';
const temporaryRoots: string[] = [];

type JsonObject = Record<string, any>;

function normalized(content: string): Buffer {
  return Buffer.from(content.replace(/\r\n?/g, '\n'), 'utf8');
}

function digest(content: string): { sha256: string; sizeBytes: number } {
  const bytes = normalized(content);
  return { sha256: createHash('sha256').update(bytes).digest('hex'), sizeBytes: bytes.byteLength };
}

function lines(content: string): JsonObject[] {
  return content.split(/\r?\n/).filter((line) => line.trim()).map((line) => JSON.parse(line) as JsonObject);
}

async function writeJsonLines(path: string, records: JsonObject[]): Promise<string> {
  const content = `${records.map((record) => JSON.stringify(record)).join('\n')}\n`;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, 'utf8');
  return content;
}

async function copyCustody(): Promise<string> {
  const root = await mkdtemp(resolve(tmpdir(), 'memberry-ret010a-'));
  temporaryRoots.push(root);
  for (const relative of [REGISTRY_RELATIVE, INPUT_RELATIVE, ORACLE_RELATIVE]) {
    const target = resolve(root, relative);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, await readFile(resolve(REPO_ROOT, relative)));
  }
  return root;
}

async function registry(root: string): Promise<JsonObject> {
  return JSON.parse(await readFile(resolve(root, REGISTRY_RELATIVE), 'utf8')) as JsonObject;
}

function ret010Entry(value: JsonObject): JsonObject {
  const entry = value.datasets.find((candidate: JsonObject) => candidate.id === DATASET_ID);
  if (!entry) throw new Error('fixture registry lost RET-010 descriptor');
  return entry;
}

async function saveRegistry(root: string, value: JsonObject): Promise<void> {
  await writeFile(resolve(root, REGISTRY_RELATIVE), `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function rewriteArtifact(
  root: string,
  role: 'input' | 'oracle',
  mutate: (records: JsonObject[]) => void,
): Promise<void> {
  const relative = role === 'input' ? INPUT_RELATIVE : ORACLE_RELATIVE;
  const records = lines(await readFile(resolve(root, relative), 'utf8'));
  mutate(records);
  const content = await writeJsonLines(resolve(root, relative), records);
  const value = await registry(root);
  const artifact = ret010Entry(value).artifacts.find((candidate: JsonObject) => candidate.role === role);
  Object.assign(artifact, digest(content));
  await saveRegistry(root, value);
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('RET-010A fixed development loader', () => {
  it('loads the exact separated 10 Recall@10 then 10 Precision@5 corpus', async () => {
    const scenarios = await loadRet010DevScenarios(REPO_ROOT);
    expect(scenarios).toHaveLength(20);
    expect(scenarios.flatMap(({ oracle }) => oracle.probes)).toHaveLength(20);
    expect(scenarios.slice(0, 10).map(({ input }) => [input.dimensions, input.queries[0]!.limit]))
      .toEqual(Array.from({ length: 10 }, () => [['recall'], 10]));
    expect(scenarios.slice(10).map(({ input }) => [input.dimensions, input.queries[0]!.limit]))
      .toEqual(Array.from({ length: 10 }, () => [['precision'], 5]));
    for (const { input, oracle } of scenarios.slice(10)) {
      const eligible = input.memories.filter((memory) => (
        memory.tenant === input.tenant && memory.project === input.project && !memory.validTo && !memory.invalidatedAt
      ));
      expect(eligible.length).toBeGreaterThan(5);
      expect(eligible.findIndex(({ id }) => id === oracle.probes[0]!.relevant[0])).toBeGreaterThanOrEqual(5);
    }
    expect(scenarios.every(({ input }) => input.split === 'dev' && input.queries.length === 1)).toBe(true);
    expect(scenarios.flatMap(({ input }) => input.tags ?? [])).toContain('tight-budget');
    for (const scenario of scenarios) {
      expect(validateScenario(scenario)).toEqual([]);
      expect(scenario.input.memories.some(({ tenant }) => tenant !== scenario.input.tenant)).toBe(true);
      expect(scenario.input.memories.some(({ project }) => project !== scenario.input.project)).toBe(true);
      expect(scenario.input.memories.some(({ validTo, invalidatedAt }) => Boolean(validTo && invalidatedAt))).toBe(true);
      expect(scenario.input.memories.map(({ id }) => id).join('\n')).not.toMatch(/out[-_]?of[-_]?corpus|unknown[-_]?result/i);
    }
  });

  it('proves frozen disabled production-path membership headroom on the tight-budget precision probe', async () => {
    const scenarios = await loadRet010DevScenarios(REPO_ROOT);
    const scenario = scenarios.find(({ input }) => input.tags?.includes('tight-budget'));
    expect(scenario).toBeDefined();
    const input = scenario!.input;
    const oracle = scenario!.oracle.probes[0]!;
    const query = input.queries[0]!;
    const namespace = { runId: 'ret010a-disabled-headroom', tenant: input.tenant, project: input.project };
    const adapter = new MemBerryRetrievalCoreAdapter();
    expect(adapter.id).toBe('memberry-retrieval-core-v1');
    await adapter.cleanup(namespace);
    try {
      const ingest = await adapter.ingest({ namespace, memories: input.memories });
      expect(ingest).toEqual({ accepted: input.memories.length, rejected: [] });
      const response = await adapter.query({
        namespace,
        query: query.query,
        limit: query.limit,
        asOf: query.asOf,
        tokenBudget: query.tokenBudget,
      });
      const returned = response.results.map(({ id }) => id);
      expect(returned.length).toBeGreaterThan(0);
      expect(returned.length).toBeLessThanOrEqual(query.limit);
      expect(returned).not.toContain(oracle.relevant[0]);
      expect(new Set(returned).size).toBe(returned.length);
    } finally {
      await adapter.cleanup(namespace);
    }
  });

  it('pins globally unique scenario, query, and probe identities with in-corpus labels only', async () => {
    const scenarios = await loadRet010DevScenarios(REPO_ROOT);
    const scenarioIds = scenarios.map(({ input }) => input.id);
    const queryIds = scenarios.map(({ input }) => input.queries[0]!.id);
    const probeIds = scenarios.map(({ oracle }) => oracle.probes[0]!.probeId);
    expect(new Set(scenarioIds).size).toBe(20);
    expect(new Set(queryIds).size).toBe(20);
    expect(new Set(probeIds).size).toBe(20);
    for (const { input, oracle } of scenarios) {
      const corpus = new Set(input.memories.map(({ id }) => id));
      const probe = oracle.probes[0]!;
      expect([probe.relevant, probe.required ?? [], probe.stale ?? [], probe.forbidden ?? []]
        .flat().every((id) => corpus.has(id))).toBe(true);
    }
  });

  it('keeps every scorer key out of adapter-visible input bytes and pins registry custody', async () => {
    const input = await readFile(resolve(REPO_ROOT, INPUT_RELATIVE), 'utf8');
    const registryValue = await registry(REPO_ROOT);
    const entry = ret010Entry(registryValue);
    expect(input).not.toMatch(/"(?:oracle|relevant|required|stale|forbidden)"\s*:/);
    expect(entry).toMatchObject({
      version: 'ret010-dev-v1', suite: 'ret010-development', kind: 'repository', split: 'dev',
      oracleAccess: 'scorer-only', requiredInCi: false,
      source: { revision: 'ret010-dev-v1', path: 'bench/lab/datasets/ret010/v1/dev' },
      acquisition: { status: 'bundled' },
    });
    expect(entry.artifacts).toHaveLength(2);
    for (const artifact of entry.artifacts) {
      const content = await readFile(resolve(REPO_ROOT, artifact.repositoryPath), 'utf8');
      expect(digest(content)).toEqual({ sha256: artifact.sha256, sizeBytes: artifact.sizeBytes });
      expect(artifact.hashMode).toBe('text-lf');
    }
    expect(entry.artifacts.map((artifact: JsonObject) => ({
      role: artifact.role,
      access: artifact.access,
      fileName: artifact.fileName,
      hashMode: artifact.hashMode,
      repositoryPath: artifact.repositoryPath,
    }))).toEqual([
      {
        role: 'input', access: 'adapter', fileName: 'input.jsonl', hashMode: 'text-lf',
        repositoryPath: INPUT_RELATIVE,
      },
      {
        role: 'oracle', access: 'scorer', fileName: 'oracle.jsonl', hashMode: 'text-lf',
        repositoryPath: ORACLE_RELATIVE,
      },
    ]);
    expect(entry.artifacts[0].repositoryPath).not.toBe(entry.artifacts[1].repositoryPath);
  });

  it('has no TypeScript compiler diagnostic even though the package lab entry list cannot discover it', () => {
    const program = ts.createProgram([LOAD_DEV], {
      noEmit: true,
      strict: true,
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      esModuleInterop: true,
      skipLibCheck: true,
    });
    const diagnostics = ts.getPreEmitDiagnostics(program);
    const formatted = ts.formatDiagnostics(diagnostics, {
      getCanonicalFileName: (fileName) => fileName,
      getCurrentDirectory: () => REPO_ROOT,
      getNewLine: () => '\n',
    });
    expect(formatted, `load-dev.ts compiler diagnostics:\n${formatted}`).toBe('');
  });

  it('rejects normalized digest drift before parsing', async () => {
    const root = await copyCustody();
    const path = resolve(root, INPUT_RELATIVE);
    await writeFile(path, `${await readFile(path, 'utf8')} `, 'utf8');
    await expect(loadRet010DevScenarios(root)).rejects.toThrow(/SHA-256 mismatch/);
  });

  it('rejects a second owned descriptor or a third artifact', async () => {
    const descriptorRoot = await copyCustody();
    const descriptorRegistry = await registry(descriptorRoot);
    descriptorRegistry.datasets.push({ ...structuredClone(ret010Entry(descriptorRegistry)), id: 'memberry-ret010-dev-shadow' });
    await saveRegistry(descriptorRoot, descriptorRegistry);
    await expect(loadRet010DevScenarios(descriptorRoot)).rejects.toThrow(/exactly one registered development descriptor/);

    const artifactRoot = await copyCustody();
    const artifactRegistry = await registry(artifactRoot);
    const entry = ret010Entry(artifactRegistry);
    const extraPath = 'bench/lab/datasets/ret010/v1/dev/extra-input.jsonl';
    const content = await readFile(resolve(artifactRoot, INPUT_RELATIVE), 'utf8');
    await writeFile(resolve(artifactRoot, extraPath), content, 'utf8');
    entry.artifacts.push({ ...entry.artifacts[0], fileName: 'extra-input.jsonl', repositoryPath: extraPath });
    await saveRegistry(artifactRoot, artifactRegistry);
    await expect(loadRet010DevScenarios(artifactRoot)).rejects.toThrow(/exactly two frozen artifacts/);
  });

  it('rejects artifact file-name or hash-mode drift before generic verification', async () => {
    const fileNameRoot = await copyCustody();
    const fileNameRegistry = await registry(fileNameRoot);
    ret010Entry(fileNameRegistry).artifacts[0].fileName = 'renamed-input.jsonl';
    await saveRegistry(fileNameRoot, fileNameRegistry);
    await expect(loadRet010DevScenarios(fileNameRoot)).rejects.toThrow(/input artifact custody mismatch/);

    const hashModeRoot = await copyCustody();
    const hashModeRegistry = await registry(hashModeRoot);
    ret010Entry(hashModeRegistry).artifacts[1].hashMode = 'bytes';
    await saveRegistry(hashModeRoot, hashModeRegistry);
    await expect(loadRet010DevScenarios(hashModeRoot)).rejects.toThrow(/oracle artifact custody mismatch/);
  });

  it('rejects descriptor kind, oracle access, acquisition, or source-revision drift', async () => {
    const cases: Array<{ mutate: (entry: JsonObject) => void; message: RegExp }> = [
      { mutate: (entry) => { entry.kind = 'external'; }, message: /descriptor custody mismatch/ },
      { mutate: (entry) => { entry.oracleAccess = 'adapter-visible'; }, message: /descriptor custody mismatch/ },
      { mutate: (entry) => { entry.acquisition.status = 'available'; }, message: /acquisition must remain bundled/ },
      { mutate: (entry) => { entry.source.revision = 'ret010-dev-drift'; }, message: /registered source root mismatch/ },
    ];
    for (const hostile of cases) {
      const root = await copyCustody();
      const value = await registry(root);
      hostile.mutate(ret010Entry(value));
      await saveRegistry(root, value);
      await expect(loadRet010DevScenarios(root)).rejects.toThrow(hostile.message);
    }
  });

  it('rejects wrong split and artifact root', async () => {
    const splitRoot = await copyCustody();
    const splitRegistry = await registry(splitRoot);
    ret010Entry(splitRegistry).split = 'evaluation';
    await saveRegistry(splitRoot, splitRegistry);
    await expect(loadRet010DevScenarios(splitRoot)).rejects.toThrow(/split must be dev/);

    const pathRoot = await copyCustody();
    const pathRegistry = await registry(pathRoot);
    const entry = ret010Entry(pathRegistry);
    const otherPath = 'bench/lab/datasets/ret010/v1/other/input.jsonl';
    await mkdir(dirname(resolve(pathRoot, otherPath)), { recursive: true });
    await writeFile(resolve(pathRoot, otherPath), await readFile(resolve(pathRoot, INPUT_RELATIVE)));
    entry.artifacts[0].repositoryPath = otherPath;
    await saveRegistry(pathRoot, pathRegistry);
    await expect(loadRet010DevScenarios(pathRoot)).rejects.toThrow(/outside the frozen development root/);

  });

  it('rejects a fixed artifact symlink before generic verification can open its target', async () => {
    const root = await copyCustody();
    const outside = await mkdtemp(resolve(tmpdir(), 'memberry-ret010a-outside-'));
    temporaryRoots.push(outside);
    const outsideInput = resolve(outside, 'outside-input.jsonl');
    const fixedInput = resolve(root, INPUT_RELATIVE);
    await writeFile(outsideInput, await readFile(fixedInput));
    await rm(fixedInput);
    await symlink(outsideInput, fixedInput, 'file');
    await expect(loadRet010DevScenarios(root)).rejects.toThrow(/must not be a symbolic link/);
  });

  it('rejects mixed dimension or k', async () => {
    const dimensionRoot = await copyCustody();
    await rewriteArtifact(dimensionRoot, 'input', (records) => { records[0]!.dimensions = ['precision']; });
    await expect(loadRet010DevScenarios(dimensionRoot)).rejects.toThrow(/expected recall-only dimension/);

    const kRoot = await copyCustody();
    await rewriteArtifact(kRoot, 'input', (records) => { records[10]!.queries[0].limit = 10; });
    await expect(loadRet010DevScenarios(kRoot)).rejects.toThrow(/expected k=5/);
  });

  it('rejects duplicate identities and unmatched input/oracle order', async () => {
    const duplicateRoot = await copyCustody();
    await rewriteArtifact(duplicateRoot, 'input', (records) => { records[1]!.id = records[0]!.id; });
    await rewriteArtifact(duplicateRoot, 'oracle', (records) => { records[1]!.scenarioId = records[0]!.scenarioId; });
    await expect(loadRet010DevScenarios(duplicateRoot)).rejects.toThrow(/duplicate scenario id/);

    const unmatchedRoot = await copyCustody();
    await rewriteArtifact(unmatchedRoot, 'oracle', (records) => { [records[0], records[1]] = [records[1], records[0]]; });
    await expect(loadRet010DevScenarios(unmatchedRoot)).rejects.toThrow(/oracle identity\/order mismatch/);
  });

  it('rejects scorer keys in input and oracle references absent from the matching corpus', async () => {
    const scorerRoot = await copyCustody();
    await rewriteArtifact(scorerRoot, 'input', (records) => { records[0]!.metadata = { oracle: 'must-not-cross' }; });
    await expect(loadRet010DevScenarios(scorerRoot)).rejects.toThrow(/contains scorer-only data/);

    const unknownRoot = await copyCustody();
    await rewriteArtifact(unknownRoot, 'oracle', (records) => { records[0]!.probes[0].relevant = ['absent-output-id']; });
    await expect(loadRet010DevScenarios(unknownRoot)).rejects.toThrow(/unknown fixture id absent-output-id/);
  });
});
