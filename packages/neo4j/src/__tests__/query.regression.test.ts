// packages/neo4j/src/__tests__/query.regression.test.ts
import { describe, it, expect, vi } from 'vitest';
import neo4j from 'neo4j-driver';
import { ScopedQuery } from '../query.js';

describe('ScopedQuery.rawCypher regression', () => {
  it('enforces the caller limit even when user Cypher already includes a larger LIMIT', async () => {
    const session = {
      run: vi.fn().mockResolvedValue({ records: [] }),
      close: vi.fn().mockResolvedValue(undefined),
    };
    const mockDriver = {
      session: vi.fn().mockReturnValue(session),
    };

    const query = new ScopedQuery(mockDriver as never);
    await query.rawCypher('MATCH (s:Semantic) RETURN s LIMIT 1000000', 25);

    expect(session.run).toHaveBeenCalledWith(
      expect.stringMatching(/RETURN \* LIMIT 25\s*$/),
      {},
    );
  });

  it('caps oversized caller limits before building the outer LIMIT', async () => {
    const session = {
      run: vi.fn().mockResolvedValue({ records: [] }),
      close: vi.fn().mockResolvedValue(undefined),
    };
    const mockDriver = {
      session: vi.fn().mockReturnValue(session),
    };

    const query = new ScopedQuery(mockDriver as never);
    await query.rawCypher('MATCH (s:Semantic) RETURN s', 1000000);

    expect(session.run).toHaveBeenCalledWith(
      expect.stringMatching(/RETURN \* LIMIT 100\s*$/),
      {},
    );
  });

  it('passes parameter maps through to Neo4j session.run', async () => {
    const session = {
      run: vi.fn().mockResolvedValue({ records: [] }),
      close: vi.fn().mockResolvedValue(undefined),
    };
    const mockDriver = {
      session: vi.fn().mockReturnValue(session),
    };
    const params = { grepPatternLower: "jwt' or 1=1", grepScope: "project:amp' or true" };

    const query = new ScopedQuery(mockDriver as never);
    await query.rawCypher(
      'MATCH (s:Semantic) WHERE toLower(s.content) CONTAINS $grepPatternLower AND $grepScope IN s.tags RETURN s',
      10,
      params,
    );

    expect(session.run).toHaveBeenCalledWith(
      expect.stringContaining('$grepPatternLower'),
      params,
    );
  });

  it('OPT-07: passes a bounded transaction timeout to session.run when timeoutMs is provided', async () => {
    // SECURITY (OPT-07): a runaway server-side regex (=~) must self-abort instead
    // of pinning the shared Neo4j instance. The grep path passes a transaction
    // timeout (3rd arg to session.run); the driver aborts the tx when it elapses.
    const session = {
      run: vi.fn().mockResolvedValue({ records: [] }),
      close: vi.fn().mockResolvedValue(undefined),
    };
    const mockDriver = {
      session: vi.fn().mockReturnValue(session),
    };

    const query = new ScopedQuery(mockDriver as never);
    await query.rawCypher('MATCH (s:Semantic) WHERE s.content =~ $rx RETURN s', 10, { rx: '(?i).*x.*' }, 5000);

    expect(session.run).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ rx: '(?i).*x.*' }),
      expect.objectContaining({ timeout: neo4j.int(5000) }),
    );
  });

  it('OPT-07: omits the transactionConfig arg entirely when no timeout is given (no regression)', async () => {
    const session = {
      run: vi.fn().mockResolvedValue({ records: [] }),
      close: vi.fn().mockResolvedValue(undefined),
    };
    const mockDriver = {
      session: vi.fn().mockReturnValue(session),
    };

    const query = new ScopedQuery(mockDriver as never);
    await query.rawCypher('MATCH (s:Semantic) RETURN s', 10);

    // Default callers (berry_query) must reach session.run with exactly two args —
    // no third transactionConfig — so their timeout behaviour is unchanged.
    expect(session.run).toHaveBeenCalledTimes(1);
    expect(session.run.mock.calls[0]).toHaveLength(2);
  });

  it('BUG-0001: rawCypher rejects mutating Cypher queries before reaching the database', async () => {
    // Before the fix, rawCypher passed user-supplied Cypher directly to Neo4j
    // with no sanitization. Any MCP client could execute destructive queries
    // like DETACH DELETE or CALL dbms.listConfig(). The fix adds
    // validateReadOnlyCypher() which throws on mutating keywords.

    const mockDriver = {
      session: vi.fn(),
    };

    const query = new ScopedQuery(mockDriver as never);

    // Destructive: wipe database
    await expect(query.rawCypher('MATCH (n) DETACH DELETE n', 10)).rejects.toThrow(
      /Cypher validation failed/,
    );

    // Credential exfiltration via stored procedure
    await expect(query.rawCypher('CALL dbms.listConfig()', 10)).rejects.toThrow(
      /CALL to a stored procedure/,
    );

    // Data mutation via CREATE
    await expect(query.rawCypher('CREATE (n:Pwned {data: "injected"})', 10)).rejects.toThrow(
      /mutating keyword "CREATE"/,
    );

    // session() should never have been called — validation happens before DB access
    expect(mockDriver.session).not.toHaveBeenCalled();
  });
});
