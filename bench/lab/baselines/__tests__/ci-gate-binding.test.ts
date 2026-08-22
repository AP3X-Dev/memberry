import { cp, lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import { finalizeFailureBoundaryForTest } from '../../ret010/dev-gate.js';

const REPO_ROOT = resolve(import.meta.dirname, '..', '..', '..', '..');
const CI_GATE = resolve(REPO_ROOT, 'bench/lab/baselines/ci-gate.ts');

interface ParsedStep {
  fields: Record<string, string>;
  nested: Record<string, Record<string, string>>;
}

function parseUnitSteps(workflow: string): ParsedStep[] {
  const unit = workflow.slice(workflow.indexOf('\n  unit:'), workflow.indexOf('\n  integration:'));
  const lines = unit.split(/\r?\n/);
  const steps: ParsedStep[] = [];
  let current: ParsedStep | undefined;
  let nestedKey: string | undefined;
  let blockKey: string | undefined;
  for (const line of lines) {
    const start = /^      - (\S[^:]*):(?:\s*(.*))?$/.exec(line);
    if (start) {
      current = { fields: {}, nested: {} }; steps.push(current); nestedKey = undefined; blockKey = undefined;
      current.fields[start[1]!] = start[2] ?? '';
      continue;
    }
    if (!current) continue;
    if (blockKey && /^          /.test(line)) {
      current.fields[blockKey] += `${current.fields[blockKey] ? '\n' : ''}${line.slice(10)}`;
      continue;
    }
    const field = /^        ([A-Za-z0-9_-]+):(?:\s*(.*))?$/.exec(line);
    if (field) {
      const key = field[1]!; const value = field[2] ?? '';
      if (Object.hasOwn(current.fields, key)) throw new Error(`duplicate step key ${key}`);
      current.fields[key] = value === '|' ? '' : value;
      nestedKey = value === '' ? key : undefined;
      blockKey = value === '|' ? key : undefined;
      if (nestedKey) current.nested[nestedKey] = {};
      continue;
    }
    const nested = /^          ([A-Za-z0-9_-]+):(?:\s*(.*))?$/.exec(line);
    if (nested && nestedKey) {
      const key = nested[1]!;
      if (Object.hasOwn(current.nested[nestedKey]!, key)) throw new Error(`duplicate nested key ${key}`);
      current.nested[nestedKey]![key] = nested[2] ?? '';
    }
  }
  return steps;
}

function namedProperty(object: ts.ObjectLiteralExpression, name: string): ts.PropertyAssignment {
  const property = object.properties.find((candidate): candidate is ts.PropertyAssignment => {
    if (!ts.isPropertyAssignment(candidate)) return false;
    return (ts.isIdentifier(candidate.name) || ts.isStringLiteral(candidate.name))
      && candidate.name.text === name;
  });
  if (!property) throw new Error(`missing ${name} property`);
  return property;
}

function callsNamed(sourceFile: ts.SourceFile, name: string): ts.CallExpression[] {
  const calls: ts.CallExpression[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === name) {
      calls.push(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return calls;
}

function callObject(call: ts.CallExpression): ts.ObjectLiteralExpression {
  const argument = call.arguments[0];
  if (!argument || !ts.isObjectLiteralExpression(argument)) throw new Error('expected object-literal call argument');
  return argument;
}

function comparisonRunId(object: ts.ObjectLiteralExpression): string {
  const initializer = namedProperty(object, 'runId').initializer;
  if (!ts.isTemplateExpression(initializer)
    || initializer.templateSpans.length !== 1
    || !ts.isIdentifier(initializer.templateSpans[0]!.expression)
    || initializer.templateSpans[0]!.expression.text !== 'runId') {
    throw new Error('comparison runId must be a single suffix on the gate runId');
  }
  return initializer.templateSpans[0]!.literal.text.replace(/^-/, '');
}

function stringProperty(object: ts.ObjectLiteralExpression, name: string): string {
  const initializer = namedProperty(object, name).initializer;
  if (!ts.isStringLiteral(initializer)) throw new Error(`${name} must be a string literal`);
  return initializer.text;
}

function variableCallObject(
  sourceFile: ts.SourceFile,
  variableName: string,
  callName: string,
): ts.ObjectLiteralExpression {
  for (const statement of sourceFile.statements) {
    if (!ts.isFunctionDeclaration(statement) || !statement.body) continue;
    let found: ts.ObjectLiteralExpression | undefined;
    const visit = (node: ts.Node): void => {
      if (ts.isVariableDeclaration(node)
        && ts.isIdentifier(node.name)
        && node.name.text === variableName
        && node.initializer) {
        const initializer = ts.isAwaitExpression(node.initializer) ? node.initializer.expression : node.initializer;
        if (ts.isCallExpression(initializer)
          && ts.isIdentifier(initializer.expression)
          && initializer.expression.text === callName) {
          found = callObject(initializer);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(statement.body);
    if (found) return found;
  }
  throw new Error(`missing ${variableName} = ${callName}(...)`);
}

function aggregateHoldoutLogArguments(sourceFile: ts.SourceFile): ts.Expression[] {
  const argumentsFound: ts.Expression[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)
      && ts.isPropertyAccessExpression(node.expression)
      && ts.isIdentifier(node.expression.expression)
      && node.expression.expression.text === 'console'
      && node.expression.name.text === 'log'
      && node.arguments.length === 1
      && node.arguments[0]!.getText(sourceFile).includes('G2 holdout aggregate lane=')) {
      argumentsFound.push(node.arguments[0]!);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return argumentsFound;
}

describe('LAB-011 G2 production binding', () => {
  it('pins exactly the two G2 holdout lanes to production retrieval', async () => {
    const source = await readFile(CI_GATE, 'utf8');
    const sourceFile = ts.createSourceFile(CI_GATE, source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
    const comparisonCalls = callsNamed(sourceFile, 'compareRegisteredAdapters');
    expect(comparisonCalls).toHaveLength(5);
    const bindings = new Map(comparisonCalls.map((call) => {
      const object = callObject(call);
      return [comparisonRunId(object), stringProperty(object, 'candidateId')] as const;
    }));
    expect(bindings.size).toBe(5);

    expect(Object.fromEntries(bindings)).toEqual({
      golden: 'memberry-proxy-v1',
      protected: 'memberry-proxy-v1',
      retrieval: 'memberry-proxy-v1',
      'holdout-recall': 'memberry-retrieval-core-v1',
      'holdout-precision': 'memberry-retrieval-core-v1',
    });
  });

  it('keeps each G2 manifest and artifact writer paired to its own comparison', async () => {
    const source = await readFile(CI_GATE, 'utf8');
    const sourceFile = ts.createSourceFile(CI_GATE, source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);

    for (const lane of ['Recall', 'Precision'] as const) {
      const comparison = `holdout${lane}Comparison`;
      const manifest = `holdout${lane}Manifest`;
      const manifestObject = variableCallObject(sourceFile, manifest, 'createRunManifest');
      expect(namedProperty(manifestObject, 'runId').initializer.getText(sourceFile)).toBe(`${comparison}.runId`);
      expect(namedProperty(manifestObject, 'candidateAdapter').initializer.getText(sourceFile))
        .toBe(`${comparison}.candidate.adapterId`);

      const writer = callsNamed(sourceFile, 'writeRequiredCiComparisonArtifacts').find((call) => (
        call.arguments[1]?.getText(sourceFile) === comparison
      ));
      expect(writer, `${lane.toLowerCase()} artifact writer`).toBeDefined();
      expect(writer!.arguments[2]?.getText(sourceFile)).toBe(manifest);
    }
  });

  it('prints only the exact aggregate metric and adapter identity for each G2 lane', async () => {
    const source = await readFile(CI_GATE, 'utf8');
    const sourceFile = ts.createSourceFile(CI_GATE, source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
    const logArguments = aggregateHoldoutLogArguments(sourceFile);
    const logs = logArguments.map((argument) => argument.getText(sourceFile));

    expect(logs).toEqual([
      '`G2 holdout aggregate lane=g2-holdout-recall controlAdapterId=${holdoutRecallComparison.control.adapterId} controlRecallAtK=${holdoutRecallComparison.control.metrics.recallAtK} candidateAdapterId=${holdoutRecallComparison.candidate.adapterId} candidateRecallAtK=${holdoutRecallComparison.candidate.metrics.recallAtK}`',
      '`G2 holdout aggregate lane=g2-holdout-precision controlAdapterId=${holdoutPrecisionComparison.control.adapterId} controlPrecisionAtK=${holdoutPrecisionComparison.control.metrics.precisionAtK} candidateAdapterId=${holdoutPrecisionComparison.candidate.adapterId} candidatePrecisionAtK=${holdoutPrecisionComparison.candidate.metrics.precisionAtK}`',
    ]);
    for (const log of logs) {
      expect(log).not.toMatch(/scenarioReports|probes|probeId|query|resultIds|oracle|label|relevant|required|stale|forbidden/i);
    }

    const gate = sourceFile.statements.find((statement): statement is ts.FunctionDeclaration => (
      ts.isFunctionDeclaration(statement) && statement.name?.text === 'runDeterministicCiGate'
    ));
    if (!gate?.body) throw new Error('missing runDeterministicCiGate body');
    for (const [index, comparison] of ['holdoutRecallComparison', 'holdoutPrecisionComparison'].entries()) {
      const failureIndex = gate.body.statements.findIndex((statement) => (
        ts.isIfStatement(statement)
        && statement.expression.getText(sourceFile) === `!${comparison}.passed`
      ));
      const argument = logArguments[index]!;
      const logIndex = gate.body.statements.findIndex((statement) => (
        statement.getStart(sourceFile) <= argument.getStart(sourceFile)
        && statement.getEnd() >= argument.getEnd()
      ));
      expect(failureIndex).toBeGreaterThanOrEqual(0);
      expect(logIndex).toBe(failureIndex + 1);
    }
  });
});

describe('RET-010E terminal development custody binding', () => {
  it('launches the isolated development gate only after every existing comparison and artifact', async () => {
    const source = await readFile(CI_GATE, 'utf8');
    const launch = source.indexOf("resolve(REPO_ROOT, 'bench', 'lab', 'ret010', 'dev-gate.ts'), 'run'");
    expect(launch).toBeGreaterThan(source.lastIndexOf('writeRequiredCiComparisonArtifacts'));
    expect(launch).toBeGreaterThan(source.lastIndexOf('Evaluation-lab deterministic gate passed'));
    expect(source.slice(launch)).not.toContain('compareRegisteredAdapters');
    expect(source.slice(launch)).not.toContain('loadG2HoldoutScenariosForScoring');
    expect(source).toContain("if (development.status !== 0) process.exit(development.status ?? 1)");
  });

  it('keeps both ordinary G2 lanes bound to the disabled legacy production path', async () => {
    const source = await readFile(CI_GATE, 'utf8');
    const sourceFile = ts.createSourceFile(CI_GATE, source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
    const calls = callsNamed(sourceFile, 'compareRegisteredAdapters').map(callObject);
    const holdout = calls.filter((object) => object.getText(sourceFile).includes("splits: ['holdout']"));
    expect(holdout).toHaveLength(2);
    for (const object of holdout) {
      expect(stringProperty(object, 'candidateId')).toBe('memberry-retrieval-core-v1');
      expect(object.getText(sourceFile)).not.toContain('memberry-retrieval-core-served-v1');
    }
  });

  it('binds the finalizer and pinned terminal upload to each exact matrix run', async () => {
    const workflow = await readFile(resolve(REPO_ROOT, '.github/workflows/ci.yml'), 'utf8');
    const steps = parseUnitSteps(workflow);
    const gateIndex = steps.findIndex((step) => step.fields.id === 'ret010_development_gate');
    const finalizerIndex = steps.findIndex((step) => step.fields.name === 'Finalize RET-010 development custody');
    const uploadIndex = steps.findIndex((step) => step.fields.name === 'Upload RET-010 development custody');
    expect([gateIndex, finalizerIndex, uploadIndex]).toEqual([steps.length - 3, steps.length - 2, steps.length - 1]);
    const gate = steps[gateIndex]!; const finalizer = steps[finalizerIndex]!; const upload = steps[uploadIndex]!;
    expect(workflow.match(/^        id: ret010_development_gate$/gm)).toHaveLength(1);
    expect(workflow.match(/^        id: ret010_finalize$/gm)).toHaveLength(1);
    expect(Object.keys(gate.fields)).toEqual(['name', 'id', 'run', 'env']);
    expect(gate.fields.run).toBe('npm run bench:lab:ci');
    expect(Object.keys(finalizer.fields)).toEqual(['name', 'id', 'if', 'shell', 'run']);
    expect(finalizer.fields.id).toBe('ret010_finalize');
    expect(finalizer.fields.if).toBe('always()');
    expect(finalizer.fields.shell).toBe('bash');
    expect(finalizer.fields).not.toHaveProperty('continue-on-error');
    expect(finalizer.fields.run.split('\n')).toEqual([
      'set -euo pipefail',
      "outcome='${{ steps.ret010_development_gate.outcome }}'",
      'if [[ "$outcome" == \'success\' ]]; then',
      '  node --import tsx bench/lab/ret010/dev-gate.ts finalize success',
      'else',
      '  node --import tsx bench/lab/ret010/dev-gate.ts finalize failure',
      'fi',
    ]);
    expect(Object.keys(upload.fields)).toEqual(['name', 'if', 'uses', 'with']);
    expect(upload.fields.if).toBe("always() && steps.ret010_finalize.outcome == 'success'");
    expect(upload.fields.uses).toBe('actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02');
    expect(upload.fields).not.toHaveProperty('continue-on-error');
    expect(upload.nested.with).toEqual({
      name: 'memberry-ret010-development-node-${{ matrix.node-version }}-${{ github.run_id }}-${{ github.run_attempt }}',
      path: 'node_modules/.cache/memberry-lab/runs/ret010-development/',
      'if-no-files-found': 'error',
      'include-hidden-files': 'true',
      'retention-days': '14',
    });
    expect(Object.keys(upload.nested.with!)).toHaveLength(5);
  });

  it('rejects duplicate finalizer IDs and duplicate or additional upload paths in parsed YAML', async () => {
    const workflow = await readFile(resolve(REPO_ROOT, '.github/workflows/ci.yml'), 'utf8');
    const duplicateId = workflow.replace('        id: ret010_finalize', '        id: ret010_finalize\n        id: forged_finalize');
    expect(() => parseUnitSteps(duplicateId)).toThrow('duplicate step key id');
    const duplicatePath = workflow.replace(
      '          path: node_modules/.cache/memberry-lab/runs/ret010-development/',
      '          path: node_modules/.cache/memberry-lab/runs/ret010-development/\n          path: node_modules/.cache/memberry-lab/runs/forged/',
    );
    expect(() => parseUnitSteps(duplicatePath)).toThrow('duplicate nested key path');
    const additionalPathKey = workflow.replace(
      '          path: node_modules/.cache/memberry-lab/runs/ret010-development/',
      '          path: node_modules/.cache/memberry-lab/runs/ret010-development/\n          artifact-path: node_modules/.cache/memberry-lab/runs/forged/',
    );
    const upload = parseUnitSteps(additionalPathKey).find((step) => step.fields.name === 'Upload RET-010 development custody')!;
    expect(Object.keys(upload.nested.with!)).not.toEqual(['name', 'path', 'if-no-files-found', 'include-hidden-files', 'retention-days']);
  });

  it('maps gate failure plus finalizer custody outcomes to the exact artifact sink', async () => {
    const finalizerArgument = (outcome: 'success' | 'failure' | 'cancelled' | 'skipped') => (
      outcome === 'success' ? 'success' : 'failure'
    );
    expect(finalizerArgument('success')).toBe('success');
    for (const outcome of ['failure', 'cancelled', 'skipped'] as const) expect(finalizerArgument(outcome)).toBe('failure');
    const uploadRuns = (finalizerOutcome: 'success' | 'failure' | 'cancelled' | 'skipped') => finalizerOutcome === 'success';
    expect(uploadRuns('success')).toBe(true);
    for (const outcome of ['failure', 'cancelled', 'skipped'] as const) expect(uploadRuns(outcome)).toBe(false);
    const execute = async (failure?: 'public-cleanup' | 'gate-cleanup' | 'finalizer-cleanup' | 'all-cleanup' | 'publication' | 'verification' | 'absence') => {
      const root = await mkdtemp(join(tmpdir(), 'ret010-upload-outcome-'));
      const publicLeaf = join(root, 'public'); const gateStage = join(root, 'gate-stage');
      const finalizerStage = join(root, 'finalizer-stage'); const artifactSink = join(root, 'sink');
      for (const path of [publicLeaf, gateStage, finalizerStage]) { await mkdir(path); await writeFile(join(path, 'STALE'), 'STALE-SUCCESS'); }
      await mkdir(artifactSink);
      const cleanup = async (target: 'public' | 'gate' | 'finalizer', path: string) => {
        if (failure === 'all-cleanup' || failure === `${target}-cleanup`) throw new Error(`${target}-cleanup`);
        await rm(path, { recursive: true, force: true });
      };
      const absent = async (...paths: string[]) => {
        for (const path of paths) {
          try { await lstat(path); throw new Error('not-absent'); }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
        }
      };
      let finalizerOutcome: 'success' | 'failure' = 'success';
      try {
        await finalizeFailureBoundaryForTest({
          cleanupPublic: async () => cleanup('public', publicLeaf), cleanupGateStage: async () => cleanup('gate', gateStage),
          cleanupFinalizerStage: async () => cleanup('finalizer', finalizerStage),
          publishCurrentTombstone: async () => {
            if (failure === 'publication') throw new Error('publication');
            await mkdir(publicLeaf); await writeFile(join(publicLeaf, 'failure-tombstone.json'), 'CURRENT-TOMBSTONE\n');
          },
          verifyCurrentTombstone: async () => {
            if (failure === 'verification') throw new Error('canonical-verification');
            expect(await readFile(join(publicLeaf, 'failure-tombstone.json'), 'utf8')).toBe('CURRENT-TOMBSTONE\n');
          },
          proveAllStagingAbsent: async () => { await absent(gateStage, finalizerStage); if (failure === 'absence') throw new Error('absence'); },
          proveAllAbsent: async () => { await absent(publicLeaf, gateStage, finalizerStage); if (failure === 'absence') throw new Error('absence'); },
        });
      } catch { finalizerOutcome = 'failure'; }
      if (uploadRuns(finalizerOutcome)) await cp(publicLeaf, join(artifactSink, 'ret010-development'), { recursive: true });
      const sinkEntries = await readdir(artifactSink);
      const result = { root, artifactSink, finalizerOutcome, sinkEntries };
      return result;
    };

    const valid = await execute();
    expect(valid.finalizerOutcome).toBe('success'); expect(valid.sinkEntries).toEqual(['ret010-development']);
    expect(await readdir(join(valid.artifactSink, 'ret010-development'))).toEqual(['failure-tombstone.json']);
    expect(await readFile(join(valid.artifactSink, 'ret010-development/failure-tombstone.json'), 'utf8')).toBe('CURRENT-TOMBSTONE\n');
    await rm(valid.root, { recursive: true, force: true });

    for (const failure of ['public-cleanup', 'gate-cleanup', 'finalizer-cleanup', 'all-cleanup', 'publication', 'verification', 'absence'] as const) {
      const failed = await execute(failure);
      expect(failed.finalizerOutcome).toBe('failure'); expect(failed.sinkEntries).toEqual([]);
      await rm(failed.root, { recursive: true, force: true });
    }
  });

  it('joins workflow failure cases to the custody finalizer fail-closed behavior', async () => {
    const source = await readFile(resolve(REPO_ROOT, 'bench/lab/ret010/dev-gate.ts'), 'utf8');
    const finalizer = source.slice(source.indexOf('export async function finalizeCurrentRun'), source.indexOf('async function main'));
    expect(finalizer).toContain('if (!gateSucceeded) {');
    expect(finalizer).toContain("await finalizeCurrentFailure(identity, { failureClass: 'custody', stage: 'artifact' })");
    expect(finalizer).toContain('validateDirectoryChain(OUTPUT_LEAF, false)');
    expect(finalizer).toContain('validateCurrentHeadSuccessBundle(OUTPUT_LEAF, identity)');
    expect(finalizer).toContain('await finalizeCurrentFailure(identity, failureContext(error');
    expect(finalizer).not.toContain('process.stderr.write(SAFE_FAILURE)');
    expect(finalizer).not.toContain('process.exitCode = 1');
    const main = source.slice(source.indexOf('async function main'));
    expect(main).toContain("catch { process.stderr.write(SAFE_FAILURE); process.exitCode = 1; }");
    const publication = source.slice(source.indexOf('async function publishFailure'), source.indexOf('async function runDevelopment'));
    expect(publication).toContain('cleanBoundary()');
    expect(publication).toContain('[FAILURE_FILE]: tombstone(identity, context)');
    // A stale success is removed before the current tombstone; a current success
    // is preserved only after full identity validation. The upload predicate,
    // rather than if-no-files-found, prevents any skipped or failed finalizer
    // from reaching the artifact sink.
    expect(source).toContain("const FINALIZER_STAGING_LEAF = resolve(RUNS_ROOT, 'ret010-development.finalizer-staging')");
    expect(source).toContain('await absentPath(STAGING_LEAF); await absentPath(FINALIZER_STAGING_LEAF);');
    expect(source).toContain('manifest.workflowRunId !== identity.workflowRunId');
    expect(source).toContain('manifest.workflowRunAttempt !== identity.workflowRunAttempt');
    expect(source).toContain("aggregate.modelBlob !== gitBlobAt(identity.gitCommit, 'packages/retrieval/src/served-reranker.ts')");
    expect(source).toContain("aggregate.providerContractBlob !== gitBlobAt(identity.gitCommit, 'packages/retrieval/src/reranker.ts')");
    expect(source).toContain("aggregate.adapterBlob !== gitBlobAt(identity.gitCommit, 'bench/lab/adapters/memberry-retrieval-core.ts')");
    expect(source).toContain('aggregate.datasetDescriptorSha256 !== dataset.descriptorSha256');
    expect(source).toContain('aggregate.inputSha256 !== dataset.inputSha256');
    expect(source).toContain('aggregate.oracleSha256 !== dataset.oracleSha256');
    expect(source).toContain("aggregate.devPolicySha256 !== sha256(gitBytesAt(identity.gitCommit, 'bench/lab/ret010/dev-policy.json'))");
  });
});
