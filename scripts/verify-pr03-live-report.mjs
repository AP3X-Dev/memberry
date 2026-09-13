import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { verifyLiveReport } from './verify-pr0102-live-report.mjs';

export const requiredFiles = [
  'embedding-generation.live.test.ts',
  'runtime-candidate-channel.generation.live.test.ts',
  'embeddings.live.test.ts',
];

export function verifyPR03LiveReport(report) {
  verifyLiveReport(report, requiredFiles);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  verifyPR03LiveReport(JSON.parse(readFileSync(process.argv[2], 'utf8')));
  console.log('PR-03 live report: all required files executed without skips');
}
