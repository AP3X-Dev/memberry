import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import {
  parseAdmissionFeatureInputListV1,
  type AdmissionFeatureScenarioInputV1,
  type AdmissionFeatureFixtureSplit,
} from './contract.js';

const INPUT_PATHS = [
  'bench/lab/admission-features/fixtures/v2/dev/input.jsonl',
  'bench/lab/admission-features/fixtures/v2/holdout/input.jsonl',
] as const;

function parseJsonLines(content: string, field: string): unknown[] {
  const lines = content.replace(/\r\n?/g, '\n').split('\n').filter((line) => line.length > 0);
  try { return lines.map((line) => JSON.parse(line) as unknown); }
  catch { throw new Error(`admission_feature_fixture:invalid_json:${field}`); }
}

function exactSplits(inputs: readonly AdmissionFeatureScenarioInputV1[]): boolean {
  const counts = new Map<AdmissionFeatureFixtureSplit, number>([['dev', 0], ['holdout', 0]]);
  for (const input of inputs) counts.set(input.split, (counts.get(input.split) ?? 0) + 1);
  return counts.get('dev') === 9 && counts.get('holdout') === 4;
}

export async function loadAdmissionFeatureInputs(repoRoot = process.cwd()): Promise<readonly AdmissionFeatureScenarioInputV1[]> {
  const contents = await Promise.all(INPUT_PATHS.map((path) => readFile(resolve(repoRoot, path), 'utf8')));
  const inputs = parseAdmissionFeatureInputListV1(contents.flatMap((content, index) => parseJsonLines(content, INPUT_PATHS[index]!)));
  if (!exactSplits(inputs)) throw new Error('admission_feature_fixture:split_count_mismatch');
  return inputs;
}

export const ADMISSION_FEATURE_INPUT_PATHS = INPUT_PATHS;
