// packages/neo4j/src/__tests__/query.regression.test.ts
import { describe, it, expect, vi } from 'vitest';
import neo4j from 'neo4j-driver';
import { ScopedQuery } from '../query.js';

describe('ScopedQuery.rawCypher regression', () => {
  it('rejects oversized direct raw input before scans or database access', async () => {
    const marker = 'private-raw-cypher-content';
    const oversized = `${marker}${'x'.repeat(5001)}`;
    const normalizeSpy = vi.spyOn(String.prototype, 'normalize');
    const replaceSpy = vi.spyOn(String.prototype, 'replace');
    const matchSpy = vi.spyOn(String.prototype, 'match');
    const regexTestSpy = vi.spyOn(RegExp.prototype, 'test');
    const session = {
      run: vi.fn().mockResolvedValue({ records: [] }),
      close: vi.fn().mockResolvedValue(undefined),
    };
    const mockDriver = { session: vi.fn().mockReturnValue(session) };
    const query = new ScopedQuery(mockDriver as never);
    let thrown: unknown;

    await query.rawCypher('MATCH (n) RETURN n', 10);
    expect(normalizeSpy).toHaveBeenCalled();
    expect(replaceSpy).toHaveBeenCalled();
    expect(matchSpy).toHaveBeenCalled();
    expect(regexTestSpy).toHaveBeenCalled();
    expect(mockDriver.session).toHaveBeenCalledTimes(1);
    normalizeSpy.mockClear();
    replaceSpy.mockClear();
    matchSpy.mockClear();
    regexTestSpy.mockClear();
    mockDriver.session.mockClear();

    try {
      await query.rawCypher(oversized, 10);
    } catch (error) {
      thrown = error;
    }

    const scanCounts = {
      normalize: normalizeSpy.mock.calls.length,
      replace: replaceSpy.mock.calls.length,
      match: matchSpy.mock.calls.length,
      regexTest: regexTestSpy.mock.calls.length,
    };
    vi.restoreAllMocks();

    expect(thrown).toEqual(new Error('cypher_input_too_large'));
    expect((thrown as Error).message).not.toContain(marker);
    expect(scanCounts).toEqual({ normalize: 0, replace: 0, match: 0, regexTest: 0 });
    expect(mockDriver.session).not.toHaveBeenCalled();
  });

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
      // OPT-72: every raw query now carries a default transaction timeout.
      expect.objectContaining({ timeout: expect.anything() }),
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
      expect.objectContaining({ timeout: expect.anything() }), // OPT-72 default timeout
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
      expect.objectContaining({ timeout: expect.anything() }), // OPT-72 default timeout
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

  it('OPT-72: applies a DEFAULT bounded transaction timeout when no timeout is given', async () => {
    // OPT-07 only timed the grep path, so berry_query's raw `=~` was unbounded on
    // the shared Neo4j. OPT-72 makes rawCypher bound EVERY raw query by default:
    // a caller that passes no timeoutMs (e.g. berry_query) now still reaches
    // session.run with a transactionConfig carrying the 15s default. (Supersedes
    // the old OPT-07 assertion that no transactionConfig was passed.)
    const prev = process.env.MEMBERRY_RAW_CYPHER_TIMEOUT_MS;
    const prevAmp = process.env.AMP_RAW_CYPHER_TIMEOUT_MS;
    delete process.env.MEMBERRY_RAW_CYPHER_TIMEOUT_MS;
    delete process.env.AMP_RAW_CYPHER_TIMEOUT_MS;
    try {
      const session = {
        run: vi.fn().mockResolvedValue({ records: [] }),
        close: vi.fn().mockResolvedValue(undefined),
      };
      const mockDriver = { session: vi.fn().mockReturnValue(session) };

      const query = new ScopedQuery(mockDriver as never);
      await query.rawCypher('MATCH (s:Semantic) RETURN s', 10);

      expect(session.run).toHaveBeenCalledTimes(1);
      expect(session.run.mock.calls[0]).toHaveLength(3); // cypher, params, transactionConfig
      expect(session.run).toHaveBeenCalledWith(
        expect.any(String),
        {},
        expect.objectContaining({ timeout: neo4j.int(15000) }), // the default
      );
    } finally {
      if (prev === undefined) delete process.env.MEMBERRY_RAW_CYPHER_TIMEOUT_MS; else process.env.MEMBERRY_RAW_CYPHER_TIMEOUT_MS = prev;
      if (prevAmp === undefined) delete process.env.AMP_RAW_CYPHER_TIMEOUT_MS; else process.env.AMP_RAW_CYPHER_TIMEOUT_MS = prevAmp;
    }
  });

  it('OPT-72: an explicit timeoutMs still overrides the default (grep path)', async () => {
    const session = {
      run: vi.fn().mockResolvedValue({ records: [] }),
      close: vi.fn().mockResolvedValue(undefined),
    };
    const mockDriver = { session: vi.fn().mockReturnValue(session) };
    const query = new ScopedQuery(mockDriver as never);
    await query.rawCypher('MATCH (s:Semantic) WHERE s.content =~ $rx RETURN s', 10, { rx: '.*' }, 2000);

    expect(session.run).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ rx: '.*' }),
      expect.objectContaining({ timeout: neo4j.int(2000) }), // explicit grep bound, not the 15s default
    );
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
