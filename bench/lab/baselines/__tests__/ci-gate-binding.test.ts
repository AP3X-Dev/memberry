import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(import.meta.dirname, '..', '..', '..', '..');
const CI_GATE = resolve(REPO_ROOT, 'bench/lab/baselines/ci-gate.ts');
const REGISTRY_VALIDATOR = resolve(REPO_ROOT, 'bench/lab/registry/validate.ts');
const DATASET_HASHER = resolve(REPO_ROOT, 'bench/lab/datasets/hash.ts');

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

function variableObject(sourceFile: ts.SourceFile, variableName: string): ts.ObjectLiteralExpression {
  let found: ts.ObjectLiteralExpression | undefined;
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node)
      && ts.isIdentifier(node.name)
      && node.name.text === variableName
      && node.initializer
      && ts.isObjectLiteralExpression(node.initializer)) found = node.initializer;
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  if (!found) throw new Error(`missing ${variableName} object literal`);
  return found;
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
  it('keeps required CI artifact custody integrity-only and the RET-007 ordinary gate dev-only', async () => {
    const [gateSource, validatorSource, hasherSource] = await Promise.all([
      readFile(CI_GATE, 'utf8'),
      readFile(REGISTRY_VALIDATOR, 'utf8'),
      readFile(DATASET_HASHER, 'utf8'),
    ]);
    const gateFile = ts.createSourceFile(CI_GATE, gateSource, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
    const registryCalls = callsNamed(gateFile, 'validateRegistries');
    expect(registryCalls).toHaveLength(1);
    expect(registryCalls[0]!.arguments).toHaveLength(1);
    expect(registryCalls[0]!.arguments[0]!.getText(gateFile))
      .toBe("resolve(REPO_ROOT, 'bench', 'lab', 'registry')");

    const ret007Calls = callsNamed(gateFile, 'runRet007MultiHopDevGateClosed');
    expect(ret007Calls).toHaveLength(1);
    const ret007Options = callObject(ret007Calls[0]!);
    expect(ret007Options.properties.map((property) => property.name?.getText(gateFile))).toEqual([
      'runId', 'repoRoot', 'policy',
    ]);
    expect(gateSource).toContain("import { runRet007MultiHopDevGateClosed } from '../multihop/gate.js';");
    expect(gateSource).not.toContain('runRet007MultiHopDevGate(');
    expect(gateSource).not.toContain('runRet007MultiHopHoldoutGate');

    const deterministicGate = gateFile.statements.find((statement): statement is ts.FunctionDeclaration => (
      ts.isFunctionDeclaration(statement) && statement.name?.text === 'runDeterministicCiGate'
    ));
    if (!deterministicGate?.body) throw new Error('missing runDeterministicCiGate body');
    const ret007Call = ret007Calls[0]!;
    const ret007Statement = deterministicGate.body.statements.find((statement) => (
      statement.getStart(gateFile) <= ret007Call.getStart(gateFile)
      && statement.getEnd() >= ret007Call.getEnd()
    ));
    let aggregateLog: ts.CallExpression | undefined;
    const findAggregateLog = (node: ts.Node): void => {
      if (ts.isCallExpression(node)
        && ts.isPropertyAccessExpression(node.expression)
        && ts.isIdentifier(node.expression.expression)
        && node.expression.expression.text === 'console'
        && node.expression.name.text === 'log'
        && node.arguments.length === 1) {
        const argument = node.arguments[0]!;
        if (ts.isCallExpression(argument)
          && ts.isPropertyAccessExpression(argument.expression)
          && ts.isIdentifier(argument.expression.expression)
          && argument.expression.expression.text === 'JSON'
          && argument.expression.name.text === 'stringify'
          && argument.arguments.length === 1
          && argument.arguments[0]!.getText(gateFile) === 'ret007DevAggregate') aggregateLog = node;
      }
      ts.forEachChild(node, findAggregateLog);
    };
    findAggregateLog(gateFile);
    expect(aggregateLog).toBeDefined();
    const aggregateLogStatement = deterministicGate.body.statements.find((statement) => (
      statement.getStart(gateFile) <= aggregateLog!.getStart(gateFile)
      && statement.getEnd() >= aggregateLog!.getEnd()
    ));
    const explicitReject = deterministicGate.body.statements.find((statement) => (
      ts.isIfStatement(statement)
      && statement.expression.getText(gateFile) === "ret007Dev.outcome !== 'passed'"
    ));
    expect(ret007Statement).toBeDefined();
    expect(aggregateLogStatement).toBeDefined();
    expect(explicitReject).toBeDefined();
    expect(ret007Statement!.getStart(gateFile)).toBeLessThan(aggregateLogStatement!.getStart(gateFile));
    expect(aggregateLogStatement!.getStart(gateFile)).toBeLessThan(explicitReject!.getStart(gateFile));
    expect(aggregateLogStatement!.getText(gateFile)).toBe('console.log(JSON.stringify(ret007DevAggregate));');
    expect(explicitReject!.getText(gateFile)).toBe(`if (ret007Dev.outcome !== 'passed') {
    throw new Error(\`ret007-dev:\${ret007Dev.failureCodes.join(',')}\`);
  }`);

    const aggregate = variableObject(gateFile, 'ret007DevAggregate');
    expect(aggregate.properties.map((property) => property.name?.getText(gateFile))).toEqual([
      'outcome', 'failureCodes', 'split', 'metric', 'n', 'controlAdapterId', 'candidateAdapterId',
      'controlSuccessRate', 'candidateSuccessRate', 'delta', 'interval',
    ]);
    expect(aggregate.properties.every(ts.isPropertyAssignment)).toBe(true);
    for (const property of aggregate.properties.slice(0, -1)) {
      if (!ts.isPropertyAssignment(property)) throw new Error('aggregate field must be explicit');
      expect(property.initializer.getText(gateFile)).toBe(`ret007Dev.${property.name.getText(gateFile)}`);
    }
    const intervalProperty = namedProperty(aggregate, 'interval');
    if (!ts.isObjectLiteralExpression(intervalProperty.initializer)) throw new Error('interval must be explicit');
    expect(intervalProperty.initializer.properties.map((property) => property.name?.getText(gateFile))).toEqual([
      'outcome', 'pairedProbes', 'resamples', 'level', 'point', 'lower', 'upper', 'oneSidedLower',
    ]);
    expect(intervalProperty.initializer.properties.every((property) => (
      ts.isPropertyAssignment(property)
      && property.initializer.getText(gateFile) === `ret007Dev.interval.${property.name.getText(gateFile)}`
    ))).toBe(true);

    const validatorFile = ts.createSourceFile(
      REGISTRY_VALIDATOR, validatorSource, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS,
    );
    const requiredArtifactLoop = (() => {
      let found: ts.ForOfStatement | undefined;
      const visit = (node: ts.Node): void => {
        if (ts.isForOfStatement(node)
          && node.expression.getText(validatorFile).includes('entry.requiredInCi === true')
          && node.statement.getText(validatorFile).includes('sha256File(')) found = node;
        ts.forEachChild(node, visit);
      };
      visit(validatorFile);
      return found;
    })();
    expect(requiredArtifactLoop).toBeDefined();
    const custodyLoop = requiredArtifactLoop!.getText(validatorFile);
    expect(custodyLoop).toContain("sha256File(path, artifact.hashMode as 'bytes' | 'text-lf')");
    expect(custodyLoop).not.toMatch(/JSON\.parse|readFile|split\(|scenario|record|oracleAccess|console\./);

    const hasherFile = ts.createSourceFile(
      DATASET_HASHER, hasherSource, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS,
    );
    const sha256File = hasherFile.statements.find((statement): statement is ts.FunctionDeclaration => (
      ts.isFunctionDeclaration(statement) && statement.name?.text === 'sha256File'
    ));
    expect(sha256File?.body?.getText(hasherFile).replace(/\r\n/g, '\n')).toBe(`{
  const content = await readFile(path);
  return { sha256: sha256(content, mode), sizeBytes: normalizeForHash(content, mode).byteLength };
}`);
    expect(hasherSource).not.toMatch(/JSON\.parse|split\(|scenario|record|console\./);
  });

  it('pins exactly the two G2 holdout lanes to production retrieval', async () => {
    const source = await readFile(CI_GATE, 'utf8');
    const sourceFile = ts.createSourceFile(CI_GATE, source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
    const comparisonCalls = callsNamed(sourceFile, 'compareRegisteredAdapters');
    expect(comparisonCalls).toHaveLength(7);
    const bindings = new Map(comparisonCalls.map((call) => {
      const object = callObject(call);
      return [comparisonRunId(object), stringProperty(object, 'candidateId')] as const;
    }));
    expect(bindings.size).toBe(7);

    expect(Object.fromEntries(bindings)).toEqual({
      golden: 'memberry-proxy-v1',
      protected: 'memberry-proxy-v1',
      retrieval: 'memberry-proxy-v1',
      'holdout-recall': 'memberry-retrieval-core-v1',
      'holdout-precision': 'memberry-retrieval-core-v1',
      'ret007-holdout-recall': 'memberry-retrieval-core-query-decomposition-v1',
      'ret007-holdout-precision': 'memberry-retrieval-core-query-decomposition-v1',
    });
  });

  it('keeps existing G2 bindings byte-stable and adds separate production-core regression lanes', async () => {
    const source = await readFile(CI_GATE, 'utf8');
    expect(source).toMatch(/controlId: 'scope-aware-bm25-control-v1',[\s\S]*?candidateId: 'memberry-retrieval-core-v1',[\s\S]*?scenarios: holdoutRecallScenarios/);
    expect(source).toMatch(/controlId: 'scope-aware-bm25-control-v1',[\s\S]*?candidateId: 'memberry-retrieval-core-v1',[\s\S]*?scenarios: holdoutPrecisionScenarios/);
    expect(source).toMatch(/controlId: 'memberry-retrieval-core-v1',[\s\S]*?candidateId: 'memberry-retrieval-core-query-decomposition-v1',[\s\S]*?scenarios: holdoutRecallScenarios/);
    expect(source).toMatch(/controlId: 'memberry-retrieval-core-v1',[\s\S]*?candidateId: 'memberry-retrieval-core-query-decomposition-v1',[\s\S]*?scenarios: holdoutPrecisionScenarios/);
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

  it('pairs each RET-007 regression manifest and artifact with its own comparison', async () => {
    const source = await readFile(CI_GATE, 'utf8');
    const sourceFile = ts.createSourceFile(CI_GATE, source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
    for (const lane of ['Recall', 'Precision'] as const) {
      const comparison = `decomposition${lane}Comparison`;
      const manifest = `decomposition${lane}Manifest`;
      const manifestObject = variableCallObject(sourceFile, manifest, 'createRunManifest');
      expect(namedProperty(manifestObject, 'runId').initializer.getText(sourceFile)).toBe(`${comparison}.runId`);
      expect(namedProperty(manifestObject, 'controlAdapter').initializer.getText(sourceFile))
        .toBe(`${comparison}.control.adapterId`);
      expect(namedProperty(manifestObject, 'candidateAdapter').initializer.getText(sourceFile))
        .toBe(`${comparison}.candidate.adapterId`);
      const writer = callsNamed(sourceFile, 'writeRequiredCiComparisonArtifacts').find((call) => (
        call.arguments[1]?.getText(sourceFile) === comparison
      ));
      expect(writer).toBeDefined();
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
