import { loadAdmissionFeatureInputs } from '../inputs.js';
import { buildAdmissionFeatureCandidateImageV1 } from './build.js';
import { runAdmissionFeatureSandboxV1 } from './sandbox.js';

async function main(): Promise<void> {
  const inputs = await loadAdmissionFeatureInputs();
  const receipt = await buildAdmissionFeatureCandidateImageV1();
  const result = await runAdmissionFeatureSandboxV1({ receipt, inputs });
  if (!result.ok) {
    process.stderr.write(`live-diagnostic:sandbox-${result.failureCode}\n`);
    process.exitCode = 1;
    return;
  }
  const matches = [
    result.hashes.candidateSha256 === receipt.candidateSha256,
    result.hashes.sourceSha256 === receipt.sourceSha256,
    result.hashes.imageSha256 === receipt.imageSha256,
  ];
  process.stdout.write(`live-diagnostic:success-${matches.map(Number).join('')}\n`);
}

void main().catch(() => {
  process.stderr.write('live-diagnostic:exception\n');
  process.exitCode = 1;
});
