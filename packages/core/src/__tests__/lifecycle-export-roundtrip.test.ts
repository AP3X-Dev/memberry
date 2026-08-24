// packages/core/src/__tests__/lifecycle-export-roundtrip.test.ts
//
// MEM-006 export fidelity: the reversible `archived` flag survives the full
// canonical round trip — graph → exportAll (markdown frontmatter) →
// parseFromMarkdown → importFromPath (CREATE into a fresh graph). This is the
// "rollback/export verified" acceptance: archives are excluded from retrieval
// but must NEVER be dropped by export/import.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { exportAll } from '../export.js';
import { importFromPath } from '../import.js';
import { renderToMarkdown, parseFromMarkdown } from '../markdown.js';

const archivedProps = {
  id: 'sem-archived', content: 'Old knowledge past two half-lives.',
  confidence: 0.4, signal_count: 1, decay_class: 'stable',
  created_at: '2025-01-01T00:00:00.000Z', updated_at: '2025-06-01T00:00:00.000Z',
  tags: ['project:lab'], archived: true, archived_at: '2026-01-01T00:00:00.000Z',
};
const plainProps = {
  id: 'sem-live', content: 'Active knowledge.',
  confidence: 0.9, signal_count: 3, decay_class: 'stable',
  created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-02-01T00:00:00.000Z',
  tags: ['project:lab'],
};
const episodicArchivedProps = {
  id: 'ep-archived', session_id: 's1', agent_id: 'a1', task: 'old task',
  content: 'Old episode.', created_at: '2025-03-01T00:00:00.000Z', archived: true,
};

function nodeRecord(key: string, properties: Record<string, unknown>) {
  return { get: (k: string) => (k === key ? { properties } : undefined) };
}

function makeExportDriver() {
  const session = {
    run: vi.fn(async (cypher: string) => {
      if (cypher.includes('(s:Semantic)')) {
        return { records: [nodeRecord('s', archivedProps), nodeRecord('s', plainProps)] };
      }
      if (cypher.includes('(e:Episodic)')) {
        return { records: [nodeRecord('e', episodicArchivedProps)] };
      }
      return { records: [] };
    }),
    close: vi.fn(),
  };
  return { driver: { session: vi.fn(() => session) } as any };
}

function makeImportDriver() {
  const writes: Array<{ cypher: string; params: Record<string, unknown> }> = [];
  const session = {
    run: vi.fn(async (cypher: string, params: Record<string, unknown> = {}) => {
      if (cypher.trim().startsWith('MATCH (s:Semantic) RETURN s')) return { records: [] }; // fresh graph
      writes.push({ cypher, params });
      return { records: [] };
    }),
    close: vi.fn(),
  };
  return { driver: { session: vi.fn(() => session) } as any, writes };
}

const fakeRedis = { smembers: vi.fn(async () => []), pipeline: vi.fn() } as any;

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memberry-lifecycle-rt-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

describe('archived flag round trip', () => {
  it('renderToMarkdown / parseFromMarkdown carry archived only when true', () => {
    const md = renderToMarkdown({ ...archivedProps } as never);
    expect(md).toContain('archived: true');
    expect(parseFromMarkdown(md).archived).toBe(true);

    const plainMd = renderToMarkdown({ ...plainProps } as never);
    expect(plainMd).not.toContain('archived');
    expect(parseFromMarkdown(plainMd).archived).toBeUndefined();
  });

  it('exportAll writes the flag for archived Semantic AND Episodic nodes', async () => {
    const { driver } = makeExportDriver();
    const result = await exportAll(driver, dir);
    expect(result.exported).toBe(3);

    const archivedMd = fs.readFileSync(path.join(dir, 'semantic', 'sem-archived.md'), 'utf8');
    const plainMd = fs.readFileSync(path.join(dir, 'semantic', 'sem-live.md'), 'utf8');
    const episodicMd = fs.readFileSync(path.join(dir, 'episodic', '2025-03-01', 'ep-archived.md'), 'utf8');
    expect(archivedMd).toContain('archived: true');
    expect(plainMd).not.toContain('archived');
    expect(episodicMd).toContain('archived: true');
  });

  it('importFromPath re-creates the archived flag in a fresh graph (archived: true survives)', async () => {
    const { driver: exportDriver } = makeExportDriver();
    await exportAll(exportDriver, dir);

    const { driver: importDriver, writes } = makeImportDriver();
    const result = await importFromPath(importDriver, fakeRedis, dir);
    expect(result.added).toBe(2);
    expect(result.errors).toBe(0);

    const archivedWrite = writes.find((w) => w.params.id === 'sem-archived')!;
    const plainWrite = writes.find((w) => w.params.id === 'sem-live')!;
    expect(archivedWrite.cypher).toContain('archived: $archived');
    expect(archivedWrite.params.archived).toBe(true);
    // Non-archived nodes keep the property ABSENT (null in a CREATE map is dropped).
    expect(plainWrite.params.archived).toBeNull();
  });
});
