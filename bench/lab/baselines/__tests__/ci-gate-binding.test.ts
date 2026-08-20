import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(import.meta.dirname, '..', '..', '..', '..');
const CI_GATE = resolve(REPO_ROOT, 'bench/lab/baselines/ci-gate.ts');

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
