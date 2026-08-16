import { Buffer } from 'node:buffer';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it, vi } from 'vitest';

import {
  APPROVED_NODE_BASE_IMAGE_V1,
  classifyAdmissionCandidateImagePolicyV1,
  hasExactDockerImageArgsEscapedV1,
} from '../build.js';
import {
  hasExactCandidateRootFsExtensionV1,
  inspectDockerCopyArchiveV1,
  selectCidFileCleanupAuthorityV1,
} from '../sandbox.js';

const root = resolve(fileURLToPath(new URL('.', import.meta.url)), '../../../../..');
const id = 'd'.repeat(64);
const otherId = 'e'.repeat(64);

function candidateImagePolicyFixtureV1() {
  const baseLayers = [1, 2, 3, 4].map((digit) => `sha256:${String(digit).repeat(64)}`);
  const imageId = `sha256:${'d'.repeat(64)}`;
  const candidate = `sha256:${'a'.repeat(64)}`;
  const source = `sha256:${'b'.repeat(64)}`;
  const base = {
    RepoDigests: [APPROVED_NODE_BASE_IMAGE_V1], Os: 'linux', Architecture: 'amd64',
    RootFS: { Type: 'layers', Layers: baseLayers }, Config: { Env: ['PATH=/usr/local/bin'] },
  };
  const config = {
    User: '65532:65532',
    Env: ['PATH=/usr/local/bin', 'LANG=C.UTF-8', 'LC_ALL=C.UTF-8', 'TZ=UTC'],
    Entrypoint: ['/usr/local/bin/node'],
    Cmd: [
      '--permission', '--allow-fs-read=/run/input.json',
      '--allow-fs-write=/tmp/memberry-sandbox-write-probe',
      '--disable-proto=throw', '/app/worker.mjs', '/run/input.json',
    ],
    WorkingDir: '/app',
    Labels: {
      'org.memberry.candidate.sha256': candidate,
      'org.memberry.source.sha256': source,
      'org.memberry.base.image': APPROVED_NODE_BASE_IMAGE_V1,
    },
    ArgsEscaped: true,
  };
  const image = {
    Id: imageId, Os: 'linux', Architecture: 'amd64',
    RootFS: { Type: 'layers', Layers: [...baseLayers, `sha256:${'5'.repeat(64)}`, `sha256:${'6'.repeat(64)}`] },
    Config: config,
  };
  const classify = (candidateImage: unknown, baseImage: unknown = base) => (
    classifyAdmissionCandidateImagePolicyV1(baseImage, candidateImage, imageId, candidate, source)
  );
  return { base, baseLayers, candidate, classify, config, image, imageId, source };
}

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
  header.set(octal(0, 8), 329);
  header.set(octal(0, 8), 337);
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
  it('classifies each candidate image-policy subboundary without values', () => {
    const { baseLayers, candidate, classify, config, image } = candidateImagePolicyFixtureV1();
    expect(classify(image)).toBe('VALID');
    expect(classify({ ...image, Id: `sha256:${'e'.repeat(64)}` })).toBe('IMAGE_INSPECT_POLICY');
    expect(classify({
      ...image,
      RootFS: { Type: 'layers', Layers: [...baseLayers, `sha256:${'5'.repeat(64)}`] },
    })).toBe('IMAGE_ROOTFS_POLICY');
    const { ArgsEscaped: _argsEscaped, ...withoutArgsEscaped } = config;
    expect(classify({ ...image, Config: withoutArgsEscaped })).toBe('IMAGE_ARGS_ESCAPED_POLICY');
    expect(classify({ ...image, Config: { ...config, Extra: true } })).toBe('IMAGE_CONFIG_KEYS_POLICY');
    expect(classify({ ...image, Config: { ...config, User: '0:0' } })).toBe('IMAGE_CONFIG_POLICY');
    expect(classify({
      ...image,
      Config: { ...config, Labels: { ...config.Labels, 'org.memberry.source.sha256': candidate } },
    })).toBe('IMAGE_LABEL_POLICY');
  });

  it('accepts only the complete inert Docker 28 legacy image Config shape or no legacy fields', () => {
    const { classify, config, image } = candidateImagePolicyFixtureV1();
    const legacyDefaults = {
      Hostname: '', Domainname: '', AttachStdin: false, AttachStdout: false,
      AttachStderr: false, Tty: false, OpenStdin: false, StdinOnce: false, Image: '',
    };
    expect(classify(image)).toBe('VALID');
    expect(classify({ ...image, Config: { ...config, ...legacyDefaults } })).toBe('VALID');
    for (const [key, inert] of Object.entries(legacyDefaults)) {
      const partial = { ...config, ...legacyDefaults } as Record<string, unknown>;
      delete partial[key];
      expect(classify({ ...image, Config: partial })).toBe('IMAGE_CONFIG_POLICY');
      expect(classify({
        ...image,
        Config: { ...config, ...legacyDefaults, [key]: typeof inert === 'boolean' ? true : 'set' },
      })).toBe('IMAGE_CONFIG_POLICY');
    }
    expect(classify({ ...image, Config: { ...config, ...legacyDefaults, Unknown: false } }))
      .toBe('IMAGE_CONFIG_KEYS_POLICY');
    for (const optionalLegacy of [
      { NetworkDisabled: false }, { MacAddress: '' }, { StopTimeout: null },
    ]) {
      expect(classify({ ...image, Config: { ...config, ...legacyDefaults, ...optionalLegacy } }))
        .toBe('IMAGE_CONFIG_KEYS_POLICY');
    }
  });

  it('rejects accessor, proxy, revoked, and non-plain inspection graphs without invoking hooks', () => {
    const { base, classify, config, image } = candidateImagePolicyFixtureV1();
    const accessor = (target: object, key: string) => {
      const getter = vi.fn(() => { throw new Error('must not execute'); });
      return {
        getter,
        value: Object.defineProperty(target, key, { configurable: true, enumerable: true, get: getter }),
      };
    };
    const accessorCases = [
      accessor({ ...image }, 'Config'),
      accessor({ ...image }, 'RootFS'),
      accessor({ ...image.RootFS }, 'Layers'),
      accessor({ ...config }, 'Labels'),
      accessor({ ...config }, 'Env'),
      accessor({ ...config }, 'Cmd'),
      accessor({ ...base }, 'Config'),
    ];
    expect(classify(accessorCases[0].value)).toBe('IMAGE_INSPECT_POLICY');
    expect(classify(accessorCases[1].value)).toBe('IMAGE_INSPECT_POLICY');
    expect(classify({ ...image, RootFS: accessorCases[2].value })).toBe('IMAGE_INSPECT_POLICY');
    for (const entry of accessorCases.slice(3, 6)) {
      expect(classify({ ...image, Config: entry.value })).toBe('IMAGE_INSPECT_POLICY');
    }
    expect(classify(image, accessorCases[6].value)).toBe('IMAGE_INSPECT_POLICY');
    expect(accessorCases.every((entry) => entry.getter.mock.calls.length === 0)).toBe(true);

    const hostileProxy = (target: object) => {
      const hooks = {
        get: vi.fn(), getOwnPropertyDescriptor: vi.fn(), getPrototypeOf: vi.fn(), ownKeys: vi.fn(),
      };
      return { hooks, value: new Proxy(target, hooks) };
    };
    const proxyCases = [
      hostileProxy(config), hostileProxy(image.RootFS), hostileProxy(image.RootFS.Layers),
      hostileProxy(config.Labels), hostileProxy(config.Env), hostileProxy(config.Cmd), hostileProxy(base),
    ];
    expect(classify({ ...image, Config: proxyCases[0].value })).toBe('IMAGE_INSPECT_POLICY');
    expect(classify({ ...image, RootFS: proxyCases[1].value })).toBe('IMAGE_INSPECT_POLICY');
    expect(classify({ ...image, RootFS: { ...image.RootFS, Layers: proxyCases[2].value } }))
      .toBe('IMAGE_INSPECT_POLICY');
    for (let index = 3; index < 6; index += 1) {
      const key = ['Labels', 'Env', 'Cmd'][index - 3];
      expect(classify({ ...image, Config: { ...config, [key]: proxyCases[index].value } }))
        .toBe('IMAGE_INSPECT_POLICY');
    }
    expect(classify(image, proxyCases[6].value)).toBe('IMAGE_INSPECT_POLICY');
    expect(proxyCases.every((entry) => Object.values(entry.hooks)
      .every((hook) => hook.mock.calls.length === 0))).toBe(true);

    const revoked = Proxy.revocable(config, {});
    revoked.revoke();
    expect(classify({ ...image, Config: revoked.proxy })).toBe('IMAGE_INSPECT_POLICY');

    for (const candidateImage of [
      { ...image, RootFS: Object.create(image.RootFS) },
      { ...image, RootFS: { ...image.RootFS, Layers: Object.create(image.RootFS.Layers) } },
      { ...image, Config: Object.create(config) },
      { ...image, Config: { ...config, Labels: Object.create(config.Labels) } },
      { ...image, Config: { ...config, Env: Object.create(config.Env) } },
      { ...image, Config: { ...config, Cmd: Object.create(config.Cmd) } },
    ]) expect(classify(candidateImage)).toBe('IMAGE_INSPECT_POLICY');
    expect(classify(image, Object.create(base))).toBe('IMAGE_INSPECT_POLICY');
  });

  it('enforces exact dense object, dense array, string-byte, and depth graph bounds', () => {
    const { classify, image } = candidateImagePolicyFixtureV1();
    const denseObject = (count: number) => Object.fromEntries(
      Array.from({ length: count }, (_, index) => [`key${index}`, null]),
    );
    const denseArray = (count: number) => Array.from({ length: count }, () => null);
    const deepValue = (deepestDepthFromImage: number) => {
      let value: unknown = null;
      for (let depth = 1; depth < deepestDepthFromImage; depth += 1) value = { value };
      return value;
    };
    expect(classify({ ...image, Probe: denseObject(256) })).toBe('VALID');
    expect(classify({ ...image, Probe: denseObject(257) })).toBe('IMAGE_INSPECT_POLICY');
    expect(classify({ ...image, Probe: denseArray(512) })).toBe('VALID');
    expect(classify({ ...image, Probe: denseArray(513) })).toBe('IMAGE_INSPECT_POLICY');
    expect(classify({ ...image, Probe: 'x'.repeat(65_536) })).toBe('VALID');
    expect(classify({ ...image, Probe: 'x'.repeat(65_537) })).toBe('IMAGE_INSPECT_POLICY');
    expect(classify({ ...image, Probe: '\u00e9'.repeat(32_768) })).toBe('VALID');
    expect(classify({ ...image, Probe: '\u00e9'.repeat(32_769) })).toBe('IMAGE_INSPECT_POLICY');
    expect(classify({ ...image, Probe: deepValue(32) })).toBe('VALID');
    expect(classify({ ...image, Probe: deepValue(33) })).toBe('IMAGE_INSPECT_POLICY');
  });

  it('shares exact total entry, value, and string-byte budgets across base and image', () => {
    const { base, classify, image } = candidateImagePolicyFixtureV1();
    const usage = (value: unknown): { entries: number; stringBytes: number; values: number } => {
      if (typeof value === 'string') return { entries: 0, stringBytes: Buffer.byteLength(value), values: 1 };
      if (value === null || typeof value !== 'object') return { entries: 0, stringBytes: 0, values: 1 };
      const entries = Array.isArray(value) ? value : Object.values(value);
      const children = entries.map(usage);
      const keyBytes = Array.isArray(value) ? 0 : Object.keys(value)
        .reduce((total, key) => total + Buffer.byteLength(key), 0);
      return {
        entries: entries.length + children.reduce((total, child) => total + child.entries, 0),
        stringBytes: keyBytes + children.reduce((total, child) => total + child.stringBytes, 0),
        values: 1 + children.reduce((total, child) => total + child.values, 0),
      };
    };
    const entryTree = (entries: number): unknown[] => {
      if (entries <= 512) return Array.from({ length: entries }, () => null);
      const branches = Math.ceil(entries / 513);
      let leaves = entries - branches;
      return Array.from({ length: branches }, () => {
        const count = Math.min(512, leaves);
        leaves -= count;
        return Array.from({ length: count }, () => null);
      });
    };
    const stringPayload = (bytes: number): string[] => {
      const chunks: string[] = [];
      while (bytes > 0) {
        const size = Math.min(65_536, bytes);
        chunks.push('x'.repeat(size));
        bytes -= size;
      }
      return chunks;
    };

    const baseline = usage(base);
    const imageBaseline = usage(image);
    const remainingEntries = 8_192 - baseline.entries - imageBaseline.entries;
    const baseAddedEntries = Math.floor(remainingEntries / 2);
    const imageAddedEntries = remainingEntries - baseAddedEntries;
    const entryBase = { ...base, Probe: entryTree(baseAddedEntries - 1) };
    const entryImage = { ...image, Probe: entryTree(imageAddedEntries - 1) };
    expect(usage(entryBase).entries + usage(entryImage).entries).toBe(8_192);
    expect(usage(entryBase).values + usage(entryImage).values).toBe(8_194);
    expect(classify(entryImage, entryBase)).toBe('VALID');
    const overEntryImage = { ...entryImage, Probe: entryTree(imageAddedEntries) };
    expect(usage(entryBase).entries + usage(overEntryImage).entries).toBe(8_193);
    expect(usage(entryBase).values + usage(overEntryImage).values).toBe(8_195);
    expect(classify(overEntryImage, entryBase)).toBe('IMAGE_INSPECT_POLICY');

    const probeKeyBytes = Buffer.byteLength('Probe');
    const remainingStringBytes = 4_194_304 - baseline.stringBytes - imageBaseline.stringBytes
      - probeKeyBytes * 2;
    const baseAddedStringBytes = Math.floor(remainingStringBytes / 2);
    const imageAddedStringBytes = remainingStringBytes - baseAddedStringBytes;
    const stringBase = { ...base, Probe: stringPayload(baseAddedStringBytes) };
    const stringImage = { ...image, Probe: stringPayload(imageAddedStringBytes) };
    expect(usage(stringBase).stringBytes + usage(stringImage).stringBytes).toBe(4_194_304);
    expect(classify(stringImage, stringBase)).toBe('VALID');
    const overStringImage = { ...image, Probe: stringPayload(imageAddedStringBytes + 1) };
    expect(usage(stringBase).stringBytes + usage(overStringImage).stringBytes).toBe(4_194_305);
    expect(classify(overStringImage, stringBase)).toBe('IMAGE_INSPECT_POLICY');
  });

  it('requires Docker 29 candidate image ArgsEscaped metadata as one exact data property', () => {
    expect(hasExactDockerImageArgsEscapedV1({ ArgsEscaped: true })).toBe(true);
    expect(hasExactDockerImageArgsEscapedV1({})).toBe(false);
    expect(hasExactDockerImageArgsEscapedV1({ ArgsEscaped: false })).toBe(false);
    const getter = vi.fn(() => true);
    const accessor = Object.defineProperty({}, 'ArgsEscaped', { enumerable: true, get: getter });
    expect(hasExactDockerImageArgsEscapedV1(accessor)).toBe(false);
    expect(getter).not.toHaveBeenCalled();
  });

  it('requires the exact two-layer WORKDIR plus COPY extension over the approved base prefix', () => {
    const base = [1, 2, 3, 4].map((digit) => `sha256:${String(digit).repeat(64)}`);
    const candidate = [...base, `sha256:${'5'.repeat(64)}`, `sha256:${'6'.repeat(64)}`];
    expect(hasExactCandidateRootFsExtensionV1(base, candidate)).toBe(true);
    expect(hasExactCandidateRootFsExtensionV1(base, candidate.slice(0, -1))).toBe(false);
    expect(hasExactCandidateRootFsExtensionV1(base, [...candidate, `sha256:${'7'.repeat(64)}`])).toBe(false);
    expect(hasExactCandidateRootFsExtensionV1(
      base,
      [`sha256:${'0'.repeat(64)}`, ...candidate.slice(1)],
    )).toBe(false);
  });

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

  it('rejects NUL-filled device fields instead of accepting two zero encodings', () => {
    const archive = tar('worker.mjs', Uint8Array.of(1));
    archive.fill(0, 329, 345);
    recalculateChecksum(archive);
    expect(() => inspectDockerCopyArchiveV1(archive, 'worker.mjs'))
      .toThrow('invalid Docker copy archive');
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
