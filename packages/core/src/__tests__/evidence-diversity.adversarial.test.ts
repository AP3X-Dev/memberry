// packages/core/src/__tests__/evidence-diversity.adversarial.test.ts
//
// MEM-004 / MEM-FR-4 corroboration adversarial suite: the hardened text
// normalization must collapse cosmetic variants of one claim to a single
// piece of evidence, so a parroted sentence can never satisfy the automatic
// promotion gate — while genuine corroboration still promotes.
import { afterEach, describe, expect, it, vi } from 'vitest';

// Package-index import proves no export-* ambiguity from index.ts (Task 4).
import { normalizeEvidenceTextV1 } from '@memberry/core';

import {
  clusterHasIndependentCorroborationV1,
  countDistinctEvidence,
  countIndependentSources,
  type EvidenceRecordV1,
} from '../evidence-diversity.js';
import { ConsolidationEngine } from '../consolidation.js';
import type { AMPConfig, EpisodicNode } from '../types.js';

const GATE = { minSources: 2, minDistinctEvidence: 2 } as const;

function rec(agent_id: string, session_id: string, content: string): EvidenceRecordV1 {
  return { agent_id, session_id, content };
}

/** The pre-hardening text key — kept inline to document the closed regression. */
function legacyTextKey(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, ' ');
}

// ─── 1. Punctuation parroting ────────────────────────────────────────────────

describe('punctuation parroting', () => {
  const parroted = [
    rec('agent-1', 'sess-1', 'The gate owns validation.'),
    rec('agent-2', 'sess-2', 'The gate owns validation!'),
    rec('agent-3', 'sess-3', '“The gate owns validation…”'),
    rec('agent-4', 'sess-4', "'The gate owns validation'"),
  ];

  it('collapses punctuation and quote-style variants to one piece of evidence', () => {
    expect(countDistinctEvidence(parroted)).toBe(1);
    expect(clusterHasIndependentCorroborationV1(parroted, GATE)).toBe(false);
  });

  it('closes the legacy normalization hole (variants counted as distinct before)', () => {
    const legacyDistinct = new Set(parroted.map((r) => legacyTextKey(r.content))).size;
    expect(legacyDistinct).toBeGreaterThan(1); // the old gate would have passed
  });
});

// ─── 2. Case/whitespace parroting ────────────────────────────────────────────

describe('case and whitespace parroting', () => {
  it('remains rejected (no regression from the old normalization)', () => {
    const cluster = [
      rec('agent-1', 'sess-1', 'use redis for locks'),
      rec('agent-2', 'sess-2', 'USE   REDIS   FOR   LOCKS'),
      rec('agent-3', 'sess-3', '  Use Redis For Locks  '),
    ];
    expect(countDistinctEvidence(cluster)).toBe(1);
    expect(clusterHasIndependentCorroborationV1(cluster, GATE)).toBe(false);
  });
});

// ─── 3. Unicode confusables ──────────────────────────────────────────────────

describe('unicode confusables', () => {
  it('folds fullwidth characters via NFKC', () => {
    const cluster = [
      rec('agent-1', 'sess-1', 'ship the gate'),
      rec('agent-2', 'sess-2', 'ｓｈｉｐ ｔｈｅ ｇａｔｅ'),
    ];
    expect(countDistinctEvidence(cluster)).toBe(1);
    expect(clusterHasIndependentCorroborationV1(cluster, GATE)).toBe(false);
  });

  it('folds combining accents against precomposed forms', () => {
    const combining = 'cafe' + String.fromCharCode(0x0301) + ' rules'; // e + U+0301
    const precomposed = 'caf' + String.fromCharCode(0xe9) + ' rules'; // é
    expect(normalizeEvidenceTextV1(combining)).toBe(normalizeEvidenceTextV1(precomposed));
    const cluster = [rec('agent-1', 'sess-1', combining), rec('agent-2', 'sess-2', precomposed)];
    expect(countDistinctEvidence(cluster)).toBe(1);
    expect(clusterHasIndependentCorroborationV1(cluster, GATE)).toBe(false);
  });
});

// ─── 4. Source collusion ─────────────────────────────────────────────────────

describe('source collusion', () => {
  it('rejects one agent+session repeating genuinely distinct texts', () => {
    const cluster = [
      rec('agent-1', 'sess-1', 'redis holds the consolidation lock'),
      rec('agent-1', 'sess-1', 'neo4j owns the semantic graph'),
      rec('agent-1', 'sess-1', 'proposals stay advisor gated'),
    ];
    expect(countDistinctEvidence(cluster)).toBe(3);
    expect(countIndependentSources(cluster)).toBe(1);
    expect(clusterHasIndependentCorroborationV1(cluster, GATE)).toBe(false);
  });

  it('keys sources on a NUL separator so field boundaries cannot collide', () => {
    const cluster = [rec('a b', 'c', 'text one'), rec('a', 'b c', 'text two')];
    expect(countIndependentSources(cluster)).toBe(2);
  });
});

// ─── 5. Genuine corroboration ────────────────────────────────────────────────

describe('genuine corroboration', () => {
  it('accepts independent sources with semantically distinct evidence', () => {
    const cluster = [
      rec('agent-1', 'sess-1', 'the engine validates decay classes'),
      rec('agent-2', 'sess-2', 'decay class validation happens in the engine'),
      rec('agent-3', 'sess-3', 'invalid decay classes are rejected before apply'),
    ];
    expect(clusterHasIndependentCorroborationV1(cluster, { minSources: 3, minDistinctEvidence: 2 })).toBe(true);
  });

  it('keeps alphanumeric config diffs distinct despite symbol stripping', () => {
    expect(normalizeEvidenceTextV1('timeout is 30s')).not.toBe(normalizeEvidenceTextV1('timeout is 60s'));
  });
});

// ─── 6. Boundaries ───────────────────────────────────────────────────────────

describe('boundaries', () => {
  const twoByTwo = [
    rec('agent-1', 'sess-1', 'claim alpha holds'),
    rec('agent-2', 'sess-2', 'claim beta holds'),
  ];

  it('accepts exactly minSources and exactly minDistinctEvidence', () => {
    expect(clusterHasIndependentCorroborationV1(twoByTwo, GATE)).toBe(true);
  });

  it('rejects one below minSources', () => {
    expect(clusterHasIndependentCorroborationV1(twoByTwo, { minSources: 3, minDistinctEvidence: 2 })).toBe(false);
  });

  it('rejects one below minDistinctEvidence', () => {
    expect(clusterHasIndependentCorroborationV1(twoByTwo, { minSources: 2, minDistinctEvidence: 3 })).toBe(false);
  });
});

// ─── 7. Consolidation promote-pipeline integration ───────────────────────────

function vecAt(deg: number): number[] {
  const rad = (deg * Math.PI) / 180;
  return [Math.cos(rad), Math.sin(rad)];
}

function ep(id: string, embedding: number[], overrides: Partial<EpisodicNode> = {}): EpisodicNode {
  return {
    id,
    session_id: 'sess-1',
    agent_id: 'agent-1',
    task: `task ${id}`,
    content: `content ${id}`,
    created_at: '2026-08-12T00:00:00.000Z',
    embedding,
    scope: 'project:test',
    tags: ['project:test'],
    ...overrides,
  };
}

const CONFIG: AMPConfig = {
  redis: { url: 'redis://localhost:6379' },
  neo4j: { uri: 'bolt://localhost:7687', user: 'neo4j', password: '' },
  embedding: { provider: 'openai', apiKey: 'test-key' },
  cache: { defaultTTL: 300, contextTTL: 300, embeddingTTL: 86400 },
  consolidation: {
    autoApply: false,
    signalThreshold: 3,
    promote: { minClusterSize: 3, similarityThreshold: 0.9, maxPerRun: 3, maxCandidates: 200 },
  },
  exportPath: '/tmp',
};

function emptyRedis() {
  return {
    lock: { acquire: vi.fn().mockResolvedValue(true), release: vi.fn().mockResolvedValue(undefined) },
    signals: { consume: vi.fn().mockResolvedValue([]) },
    queue: { popHighest: vi.fn().mockResolvedValue(null) },
    proposals: {
      save: vi.fn().mockResolvedValue(undefined),
      get: vi.fn().mockResolvedValue(null),
      listPending: vi.fn().mockResolvedValue([]),
      remove: vi.fn().mockResolvedValue(undefined),
    },
    cache: { invalidateByNodeId: vi.fn().mockResolvedValue(0) },
  };
}

function llmReturning(payload: unknown) {
  return {
    available: true as const,
    modelFor: () => 'gpt-4o',
    chat: vi.fn().mockResolvedValue(JSON.stringify(payload)),
  };
}

function neo4jWith(findPromotable: unknown) {
  return {
    semantic: {
      getById: vi.fn().mockResolvedValue(null),
      getByIds: vi.fn().mockResolvedValue([]),
      updateConfidence: vi.fn(),
      supersede: vi.fn(),
      promoteFromEpisodic: vi.fn().mockResolvedValue('sem-new'),
    },
    episodic: { getById: vi.fn().mockResolvedValue(null), findPromotable },
  };
}

describe('consolidation promote pipeline with the hardened gate', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('drops a punctuation-parroted cluster and logs the drop', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const parroted = [
      ep('p1', vecAt(0), { session_id: 'sess-1', content: 'The engine owns validation.' }),
      ep('p2', vecAt(3), { session_id: 'sess-2', content: 'The engine owns validation!' }),
      ep('p3', vecAt(6), { session_id: 'sess-3', content: '“The engine owns validation…”' }),
    ];
    const neo4j = neo4jWith(vi.fn().mockResolvedValue(parroted));
    const llm = llmReturning({ content: 'Should never be proposed.', confidence: 0.9, decay_class: 'stable' });
    const engine = new ConsolidationEngine(emptyRedis() as never, neo4j as never, CONFIG, llm as never);

    const result = await engine.run('project:test');

    expect(result.proposals).toHaveLength(0);
    expect(llm.chat).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('without independent corroboration'),
    );
  });

  it('still promotes a genuinely corroborated cluster', async () => {
    const genuine = [
      ep('g1', vecAt(0), { session_id: 'sess-1', content: 'the engine validates decay classes' }),
      ep('g2', vecAt(3), { session_id: 'sess-2', content: 'decay class validation lives in the engine' }),
      ep('g3', vecAt(6), { session_id: 'sess-3', content: 'invalid decay classes never reach apply' }),
    ];
    const neo4j = neo4jWith(vi.fn().mockResolvedValue(genuine));
    const llm = llmReturning({ content: 'The engine owns validation.', confidence: 0.8, decay_class: 'stable' });
    const engine = new ConsolidationEngine(emptyRedis() as never, neo4j as never, CONFIG, llm as never);

    const result = await engine.run('project:test');

    expect(result.proposals).toHaveLength(1);
    expect(result.proposals[0]!.type).toBe('promote');
  });
});
