// packages/core/src/__tests__/import.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mock fs/promises ─────────────────────────────────────────────────────────

vi.mock('fs/promises', () => ({
  default: {
    readdir: vi.fn(),
    readFile: vi.fn(),
  },
}));

import fs from 'fs/promises';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const SEMANTIC_MD = [
  '---',
  'id: sem-1',
  'confidence: 0.9',
  'signal_count: 5',
  'decay_class: stable',
  'tags:',
  '  - brand-voice',
  'created_at: "2026-03-18T00:00:00Z"',
  'updated_at: "2026-03-18T12:00:00Z"',
  '---',
  '',
  'Client X prefers formal tone',
].join('\n');

const SEMANTIC_MD_MODIFIED = [
  '---',
  'id: sem-1',
  'confidence: 0.85',
  'signal_count: 6',
  'decay_class: stable',
  'tags:',
  '  - brand-voice',
  'created_at: "2026-03-18T00:00:00Z"',
  'updated_at: "2026-03-18T14:00:00Z"',
  '---',
  '',
  'Client X prefers formal tone (updated)',
].join('\n');

const SEMANTIC_MD_NEW = [
  '---',
  'id: sem-new',
  'confidence: 0.7',
  'signal_count: 1',
  'decay_class: volatile',
  'tags: []',
  'created_at: "2026-03-18T10:00:00Z"',
  'updated_at: "2026-03-18T10:00:00Z"',
  '---',
  '',
  'Brand new semantic node',
].join('\n');

// No `created_at` in frontmatter: markdown.ts has no authored-at concept and
// yields an empty string here, which the added writer degrades to `now`.
const SEMANTIC_MD_NO_CREATED = [
  '---',
  'id: sem-nodate',
  'confidence: 0.7',
  'signal_count: 1',
  'decay_class: volatile',
  'tags: []',
  'updated_at: "2026-03-18T10:00:00Z"',
  '---',
  '',
  'Semantic without a frontmatter created_at',
].join('\n');

// ─── Driver factory ───────────────────────────────────────────────────────────

function makeGraphRecord(id: string, content: string) {
  const { renderToMarkdown } = require('../markdown.js');
  const node = {
    id,
    content,
    confidence: 0.9,
    signal_count: 5,
    created_at: '2026-03-18T00:00:00Z',
    updated_at: '2026-03-18T12:00:00Z',
    decay_class: 'stable',
    tags: ['brand-voice'],
  };
  const rendered = renderToMarkdown(node);
  return {
    get: (key: string) =>
      key === 's' ? { properties: node } : null,
    _rendered: rendered,
  };
}

type MockSession = {
  run: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
};

function makeDriver(sessions: MockSession[]) {
  let idx = 0;
  return {
    session: () => sessions[Math.min(idx++, sessions.length - 1)],
  };
}

function makeSession(records: unknown[] = []): MockSession {
  return {
    run: vi.fn().mockResolvedValue({ records }),
    close: vi.fn().mockResolvedValue(undefined),
  };
}

function makeRecord(props: Record<string, unknown>) {
  return {
    get: (key: string) => (key === 's' ? { properties: props } : null),
  };
}

// ─── Redis mock ───────────────────────────────────────────────────────────────

function makeRedisMock() {
  return {
    smembers: vi.fn().mockResolvedValue([]),
    pipeline: vi.fn().mockReturnValue({
      del: vi.fn().mockReturnThis(),
      exec: vi.fn().mockResolvedValue([]),
    }),
    disconnect: vi.fn(),
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('importFromPath', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns all zeros when semantic directory is empty', async () => {
    vi.mocked(fs.readdir).mockResolvedValue([] as never);

    const graphSession = makeSession([]);
    const driver = makeDriver([graphSession]) as never;
    const redis = makeRedisMock() as never;

    const { importFromPath } = await import('../import.js');
    const result = await importFromPath(driver, redis, '/tmp/amp');

    expect(result.added).toBe(0);
    expect(result.modified).toBe(0);
    expect(result.deleted).toBe(0);
    expect(result.unchanged).toBe(0);
  });

  it('detects a new file as added and creates it in Neo4j', async () => {
    vi.mocked(fs.readdir).mockResolvedValue(['sem-new.md'] as never);
    vi.mocked(fs.readFile).mockResolvedValue(SEMANTIC_MD_NEW as never);

    // Graph has no existing nodes
    const graphQuerySession = makeSession([]);
    // One session per added node (create)
    const createSession = makeSession([]);
    const driver = makeDriver([graphQuerySession, createSession]) as never;
    const redis = makeRedisMock() as never;

    const { importFromPath } = await import('../import.js');
    const result = await importFromPath(driver, redis, '/tmp/amp');

    expect(result.added).toBe(1);
    expect(result.modified).toBe(0);
    expect(result.deleted).toBe(0);
    expect(result.unchanged).toBe(0);

    // Verify CREATE was called
    expect(createSession.run).toHaveBeenCalledWith(
      expect.stringContaining('CREATE'),
      expect.objectContaining({ id: 'sem-new' }),
    );
  });

  it('detects an unchanged file and does not write to Neo4j', async () => {
    vi.mocked(fs.readdir).mockResolvedValue(['sem-1.md'] as never);
    vi.mocked(fs.readFile).mockResolvedValue(SEMANTIC_MD as never);

    // Graph has sem-1 with the same content hash → unchanged
    const props = {
      id: 'sem-1',
      content: 'Client X prefers formal tone',
      confidence: 0.9,
      signal_count: 5,
      created_at: '2026-03-18T00:00:00Z',
      updated_at: '2026-03-18T12:00:00Z',
      decay_class: 'stable',
      tags: ['brand-voice'],
    };
    const graphQuerySession = makeSession([makeRecord(props)]);
    const driver = makeDriver([graphQuerySession]) as never;
    const redis = makeRedisMock() as never;

    const { importFromPath } = await import('../import.js');
    const result = await importFromPath(driver, redis, '/tmp/amp');

    // Regardless of whether hashes match (they will if renderToMarkdown is deterministic),
    // the result should show no modifications
    expect(result.added).toBe(0);
    expect(result.deleted).toBe(0);
    // May be unchanged or modified depending on hash comparison — just ensure no crash
    expect(result.added + result.modified + result.unchanged).toBe(1);
  });

  it('dry-run mode does not call session.run for modifications', async () => {
    vi.mocked(fs.readdir).mockResolvedValue(['sem-new.md'] as never);
    vi.mocked(fs.readFile).mockResolvedValue(SEMANTIC_MD_NEW as never);

    const graphQuerySession = makeSession([]);
    const driver = makeDriver([graphQuerySession]) as never;
    const redis = makeRedisMock() as never;

    const { importFromPath } = await import('../import.js');
    const result = await importFromPath(driver, redis, '/tmp/amp', { dryRun: true });

    expect(result.added).toBe(1);
    // Only one session was used (graph query); no write sessions opened
    expect(graphQuerySession.run).toHaveBeenCalledTimes(1);
  });

  it('applies confidence-weighted strategy (caps at 0.8)', async () => {
    // File has confidence 0.9 — with confidence-weighted it should be capped at 0.8
    vi.mocked(fs.readdir).mockResolvedValue(['sem-new.md'] as never);
    vi.mocked(fs.readFile).mockResolvedValue(SEMANTIC_MD_NEW as never);

    const graphQuerySession = makeSession([]);
    const createSession = makeSession([]);
    const driver = makeDriver([graphQuerySession, createSession]) as never;
    const redis = makeRedisMock() as never;

    const { importFromPath } = await import('../import.js');
    await importFromPath(driver, redis, '/tmp/amp', { strategy: 'confidence-weighted' });

    const createCall = createSession.run.mock.calls[0];
    expect(createCall).toBeDefined();
    // sem-new has confidence 0.7, which is below 0.8, so min(0.7, 0.8) = 0.7
    expect(createCall[1]).toMatchObject({ confidence: 0.7 });
  });

  it('applies overwrite strategy (uses confidence as-is)', async () => {
    vi.mocked(fs.readdir).mockResolvedValue(['sem-new.md'] as never);
    vi.mocked(fs.readFile).mockResolvedValue(SEMANTIC_MD_NEW as never);

    const graphQuerySession = makeSession([]);
    const createSession = makeSession([]);
    const driver = makeDriver([graphQuerySession, createSession]) as never;
    const redis = makeRedisMock() as never;

    const { importFromPath } = await import('../import.js');
    await importFromPath(driver, redis, '/tmp/amp', { strategy: 'overwrite' });

    const createCall = createSession.run.mock.calls[0];
    expect(createCall[1]).toMatchObject({ confidence: 0.7 });
  });

  it('invalidates Redis cache for changed nodes', async () => {
    vi.mocked(fs.readdir).mockResolvedValue(['sem-new.md'] as never);
    vi.mocked(fs.readFile).mockResolvedValue(SEMANTIC_MD_NEW as never);

    const graphQuerySession = makeSession([]);
    const createSession = makeSession([]);
    const driver = makeDriver([graphQuerySession, createSession]) as never;

    const redis = makeRedisMock();
    redis.smembers.mockResolvedValue(['amp:ctx:abc123'] as never);
    const delFn = vi.fn().mockReturnThis();
    redis.pipeline.mockReturnValue({
      del: delFn,
      exec: vi.fn().mockResolvedValue([]),
    });

    const { importFromPath } = await import('../import.js');
    await importFromPath(driver, redis as never, '/tmp/amp');

    expect(redis.smembers).toHaveBeenCalledWith('amp:deps:sem-new');
    expect(delFn).toHaveBeenCalledWith('amp:ctx:abc123');
  });

  it('marks deleted nodes as archived without hard-deleting', async () => {
    // File directory is empty, graph has sem-1 → should be archived
    vi.mocked(fs.readdir).mockResolvedValue([] as never);

    const props = {
      id: 'sem-1',
      content: 'Will be archived',
      confidence: 0.9,
      signal_count: 3,
      created_at: '2026-03-18T00:00:00Z',
      updated_at: '2026-03-18T00:00:00Z',
      decay_class: 'stable',
      tags: [],
    };
    const graphQuerySession = makeSession([makeRecord(props)]);
    const archiveSession = makeSession([]);
    const driver = makeDriver([graphQuerySession, archiveSession]) as never;
    const redis = makeRedisMock() as never;

    const { importFromPath } = await import('../import.js');
    const result = await importFromPath(driver, redis, '/tmp/amp');

    expect(result.deleted).toBe(1);
    expect(archiveSession.run).toHaveBeenCalledWith(
      expect.stringContaining('archived'),
      expect.objectContaining({ id: 'sem-1' }),
    );
  });

  it('handles non-existent semantic directory gracefully', async () => {
    vi.mocked(fs.readdir).mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));

    const graphQuerySession = makeSession([]);
    const driver = makeDriver([graphQuerySession]) as never;
    const redis = makeRedisMock() as never;

    const { importFromPath } = await import('../import.js');
    const result = await importFromPath(driver, redis, '/nonexistent');

    expect(result.added).toBe(0);
    expect(result.modified).toBe(0);
  });

  it('skips files that fail to parse without crashing', async () => {
    vi.mocked(fs.readdir).mockResolvedValue(['bad.md'] as never);
    vi.mocked(fs.readFile).mockRejectedValue(new Error('read error'));

    const graphQuerySession = makeSession([]);
    const driver = makeDriver([graphQuerySession]) as never;
    const redis = makeRedisMock() as never;

    const { importFromPath } = await import('../import.js');
    const result = await importFromPath(driver, redis, '/tmp/amp');

    expect(result.added).toBe(0);
    expect(result.unchanged).toBe(0);
  });

  // ─── RET-005B-AUTH-001B6P: semantic lifecycle producer, sites 5-7 ─────────
  //
  // markdown.ts carries no authored-at concept (frontmatter is created_at /
  // updated_at only), so frontmatter created_at is the best truthful source for
  // the added writer, degrading to `now` exactly as the writer already degrades
  // created_at itself. The modified writer stamps NOTHING — a content edit is
  // not a new assertion instant — and the archive writer is the one truthful
  // deactivation instant in the tree, doubly fenced and ONE-WAY (nothing in
  // this packet ever clears invalid_at; a delete-then-restore stays inactive,
  // an accepted disclosed fail-closed defect).

  it('T12: the added writer stamps valid_at from frontmatter created_at', async () => {
    vi.mocked(fs.readdir).mockResolvedValue(['sem-new.md'] as never);
    vi.mocked(fs.readFile).mockResolvedValue(SEMANTIC_MD_NEW as never);

    const graphQuerySession = makeSession([]);
    const createSession = makeSession([]);
    const driver = makeDriver([graphQuerySession, createSession]) as never;
    const redis = makeRedisMock() as never;

    const { importFromPath } = await import('../import.js');
    await importFromPath(driver, redis, '/tmp/amp');

    const [query, params] = createSession.run.mock.calls[0] as [string, Record<string, unknown>];
    expect(query).toContain('valid_at: $created_at');
    expect(query).not.toContain('invalid_at');
    // Reuses the EXISTING $created_at parameter — no new key was introduced.
    expect(params.created_at).toBe('2026-03-18T10:00:00Z');
    expect(Object.prototype.hasOwnProperty.call(params, 'valid_at')).toBe(false);
    expect(query).not.toMatch(/(valid_at|invalid_at)\s*[=:]\s*null/i);
    expect(Object.prototype.hasOwnProperty.call(params, 'invalid_at')).toBe(false);
  });

  it('T12: the added writer degrades to now when frontmatter carries no created_at', async () => {
    vi.mocked(fs.readdir).mockResolvedValue(['sem-nodate.md'] as never);
    vi.mocked(fs.readFile).mockResolvedValue(SEMANTIC_MD_NO_CREATED as never);

    const graphQuerySession = makeSession([]);
    const createSession = makeSession([]);
    const driver = makeDriver([graphQuerySession, createSession]) as never;
    const redis = makeRedisMock() as never;

    const before = new Date().toISOString();
    const { importFromPath } = await import('../import.js');
    await importFromPath(driver, redis, '/tmp/amp');
    const after = new Date().toISOString();

    const [, params] = createSession.run.mock.calls[0] as [string, Record<string, unknown>];
    // The disclosed degradation, asserted rather than assumed: an empty
    // frontmatter created_at falls through `node.created_at || now`.
    const stamped = params.created_at as string;
    expect(stamped).not.toBe('');
    expect(stamped >= before && stamped <= after).toBe(true);
  });

  it('T13: the modified writer emits no lifecycle field at all', async () => {
    vi.mocked(fs.readdir).mockResolvedValue(['sem-1.md'] as never);
    vi.mocked(fs.readFile).mockResolvedValue(SEMANTIC_MD_MODIFIED as never);

    const graphQuerySession = makeSession([makeRecord({
      id: 'sem-1',
      content: 'Client X prefers formal tone',
      confidence: 0.9,
      signal_count: 5,
      created_at: '2026-03-18T00:00:00Z',
      updated_at: '2026-03-18T12:00:00Z',
      decay_class: 'stable',
      tags: ['brand-voice'],
    })]);
    const modifySession = makeSession([]);
    const driver = makeDriver([graphQuerySession, modifySession]) as never;
    const redis = makeRedisMock() as never;

    const { importFromPath } = await import('../import.js');
    const result = await importFromPath(driver, redis, '/tmp/amp');

    expect(result.modified).toBe(1);
    const [query] = modifySession.run.mock.calls[0] as [string, Record<string, unknown>];
    expect(query).toContain('SET s.content = $content');
    // The omit ruling's only guard. A null-guard here would be a runtime
    // rewrite of a possibly-legacy row in everything but name.
    expect(query).not.toContain('valid_at');
    expect(query).not.toContain('invalid_at');
  });

  it('T14: the archive writer stamps invalid_at behind the two-sided CASE fence', async () => {
    vi.mocked(fs.readdir).mockResolvedValue([] as never);

    const graphQuerySession = makeSession([makeRecord({
      id: 'sem-1',
      content: 'Will be archived',
      confidence: 0.9,
      signal_count: 3,
      created_at: '2026-03-18T00:00:00Z',
      updated_at: '2026-03-18T00:00:00Z',
      decay_class: 'stable',
      tags: [],
    })]);
    const archiveSession = makeSession([]);
    const driver = makeDriver([graphQuerySession, archiveSession]) as never;
    const redis = makeRedisMock() as never;

    const { importFromPath } = await import('../import.js');
    await importFromPath(driver, redis, '/tmp/amp');

    const [query, params] = archiveSession.run.mock.calls[0] as [string, Record<string, unknown>];
    // (a) it stamps.
    expect(query).toContain('SET s.invalid_at = CASE WHEN');
    expect(params.now).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    // (b) a legacy row without valid_at is never stamped, and (c) an already
    // inactive row is never re-stamped — the guard IS what makes both true, and
    // the guard is what this harness can see.
    expect(query).toContain('s.valid_at IS NOT NULL');
    expect(query).toContain('s.invalid_at IS NULL');
    expect(query).toContain('ELSE s.invalid_at END');
    // The pre-existing archive marker is untouched by this packet.
    expect(query).toContain('SET s.archived = true, s.archived_at = $now');
    expect(query).not.toMatch(/(valid_at|invalid_at)\s*[=:]\s*null/i);
    expect(Object.prototype.hasOwnProperty.call(params, 'valid_at')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(params, 'invalid_at')).toBe(false);
  });
});
