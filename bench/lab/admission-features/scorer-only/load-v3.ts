import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import {
  parseAdmissionFeatureOracleListV3,
  type AdmissionFeatureFixtureSplitV3,
  type AdmissionFeatureScenarioOracleV3,
} from '../contract-v3.js';

export const ADMISSION_FEATURE_ORACLE_PATHS_V3: Readonly<Record<AdmissionFeatureFixtureSplitV3, string>> = Object.freeze({
  dev: 'bench/lab/admission-features/scorer-only/v3/dev/oracle.jsonl',
  holdout: 'bench/lab/admission-features/scorer-only/v3/holdout/oracle.jsonl',
});

function parseJsonLines(content: string, field: string): unknown[] {
  const lines = content.replace(/\r\n?/g, '\n').split('\n').filter((line) => line.length > 0);
  try { return lines.map((line) => JSON.parse(line) as unknown); }
  catch { throw new Error(`admission_feature_oracle_v3:invalid_json:${field}`); }
}

/**
 * Scorer-only oracle loader. The holdout oracle is sealed custodian material
 * and only exists inside the one-shot scoring custody, so the dev gate loads
 * ['dev'] alone. Oracles are opened by scorer code only (lab boundary).
 */
export async function loadAdmissionFeatureOraclesV3(
  splits: readonly AdmissionFeatureFixtureSplitV3[] = ['dev'],
  repoRoot = process.cwd(),
): Promise<readonly AdmissionFeatureScenarioOracleV3[]> {
  const paths = splits.map((split) => ADMISSION_FEATURE_ORACLE_PATHS_V3[split]);
  const contents = await Promise.all(paths.map((path) => readFile(resolve(repoRoot, path), 'utf8')));
  return parseAdmissionFeatureOracleListV3(
    contents.flatMap((content, index) => parseJsonLines(content, paths[index]!)),
  );
}
