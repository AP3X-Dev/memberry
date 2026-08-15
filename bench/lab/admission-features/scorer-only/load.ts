import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import {
  parseAdmissionFeatureOracleListV1,
  type AdmissionFeatureScenarioOracleV1,
} from '../contract.js';

const ORACLE_PATHS = [
  'bench/lab/admission-features/scorer-only/v1/dev/oracle.jsonl',
  'bench/lab/admission-features/scorer-only/v1/holdout/oracle.jsonl',
] as const;
let oracleOpenAttempts = 0;

export function admissionFeatureOracleOpenAttemptsForTest(): number {
  return oracleOpenAttempts;
}

export function resetAdmissionFeatureOracleOpenAttemptsForTest(): void {
  oracleOpenAttempts = 0;
}

function parseJsonLines(content: string, field: string): unknown[] {
  const lines = content.replace(/\r\n?/g, '\n').split('\n').filter((line) => line.length > 0);
  try { return lines.map((line) => JSON.parse(line) as unknown); }
  catch { throw new Error(`admission_feature_oracle:invalid_json:${field}`); }
}

export async function loadAdmissionFeatureOracles(repoRoot = process.cwd()): Promise<readonly AdmissionFeatureScenarioOracleV1[]> {
  oracleOpenAttempts += 1;
  const contents = await Promise.all(ORACLE_PATHS.map((path) => readFile(resolve(repoRoot, path), 'utf8')));
  const oracles = parseAdmissionFeatureOracleListV1(contents.flatMap((content, index) => parseJsonLines(content, ORACLE_PATHS[index]!)));
  const dev = oracles.filter(({ split }) => split === 'dev').length;
  const holdout = oracles.filter(({ split }) => split === 'holdout').length;
  if (dev !== 3 || holdout !== 3) throw new Error('admission_feature_oracle:split_count_mismatch');
  return oracles;
}

export const ADMISSION_FEATURE_ORACLE_PATHS = ORACLE_PATHS;
