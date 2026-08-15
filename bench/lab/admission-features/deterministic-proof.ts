import {
  ADMISSION_FEATURE_CONTRACT_ID,
  ADMISSION_FEATURE_CONTRACT_VERSION,
  ADMISSION_FEATURE_EXTRACTOR_ID,
  ADMISSION_FEATURE_EXTRACTOR_VERSION,
} from '../../../packages/core/src/admission-features.js';
import {
  admissionFeatureEvaluationArtifactIdentity,
  buildAdmissionFeatureEvaluationArtifact,
  canonicalAdmissionFeatureEvaluationArtifact,
} from './artifact.js';
import { loadAdmissionFeatureInputs } from './inputs.js';
import {
  admissionFeaturePredictionArtifactIdentityV1,
  encodeAdmissionFeaturePredictionArtifactV1,
  parseAdmissionFeaturePredictionArtifactV1,
} from './prediction-artifact.js';
import { loadAdmissionFeatureOracles } from './scorer-only/load.js';
import { scoreAdmissionFeatureAgreement } from './scorer.js';

/**
 * Deterministic scorer self-check only. This deliberately runs no candidate and
 * makes no extractor-quality claim; scorer-owned exact labels exercise the
 * agreement and artifact contracts across supported Node runtimes.
 */
export async function admissionFeatureDeterministicProof(): Promise<string> {
  const inputs = await loadAdmissionFeatureInputs();
  const oracles = await loadAdmissionFeatureOracles();
  const predictions = oracles.map((oracle) => ({
    scenarioId: oracle.scenarioId,
    split: oracle.split,
    features: {
      contractId: ADMISSION_FEATURE_CONTRACT_ID,
      contractVersion: ADMISSION_FEATURE_CONTRACT_VERSION,
      extractor: {
        id: ADMISSION_FEATURE_EXTRACTOR_ID,
        version: ADMISSION_FEATURE_EXTRACTOR_VERSION,
      },
      dimensions: oracle.dimensions,
    },
  }));
  // These fixed exact predictions are scorer-owned self-proof data. They are
  // never presented as candidate output or extractor-quality evidence.
  const predictionBytes = encodeAdmissionFeaturePredictionArtifactV1({ inputs, predictions });
  const predictionArtifact = parseAdmissionFeaturePredictionArtifactV1(predictionBytes, inputs);
  const predictionArtifactIdentity = admissionFeaturePredictionArtifactIdentityV1(predictionArtifact);
  const report = scoreAdmissionFeatureAgreement({ inputs, oracles, predictions: predictionArtifact.predictions });
  if (!report.passed) throw new Error('admission_feature_deterministic_proof:scorer_self_check_failed');
  const artifact = buildAdmissionFeatureEvaluationArtifact({ inputs, oracles, report });
  return `${JSON.stringify({
    identity: admissionFeatureEvaluationArtifactIdentity(artifact),
    predictionArtifactIdentity,
    artifact: JSON.parse(canonicalAdmissionFeatureEvaluationArtifact(artifact)) as unknown,
  })}\n`;
}

if (process.argv[1]?.replace(/\\/g, '/').endsWith('/admission-features/deterministic-proof.ts')) {
  void admissionFeatureDeterministicProof()
    .then((output) => process.stdout.write(output))
    .catch((error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.message : 'admission_feature_deterministic_proof:unknown'}\n`);
      process.exitCode = 1;
    });
}
