import { describe, expect, it } from 'vitest';

import {
  ADMISSION_FEATURE_PREDICTION_ARTIFACT_MAX_BYTES,
  admissionFeaturePredictionArtifactIdentityV1,
  encodeAdmissionFeaturePredictionArtifactV1,
  parseAdmissionFeaturePredictionArtifactV1,
  runAdmissionFeaturePredictionEvidence,
} from '../prediction-artifact.js';
import {
  admissionFeatureOracleOpenAttemptsForTest,
  loadAdmissionFeatureOracles,
  resetAdmissionFeatureOracleOpenAttemptsForTest,
} from '../scorer-only/load.js';
import { loadAdmissionFeatureInputs } from '../inputs.js';

const textEncoder = new TextEncoder();

function exactPredictions(oracles: Awaited<ReturnType<typeof loadAdmissionFeatureOracles>>) {
  return oracles.map((oracle) => ({
    scenarioId: oracle.scenarioId,
    split: oracle.split,
    features: {
      contractId: 'memberry.admission-feature-envelope' as const,
      contractVersion: '1.0.0' as const,
      extractor: {
        id: 'memberry.precomputed-feature-signals' as const,
        version: '1.0.0' as const,
      },
      dimensions: structuredClone(oracle.dimensions),
    },
  }));
}

async function exactArtifact() {
  const inputs = await loadAdmissionFeatureInputs();
  const oracles = await loadAdmissionFeatureOracles();
  const predictions = exactPredictions(oracles);
  const bytes = encodeAdmissionFeaturePredictionArtifactV1({ inputs, predictions });
  return { inputs, oracles, predictions, bytes };
}

function mutateCanonical(bytes: Uint8Array, mutate: (value: Record<string, any>) => void): Uint8Array {
  const value = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, any>;
  mutate(value);
  return textEncoder.encode(JSON.stringify(value));
}

describe('MEM-002B data-only prediction artifact boundary', () => {
  it('accepts only canonical bounded bytes and returns deeply frozen exact-corpus predictions', async () => {
    const { inputs, bytes } = await exactArtifact();
    const artifact = parseAdmissionFeaturePredictionArtifactV1(bytes, inputs);

    expect(artifact.predictions).toHaveLength(6);
    expect(artifact.inputHash).toBe('sha256:41ef02bbe9df03e4f7b4f95b248265a71635aefa7cbe69c585a1eb8647936b24');
    expect(Object.isFrozen(artifact)).toBe(true);
    expect(Object.isFrozen(artifact.predictions)).toBe(true);
    expect(Object.isFrozen(artifact.predictions[0]!.features)).toBe(true);
    expect(Object.isFrozen(artifact.predictions[0]!.features.dimensions)).toBe(true);
    expect(admissionFeaturePredictionArtifactIdentityV1(artifact)).toBe(
      'sha256:a437043418f4cd545b65a116e7a84aeb41011d05c3cf1a1ed8a770f65cfaa636',
    );
  });

  it.each([
    ['pretty JSON', (bytes: Uint8Array) => textEncoder.encode(JSON.stringify(JSON.parse(new TextDecoder().decode(bytes)), null, 2))],
    ['trailing newline', (bytes: Uint8Array) => textEncoder.encode(`${new TextDecoder().decode(bytes)}\n`)],
    ['UTF-8 byte-order mark', (bytes: Uint8Array) => Uint8Array.from([0xef, 0xbb, 0xbf, ...bytes])],
    ['reordered root keys', (bytes: Uint8Array) => {
      const value = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
      const { artifactVersion, datasetId, datasetVersion, evaluationContractVersion, featureContractVersion, inputHash, predictions } = value;
      return textEncoder.encode(JSON.stringify({ datasetId, artifactVersion, datasetVersion, evaluationContractVersion, featureContractVersion, inputHash, predictions }));
    }],
    ['unknown root metadata', (bytes: Uint8Array) => mutateCanonical(bytes, (value) => { value.metadata = {}; })],
    ['wrong input hash', (bytes: Uint8Array) => mutateCanonical(bytes, (value) => { value.inputHash = `sha256:${'0'.repeat(64)}`; })],
    ['wrong artifact version', (bytes: Uint8Array) => mutateCanonical(bytes, (value) => { value.artifactVersion = '2.0.0'; })],
    ['wrong dataset version', (bytes: Uint8Array) => mutateCanonical(bytes, (value) => { value.datasetVersion = '2.0.0'; })],
    ['scenario substitution', (bytes: Uint8Array) => mutateCanonical(bytes, (value) => { value.predictions[0].scenarioId = 'af-dev-999'; })],
    ['split substitution', (bytes: Uint8Array) => mutateCanonical(bytes, (value) => { value.predictions[0].split = 'holdout'; })],
    ['duplicate scenario', (bytes: Uint8Array) => mutateCanonical(bytes, (value) => { value.predictions[1].scenarioId = value.predictions[0].scenarioId; })],
    ['omitted scenario', (bytes: Uint8Array) => mutateCanonical(bytes, (value) => { value.predictions.pop(); })],
    ['omitted feature dimension', (bytes: Uint8Array) => mutateCanonical(bytes, (value) => { delete value.predictions[0].features.dimensions.salience; })],
    ['noninteger feature value', (bytes: Uint8Array) => mutateCanonical(bytes, (value) => { value.predictions[0].features.dimensions.salience.valuePermille = 100.5; })],
    ['executable code shape', (bytes: Uint8Array) => mutateCanonical(bytes, (value) => { value.code = 'return process'; })],
    ['source shape', (bytes: Uint8Array) => mutateCanonical(bytes, (value) => { value.source = 'candidate'; })],
    ['module path shape', (bytes: Uint8Array) => mutateCanonical(bytes, (value) => { value.moduleName = 'node:fs'; })],
    ['filesystem path shape', (bytes: Uint8Array) => mutateCanonical(bytes, (value) => { value.path = 'candidate.js'; })],
    ['VM shape', (bytes: Uint8Array) => mutateCanonical(bytes, (value) => { value.vm = {}; })],
    ['worker shape', (bytes: Uint8Array) => mutateCanonical(bytes, (value) => { value.worker = 'candidate.js'; })],
    ['callback shape', (bytes: Uint8Array) => mutateCanonical(bytes, (value) => { value.predictions[0].callback = 'evaluate'; })],
    ['extension shape', (bytes: Uint8Array) => mutateCanonical(bytes, (value) => { value.predictions[0].features.extensions = {}; })],
  ])('rejects %s', async (_name, mutation) => {
    const { inputs, bytes } = await exactArtifact();
    expect(() => parseAdmissionFeaturePredictionArtifactV1(mutation(bytes), inputs)).toThrow();
  });

  it('rejects oversized and non-byte executable/module inputs', async () => {
    const inputs = await loadAdmissionFeatureInputs();
    expect(() => parseAdmissionFeaturePredictionArtifactV1(
      new Uint8Array(ADMISSION_FEATURE_PREDICTION_ARTIFACT_MAX_BYTES + 1),
      inputs,
    )).toThrow(/size|bytes/i);
    for (const value of ['{}', () => ({}), { module: 'node:fs' }, new SharedArrayBuffer(8)]) {
      expect(() => parseAdmissionFeaturePredictionArtifactV1(value as never, inputs)).toThrow(/bytes/i);
    }
  });

  it('rejects a mutually substituted fixture and prediction corpus', async () => {
    const { inputs, predictions } = await exactArtifact();
    const substitutedInputs = inputs.map((input, index) => (
      index === 0 ? { ...input, scenarioId: 'af-dev-099' } : input
    ));
    const substitutedPredictions = predictions.map((prediction, index) => (
      index === 0 ? { ...prediction, scenarioId: 'af-dev-099' } : prediction
    ));

    expect(() => encodeAdmissionFeaturePredictionArtifactV1({
      inputs: substitutedInputs,
      predictions: substitutedPredictions,
    })).toThrow(/corpus|scenario|input/i);
  });

  it('rejects invalid bytes before scorer-only oracle files are opened', async () => {
    const { bytes } = await exactArtifact();
    resetAdmissionFeatureOracleOpenAttemptsForTest();
    const invalid = mutateCanonical(bytes, (value) => { value.worker = 'candidate.js'; });

    await expect(runAdmissionFeaturePredictionEvidence(invalid)).rejects.toThrow();
    expect(admissionFeatureOracleOpenAttemptsForTest()).toBe(0);
  });

  it('scores canonical scorer-owned self-proof bytes and opens labels only after validation and SHA', async () => {
    const { predictions, bytes } = await exactArtifact();
    resetAdmissionFeatureOracleOpenAttemptsForTest();
    const exact = await runAdmissionFeaturePredictionEvidence(bytes);
    expect(exact.evidenceMode).toBe('prediction-artifact');
    expect(exact.report.passed).toBe(true);
    expect(exact.report.metrics.agreementPermille).toBe(1_000);
    expect(exact.predictionArtifactIdentity).toBe(
      'sha256:a437043418f4cd545b65a116e7a84aeb41011d05c3cf1a1ed8a770f65cfaa636',
    );
    expect(admissionFeatureOracleOpenAttemptsForTest()).toBe(1);

    const salience = predictions[0]!.features.dimensions.salience;
    if (salience.availability !== 'available') throw new Error('self-proof fixture requires available salience');
    (predictions[0]!.features.dimensions as any).salience = {
      availability: 'available', valuePermille: salience.valuePermille + 1,
    };
    const inputs = await loadAdmissionFeatureInputs();
    const mismatchBytes = encodeAdmissionFeaturePredictionArtifactV1({ inputs, predictions });
    const mismatch = await runAdmissionFeaturePredictionEvidence(mismatchBytes);
    expect(mismatch.report.passed).toBe(false);
    expect(mismatch.report.metrics.agreementPermille).toBe(972);
    expect(mismatch.report.metrics.valueMismatchCount).toBe(1);
  });
});
