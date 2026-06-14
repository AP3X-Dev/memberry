// packages/mcp/src/__tests__/parse-token-pairs.test.ts
//
// OPT-30: MEMBERRY_API_TOKENS / MEMBERRY_TENANT_TOKENS are parsed by splitting on
// ',' then the first ':'. Previously malformed/empty/oversized entries were
// dropped SILENTLY, which masked typos and could silently disable auth or
// multi-tenant mode. parseTokenPairs now validates token length and WARNS on
// every skipped entry (and on a non-empty var that yields zero valid pairs —
// this also covers OPT-38).
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  parseTokenPairs,
  MIN_API_TOKEN_LEN,
  MAX_API_TOKEN_LEN,
} from '../server.js';

/** Collect the (name, token) pairs parseTokenPairs accepts into a Map. */
function collect(raw: string | undefined, varName = 'MEMBERRY_API_TOKENS'): Map<string, string> {
  const out = new Map<string, string>();
  parseTokenPairs(raw, varName, (name, token) => out.set(name, token));
  return out;
}

describe('parseTokenPairs (OPT-30 token-parse validation)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('accepts well-formed name:token pairs', () => {
    const warn = vi.spyOn(console, 'error').mockImplementation(() => {});
    const out = collect('alice:tok-alice,bob:tok-bob');
    expect(out.get('alice')).toBe('tok-alice');
    expect(out.get('bob')).toBe('tok-bob');
    expect(out.size).toBe(2);
    expect(warn).not.toHaveBeenCalled(); // no skips, no zero-pairs warning
  });

  it('returns nothing and warns nothing for an unset var', () => {
    const warn = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(collect(undefined).size).toBe(0);
    expect(collect('').size).toBe(0);
    expect(warn).not.toHaveBeenCalled();
  });

  it('tolerates empty/trailing commas silently but keeps the valid pairs', () => {
    const warn = vi.spyOn(console, 'error').mockImplementation(() => {});
    const out = collect('alice:tok-alice,,bob:tok-bob,');
    expect(out.size).toBe(2);
    expect(warn).not.toHaveBeenCalled(); // blank entries are not "malformed"
  });

  it('skips a malformed entry (no colon) WITH a warning', () => {
    const warn = vi.spyOn(console, 'error').mockImplementation(() => {});
    const out = collect('alice:tok-alice,not-a-pair,bob:tok-bob');
    expect([...out.keys()]).toEqual(['alice', 'bob']);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatch(/skipping malformed entry #2/);
  });

  it('skips an entry with an empty name or empty token WITH a warning', () => {
    const warn = vi.spyOn(console, 'error').mockImplementation(() => {});
    const out = collect(':tok-orphan,bob:,carol:tok-carol');
    expect([...out.keys()]).toEqual(['carol']);
    expect(warn).toHaveBeenCalledTimes(2); // the two bad entries
  });

  it('skips a token shorter than MIN_API_TOKEN_LEN WITH a warning naming the entry (not the token)', () => {
    const warn = vi.spyOn(console, 'error').mockImplementation(() => {});
    const shortTok = 'a'.repeat(MIN_API_TOKEN_LEN - 1);
    const out = collect(`alice:${shortTok},bob:tok-bob`);
    expect([...out.keys()]).toEqual(['bob']);
    expect(warn).toHaveBeenCalledTimes(1);
    const msg = warn.mock.calls[0][0] as string;
    expect(msg).toMatch(/token length/);
    expect(msg).toContain('alice'); // names are not secret; tokens must not be logged
    expect(msg).not.toContain(shortTok);
  });

  it('skips a token longer than MAX_API_TOKEN_LEN WITH a warning', () => {
    const warn = vi.spyOn(console, 'error').mockImplementation(() => {});
    const longTok = 'a'.repeat(MAX_API_TOKEN_LEN + 1);
    const out = collect(`alice:${longTok}`);
    expect(out.size).toBe(0);
    // one length-skip warning + the zero-valid-pairs warning
    expect(warn).toHaveBeenCalledTimes(2);
    expect((warn.mock.calls.at(-1)![0] as string)).toMatch(/ZERO valid/);
  });

  it('warns when a non-empty var yields ZERO valid pairs (covers OPT-38)', () => {
    const warn = vi.spyOn(console, 'error').mockImplementation(() => {});
    const out = collect('garbage-without-colons');
    expect(out.size).toBe(0);
    const msgs = warn.mock.calls.map((c) => c[0] as string);
    expect(msgs.some((m) => /skipping malformed entry/.test(m))).toBe(true);
    expect(msgs.some((m) => /ZERO valid "name:token" pairs/.test(m))).toBe(true);
  });

  it('surfaces a comma-containing token as corruption rather than accepting it silently', () => {
    const warn = vi.spyOn(console, 'error').mockImplementation(() => {});
    // An intended token "tok-with,commas" splits on ',' into
    // ["alice:tok-with", "commas"]: the first entry yields a TRUNCATED token,
    // and the "commas" tail is flagged malformed — so the corruption surfaces
    // in the log instead of being applied silently.
    const out = collect('alice:tok-with,commas');
    expect(out.get('alice')).toBe('tok-with'); // truncated at the comma
    expect(warn).toHaveBeenCalled(); // the "commas" fragment is reported
    expect((warn.mock.calls[0][0] as string)).toMatch(/skipping malformed entry/);
  });

  it('the callback may apply map-specific side effects (tenant→actor seeding shape)', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const tokenToTenant = new Map<string, string>();
    const tokenToActor = new Map<string, string>();
    parseTokenPairs('acme:tok-acme,globex:tok-globex', 'MEMBERRY_TENANT_TOKENS', (tenant, tok) => {
      tokenToTenant.set(tok, tenant);
      if (!tokenToActor.has(tok)) tokenToActor.set(tok, tenant);
    });
    expect(tokenToTenant.get('tok-acme')).toBe('acme');
    expect(tokenToActor.get('tok-globex')).toBe('globex');
  });
});
