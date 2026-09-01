import neo4j from 'neo4j-driver';
import { describe, expect, it, vi } from 'vitest';
import {
  ProjectScopeResolver,
  ScopedEntityResolverError,
} from '../scoped-entity-resolver.js';

function record(row: Readonly<Record<string, unknown>>) {
  const keys = Object.keys(row);
  return new neo4j.Record(keys, keys.map((key) => row[key]));
}

function fakeDriver(rows: ReadonlyArray<Readonly<Record<string, unknown>>>) {
  const run = vi.fn().mockResolvedValue({ records: rows.map(record) });
  const close = vi.fn().mockResolvedValue(undefined);
  const session = vi.fn(() => ({ run, close }));
  return { driver: { session } as never, session, run, close };
}

describe('ProjectScopeResolver', () => {
  it('maps a safe display-derived hint to bootstrap-owned canonical scope', async () => {
    const fake = fakeDriver([{
      projectId: 'ent-YOX6g9puSeht',
      canonicalProjectScope: 'project:dealerbot',
    }]);

    await expect(new ProjectScopeResolver(fake.driver, 'default')
      .resolve('project:dealerbot3-0')).resolves.toBe('project:dealerbot');

    expect(fake.session).toHaveBeenCalledWith({ defaultAccessMode: neo4j.session.READ });
    expect(fake.run).toHaveBeenCalledWith(
      expect.stringContaining('project.project_scope = $projectHint'),
      {
        projectHint: 'project:dealerbot3-0',
        tenantId: 'default',
        defaultTenant: 'default',
      },
      { timeout: 3_000 },
    );
    const query = fake.run.mock.calls[0]![0] as string;
    expect(query).toContain('MATCH (tenantProject:Entity {tenant_id: $tenantId})');
    expect(query).toContain('legacyProject.tenant_id IS NULL');
    expect(query).not.toContain('aliases');
    expect(query).not.toMatch(/\b(?:CREATE|MERGE|SET|DELETE|DETACH|REMOVE|DROP)\b/i);
    expect(fake.close).toHaveBeenCalledTimes(1);
  });

  it('preserves legacy display-name derivation when project_scope is absent', async () => {
    const fake = fakeDriver([{
      projectId: 'legacy-project',
      canonicalProjectScope: 'project:guardrail-control-plane',
    }]);

    await expect(new ProjectScopeResolver(fake.driver, 'default')
      .resolve('project:guardrail-control-plane'))
      .resolves.toBe('project:guardrail-control-plane');
  });

  it('returns undefined for an unknown root and rejects ambiguous authority', async () => {
    const missing = fakeDriver([]);
    await expect(new ProjectScopeResolver(missing.driver, 'default')
      .resolve('project:missing')).resolves.toBeUndefined();

    const duplicate = fakeDriver([
      { projectId: 'project-a', canonicalProjectScope: 'project:dealerbot' },
      { projectId: 'project-b', canonicalProjectScope: 'project:dealerbot' },
    ]);
    await expect(new ProjectScopeResolver(duplicate.driver, 'default')
      .resolve('project:dealerbot3-0')).rejects.toMatchObject<Partial<ScopedEntityResolverError>>({
        code: 'invalid_record',
      });
  });

  it('rejects malformed scope hints before opening a session', async () => {
    const fake = fakeDriver([]);
    await expect(new ProjectScopeResolver(fake.driver, 'default')
      .resolve('project:dealerbot/foreign')).rejects.toMatchObject<Partial<ScopedEntityResolverError>>({
        code: 'invalid_authority',
      });
    expect(fake.session).not.toHaveBeenCalled();
  });
});
