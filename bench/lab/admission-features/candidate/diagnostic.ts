import { buildAdmissionFeatureCandidateImageV1 } from './build.js';

async function main(): Promise<void> {
  try {
    await buildAdmissionFeatureCandidateImageV1();
    process.stdout.write('diagnostic:success\n');
  } catch (error) {
    const message = error instanceof Error && /^diagnostic:[a-z.-]+$/.test(error.message)
      ? error.message
      : 'diagnostic:unknown';
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  }
}

void main();
