import { describe, expect, it } from 'vitest';

import { produceAdmissionFeatureEnvelopeV2 } from '../../../../../packages/core/src/admission-feature-producer.js';
import {
  completeAdmissionFeatureFactsV3,
  parseAdmissionFeaturePredictionListV3,
} from '../../contract-v3.js';
import { loadAdmissionFeatureInputsV3 } from '../../inputs-v3.js';
import {
  CandidateAdmissionFeatureV3Error,
  runAdmissionFeatureCandidateV3,
  runAdmissionFeatureCandidateV3Bytes,
} from '../worker.js';

describe('MEM-002 productionization v3 candidate adapter', () => {
  it('executes the PRODUCTION producer over the v3 dev corpus', async () => {
    const inputs = await loadAdmissionFeatureInputsV3(['dev']);
    const artifact = runAdmissionFeatureCandidateV3(inputs);

    expect(artifact).toMatchObject({
      artifactVersion: '1.0.0',
      datasetId: 'memberry.synthetic-admission-feature-labels',
      datasetVersion: '3.0.0',
      featureContractVersion: '2.0.0',
    });
    expect(artifact.predictions).toHaveLength(14);
    // Predictions are exactly the production module's output, envelope by envelope.
    for (const [index, input] of inputs.entries()) {
      const expected = produceAdmissionFeatureEnvelopeV2(completeAdmissionFeatureFactsV3(input.facts));
      expect(artifact.predictions[index]).toEqual({
        scenarioId: input.scenarioId,
        split: input.split,
        features: expected,
      });
      expect(artifact.predictions[index]!.features.extractor).toEqual({
        id: 'memberry.safe-facts-feature-producer',
        version: '1.0.0',
      });
    }
    // The emitted predictions re-parse under the v3 evaluation contract.
    expect(() => parseAdmissionFeaturePredictionListV3(
      artifact.predictions.map((prediction) => ({ ...prediction })),
    )).not.toThrow();
  });

  it('is byte-deterministic over the bounded bytes surface', async () => {
    const inputs = await loadAdmissionFeatureInputsV3(['dev']);
    const bytes = new TextEncoder().encode(JSON.stringify(inputs));
    const first = runAdmissionFeatureCandidateV3Bytes(bytes);
    const second = runAdmissionFeatureCandidateV3Bytes(bytes);
    expect(Buffer.from(first).equals(Buffer.from(second))).toBe(true);
    expect(first.byteLength).toBeLessThanOrEqual(32_768);
  });

  it('rejects oversized, empty, and garbage input', async () => {
    expect(() => runAdmissionFeatureCandidateV3Bytes(new Uint8Array(0)))
      .toThrow(CandidateAdmissionFeatureV3Error);
    expect(() => runAdmissionFeatureCandidateV3Bytes(new Uint8Array(32_769)))
      .toThrow(CandidateAdmissionFeatureV3Error);
    expect(() => runAdmissionFeatureCandidateV3Bytes(new TextEncoder().encode('not-json')))
      .toThrow('admission_feature_candidate_v3:invalid_json:input');
    expect(() => runAdmissionFeatureCandidateV3(['garbage'])).toThrow();
  });
});
