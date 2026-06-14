// packages/mcp/src/__tests__/server.host.opt62.test.ts
// OPT-62: the HTTP bind host is now configurable (MEMBERRY_HOST / HOST) instead of
// hardcoded all-interfaces. `undefined` preserves the prior all-interfaces bind so
// default behavior is unchanged; an operator can set 127.0.0.1 to restrict to loopback.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { resolveListenHost } from '../server.js';

const KEYS = ['MEMBERRY_HOST', 'AMP_HOST', 'HOST'] as const;

describe('OPT-62: resolveListenHost', () => {
  let saved: Record<string, string | undefined>;
  beforeEach(() => {
    saved = {};
    for (const k of KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
  });
  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it('returns undefined when no host env is set (preserves the all-interfaces default bind)', () => {
    expect(resolveListenHost()).toBeUndefined();
  });

  it('honors MEMBERRY_HOST (e.g. loopback-only)', () => {
    process.env.MEMBERRY_HOST = '127.0.0.1';
    expect(resolveListenHost()).toBe('127.0.0.1');
  });

  it('falls back to the generic HOST env (systemd) when MEMBERRY_HOST is unset', () => {
    process.env.HOST = '0.0.0.0';
    expect(resolveListenHost()).toBe('0.0.0.0');
  });

  it('MEMBERRY_HOST takes precedence over the generic HOST', () => {
    process.env.MEMBERRY_HOST = '127.0.0.1';
    process.env.HOST = '0.0.0.0';
    expect(resolveListenHost()).toBe('127.0.0.1');
  });

  it('treats a blank/whitespace value as unset (→ default bind)', () => {
    process.env.MEMBERRY_HOST = '   ';
    expect(resolveListenHost()).toBeUndefined();
  });
});
