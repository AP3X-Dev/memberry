import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import {
  parseAdmissionFeatureInputListV3,
  type AdmissionFeatureFixtureSplitV3,
  type AdmissionFeatureScenarioInputV3,
} from './contract-v3.js';

export const ADMISSION_FEATURE_INPUT_PATHS_V3: Readonly<Record<AdmissionFeatureFixtureSplitV3, string>> = Object.freeze({
  dev: 'bench/lab/admission-features/fixtures/v3/dev/input.jsonl',
  holdout: 'bench/lab/admission-features/fixtures/v3/holdout/input.jsonl',
});

const DEV_SCENARIO_COUNT = 14;

function parseJsonLines(content: string, field: string): unknown[] {
  const lines = content.replace(/\r\n?/g, '\n').split('\n').filter((line) => line.length > 0);
  try { return lines.map((line) => JSON.parse(line) as unknown); }
  catch { throw new Error(`admission_feature_fixture_v3:invalid_json:${field}`); }
}

/**
 * Load v3 scenario inputs for the requested splits. The holdout fixture file
 * is authored under scorer/owner custody and only exists once sealed, so the
 * dev gate loads ['dev'] alone.
 */
export async function loadAdmissionFeatureInputsV3(
  splits: readonly AdmissionFeatureFixtureSplitV3[] = ['dev'],
  repoRoot = process.cwd(),
): Promise<readonly AdmissionFeatureScenarioInputV3[]> {
  const paths = splits.map((split) => ADMISSION_FEATURE_INPUT_PATHS_V3[split]);
  const contents = await Promise.all(paths.map((path) => readFile(resolve(repoRoot, path), 'utf8')));
  const inputs = parseAdmissionFeatureInputListV3(
    contents.flatMap((content, index) => parseJsonLines(content, paths[index]!)),
  );
  if (splits.includes('dev')
    && inputs.filter(({ split }) => split === 'dev').length !== DEV_SCENARIO_COUNT) {
    throw new Error('admission_feature_fixture_v3:split_count_mismatch');
  }
  return inputs;
}
