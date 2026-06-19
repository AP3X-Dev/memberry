// packages/core/src/__tests__/hook-stdin.test.ts
//
// Unit test for the hook stdin reader (OPT-17). The guard is an IDLE timeout, not
// an absolute cap: a payload that streams in slowly (each chunk arriving < the
// idle window apart) must be captured IN FULL. Before the fix, a hard
// setTimeout(done, 1000) truncated any payload that took longer than 1s overall,
// even if it was still actively streaming.
//
// We swap process.stdin for a fake EventEmitter, emit chunks with small gaps,
// then 'end', and assert the whole payload survived.

import { describe, it, expect, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { readStdin } from '../cli/hook.js';

const realStdin = process.stdin;

function installFakeStdin(): EventEmitter & { isTTY: boolean; setEncoding: () => void } {
  const fake = new EventEmitter() as any;
  fake.isTTY = false;
  fake.setEncoding = () => {};
  Object.defineProperty(process, 'stdin', { value: fake, configurable: true });
  return fake;
}

afterEach(() => {
  Object.defineProperty(process, 'stdin', { value: realStdin, configurable: true });
});

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe('hook readStdin: idle timeout (OPT-17)', () => {
  it('captures the full payload when chunks stream in slowly (gaps < idle window)', async () => {
    const fake = installFakeStdin();
    const p = readStdin();

    // Stream a large payload in chunks spaced 60ms apart — well over the OLD 1s
    // absolute cap in aggregate if there were many, but each gap is < the 1000ms
    // idle window, so the idle guard keeps resetting and nothing is truncated.
    const chunks = ['{"a":1', ',"big":"', 'x'.repeat(500), '","b":2}'];
    for (const c of chunks) {
      fake.emit('data', c);
      await sleep(60);
    }
    fake.emit('end');

    const raw = await p;
    expect(JSON.parse(raw)).toEqual({ a: 1, big: 'x'.repeat(500), b: 2 });
  });

  it('returns the captured data on end even with no further chunks', async () => {
    const fake = installFakeStdin();
    const p = readStdin();
    fake.emit('data', '{"ok":true}');
    fake.emit('end');
    expect(JSON.parse(await p)).toEqual({ ok: true });
  });

  it('returns "" immediately when stdin is a TTY', async () => {
    const fake = installFakeStdin();
    fake.isTTY = true;
    expect(await readStdin()).toBe('');
  });
});
