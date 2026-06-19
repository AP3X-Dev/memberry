// packages/wiki/src/__tests__/viewer-host.test.ts
// OPT-12: the wiki viewer used to call server.listen(port, cb) with no host arg,
// so Node bound ALL interfaces (0.0.0.0) — a systemd deploy with no publish layer
// was LAN-reachable on :3200 with no auth. resolveWikiHost(env) now resolves the
// bind host from env, and startWikiViewer passes it to listen when set.
//
// These are pure-helper unit tests (no real server): resolveWikiHost is a pure
// function of its env argument, so we assert its precedence and the unchanged
// default (undefined → all-interfaces, preserving Docker behavior).

import { describe, it, expect } from 'vitest';
import { resolveWikiHost } from '../viewer.js';

describe('OPT-12: resolveWikiHost (wiki viewer bind host)', () => {
  it('returns undefined when no host env is set (preserves all-interfaces bind for Docker)', () => {
    expect(resolveWikiHost({})).toBeUndefined();
  });

  it('treats empty/whitespace values as unset (still undefined)', () => {
    expect(resolveWikiHost({ MEMBERRY_WIKI_HOST: '' })).toBeUndefined();
    expect(resolveWikiHost({ MEMBERRY_HOST: '   ' })).toBeUndefined();
    expect(resolveWikiHost({ HOST: '' })).toBeUndefined();
  });

  it('uses MEMBERRY_WIKI_HOST when set', () => {
    expect(resolveWikiHost({ MEMBERRY_WIKI_HOST: '127.0.0.1' })).toBe('127.0.0.1');
  });

  it('falls back to MEMBERRY_HOST, then HOST (precedence order)', () => {
    expect(resolveWikiHost({ MEMBERRY_HOST: '10.0.0.5' })).toBe('10.0.0.5');
    expect(resolveWikiHost({ HOST: '0.0.0.0' })).toBe('0.0.0.0');
  });

  it('viewer-specific MEMBERRY_WIKI_HOST wins over the shared MEMBERRY_HOST and HOST', () => {
    expect(
      resolveWikiHost({
        MEMBERRY_WIKI_HOST: '127.0.0.1',
        MEMBERRY_HOST: '10.0.0.5',
        HOST: '0.0.0.0',
      }),
    ).toBe('127.0.0.1');
  });

  it('MEMBERRY_HOST wins over the generic HOST', () => {
    expect(resolveWikiHost({ MEMBERRY_HOST: '10.0.0.5', HOST: '0.0.0.0' })).toBe('10.0.0.5');
  });

  it('honors the AMP_* legacy aliases (AMP_WIKI_HOST, AMP_HOST) for the MEMBERRY_* vars', () => {
    expect(resolveWikiHost({ AMP_WIKI_HOST: '127.0.0.1' })).toBe('127.0.0.1');
    expect(resolveWikiHost({ AMP_HOST: '10.0.0.5' })).toBe('10.0.0.5');
    // Canonical MEMBERRY_* still wins over the legacy AMP_* alias.
    expect(resolveWikiHost({ MEMBERRY_WIKI_HOST: '127.0.0.1', AMP_WIKI_HOST: '9.9.9.9' })).toBe(
      '127.0.0.1',
    );
  });

  it('trims surrounding whitespace from a real value', () => {
    expect(resolveWikiHost({ MEMBERRY_WIKI_HOST: '  127.0.0.1  ' })).toBe('127.0.0.1');
  });
});
