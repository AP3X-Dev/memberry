import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it, vi } from 'vitest';

import {
  inspectDockerCopyArchiveV1,
  selectCidFileCleanupAuthorityV1,
} from '../sandbox.js';

const root = resolve(fileURLToPath(new URL('.', import.meta.url)), '../../../../..');
const id = 'd'.repeat(64);
const otherId = 'e'.repeat(64);

function tar(
  name: 'worker.mjs' | 'attestation.json' | 'node',
  content: Uint8Array,
): Uint8Array {
  const octal = (value: number, width: number) => new TextEncoder().encode(
    `${value.toString(8).padStart(width - 1, '0')}\0`,
  );
  const header = new Uint8Array(512);
  const node = name === 'node';
  header.set(new TextEncoder().encode(name), 0);
  header.set(octal(node ? 0o755 : 0o444, 8), 100);
  header.set(octal(node ? 0 : 65_532, 8), 108);
  header.set(octal(node ? 0 : 65_532, 8), 116);
  header.set(octal(content.byteLength, 12), 124);
  header.set(octal(0, 12), 136);
  header.fill(0x20, 148, 156);
  header[156] = 0x30;
  header.set(new TextEncoder().encode('ustar\0'), 257);
  header.set(new TextEncoder().encode('00'), 263);
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  header.set(new TextEncoder().encode(`${checksum.toString(8).padStart(6, '0')}\0 `), 148);
  const archive = new Uint8Array(512 + Math.ceil(content.byteLength / 512) * 512 + 1_024);
  archive.set(header);
  archive.set(content, 512);
  return archive;
}

function recalculateChecksum(archive: Uint8Array): void {
  archive.fill(0x20, 148, 156);
  const checksum = archive.subarray(0, 512).reduce((sum, byte) => sum + byte, 0);
  archive.set(new TextEncoder().encode(`${checksum.toString(8).padStart(6, '0')}\0 `), 148);
}

describe('MEM-002C2 CID-file-only cleanup authority', () => {
  it('never promotes label discovery alone into deletion authority', () => {
    expect(selectCidFileCleanupAuthorityV1(undefined, '', [id])).toBeUndefined();
    expect(selectCidFileCleanupAuthorityV1('garbage', '', [id])).toBeUndefined();
  });

  it('accepts one pinned CID with absent stdout only when discovery corroborates it', () => {
    expect(selectCidFileCleanupAuthorityV1(id, '', [id])).toBe(id);
    expect(selectCidFileCleanupAuthorityV1(id, undefined, [id])).toBe(id);
    expect(selectCidFileCleanupAuthorityV1(id, '', [])).toBeUndefined();
  });

  it('treats stdout/CID disagreement as ambiguous and authorizes no deletion', () => {
    expect(selectCidFileCleanupAuthorityV1(id, otherId, [id, otherId])).toBeUndefined();
  });

  it('does not let a concurrent same-label foreign ID replace the exact CID authority', () => {
    expect(selectCidFileCleanupAuthorityV1(id, id, [otherId, id])).toBe(id);
    expect(selectCidFileCleanupAuthorityV1(otherId, id, [otherId, id])).toBeUndefined();
  });

  it('rejects proxy and sparse discovery arrays without invoking hooks', () => {
    const hooks = { get: vi.fn(), getPrototypeOf: vi.fn(), ownKeys: vi.fn() };
    expect(selectCidFileCleanupAuthorityV1(id, id, new Proxy([id], hooks))).toBeUndefined();
    expect(hooks.get).not.toHaveBeenCalled();
    expect(hooks.getPrototypeOf).not.toHaveBeenCalled();
    expect(hooks.ownKeys).not.toHaveBeenCalled();
    const sparse = [id, otherId];
    delete (sparse as any)[0];
    expect(selectCidFileCleanupAuthorityV1(id, id, sparse)).toBeUndefined();
  });

  it('keeps label queries as residue proofs and removes only exact IDs with volumes', async () => {
    const sandbox = await readFile(resolve(root, 'bench/lab/admission-features/candidate/sandbox.ts'), 'utf8');
    const build = await readFile(resolve(root, 'bench/lab/admission-features/candidate/build.ts'), 'utf8');
    expect(`${sandbox}\n${build}`).not.toMatch(/(?:discovered|residue)\s*\[\s*0\s*\]/);
    expect(sandbox).toMatch(/\[\s*'container',\s*'rm',\s*'-fv',\s*exactId,?\s*\]/);
    expect(build).toMatch(/\[\s*'container',\s*'rm',\s*'-fv',\s*id\]/);
  });
});

describe('MEM-002C2 canonical Docker-copy USTAR boundary', () => {
  it.each(['worker.mjs', 'attestation.json', 'node'] as const)(
    'accepts one exact canonical regular-file archive for %s',
    (name) => {
      const bytes = new TextEncoder().encode(`content:${name}`);
      expect(inspectDockerCopyArchiveV1(tar(name, bytes), name)).toEqual(bytes);
    },
  );

  it.each([
    ['prefix', 345, 0x78],
    ['link name', 157, 0x78],
    ['user name', 265, 0x78],
    ['group name', 297, 0x78],
    ['device major', 329, 0x31],
    ['device minor', 337, 0x31],
    ['header padding', 500, 0x78],
  ])('rejects a nonempty %s field even with a recomputed checksum', (_name, offset, byte) => {
    const archive = tar('worker.mjs', Uint8Array.of(1));
    archive[offset] = byte as number;
    recalculateChecksum(archive);
    expect(() => inspectDockerCopyArchiveV1(archive, 'worker.mjs')).toThrow('invalid Docker copy archive');
  });

  it('rejects noncanonical numeric fields, magic, version, and checksum spelling', () => {
    for (const mutate of [
      (archive: Uint8Array) => { archive[100] = 0x20; },
      (archive: Uint8Array) => { archive[257] = 0x78; },
      (archive: Uint8Array) => { archive[263] = 0x31; },
    ]) {
      const archive = tar('worker.mjs', Uint8Array.of(1));
      mutate(archive);
      recalculateChecksum(archive);
      expect(() => inspectDockerCopyArchiveV1(archive, 'worker.mjs')).toThrow();
    }
    const checksum = tar('worker.mjs', Uint8Array.of(1));
    checksum[154] = 0x20;
    expect(() => inspectDockerCopyArchiveV1(checksum, 'worker.mjs')).toThrow('invalid Docker copy archive');
  });

  it('rejects path suffix garbage after NUL and nonzero content padding/trailer', () => {
    const nameGarbage = tar('worker.mjs', Uint8Array.of(1));
    nameGarbage[20] = 0x78;
    recalculateChecksum(nameGarbage);
    expect(() => inspectDockerCopyArchiveV1(nameGarbage, 'worker.mjs')).toThrow();

    const padding = tar('worker.mjs', Uint8Array.of(1));
    padding[513] = 1;
    expect(() => inspectDockerCopyArchiveV1(padding, 'worker.mjs')).toThrow();
  });
});
