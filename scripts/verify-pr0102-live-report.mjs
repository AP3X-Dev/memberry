import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const requiredFiles = [
  'semantic-eligibility.live.test.ts',
  'semantic.supersession.live.test.ts',
  'knowledge-epoch.live.test.ts',
  'service.delivery.live.test.ts',
  'knowledge-mutation.live.test.ts',
];

// A green process with skipped/undiscovered live tests is not database proof.
export function verifyLiveReport(report, files = requiredFiles) {
  assert.equal(report.success, true, 'live run must succeed');
  assert.equal(report.numFailedTests, 0, 'failed tests are not live proof');
  assert.equal(report.numPendingTests, 0, 'skipped tests are not live proof');
  assert.equal(report.numTodoTests, 0, 'todo tests are not live proof');
  assert.equal(report.testResults.length, files.length, 'exact live file set required');
  for (const file of files) {
    const matches = report.testResults.filter((result) =>
      result.name.replaceAll('\\', '/').endsWith(`/src/__tests__/${file}`),
    );
    assert.equal(matches.length, 1, `missing or duplicate live file: ${file}`);
    const result = matches[0];
    assert.equal(result.status, 'passed', `${file} must pass`);
    assert.ok(result.assertionResults.length > 0, `${file} must execute tests`);
    for (const test of result.assertionResults) {
      assert.equal(test.status, 'passed', `${file}: ${test.fullName} must pass`);
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  verifyLiveReport(JSON.parse(readFileSync(process.argv[2], 'utf8')));
  console.log('PR-01/02 live report: all required files executed without skips');
}
