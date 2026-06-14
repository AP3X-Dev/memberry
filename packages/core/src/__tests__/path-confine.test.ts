// packages/core/src/__tests__/path-confine.test.ts
//
// OPT-74: the shared realpath confinement helper must resolve symlinks at ANY
// level — including an ANCESTOR of a not-yet-existing leaf — so a planted
// `${base}/evil → /outside` symlink can't be used to escape via a path being
// created under it (the old realpath-the-full-target-only / ENOENT→allow gap).
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { isRealpathWithinBase, realpathNearestExisting } from '../path-confine.js';

/** Create a symlink; return false if the platform forbids it (Windows w/o priv). */
function trySymlink(target: string, link: string): boolean {
  try {
    symlinkSync(target, link);
    return true;
  } catch {
    return false;
  }
}

describe('isRealpathWithinBase (OPT-74 symlink-ancestor confinement)', () => {
  let base: string;
  let outside: string;

  beforeEach(() => {
    base = realpathSync(mkdtempSync(join(tmpdir(), 'amp-confine-core-')));
    outside = realpathSync(mkdtempSync(join(tmpdir(), 'amp-confine-out-')));
  });
  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });

  it('accepts an existing in-base file', () => {
    const f = join(base, 'a.ts');
    writeFileSync(f, 'x');
    expect(isRealpathWithinBase(f, base)).toBe(true);
  });

  it('accepts a not-yet-existing in-base leaf (no symlinked ancestor)', () => {
    expect(isRealpathWithinBase(join(base, 'src', 'new.ts'), base)).toBe(true);
  });

  it('rejects a path resolving outside the base', () => {
    expect(isRealpathWithinBase(join(outside, 'secret.ts'), base)).toBe(false);
  });

  it('rejects a symlinked LEAF pointing outside the base', () => {
    const secret = join(outside, 'secret.ts');
    writeFileSync(secret, 'leak');
    const link = join(base, 'link.ts');
    if (!trySymlink(secret, link)) return; // skip where symlinks need privileges
    expect(isRealpathWithinBase(link, base)).toBe(false);
  });

  it('rejects a not-yet-existing leaf under a symlinked ANCESTOR (the OPT-74 gap)', () => {
    // base/evil → outside ; then a path being CREATED under it must NOT escape.
    const link = join(base, 'evil');
    if (!trySymlink(outside, link)) return;
    // The leaf does not exist; pre-OPT-74 this fell through to a lexical allow.
    expect(isRealpathWithinBase(join(base, 'evil', 'sub', 'new.ts'), base)).toBe(false);
  });

  it('realpathNearestExisting resolves a symlinked ancestor and re-joins the tail', () => {
    const link = join(base, 'evil');
    if (!trySymlink(outside, link)) return;
    // evil/sub/new.ts doesn't exist; nearest existing ancestor is `evil` → outside.
    expect(realpathNearestExisting(join(base, 'evil', 'sub', 'new.ts'))).toBe(join(outside, 'sub', 'new.ts'));
  });

  it('realpathNearestExisting returns an in-base path unchanged when no symlink is involved', () => {
    expect(realpathNearestExisting(join(base, 'x', 'y.ts'))).toBe(join(base, 'x', 'y.ts'));
  });
});
