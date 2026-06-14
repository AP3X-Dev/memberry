// packages/mcp/src/__tests__/tenant-datastores.opt37.test.ts
//
// OPT-37: MEMBERRY_TENANT_DATASTORES was JSON.parsed but not shape-validated.
// A non-object value (a string is iterated char-by-char by Object.entries) or an
// entry missing neo4jUri/neo4jPassword/redisUrl would silently construct a core
// pointing at the localhost DEFAULTS — i.e. the SHARED instance — so a tenant the
// operator believed was physically isolated would be colocated. parseTenantDatastores
// now fails closed on any malformed input.
import { describe, it, expect } from 'vitest';
import { parseTenantDatastores } from '../bootstrap.js';

const VALID = JSON.stringify({
  acme: {
    neo4jUri: 'bolt://acme-neo4j:7687',
    neo4jPassword: 'acme-pw',
    redisUrl: 'redis://acme-redis:6379',
  },
  globex: {
    neo4jUri: 'bolt://globex-neo4j:7687',
    neo4jUser: 'globex',
    neo4jPassword: 'globex-pw',
    redisUrl: 'redis://globex-redis:6379',
    openaiKey: 'sk-globex',
  },
});

describe('parseTenantDatastores (OPT-37 shape validation)', () => {
  it('returns {} for unset / empty', () => {
    expect(parseTenantDatastores(undefined)).toEqual({});
    expect(parseTenantDatastores('')).toEqual({});
  });

  it('accepts a well-formed map and returns the validated config', () => {
    const out = parseTenantDatastores(VALID);
    expect(Object.keys(out)).toEqual(['acme', 'globex']);
    expect(out.acme).toMatchObject({
      neo4jUri: 'bolt://acme-neo4j:7687',
      neo4jPassword: 'acme-pw',
      redisUrl: 'redis://acme-redis:6379',
    });
    expect(out.globex.neo4jUser).toBe('globex');
    expect(out.globex.openaiKey).toBe('sk-globex');
  });

  it('throws on invalid JSON', () => {
    expect(() => parseTenantDatastores('{not json')).toThrow(/not valid JSON/);
  });

  it('throws on a non-object root (the old char-iteration footgun)', () => {
    // Before OPT-37, JSON.parse('"acme"') → "acme" and Object.entries iterated
    // its characters, mapping bogus single-char "tenants" onto localhost.
    for (const bad of ['"acme"', '42', 'true', 'null', '[{"neo4jUri":"x"}]']) {
      expect(() => parseTenantDatastores(bad)).toThrow(/must be a JSON object/);
    }
  });

  it('throws when an entry is missing a required field (neo4jUri / neo4jPassword / redisUrl)', () => {
    expect(() =>
      parseTenantDatastores(JSON.stringify({ acme: { neo4jPassword: 'p', redisUrl: 'r' } })),
    ).toThrow(/malformed.*neo4jUri/s);
    expect(() =>
      parseTenantDatastores(JSON.stringify({ acme: { neo4jUri: 'u', redisUrl: 'r' } })),
    ).toThrow(/malformed.*neo4jPassword/s);
    expect(() =>
      parseTenantDatastores(JSON.stringify({ acme: { neo4jUri: 'u', neo4jPassword: 'p' } })),
    ).toThrow(/malformed.*redisUrl/s);
  });

  it('throws on an empty-string required field (no silent localhost fallback)', () => {
    expect(() =>
      parseTenantDatastores(JSON.stringify({ acme: { neo4jUri: '', neo4jPassword: 'p', redisUrl: 'r' } })),
    ).toThrow(/malformed/);
  });

  it('rejects unknown/typo\'d keys (.strict)', () => {
    expect(() =>
      parseTenantDatastores(
        JSON.stringify({ acme: { neo4jUri: 'u', neo4jPassword: 'p', redisUrl: 'r', neo4jURL: 'typo' } }),
      ),
    ).toThrow(/malformed/);
  });

  it('does NOT echo a secret value in the error message (log safety)', () => {
    // redisUrl is the wrong type → validation fails, but the present password
    // must not appear in the thrown message (it reports the key path only).
    let msg = '';
    try {
      parseTenantDatastores(
        JSON.stringify({ acme: { neo4jUri: 'u', neo4jPassword: 'SUPERSECRET', redisUrl: 123 } }),
      );
    } catch (e) {
      msg = e instanceof Error ? e.message : String(e);
    }
    expect(msg).toMatch(/malformed/);
    expect(msg).toContain('redisUrl');
    expect(msg).not.toContain('SUPERSECRET');
  });
});
