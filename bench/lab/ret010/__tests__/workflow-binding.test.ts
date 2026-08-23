import { readFile } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(import.meta.dirname, '..', '..', '..', '..');
const WORKFLOW = resolve(REPO_ROOT, '.github/workflows/ret010-holdout-qualification.yml');
const LOADER = resolve(REPO_ROOT, 'bench/lab/ret010/load-dev.ts');
const REGISTRY = resolve(REPO_ROOT, 'bench/lab/registry/datasets.json');
const DEV_POLICY = resolve(REPO_ROOT, 'bench/lab/ret010/dev-policy.json');
const HOLDOUT_POLICY = resolve(REPO_ROOT, 'bench/lab/ret010/holdout-policy.json');
const DATASET_ID = 'memberry-ret010-dev-v1';

const GENERIC_LOADER_GRAPH = [
  'bench/lab/ret010/load-dev.ts',
  'bench/lab/contracts/scenario.ts',
  'bench/lab/contracts/adapter.ts',
  'bench/lab/datasets/load-golden.ts',
  'bench/lab/datasets/acquire.ts',
  'bench/lab/datasets/hash.ts',
  'bench/lab/registry/validate.ts',
  'bench/lab/baselines/canonical.ts',
].sort();

type JsonObject = Record<string, any>;

function keys(value: JsonObject): string[] {
  return Object.keys(value).sort();
}

function repoPath(path: string): string {
  return relative(REPO_ROOT, path).replaceAll('\\', '/');
}

async function staticRelativeGraph(entry: string): Promise<Map<string, string>> {
  const pending = [entry];
  const graph = new Map<string, string>();
  while (pending.length > 0) {
    const path = pending.pop()!;
    if (graph.has(path)) continue;
    const source = await readFile(path, 'utf8');
    graph.set(path, source);
    const parsed = ts.preProcessFile(source, true, true);
    for (const imported of parsed.importedFiles) {
      if (!imported.fileName.startsWith('.')) continue;
      const target = resolve(dirname(path), imported.fileName.replace(/\.js$/, '.ts'));
      pending.push(target);
    }
  }
  return graph;
}

describe('RET-010A qualification and binding boundary', () => {
  it('keeps the qualification workflow manual-only, immutable, read-only, and pinned', async () => {
    const workflow = await readFile(WORKFLOW, 'utf8');
    expect(workflow).toMatch(/^on:\s*\n\s+workflow_dispatch:/m);
    expect(workflow).not.toMatch(/^\s+(?:push|pull_request|pull_request_target|schedule):/m);
    expect(workflow.match(/^\s{6}(qualification_sha|approval_digest):$/gm)?.map((line) => line.trim()))
      .toEqual(['qualification_sha:', 'approval_digest:']);
    expect(workflow.match(/required: true/g)).toHaveLength(2);
    expect(workflow.match(/type: string/g)).toHaveLength(2);
    expect(workflow).toMatch(/^permissions:\s*\n\s+contents: read$/m);
    expect(workflow).not.toMatch(/\bsecrets\b|permissions:[\s\S]*?\bwrite\b/i);
    expect(workflow).not.toMatch(/^\s*environment:/m);
    expect(workflow).toContain('node-version: [20, 22]');
    expect(workflow).toContain('fail-fast: false');
    expect(workflow).toContain('^[0-9a-f]{40}$');
    expect(workflow).toContain('^[0-9a-f]{64}$');
    expect(workflow).toContain('ref: ${{ inputs.qualification_sha }}');
    expect(workflow).not.toMatch(/refs\/heads|github\.ref/);
    expect(workflow).toContain('fetch-depth: 0');
    expect(workflow).toContain('persist-credentials: false');
    expect(workflow).toContain('[[ "$(git rev-parse HEAD)" == "$REQUESTED_QUALIFICATION_SHA" ]]');
    expect(workflow).not.toContain('GITHUB_SHA');
    expect(workflow).toContain('npm ci --ignore-scripts');
    expect(workflow).toContain('git status --porcelain --untracked-files=all');
    expect(workflow).toContain('npm run build');
    expect(workflow.match(/git rev-parse HEAD/g)).toHaveLength(2);
    expect(workflow).toContain('git status --porcelain --untracked-files=no');
    expect(workflow.indexOf('npm run build'))
      .toBeLessThan(workflow.indexOf('Reverify exact tracked source before qualification'));
    expect(workflow.indexOf('Reverify exact tracked source before qualification'))
      .toBeLessThan(workflow.indexOf('Run closed RET-010 qualification gate'));
    expect(workflow).toContain('bench/lab/ret010/holdout-gate.mts');
    expect(workflow.match(/RET010_HOLDOUT_QUALIFICATION_SHA: \$\{\{ inputs\.qualification_sha \}\}/g))
      .toHaveLength(2);
    expect(workflow.match(/RET010_HOLDOUT_APPROVAL_DIGEST: \$\{\{ inputs\.approval_digest \}\}/g))
      .toHaveLength(2);
    expect(workflow).not.toContain('RET010_QUALIFICATION_SHA');
    expect(workflow).not.toContain('RET010_APPROVAL_DIGEST');
    expect(workflow).toContain('if: ${{ always() }}');
    expect(workflow).toContain('if-no-files-found: error');
    expect(workflow).toContain('path: ${{ steps.ret010_holdout_finalize.outputs.upload_path }}');
    expect(workflow).not.toMatch(/path:.*(?:bench\/lab\/datasets|input\.jsonl|oracle\.jsonl)/);
    const uses = [...workflow.matchAll(/uses:\s*([^\s]+)/g)].map((match) => match[1]!);
    expect(uses).toEqual([
      'actions/checkout@11d5960a326750d5838078e36cf38b85af677262',
      'actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020',
      'actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02',
      'actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02',
    ]);
    expect(uses.every((value) => /@[0-9a-f]{40}$/.test(value))).toBe(true);
  });

  it('pins the loader to one development identity and only reviewed generic infrastructure', async () => {
    const graph = await staticRelativeGraph(LOADER);
    expect([...graph.keys()].map(repoPath).sort()).toEqual(GENERIC_LOADER_GRAPH);
    const loader = graph.get(LOADER)!;
    expect(loader.split(DATASET_ID)).toHaveLength(2);
    expect(loader).not.toMatch(/memberry-g2|datasets[\\/]g2|loadG2|datasets[\\/]load-suite|load-suite|holdout/i);
    expect(loader).not.toMatch(/datasetId\s*[:=]|split\s*[:=].*['"](?:dev|evaluation)/);
    expect(loader).toContain("loadRegisteredDatasetDescriptor(DATASET_ID, repoRoot, 'all')");
    for (const [path, source] of graph) {
      const name = repoPath(path);
      if (name === 'bench/lab/ret010/load-dev.ts') continue;
      expect(GENERIC_LOADER_GRAPH).toContain(name);
      expect(source).not.toMatch(/from ['"].*(?:datasets[\\/]g2|load-suite)/i);
    }
  });

  it('pins exact closed development and qualification policy schemas', async () => {
    const dev = JSON.parse(await readFile(DEV_POLICY, 'utf8')) as JsonObject;
    const holdout = JSON.parse(await readFile(HOLDOUT_POLICY, 'utf8')) as JsonObject;
    for (const policy of [dev, holdout]) {
      expect(keys(policy)).toEqual([
        'candidateAdapterId', 'controlAdapterId', 'dataset', 'efficiency', 'lanes',
        'pairedVectorOrder', 'safety', 'schemaVersion', 'withinLaneSortKeys',
      ]);
      expect(policy.schemaVersion).toBe(1);
      expect(policy.controlAdapterId).toBe('memberry-retrieval-core-disabled-v1');
      expect(policy.candidateAdapterId).toBe('memberry-retrieval-core-served-v1');
      expect(keys(policy.dataset)).toEqual(['id', 'split']);
      expect(keys(policy.lanes)).toEqual(['precision', 'recall']);
      expect(keys(policy.lanes.recall)).toEqual(['dimension', 'k', 'minimumDelta', 'probes']);
      expect(keys(policy.lanes.precision)).toEqual(['dimension', 'k', 'minimumDelta', 'probes']);
      expect(policy.lanes.recall).toMatchObject({ dimension: 'recall', probes: 10, k: 10 });
      expect(policy.lanes.precision).toMatchObject({ dimension: 'precision', probes: 10, k: 5 });
      expect(keys(policy.safety)).toEqual([
        'maxDuplicateRate', 'maxIsolationLeakRate', 'maxStaleLeakRate', 'maxUnknownResultRate',
      ]);
      expect(Object.values(policy.safety)).toEqual([0, 0, 0, 0]);
      expect(policy.pairedVectorOrder).toEqual(['recall', 'precision']);
      expect(policy.withinLaneSortKeys).toEqual(['scenarioId', 'probeId']);
      expect(policy.efficiency).toMatchObject({
        outcome: 'measured', method: 'paired-bootstrap', confidenceLevel: 0.95,
        minimumOneSided95LowerBound: 0, resamples: 2000,
        minimumPairedProbes: 10, seedRule: 'vector-derived',
      });
    }
    expect(dev.dataset).toEqual({ id: DATASET_ID, split: 'dev' });
    expect(dev.lanes.recall.minimumDelta).toBe(0);
    expect(dev.lanes.precision.minimumDelta).toBe(0.05);
    expect(keys(dev.efficiency)).toEqual([
      'confidenceLevel', 'method', 'minimumOneSided95LowerBound', 'minimumPairedProbes',
      'minimumPointDeltaExclusive', 'outcome', 'resamples', 'seedRule',
    ]);
    expect(dev.efficiency.minimumPointDeltaExclusive).toBe(0);
    expect(holdout.dataset).toEqual({ id: 'memberry-g2-holdout-holdout', split: 'holdout' });
    expect(holdout.lanes.recall.minimumDelta).toBe(0);
    expect(holdout.lanes.precision.minimumDelta).toBe(0);
    expect(keys(holdout.efficiency)).toEqual([
      'confidenceLevel', 'method', 'minimumOneSided95LowerBound', 'minimumPairedProbes',
      'minimumPointDeltaInclusive', 'outcome', 'resamples', 'seedRule',
    ]);
    expect(holdout.efficiency.minimumPointDeltaInclusive).toBe(0);
  });

  it('keeps ordinary G2 calls disabled and the manual qualification workflow unbound', async () => {
    const ordinaryWorkflow = await readFile(resolve(REPO_ROOT, '.github/workflows/ci.yml'), 'utf8');
    const ordinaryGate = await readFile(resolve(REPO_ROOT, 'bench/lab/baselines/ci-gate.ts'), 'utf8');
    expect(ordinaryWorkflow).not.toContain('ret010-holdout-qualification');
    expect(ordinaryWorkflow).not.toContain('bench/lab/ret010/holdout-gate.mts');
    const gateSource = ts.createSourceFile('ci-gate.ts', ordinaryGate, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
    const holdoutCalls: ts.ObjectLiteralExpression[] = [];
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node)
        && ts.isIdentifier(node.expression)
        && node.expression.text === 'compareRegisteredAdapters'
        && node.arguments[0]
        && ts.isObjectLiteralExpression(node.arguments[0])
        && node.arguments[0].getText(gateSource).includes('holdout')) {
        holdoutCalls.push(node.arguments[0]);
      }
      ts.forEachChild(node, visit);
    };
    visit(gateSource);
    expect(holdoutCalls).toHaveLength(2);
    for (const call of holdoutCalls) {
      expect(call.getText(gateSource)).toContain("candidateId: 'memberry-retrieval-core-v1'");
      expect(call.getText(gateSource)).toContain("splits: ['holdout']");
      expect(call.getText(gateSource)).not.toContain('memberry-retrieval-core-served-v1');
    }
    const registry = JSON.parse(await readFile(REGISTRY, 'utf8')) as JsonObject;
    const owned = registry.datasets.filter((entry: JsonObject) => entry.id === DATASET_ID || entry.suite === 'ret010-development');
    expect(owned).toHaveLength(1);
    expect(owned[0].artifacts.map((artifact: JsonObject) => artifact.repositoryPath)).toEqual([
      'bench/lab/datasets/ret010/v1/dev/input.jsonl',
      'bench/lab/datasets/ret010/v1/dev/oracle.jsonl',
    ]);
  });

});
