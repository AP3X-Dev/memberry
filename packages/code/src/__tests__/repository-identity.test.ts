import crypto, { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';

import { describe, expect, it } from 'vitest';

import {
  REPOSITORY_FILE_IDENTITY_CONTRACT_ID,
  REPOSITORY_FILE_IDENTITY_CONTRACT_VERSION,
  REPOSITORY_FILE_IDENTITY_MAX_BRANCH_REF_BYTES,
  REPOSITORY_FILE_IDENTITY_MAX_PATH_BYTES,
  REPOSITORY_FILE_IDENTITY_MAX_REPOSITORY_ID_BYTES,
  REPOSITORY_FILE_IDENTITY_MAX_WORKTREE_ID_BYTES,
  RepositoryFileIdentityContractError,
  parseRepositoryFileIdentityV1,
  repositoryFileScopeKeyV1,
  type RepositoryFileIdentityV1,
} from '../repository-identity.js';

const SHA1 = '0123456789abcdef0123456789abcdef01234567';
const SHA256 = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

function identity(overrides: Partial<RepositoryFileIdentityV1> = {}): RepositoryFileIdentityV1 {
  return {
    contractId: 'memberry.repository-file-identity',
    contractVersion: '1.0.0',
    repositoryId: 'Repo-Primary',
    worktreeId: 'Worktree-A',
    checkout: { kind: 'branch', ref: 'refs/heads/feature/COD-001A' },
    commit: { algorithm: 'sha1', oid: SHA1 },
    repositoryRelativePath: 'packages/code/src/Example.ts',
    ...overrides,
  };
}

function expectFailure(
  input: unknown,
  code: 'invalid-identity' | 'budget-exceeded' = 'invalid-identity',
): void {
  let thrown: unknown;
  try {
    parseRepositoryFileIdentityV1(input);
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(RepositoryFileIdentityContractError);
  expect(thrown).toMatchObject({
    name: 'RepositoryFileIdentityContractError',
    message: code,
    code,
  });
  expect(String(thrown)).toBe(`RepositoryFileIdentityContractError: ${code}`);
}

function expectExactFrozenRecord(value: object, keys: readonly string[]): void {
  expect(Object.getPrototypeOf(value)).toBeNull();
  expect(Reflect.ownKeys(value)).toEqual(keys);
  expect(Object.isFrozen(value)).toBe(true);
  for (const key of keys) {
    expect(Object.getOwnPropertyDescriptor(value, key)).toMatchObject({
      enumerable: true,
      writable: false,
      configurable: false,
    });
  }
}

describe('repository file identity v1', () => {
  it('parses an exact branch identity into deeply frozen null-prototype records', () => {
    const source = identity();
    const parsed = parseRepositoryFileIdentityV1(source);

    expect(parsed).toEqual(source);
    expect(parsed).not.toBe(source);
    expect(parsed.repositoryId).toBe('Repo-Primary');
    expect(parsed.worktreeId).toBe('Worktree-A');
    expect(parsed.repositoryRelativePath).toBe('packages/code/src/Example.ts');
    expectExactFrozenRecord(parsed, [
      'contractId', 'contractVersion', 'repositoryId', 'worktreeId',
      'checkout', 'commit', 'repositoryRelativePath',
    ]);
    expectExactFrozenRecord(parsed.checkout, ['kind', 'ref']);
    expectExactFrozenRecord(parsed.commit, ['algorithm', 'oid']);
    expect(Object.isFrozen(source)).toBe(false);
    expect(Object.isFrozen(source.checkout)).toBe(false);
    expect(Object.isFrozen(source.commit)).toBe(false);
  });

  it('accepts detached checkout only in its exact one-field shape', () => {
    const parsed = parseRepositoryFileIdentityV1(identity({ checkout: { kind: 'detached' } }));
    expect(parsed.checkout).toEqual({ kind: 'detached' });
    expectExactFrozenRecord(parsed.checkout, ['kind']);
    expectFailure(identity({ checkout: { kind: 'detached', ref: 'refs/heads/main' } as never }));
  });

  it('matches a fixed cross-runtime SHA-256 fixture over nine 32-bit-BE length-prefixed fields', () => {
    const fixture = identity({
      repositoryRelativePath: 'packages/code/src/Éxample.ts',
    });
    expect(repositoryFileScopeKeyV1(fixture)).toBe(
      'a410b481a55359c90b9fffb6846175501fb0151a2aeb481efbc6ab6c0fdc3136',
    );
    expect(repositoryFileScopeKeyV1(fixture)).toMatch(/^[a-f0-9]{64}$/);
  });

  it('binds repository, worktree, checkout kind/ref, algorithm/OID, path, and case', () => {
    const base = identity();
    const variants: RepositoryFileIdentityV1[] = [
      base,
      identity({ repositoryId: 'repo-Primary' }),
      identity({ worktreeId: 'worktree-A' }),
      identity({ checkout: { kind: 'detached' } }),
      identity({ checkout: { kind: 'branch', ref: 'refs/heads/feature/cod-001a' } }),
      identity({ commit: { algorithm: 'sha256', oid: SHA256 } }),
      identity({ commit: { algorithm: 'sha1', oid: `1${SHA1.slice(1)}` } }),
      identity({ repositoryRelativePath: 'packages/code/src/example.ts' }),
    ];
    const keys = variants.map((value) => repositoryFileScopeKeyV1(value));
    expect(new Set(keys)).toHaveLength(variants.length);
  });

  it('separates delimiter-concatenation and field-boundary collision attempts', () => {
    const pairs: Array<[RepositoryFileIdentityV1, RepositoryFileIdentityV1]> = [
      [identity({ repositoryId: 'ab', worktreeId: 'c' }), identity({ repositoryId: 'a', worktreeId: 'bc' })],
      [
        identity({ checkout: { kind: 'branch', ref: 'refs/heads/ab' }, repositoryRelativePath: 'c' }),
        identity({ checkout: { kind: 'branch', ref: 'refs/heads/a' }, repositoryRelativePath: 'bc' }),
      ],
      [identity({ repositoryId: 'a:b', worktreeId: 'c' }), identity({ repositoryId: 'a', worktreeId: 'b:c' })],
    ];
    for (const [left, right] of pairs) {
      expect(repositoryFileScopeKeyV1(left)).not.toBe(repositoryFileScopeKeyV1(right));
    }
  });

  it('is independent of caller property insertion order', () => {
    const canonical = identity();
    const reordered = {
      repositoryRelativePath: canonical.repositoryRelativePath,
      commit: { oid: canonical.commit.oid, algorithm: canonical.commit.algorithm },
      checkout: { ref: 'refs/heads/feature/COD-001A', kind: 'branch' },
      worktreeId: canonical.worktreeId,
      repositoryId: canonical.repositoryId,
      contractVersion: canonical.contractVersion,
      contractId: canonical.contractId,
    };
    expect(parseRepositoryFileIdentityV1(reordered)).toEqual(canonical);
    expect(repositoryFileScopeKeyV1(reordered)).toBe(repositoryFileScopeKeyV1(canonical));
  });

  it('accepts exact lowercase SHA-1 and SHA-256 OIDs only', () => {
    expect(parseRepositoryFileIdentityV1(identity()).commit).toEqual({ algorithm: 'sha1', oid: SHA1 });
    expect(parseRepositoryFileIdentityV1(identity({
      commit: { algorithm: 'sha256', oid: SHA256 },
    })).commit).toEqual({ algorithm: 'sha256', oid: SHA256 });

    const invalid = [
      { algorithm: 'sha1', oid: SHA1.slice(1) },
      { algorithm: 'sha1', oid: `${SHA1}0` },
      { algorithm: 'sha1', oid: SHA1.toUpperCase() },
      { algorithm: 'sha1', oid: `${SHA1.slice(0, -1)}g` },
      { algorithm: 'sha256', oid: SHA256.slice(1) },
      { algorithm: 'sha256', oid: `${SHA256}0` },
      { algorithm: 'sha256', oid: SHA256.toUpperCase() },
      { algorithm: 'sha512', oid: SHA256 },
    ];
    for (const commit of invalid) expectFailure(identity({ commit: commit as never }));
  });

  it('enforces explicit assigned-ID byte caps at N/N+1 and preserves case', () => {
    const repositoryN = `R${'a'.repeat(REPOSITORY_FILE_IDENTITY_MAX_REPOSITORY_ID_BYTES - 1)}`;
    const worktreeN = `W${'b'.repeat(REPOSITORY_FILE_IDENTITY_MAX_WORKTREE_ID_BYTES - 1)}`;
    const parsed = parseRepositoryFileIdentityV1(identity({
      repositoryId: repositoryN,
      worktreeId: worktreeN,
    }));
    expect(parsed.repositoryId).toBe(repositoryN);
    expect(parsed.worktreeId).toBe(worktreeN);
    expectFailure(identity({ repositoryId: `${repositoryN}x` }), 'budget-exceeded');
    expectFailure(identity({ worktreeId: `${worktreeN}x` }), 'budget-exceeded');

    for (const value of ['', '.repo', '-repo', 'repo/name', 'repo name', 'repo@name', 'répo', '\ud800']) {
      expectFailure(identity({ repositoryId: value }));
      expectFailure(identity({ worktreeId: value }));
    }
  });

  it('enforces exact branch-ref byte N/N+1', () => {
    const prefix = 'refs/heads/';
    const refN = `${prefix}${'a'.repeat(REPOSITORY_FILE_IDENTITY_MAX_BRANCH_REF_BYTES - prefix.length)}`;
    expect(parseRepositoryFileIdentityV1(identity({
      checkout: { kind: 'branch', ref: refN },
    })).checkout).toEqual({ kind: 'branch', ref: refN });
    expectFailure(identity({
      checkout: { kind: 'branch', ref: `${refN}a` },
    }), 'budget-exceeded');
  });

  it('rejects short, remote, and invalid Git branch refs', () => {
    const invalidRefs = [
      'main',
      'refs/remotes/origin/main',
      'refs/tags/v1',
      'refs/heads/',
      'refs/heads/.hidden',
      'refs/heads/a/.hidden',
      'refs/heads/a..b',
      'refs/heads/a@{b',
      'refs/heads/a.lock',
      'refs/heads/a.lock/b',
      'refs/heads/a b',
      'refs/heads/a\tb',
      'refs/heads/a~b',
      'refs/heads/a^b',
      'refs/heads/a:b',
      'refs/heads/a?b',
      'refs/heads/a*b',
      'refs/heads/a[b',
      'refs/heads/a\\b',
      'refs/heads/a//b',
      'refs/heads/a/',
      'refs/heads/a.',
      'refs/heads/-danger',
      'refs/heads/cafe\u0301',
      'refs/heads/\ud800',
    ];
    for (const ref of invalidRefs) {
      expectFailure(identity({ checkout: { kind: 'branch', ref } }));
    }
    expect(parseRepositoryFileIdentityV1(identity({
      checkout: { kind: 'branch', ref: 'refs/heads/Feature/Éclair-1' },
    })).checkout).toEqual({ kind: 'branch', ref: 'refs/heads/Feature/Éclair-1' });
  });

  it('enforces canonical repository-relative POSIX path byte N/N+1', () => {
    const pathN = 'a'.repeat(REPOSITORY_FILE_IDENTITY_MAX_PATH_BYTES);
    expect(parseRepositoryFileIdentityV1(identity({
      repositoryRelativePath: pathN,
    })).repositoryRelativePath).toBe(pathN);
    expectFailure(identity({ repositoryRelativePath: `${pathN}a` }), 'budget-exceeded');
  });

  it('rejects oversized malformed strings before Unicode validation for every bounded field', () => {
    const oversizedMalformed = (maxBytes: number, prefix = ''): string => (
      `${prefix}${'a'.repeat(maxBytes + 1)}\ud800`
    );

    expectFailure(identity({
      repositoryId: oversizedMalformed(REPOSITORY_FILE_IDENTITY_MAX_REPOSITORY_ID_BYTES),
    }), 'budget-exceeded');
    expectFailure(identity({
      worktreeId: oversizedMalformed(REPOSITORY_FILE_IDENTITY_MAX_WORKTREE_ID_BYTES),
    }), 'budget-exceeded');
    expectFailure(identity({
      checkout: {
        kind: 'branch',
        ref: oversizedMalformed(REPOSITORY_FILE_IDENTITY_MAX_BRANCH_REF_BYTES, 'refs/heads/'),
      },
    }), 'budget-exceeded');
    expectFailure(identity({
      repositoryRelativePath: oversizedMalformed(REPOSITORY_FILE_IDENTITY_MAX_PATH_BYTES),
    }), 'budget-exceeded');
  });

  it('rejects absolute, drive, UNC, backslash, empty, traversal, control, and alias paths', () => {
    const invalidPaths = [
      '',
      '/absolute/file.ts',
      '//server/share/file.ts',
      'C:/file.ts',
      'c:relative.ts',
      '\\\\server\\share\\file.ts',
      'folder\\file.ts',
      'folder//file.ts',
      '.',
      '..',
      './file.ts',
      'folder/./file.ts',
      'folder/../file.ts',
      'folder/..',
      'folder/',
      'folder/\0file.ts',
      'folder/\u001ffile.ts',
      'folder/\u007ffile.ts',
      'folder/\u0085file.ts',
      'folder/cafe\u0301.ts',
      'folder/\ud800.ts',
    ];
    for (const repositoryRelativePath of invalidPaths) {
      expectFailure(identity({ repositoryRelativePath }));
    }
    const unicode = 'Source/Éclair/東京.ts';
    expect(parseRepositoryFileIdentityV1(identity({
      repositoryRelativePath: unicode,
    })).repositoryRelativePath).toBe(unicode);
  });

  it('rejects malformed, extra, missing, array, symbol, accessor, and unsafe-prototype shapes', () => {
    const invalid: unknown[] = [
      null,
      [],
      {},
      { ...identity(), extra: true },
      { ...identity(), contractId: 'foreign.contract' },
      { ...identity(), contractVersion: '2.0.0' },
      { ...identity(), checkout: [] },
      { ...identity(), checkout: { kind: 'branch' } },
      { ...identity(), checkout: { kind: 'branch', ref: 'refs/heads/main', extra: true } },
      { ...identity(), checkout: Object.create({ kind: 'branch', ref: 'refs/heads/main' }) },
      { ...identity(), commit: [] },
      { ...identity(), commit: { algorithm: 'sha1', oid: SHA1, extra: true } },
      { ...identity(), commit: Object.create({ algorithm: 'sha1', oid: SHA1 }) },
      Object.create(identity()),
    ];
    const symbolRoot = identity() as unknown as Record<PropertyKey, unknown>;
    symbolRoot[Symbol('extra')] = true;
    invalid.push(symbolRoot);
    for (const input of invalid) expectFailure(input);

    let getterCalls = 0;
    const accessor = { ...identity() } as Record<string, unknown>;
    Object.defineProperty(accessor, 'repositoryId', {
      enumerable: true,
      get: () => { getterCalls += 1; return 'secret'; },
    });
    expectFailure(accessor);
    expect(getterCalls).toBe(0);

    let nestedGetterCalls = 0;
    const checkoutAccessor = { kind: 'branch' } as Record<string, unknown>;
    Object.defineProperty(checkoutAccessor, 'ref', {
      enumerable: true,
      get: () => { nestedGetterCalls += 1; return 'refs/heads/secret'; },
    });
    expectFailure(identity({ checkout: checkoutAccessor as never }));
    expect(nestedGetterCalls).toBe(0);

    const nonEnumerable = identity() as unknown as Record<string, unknown>;
    Object.defineProperty(nonEnumerable, 'repositoryId', {
      enumerable: false,
      value: 'Repo-Primary',
    });
    expectFailure(nonEnumerable);
  });

  it('accepts null-prototype input records without changing the fixed output shape', () => {
    const checkout = Object.assign(Object.create(null), {
      kind: 'branch' as const,
      ref: 'refs/heads/main',
    });
    const commit = Object.assign(Object.create(null), { algorithm: 'sha1' as const, oid: SHA1 });
    const root = Object.assign(Object.create(null), identity({ checkout, commit }));
    const parsed = parseRepositoryFileIdentityV1(root);
    expect(parsed.checkout).toEqual(checkout);
    expect(parsed.commit).toEqual(commit);
    expect(Object.getPrototypeOf(parsed)).toBeNull();
  });

  it('rejects proxies, revoked proxies, and aliases with zero hooks', () => {
    let rootGets = 0;
    const rootProxy = new Proxy(identity(), {
      get: () => { rootGets += 1; throw new Error('root trap'); },
    });
    expectFailure(rootProxy);
    expect(rootGets).toBe(0);

    let checkoutGets = 0;
    const checkoutProxy = new Proxy({ kind: 'branch', ref: 'refs/heads/main' }, {
      get: () => { checkoutGets += 1; throw new Error('checkout trap'); },
    });
    expectFailure(identity({ checkout: checkoutProxy as never }));
    expect(checkoutGets).toBe(0);

    const revoked = Proxy.revocable({ algorithm: 'sha1', oid: SHA1 }, {});
    revoked.revoke();
    expectFailure(identity({ commit: revoked.proxy as never }));

    const cyclic = identity() as unknown as Record<string, unknown>;
    cyclic.checkout = cyclic;
    expectFailure(cyclic);

    const aliased = { kind: 'branch' as const, ref: 'refs/heads/main' };
    expectFailure(identity({ checkout: aliased, commit: aliased as never }));
  });

  it('uses captured Object, String, UTF-8, and crypto intrinsics', () => {
    const source = identity();
    const expected = repositoryFileScopeKeyV1(source);
    const hashPrototype = Object.getPrototypeOf(createHash('sha256')) as {
      update: (...args: unknown[]) => unknown;
      digest: (...args: unknown[]) => unknown;
    };
    const originals = {
      object: globalThis.Object,
      string: globalThis.String,
      regexp: globalThis.RegExp,
      stringify: JSON.stringify,
      byteLength: Buffer.byteLength,
      allocUnsafe: Buffer.allocUnsafe,
      writeUInt32BE: Buffer.prototype.writeUInt32BE,
      ownKeys: Reflect.ownKeys,
      getOwnPropertyDescriptor: Object.getOwnPropertyDescriptor,
      getPrototypeOf: Object.getPrototypeOf,
      create: Object.create,
      defineProperty: Object.defineProperty,
      freeze: Object.freeze,
      hasOwn: Object.hasOwn,
      charCodeAt: String.prototype.charCodeAt,
      normalize: String.prototype.normalize,
      startsWith: String.prototype.startsWith,
      endsWith: String.prototype.endsWith,
      slice: String.prototype.slice,
      update: hashPrototype.update,
      digest: hashPrototype.digest,
    };
    let parsed: RepositoryFileIdentityV1 | undefined;
    let actual: string | undefined;
    try {
      JSON.stringify = (() => { throw new Error('ambient JSON'); }) as typeof JSON.stringify;
      Buffer.byteLength = (() => { throw new Error('ambient byteLength'); }) as typeof Buffer.byteLength;
      Buffer.allocUnsafe = (() => { throw new Error('ambient allocUnsafe'); }) as typeof Buffer.allocUnsafe;
      Buffer.prototype.writeUInt32BE = (() => { throw new Error('ambient writeUInt32BE'); }) as typeof Buffer.prototype.writeUInt32BE;
      Reflect.ownKeys = (() => { throw new Error('ambient ownKeys'); }) as typeof Reflect.ownKeys;
      Object.getOwnPropertyDescriptor = (() => { throw new Error('ambient descriptor'); }) as typeof Object.getOwnPropertyDescriptor;
      Object.getPrototypeOf = (() => { throw new Error('ambient prototype'); }) as typeof Object.getPrototypeOf;
      Object.create = (() => { throw new Error('ambient create'); }) as typeof Object.create;
      Object.defineProperty = (() => { throw new Error('ambient define'); }) as typeof Object.defineProperty;
      Object.freeze = (() => { throw new Error('ambient freeze'); }) as typeof Object.freeze;
      Object.hasOwn = (() => { throw new Error('ambient hasOwn'); }) as typeof Object.hasOwn;
      originals.string.prototype.charCodeAt = (() => { throw new Error('ambient charCodeAt'); }) as typeof String.prototype.charCodeAt;
      originals.string.prototype.normalize = (() => { throw new Error('ambient normalize'); }) as typeof String.prototype.normalize;
      originals.string.prototype.startsWith = (() => { throw new Error('ambient startsWith'); }) as typeof String.prototype.startsWith;
      originals.string.prototype.endsWith = (() => { throw new Error('ambient endsWith'); }) as typeof String.prototype.endsWith;
      originals.string.prototype.slice = (() => { throw new Error('ambient slice'); }) as typeof String.prototype.slice;
      hashPrototype.update = () => { throw new Error('ambient hash.update'); };
      hashPrototype.digest = () => { throw new Error('ambient hash.digest'); };
      globalThis.Object = function BrokenObject() { throw new Error('ambient Object'); } as unknown as ObjectConstructor;
      globalThis.String = function BrokenString() { throw new Error('ambient String'); } as unknown as StringConstructor;
      globalThis.RegExp = function BrokenRegExp() { throw new Error('ambient RegExp'); } as unknown as RegExpConstructor;
      parsed = parseRepositoryFileIdentityV1(source);
      actual = repositoryFileScopeKeyV1(source);
    } finally {
      globalThis.Object = originals.object;
      globalThis.String = originals.string;
      globalThis.RegExp = originals.regexp;
      JSON.stringify = originals.stringify;
      Buffer.byteLength = originals.byteLength;
      Buffer.allocUnsafe = originals.allocUnsafe;
      Buffer.prototype.writeUInt32BE = originals.writeUInt32BE;
      Reflect.ownKeys = originals.ownKeys;
      Object.getOwnPropertyDescriptor = originals.getOwnPropertyDescriptor;
      Object.getPrototypeOf = originals.getPrototypeOf;
      Object.create = originals.create;
      Object.defineProperty = originals.defineProperty;
      Object.freeze = originals.freeze;
      Object.hasOwn = originals.hasOwn;
      originals.string.prototype.charCodeAt = originals.charCodeAt;
      originals.string.prototype.normalize = originals.normalize;
      originals.string.prototype.startsWith = originals.startsWith;
      originals.string.prototype.endsWith = originals.endsWith;
      originals.string.prototype.slice = originals.slice;
      hashPrototype.update = originals.update;
      hashPrototype.digest = originals.digest;
    }
    expect(parsed).toEqual(source);
    expect(actual).toBe(expected);
  });

  it('captures the built-in hash factory before synchronized live-binding drift', () => {
    const fixture = identity({ repositoryRelativePath: 'packages/code/src/Éxample.ts' });
    const expected = 'a410b481a55359c90b9fffb6846175501fb0151a2aeb481efbc6ab6c0fdc3136';
    const originalCreateHash = crypto.createHash;
    let hostileCalls = 0;
    try {
      crypto.createHash = ((..._args: Parameters<typeof crypto.createHash>) => {
        hostileCalls += 1;
        return originalCreateHash('sha1');
      }) as typeof crypto.createHash;
      syncBuiltinESMExports();
      const actual = repositoryFileScopeKeyV1(fixture);
      expect(actual).toBe(expected);
      expect(actual).toMatch(/^[a-f0-9]{64}$/);
      expect(hostileCalls).toBe(0);
    } finally {
      crypto.createHash = originalCreateHash;
      syncBuiltinESMExports();
    }
  });

  it('returns fixed value-free errors and deterministic keys', () => {
    const secret = 'secret-customer-repository/path';
    let thrown: unknown;
    try {
      repositoryFileScopeKeyV1(identity({ repositoryRelativePath: `../${secret}` }));
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(RepositoryFileIdentityContractError);
    expect(String(thrown)).toBe('RepositoryFileIdentityContractError: invalid-identity');
    expect(String(thrown)).not.toContain(secret);

    const first = repositoryFileScopeKeyV1(identity());
    const second = repositoryFileScopeKeyV1(identity());
    expect(first).toBe(second);
  });

  it('stays validation-only with no Git, filesystem, environment, network, or runtime wiring', () => {
    const source = readFileSync(new URL('../repository-identity.ts', import.meta.url), 'utf8');
    expect(source).not.toMatch(/from ['"]node:(fs|path|child_process|os|net|http|https)['"]/);
    expect(source).not.toMatch(/\b(exec|execFile|spawn|spawnSync|fetch|console|process|cwd|env)\b/);
    expect(source).not.toMatch(/\b(git|\.git|GIT_DIR|GIT_COMMON_DIR)\b/i);
    expect(source).not.toMatch(/@memberry\//);
    expect(source).not.toMatch(/from ['"]\.\/(indexer|parser|schema|store|types|index|runtime)/);
    expect(source).not.toMatch(/JSON\.(stringify|parse)/);
    expect(source).not.toMatch(/normalize\(['"]NFK/);
    expect(REPOSITORY_FILE_IDENTITY_CONTRACT_ID).toBe('memberry.repository-file-identity');
    expect(REPOSITORY_FILE_IDENTITY_CONTRACT_VERSION).toBe('1.0.0');
  });
});
