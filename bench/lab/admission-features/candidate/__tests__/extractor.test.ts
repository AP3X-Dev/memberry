import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  ADMISSION_FEATURE_CANDIDATE_MAX_BYTES,
  CandidateAdmissionFeatureError,
  encodeAdmissionFeatureCandidateArtifactV1,
  extractAdmissionFeatureEnvelopeV1,
  predictAdmissionFeatureScenarioV1,
  predictAdmissionFeatureScenariosV1,
} from '../extractor.js';

const root = resolve(import.meta.dirname, '../../../../..');

async function jsonLines(path: string): Promise<unknown[]> {
  return (await readFile(resolve(root, path), 'utf8'))
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as unknown);
}

const unknownSignals = Object.freeze({
  priority: 'unknown',
  noveltyEvidence: 'unknown',
  retentionHorizon: 'unknown',
  evidenceSupport: 'unknown',
  scopeBinding: 'unknown',
  sensitivitySignal: 'unknown',
});

function signals(overrides: Record<string, string> = {}): Record<string, string> {
  return { ...unknownSignals, ...overrides };
}

function scenario(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    datasetId: 'memberry.synthetic-admission-feature-labels',
    datasetVersion: '1.0.0',
    scenarioId: 'af-dev-001',
    split: 'dev',
    fixtureCode: 'case-001',
    signals: signals(),
    ...overrides,
  };
}

function dimension(valuePermille?: number) {
  return valuePermille === undefined
    ? { availability: 'unavailable' }
    : { availability: 'available', valuePermille };
}

describe('MEM-002C1 blind deterministic extractor', () => {
  it('reproduces every permitted DEV oracle envelope exactly', async () => {
    const inputs = await jsonLines('bench/lab/admission-features/fixtures/v1/dev/input.jsonl');
    const oracles = await jsonLines('bench/lab/admission-features/scorer-only/v1/dev/oracle.jsonl') as any[];

    expect(inputs.map((input) => predictAdmissionFeatureScenarioV1(input))).toEqual(
      oracles.map((oracle) => ({
        scenarioId: oracle.scenarioId,
        split: oracle.split,
        features: {
          contractId: 'memberry.admission-feature-envelope',
          contractVersion: '1.0.0',
          extractor: { id: 'memberry.precomputed-feature-signals', version: '1.0.0' },
          dimensions: oracle.dimensions,
        },
      })),
    );
  });

  it('maps every closed categorical signal and unknown to unavailable', () => {
    const cases = [
      ['priority', 'salience', [['none', 0], ['normal', 100], ['explicit', 1_000], ['unknown', undefined]]],
      ['noveltyEvidence', 'novelty', [['none', 0], ['partial', 500], ['independent', 1_000], ['unknown', undefined]]],
      ['retentionHorizon', 'durability', [['transient', 100], ['session', 700], ['durable', 800], ['unknown', undefined]]],
      ['evidenceSupport', 'evidenceQuality', [['none', 0], ['single', 500], ['corroborated', 1_000], ['unknown', undefined]]],
      ['scopeBinding', 'scopeConfidence', [['missing', 0], ['inferred', 500], ['explicit', 1_000], ['unknown', undefined]]],
      ['sensitivitySignal', 'sensitivity', [['none', 0], ['possible', 50], ['confirmed', 1_000], ['unknown', undefined]]],
    ] as const;

    for (const [signal, feature, values] of cases) {
      for (const [category, expected] of values) {
        expect(extractAdmissionFeatureEnvelopeV1(signals({ [signal]: category })).dimensions[feature])
          .toEqual(dimension(expected));
      }
    }
  });

  it('applies only DEV-evidenced cross-signal adjustments', () => {
    expect(extractAdmissionFeatureEnvelopeV1(signals({
      noveltyEvidence: 'partial', evidenceSupport: 'corroborated',
    })).dimensions.novelty).toEqual(dimension(200));
    expect(extractAdmissionFeatureEnvelopeV1(signals({
      scopeBinding: 'explicit', sensitivitySignal: 'possible',
    })).dimensions.scopeConfidence).toEqual(dimension(900));
  });

  it('is independent of scenario and fixture IDs', () => {
    const shared = signals({
      priority: 'normal', noveltyEvidence: 'partial', retentionHorizon: 'durable',
      evidenceSupport: 'corroborated', scopeBinding: 'explicit', sensitivitySignal: 'possible',
    });
    const first = predictAdmissionFeatureScenarioV1(scenario({ signals: shared }));
    const second = predictAdmissionFeatureScenarioV1(scenario({
      scenarioId: 'af-dev-099', fixtureCode: 'case-999', signals: shared,
    }));

    expect(second.features).toEqual(first.features);
    expect(second.scenarioId).not.toBe(first.scenarioId);
  });

  it('is permutation- and repeat-deterministic with deeply frozen canonical objects', () => {
    const ordered = signals({
      priority: 'normal', noveltyEvidence: 'partial', retentionHorizon: 'durable',
      evidenceSupport: 'corroborated', scopeBinding: 'explicit', sensitivitySignal: 'possible',
    });
    const permuted = {
      sensitivitySignal: 'possible', scopeBinding: 'explicit', evidenceSupport: 'corroborated',
      retentionHorizon: 'durable', noveltyEvidence: 'partial', priority: 'normal',
    };
    const expected = JSON.stringify(extractAdmissionFeatureEnvelopeV1(ordered));

    for (let iteration = 0; iteration < 100; iteration += 1) {
      const envelope = extractAdmissionFeatureEnvelopeV1(iteration % 2 === 0 ? ordered : permuted);
      expect(JSON.stringify(envelope)).toBe(expected);
      expect(Object.isFrozen(envelope)).toBe(true);
      expect(Object.isFrozen(envelope.extractor)).toBe(true);
      expect(Object.isFrozen(envelope.dimensions)).toBe(true);
      expect(Object.values(envelope.dimensions).every(Object.isFrozen)).toBe(true);
    }
  });

  it.each([
    ['null', null],
    ['array', []],
    ['missing key', { ...unknownSignals, priority: undefined }],
    ['invalid enum', signals({ priority: 'urgent' })],
    ['unknown key', { ...unknownSignals, metadata: true }],
    ['proxy', new Proxy({ ...unknownSignals }, {})],
    ['accessor', Object.defineProperty({ ...unknownSignals }, 'priority', { get: () => 'normal' })],
  ])('rejects malformed signals: %s', (_name, value) => {
    expect(() => extractAdmissionFeatureEnvelopeV1(value)).toThrow(CandidateAdmissionFeatureError);
  });

  it('rejects malformed and oversized scenario collections', () => {
    expect(() => predictAdmissionFeatureScenariosV1([])).toThrow(/length/i);
    expect(() => predictAdmissionFeatureScenariosV1(
      Array.from({ length: 129 }, (_, index) => scenario({
        scenarioId: `af-dev-${String(index + 1).padStart(3, '0')}`,
        fixtureCode: `case-${String(index + 1).padStart(3, '0')}`,
      })),
    )).toThrow(/length/i);
    const sparse = [scenario(), , scenario({ scenarioId: 'af-dev-002', fixtureCode: 'case-002' })];
    expect(() => predictAdmissionFeatureScenariosV1(sparse)).toThrow(/array/i);
  });

  it('emits exact canonical bounded prediction artifact bytes', async () => {
    const inputs = [
      ...await jsonLines('bench/lab/admission-features/fixtures/v1/dev/input.jsonl'),
      ...await jsonLines('bench/lab/admission-features/fixtures/v1/holdout/input.jsonl'),
    ];
    const predictions = predictAdmissionFeatureScenariosV1(inputs);
    const bytes = encodeAdmissionFeatureCandidateArtifactV1(inputs);
    const expected = JSON.stringify({
      artifactVersion: '1.0.0',
      datasetId: 'memberry.synthetic-admission-feature-labels',
      datasetVersion: '1.0.0',
      evaluationContractVersion: '1.0.0',
      featureContractVersion: '1.0.0',
      inputHash: 'sha256:41ef02bbe9df03e4f7b4f95b248265a71635aefa7cbe69c585a1eb8647936b24',
      predictions,
    });

    expect(new TextDecoder('utf-8', { fatal: true }).decode(bytes)).toBe(expected);
    expect(bytes.byteLength).toBe(new TextEncoder().encode(expected).byteLength);
    expect(bytes.byteLength).toBeLessThanOrEqual(ADMISSION_FEATURE_CANDIDATE_MAX_BYTES);
    expect(encodeAdmissionFeatureCandidateArtifactV1(inputs)).toEqual(bytes);
  });
});
