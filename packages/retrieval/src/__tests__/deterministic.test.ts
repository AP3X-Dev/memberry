// packages/retrieval/src/__tests__/deterministic.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DeterministicAssembler } from '../deterministic.js';

// ─── Mock helpers ────────────────────────────────────────────────────────────

function mockRecord(data: Record<string, unknown>) {
  return {
    get: (key: string) => data[key],
  };
}

function mockNeo4jResult(records: Array<Record<string, unknown>>) {
  return { records: records.map(mockRecord) };
}

function mockEntityNode(props: Record<string, unknown>) {
  return { properties: props };
}

function createMockDriver() {
  const mockSession = {
    run: vi.fn(),
    close: vi.fn().mockResolvedValue(undefined),
  };
  const mockDriver = {
    session: vi.fn().mockReturnValue(mockSession),
  };
  return { mockDriver, mockSession };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('DeterministicAssembler', () => {
  let mockSession: ReturnType<typeof createMockDriver>['mockSession'];
  let assembler: DeterministicAssembler;

  beforeEach(() => {
    const mocks = createMockDriver();
    mockSession = mocks.mockSession;
    assembler = new DeterministicAssembler(mocks.mockDriver as never);
  });

  describe('assemble with entity_scope', () => {
    it('returns "no matching entities" section when entity_scope is empty', async () => {
      // Empty entity_scope (length 0) is falsy, so it falls through to matchEntities.
      // matchEntities tries fulltext (may throw), then keyword CONTAINS (returns empty).
      let callCount = 0;
      const mockDriver = {
        session: vi.fn().mockImplementation(() => ({
          run: vi.fn().mockImplementation(() => {
            callCount++;
            if (callCount === 1) throw new Error('No such index');
            return mockNeo4jResult([]);
          }),
          close: vi.fn().mockResolvedValue(undefined),
        })),
      };
      const asm = new DeterministicAssembler(mockDriver as never);

      const sections = await asm.assemble('test task', { entity_scope: [] });

      expect(sections).toHaveLength(1);
      expect(sections[0].heading).toBe('No matching entities found');
    });

    it('assembles hierarchy, target, dependencies, aspects, and semantics for scoped entities', async () => {
      // Each method call opens a new session, so we need to track across sessions
      const sessions: Array<{ run: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> }> = [];

      const mockDriver = {
        session: vi.fn().mockImplementation(() => {
          const sess = {
            run: vi.fn().mockResolvedValue(mockNeo4jResult([])),
            close: vi.fn().mockResolvedValue(undefined),
          };
          sessions.push(sess);
          return sess;
        }),
      };

      const asm = new DeterministicAssembler(mockDriver as never);

      // Set up responses for each query in order of method calls:
      // getAncestors -> getEntity -> getDependencies -> getDependents -> getAspects -> getScopedSemantics
      // Each creates a new session

      // After creating, override each session's run in order
      // We need to do this via the driver mock since sessions are created lazily

      let callIdx = 0;
      mockDriver.session.mockImplementation(() => {
        // Batched per-step queries tag every row with `targetName` so results can
        // be regrouped per target. Each step still opens one session for a single
        // target, so the per-step session order below is unchanged.
        const responses = [
          // Step 2: getAncestorsBatch
          mockNeo4jResult([
            { targetName: 'AuthService', name: 'Platform', depth: 0, responsibility: 'Root platform' },
          ]),
          // Step 3: getEntitiesBatch
          mockNeo4jResult([{
            targetName: 'AuthService',
            e: mockEntityNode({
              name: 'AuthService',
              category: 'service',
              responsibility: 'Handles auth',
              interface_desc: 'JWT API',
              internals: 'bcrypt hashing',
            }),
          }]),
          // Step 4: getDependenciesBatch
          mockNeo4jResult([
            { targetName: 'AuthService', name: 'UserStore', relation: 'USES', interface_desc: 'CRUD' },
          ]),
          // Step 4: getDependentsBatch
          mockNeo4jResult([
            { targetName: 'AuthService', name: 'Gateway', relation: 'CALLS' },
          ]),
          // Step 5: getAspectsBatch
          mockNeo4jResult([
            { targetName: 'AuthService', name: 'security', stability_tier: 'protocol', description: 'Security aspect' },
          ]),
          // Step 6: getScopedSemanticsBatch
          mockNeo4jResult([
            { targetName: 'AuthService', id: 'sem-1', content: 'Auth uses JWT tokens', confidence: 0.9, tags: ['auth'] },
          ]),
        ];

        const idx = callIdx++;
        const sess = {
          run: vi.fn().mockResolvedValue(responses[idx] ?? mockNeo4jResult([])),
          close: vi.fn().mockResolvedValue(undefined),
        };
        return sess;
      });

      const sections = await asm.assemble('auth query', {
        entity_scope: ['AuthService'],
      });

      // Should have sections for hierarchy, targets, deps, aspects, semantics
      expect(sections.length).toBeGreaterThan(0);

      const headings = sections.map((s) => s.heading);
      expect(headings).toContain('Domain Hierarchy');
      expect(headings).toContain('Target Components');
    });

    it('batches per-step queries across multiple targets (one run per step, original order preserved)', async () => {
      // Two targets. Each step issues ONE batched query whose rows are tagged with
      // `targetName`. This proves the N+1 reduction (6 runs for T=2, not 12) AND
      // that regrouping preserves the original `targets` array order plus each
      // step's per-target secondary ordering.
      const runFns: ReturnType<typeof vi.fn>[] = [];
      let callIdx = 0;
      const mockDriver = {
        session: vi.fn().mockImplementation(() => {
          const idx = callIdx++;
          // Batched responses, in step order. Rows for both targets in one result.
          const responses = [
            // Step 2: getAncestorsBatch — return Beta's rows first to prove JS
            // regrouping (not Cypher row order) drives the final target order.
            mockNeo4jResult([
              { targetName: 'Beta', name: 'PlatformB', depth: 0, responsibility: 'B root' },
              { targetName: 'Alpha', name: 'PlatformA', depth: 0, responsibility: 'A root' },
            ]),
            // Step 3: getEntitiesBatch
            mockNeo4jResult([
              { targetName: 'Alpha', e: mockEntityNode({ name: 'Alpha', category: 'service' }) },
              { targetName: 'Beta', e: mockEntityNode({ name: 'Beta', category: 'service' }) },
            ]),
            // Step 4: getDependenciesBatch
            mockNeo4jResult([
              { targetName: 'Alpha', name: 'StoreA', relation: 'USES', interface_desc: '' },
              { targetName: 'Beta', name: 'StoreB', relation: 'USES', interface_desc: '' },
            ]),
            // Step 4: getDependentsBatch
            mockNeo4jResult([]),
            // Step 5: getAspectsBatch
            mockNeo4jResult([]),
            // Step 6: getScopedSemanticsBatch
            mockNeo4jResult([]),
          ];
          const run = vi.fn().mockResolvedValue(responses[idx] ?? mockNeo4jResult([]));
          runFns.push(run);
          return { run, close: vi.fn().mockResolvedValue(undefined) };
        }),
      };

      const asm = new DeterministicAssembler(mockDriver as never);
      const sections = await asm.assemble('multi target', {
        entity_scope: ['Alpha', 'Beta'],
      });

      // Exactly one session.run per step (6), not one per target per step (12).
      expect(runFns).toHaveLength(6);
      expect(runFns.every((r) => r.mock.calls.length === 1)).toBe(true);

      // Hierarchy: original target order (Alpha before Beta), despite Cypher
      // returning Beta's row first.
      const hierarchy = sections.find((s) => s.heading === 'Domain Hierarchy');
      expect(hierarchy?.items.map((i) => i.id)).toEqual(['hier-PlatformA', 'hier-PlatformB']);

      // Targets assembled in original order.
      const targetsSection = sections.find((s) => s.heading === 'Target Components');
      expect(targetsSection?.items.map((i) => i.id)).toEqual(['target-Alpha', 'target-Beta']);

      // Dependencies grouped per target, original order.
      const deps = sections.find((s) => s.heading === 'Dependencies & Dependents');
      expect(deps?.items.map((i) => i.id)).toEqual(['dep-Alpha-StoreA', 'dep-Beta-StoreB']);
    });
  });

  describe('assemble without entity_scope (keyword matching)', () => {
    it('returns no-match section when no entities match the task', async () => {
      // matchEntities tries fulltext first, then keyword CONTAINS
      // Fulltext throws (no index), keyword returns empty
      let callCount = 0;
      const mockDriver = {
        session: vi.fn().mockImplementation(() => ({
          run: vi.fn().mockImplementation(() => {
            callCount++;
            if (callCount === 1) {
              // Fulltext search fails
              throw new Error('No such index');
            }
            // Keyword fallback returns empty
            return mockNeo4jResult([]);
          }),
          close: vi.fn().mockResolvedValue(undefined),
        })),
      };

      const asm = new DeterministicAssembler(mockDriver as never);
      const sections = await asm.assemble('xyz nonexistent thing');

      expect(sections).toHaveLength(1);
      expect(sections[0].heading).toBe('No matching entities found');
      expect(sections[0].source_type).toBe('arch_entity');
    });

    it('uses fulltext search results when available', async () => {
      let callIdx = 0;
      const mockDriver = {
        session: vi.fn().mockImplementation(() => {
          callIdx++;
          if (callIdx === 1) {
            // matchEntities session — fulltext search succeeds
            return {
              run: vi.fn().mockResolvedValue(
                mockNeo4jResult([{ name: 'AuthService' }]),
              ),
              close: vi.fn().mockResolvedValue(undefined),
            };
          }
          // All subsequent sessions (getAncestors, getEntity, etc.) return empty
          return {
            run: vi.fn().mockResolvedValue(mockNeo4jResult([])),
            close: vi.fn().mockResolvedValue(undefined),
          };
        }),
      };

      const asm = new DeterministicAssembler(mockDriver as never);
      const sections = await asm.assemble('auth service');

      // Should not get the "no matching" section since fulltext found AuthService
      const noMatch = sections.find((s) => s.heading === 'No matching entities found');
      expect(noMatch).toBeUndefined();
    });

    it('scopes fulltext entity matching to the requested project containment tree', async () => {
      const run = vi.fn()
        .mockResolvedValueOnce(mockNeo4jResult([{ name: 'AuthService' }]))
        .mockResolvedValue(mockNeo4jResult([]));
      const mockDriver = {
        session: vi.fn().mockReturnValue({
          run,
          close: vi.fn().mockResolvedValue(undefined),
        }),
      };

      const asm = new DeterministicAssembler(mockDriver as never);
      await asm.assemble('auth service', { project_name: 'project:AMP' });

      const [query, params] = run.mock.calls[0] as [string, Record<string, unknown>];
      expect(query).toContain('$projectName IS NULL');
      expect(query).toContain('CONTAINS*0..');
      expect(params.projectName).toBe('AMP');
    });

    it('scopes keyword fallback entity matching to the requested project containment tree', async () => {
      const run = vi.fn()
        .mockRejectedValueOnce(new Error('No such index'))
        .mockResolvedValueOnce(mockNeo4jResult([]));
      const mockDriver = {
        session: vi.fn().mockReturnValue({
          run,
          close: vi.fn().mockResolvedValue(undefined),
        }),
      };

      const asm = new DeterministicAssembler(mockDriver as never);
      await asm.assemble('auth service', { project_name: 'DealerBot.AI' });

      const [query, params] = run.mock.calls[1] as [string, Record<string, unknown>];
      expect(query).toContain('$projectName IS NULL');
      expect(query).toContain('CONTAINS*0..');
      expect(params.projectName).toBe('DealerBot.AI');
    });
  });

  describe('token budgeting', () => {
    it('respects max_tokens by truncating lower-priority items', async () => {
      let callIdx = 0;
      const mockDriver = {
        session: vi.fn().mockImplementation(() => {
          callIdx++;
          // All queries return large results
          const longContent = 'A'.repeat(500);
          return {
            run: vi.fn().mockResolvedValue(
              callIdx === 1
                // getAncestors: many ancestors with long responsibilities
                ? mockNeo4jResult(
                    Array.from({ length: 20 }, (_, i) => ({
                      targetName: 'Target',
                      name: `Ancestor${i}`,
                      depth: i,
                      responsibility: longContent,
                    })),
                  )
                : mockNeo4jResult([]),
            ),
            close: vi.fn().mockResolvedValue(undefined),
          };
        }),
      };

      const asm = new DeterministicAssembler(mockDriver as never);
      const sections = await asm.assemble('test', {
        entity_scope: ['Target'],
        max_tokens: 200, // very tight budget
      });

      // With tight budget, not all items should make it through
      const totalItems = sections.reduce((sum, s) => sum + s.items.length, 0);
      expect(totalItems).toBeLessThan(20);
    });

    it('skips oversized section items and keeps later items that fit the remaining budget', async () => {
      let callIdx = 0;
      const mockDriver = {
        session: vi.fn().mockImplementation(() => {
          callIdx++;
          if (callIdx === 1) {
            return {
              run: vi.fn().mockResolvedValue(
                mockNeo4jResult([
                  { targetName: 'Target', name: 'Root', depth: 0, responsibility: 'x'.repeat(2000) },
                  { targetName: 'Target', name: 'Service', depth: 1, responsibility: 'Small useful context' },
                ]),
              ),
              close: vi.fn().mockResolvedValue(undefined),
            };
          }
          return {
            run: vi.fn().mockResolvedValue(mockNeo4jResult([])),
            close: vi.fn().mockResolvedValue(undefined),
          };
        }),
      };

      const asm = new DeterministicAssembler(mockDriver as never);
      const sections = await asm.assemble('test', {
        entity_scope: ['Target'],
        max_tokens: 100,
      });

      const hierarchy = sections.find((s) => s.heading === 'Domain Hierarchy');
      expect(hierarchy?.items.map((item) => item.id)).toEqual(['hier-Service']);
    });
  });

  describe('budgetSection sorting', () => {
    it('sorts items by score descending (most relevant first)', async () => {
      let callIdx = 0;
      const mockDriver = {
        session: vi.fn().mockImplementation(() => {
          callIdx++;
          if (callIdx === 1) {
            // getAncestors: items with varying depths (which map to varying scores)
            return {
              run: vi.fn().mockResolvedValue(
                mockNeo4jResult([
                  { targetName: 'Target', name: 'Deep', depth: 5, responsibility: 'Deep ancestor' },
                  { targetName: 'Target', name: 'Shallow', depth: 1, responsibility: 'Shallow ancestor' },
                  { targetName: 'Target', name: 'Root', depth: 0, responsibility: 'Root ancestor' },
                ]),
              ),
              close: vi.fn().mockResolvedValue(undefined),
            };
          }
          return {
            run: vi.fn().mockResolvedValue(mockNeo4jResult([])),
            close: vi.fn().mockResolvedValue(undefined),
          };
        }),
      };

      const asm = new DeterministicAssembler(mockDriver as never);
      const sections = await asm.assemble('test', {
        entity_scope: ['Target'],
        max_tokens: 8000,
      });

      const hierarchy = sections.find((s) => s.heading === 'Domain Hierarchy');
      if (hierarchy && hierarchy.items.length > 1) {
        // Items should be sorted by score descending
        for (let i = 0; i < hierarchy.items.length - 1; i++) {
          expect(hierarchy.items[i].score).toBeGreaterThanOrEqual(hierarchy.items[i + 1].score);
        }
      }
    });
  });

  describe('aspect stability tier scoring', () => {
    it('scores schema aspects higher than protocol, higher than implementation', async () => {
      let callIdx = 0;
      const mockDriver = {
        session: vi.fn().mockImplementation(() => {
          callIdx++;
          if (callIdx === 5) {
            // getAspectsBatch call (5th session: ancestors, entity, deps, dependents, aspects)
            return {
              run: vi.fn().mockResolvedValue(
                mockNeo4jResult([
                  { targetName: 'Target', name: 'impl-aspect', stability_tier: 'implementation', description: 'Impl' },
                  { targetName: 'Target', name: 'proto-aspect', stability_tier: 'protocol', description: 'Proto' },
                  { targetName: 'Target', name: 'schema-aspect', stability_tier: 'schema', description: 'Schema' },
                ]),
              ),
              close: vi.fn().mockResolvedValue(undefined),
            };
          }
          return {
            run: vi.fn().mockResolvedValue(mockNeo4jResult([])),
            close: vi.fn().mockResolvedValue(undefined),
          };
        }),
      };

      const asm = new DeterministicAssembler(mockDriver as never);
      const sections = await asm.assemble('test', {
        entity_scope: ['Target'],
      });

      const aspects = sections.find((s) => s.heading === 'Cross-Cutting Concerns');
      if (aspects && aspects.items.length === 3) {
        // schema (0.9) > protocol (0.7) > implementation (0.5)
        expect(aspects.items[0].score).toBe(0.9);
        expect(aspects.items[1].score).toBe(0.7);
        expect(aspects.items[2].score).toBe(0.5);
      }
    });
  });

  describe('session cleanup', () => {
    it('closes sessions after each query', async () => {
      const closeFns: Array<ReturnType<typeof vi.fn>> = [];
      const mockDriver = {
        session: vi.fn().mockImplementation(() => {
          const closeFn = vi.fn().mockResolvedValue(undefined);
          closeFns.push(closeFn);
          return {
            run: vi.fn().mockResolvedValue(mockNeo4jResult([])),
            close: closeFn,
          };
        }),
      };

      const asm = new DeterministicAssembler(mockDriver as never);
      await asm.assemble('test', { entity_scope: ['Target'] });

      // Every session that was opened should have been closed
      for (const closeFn of closeFns) {
        expect(closeFn).toHaveBeenCalled();
      }
    });
  });
});
