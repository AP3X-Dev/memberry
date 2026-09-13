import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

export const REQUIRED_RELEASE_GATE_STAGES = Object.freeze([
  'INSTALL',
  'GATE_CONTRACT',
  'FORMAT',
  'LINT',
  'BUILD',
  'GUIDANCE',
  'WORKSPACE',
  'LAB',
  'LAB_TYPECHECK',
  'LAB_VALIDATE',
  'BASELINE',
  'LAB_CI',
  'SOURCE_BINDING',
]);

const RECEIPT = /^([A-Z][A-Z0-9_]*)_EXIT=([0-9]+)$/;

export function parseReleaseGateReceipts(text) {
  const receipts = new Map();
  const errors = [];
  for (const [index, rawLine] of text.split(/\r?\n/).entries()) {
    const line = rawLine.trim();
    if (line.length === 0) continue;
    const match = RECEIPT.exec(line);
    if (!match) {
      errors.push(`line ${index + 1}: malformed receipt`);
      continue;
    }
    const [, stage, rawExit] = match;
    if (receipts.has(stage)) {
      errors.push(`line ${index + 1}: duplicate receipt for ${stage}`);
      continue;
    }
    const exitCode = Number(rawExit);
    if (!Number.isSafeInteger(exitCode) || exitCode > 255) {
      errors.push(`line ${index + 1}: invalid exit code for ${stage}`);
      continue;
    }
    receipts.set(stage, exitCode);
  }

  const required = new Set(REQUIRED_RELEASE_GATE_STAGES);
  for (const stage of REQUIRED_RELEASE_GATE_STAGES) {
    if (!receipts.has(stage)) errors.push(`missing receipt for ${stage}`);
  }
  for (const stage of receipts.keys()) {
    if (!required.has(stage)) errors.push(`unexpected receipt for ${stage}`);
  }

  const failedStages = REQUIRED_RELEASE_GATE_STAGES.filter(
    (stage) => receipts.get(stage) !== 0,
  );
  return Object.freeze({
    ok: errors.length === 0 && failedStages.length === 0,
    errors: Object.freeze(errors),
    failedStages: Object.freeze(failedStages),
    receipts,
  });
}

export async function verifyReleaseGateReceiptFile(path) {
  return parseReleaseGateReceipts(await readFile(path, 'utf8'));
}

async function main() {
  const path = process.argv[2];
  if (!path) throw new Error('usage: node scripts/release-gate-status.mjs <receipt-file>');
  const result = await verifyReleaseGateReceiptFile(path);
  for (const stage of REQUIRED_RELEASE_GATE_STAGES) {
    const exitCode = result.receipts.get(stage);
    console.log(`${stage}_EXIT=${exitCode === undefined ? 'MISSING' : exitCode}`);
  }
  for (const error of result.errors) console.error(`gate: ${error}`);
  if (!result.ok) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`gate: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
