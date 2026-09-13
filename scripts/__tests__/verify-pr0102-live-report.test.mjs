import assert from 'node:assert/strict';
import { test } from 'node:test';
import { requiredFiles, verifyLiveReport } from '../verify-pr0102-live-report.mjs';
import { requiredFiles as generationFiles, verifyPR03LiveReport } from '../verify-pr03-live-report.mjs';

function passingReport() {
  return {
    success: true,
    numFailedTests: 0,
    numPendingTests: 0,
    numTodoTests: 0,
    testResults: requiredFiles.map((file) => ({
      name: `/repo/packages/neo4j/src/__tests__/${file}`,
      status: 'passed',
      assertionResults: [{ status: 'passed', fullName: 'live fixture' }],
    })),
  };
}

test('accepts every required live file with passing assertions', () => {
  verifyLiveReport(passingReport());
});

test('requires the distinct PR-03 live file set and rejects empty or skipped generation proof', () => {
  const report = passingReport();
  report.testResults = generationFiles.map(file => ({ name: `/repo/src/__tests__/${file}`, status: 'passed',
    assertionResults: [{ status: 'passed', fullName: 'generation fixture' }] }));
  verifyPR03LiveReport(report);
  assert.throws(() => verifyLiveReport(report));
  report.testResults[0].assertionResults[0].status = 'pending';
  assert.throws(() => verifyPR03LiveReport(report));
  report.testResults[0].assertionResults = [];
  assert.throws(() => verifyPR03LiveReport(report));
});

test('rejects missing and duplicated live files', () => {
  const missing = passingReport();
  missing.testResults.pop();
  assert.throws(() => verifyLiveReport(missing));
  const duplicate = passingReport();
  duplicate.testResults[2] = duplicate.testResults[0];
  assert.throws(() => verifyLiveReport(duplicate));
});

test('rejects skipped and empty suites even when the process succeeds', () => {
  const skipped = passingReport();
  skipped.testResults[0].assertionResults[0].status = 'pending';
  assert.throws(() => verifyLiveReport(skipped));
  const empty = passingReport();
  empty.testResults[0].assertionResults = [];
  assert.throws(() => verifyLiveReport(empty));
});

test('rejects failed hooks, failed tests and incomplete aggregate results', () => {
  for (const [field, value] of [
    ['success', false],
    ['numFailedTests', 1],
    ['numPendingTests', 1],
    ['numTodoTests', 1],
  ]) {
    assert.throws(() => verifyLiveReport({ ...passingReport(), [field]: value }));
  }
  const hookFailure = passingReport();
  hookFailure.testResults[0].status = 'failed';
  assert.throws(() => verifyLiveReport(hookFailure));
});
