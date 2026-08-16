import { describe, expect, it, vi } from 'vitest';

describe('MEM-002C2 host orchestration isolation', () => {
  it('imports build and sandbox without importing or executing candidate extractor or worker modules', async () => {
    vi.resetModules();
    let candidateExecutions = 0;
    vi.doMock('../extractor.js', () => {
      candidateExecutions += 1;
      return { encodeAdmissionFeatureCandidateArtifactV1: vi.fn() };
    });
    vi.doMock('../worker.js', () => {
      candidateExecutions += 1;
      return { runAdmissionFeatureWorkerBytesV1: vi.fn() };
    });

    await import('../sandbox.js');
    await import('../build.js');
    expect(candidateExecutions).toBe(0);
  });
});
