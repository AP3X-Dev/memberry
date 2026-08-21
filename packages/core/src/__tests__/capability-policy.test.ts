import { Buffer as NodeBuffer } from 'node:buffer';
import { readFileSync } from 'node:fs';
import { types as nodeUtilTypes } from 'node:util';

import { describe, expect, it } from 'vitest';

import {
  CAPABILITY_POLICY_CONTRACT_ID,
  CAPABILITY_POLICY_CONTRACT_VERSION,
  CAPABILITY_POLICY_MAX_ACTOR_ID_BYTES,
  CAPABILITY_POLICY_MAX_DOMAIN_ID_BYTES,
  CAPABILITY_POLICY_MAX_GRANTS,
  CAPABILITY_POLICY_MAX_PROJECT_ID_BYTES,
  CAPABILITY_POLICY_MAX_TENANT_ID_BYTES,
  CAPABILITY_POLICY_MAX_TOOL_ID_BYTES,
  CapabilityPolicyContractError,
  evaluateCapabilityV1,
  parseActorCapabilityPolicyV1,
  parseCapabilityCheckRequestV1,
} from '../capability-policy.js';

type Operation = 'read' | 'create' | 'update' | 'delete' | 'admin';
type ScopeInput = { kind: 'tenant' } | { kind: 'project'; projectId: string };

function tenantScope(): ScopeInput {
  return { kind: 'tenant' };
}

function projectScope(projectId = 'project:memberry'): ScopeInput {
  return { kind: 'project', projectId };
}

function grant(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    scope: tenantScope(),
    domainId: 'memory.semantic',
    toolId: 'berry_context',
    operation: 'read',
    ...overrides,
  };
}

function policy(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    contractId: 'memberry.capability-policy',
    contractVersion: '1.0.0',
    actorId: 'actor:alice',
    tenantId: 'tenant:acme',
    grants: [grant()],
    ...overrides,
  };
}

function request(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    contractId: 'memberry.capability-policy',
    contractVersion: '1.0.0',
    actorId: 'actor:alice',
    tenantId: 'tenant:acme',
    scope: tenantScope(),
    domainId: 'memory.semantic',
    toolId: 'berry_context',
    operation: 'read',
    ...overrides,
  };
}

function expectFrozenRecord(value: object, keys: readonly string[]): void {
  expect(Object.getPrototypeOf(value)).toBeNull();
  expect(Object.isFrozen(value)).toBe(true);
  expect(Reflect.ownKeys(value)).toEqual(keys);
  for (let index = 0; index < keys.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, keys[index]!)!;
    expect(descriptor.enumerable).toBe(true);
    expect(descriptor.configurable).toBe(false);
    expect(descriptor.writable).toBe(false);
    expect(descriptor.get).toBeUndefined();
    expect(descriptor.set).toBeUndefined();
  }
}

function expectFailure(work: () => unknown, code: 'invalid-policy' | 'invalid-request' | 'budget-exceeded'): void {
  let caught: unknown;
  try {
    work();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(CapabilityPolicyContractError);
  expect((caught as CapabilityPolicyContractError).code).toBe(code);
  expect(String(caught)).toBe(`CapabilityPolicyContractError: capability_policy_contract:${code}`);
  expect(String(caught)).not.toContain('alice');
  expect(String(caught)).not.toContain('acme');
}

describe('capability policy v1', () => {
  it('parses the exact policy graph into deeply frozen null-prototype records', () => {
    const input = policy({
      grants: [
        grant(),
        grant({
          scope: projectScope(),
          domainId: 'memory.blocks',
          toolId: 'berry_store',
          operation: 'create',
        }),
      ],
    });
    const parsed = parseActorCapabilityPolicyV1(input);

    expect(parsed).toEqual(input);
    expectFrozenRecord(parsed, ['contractId', 'contractVersion', 'actorId', 'tenantId', 'grants']);
    expect(Array.isArray(parsed.grants)).toBe(true);
    expect(Object.getPrototypeOf(parsed.grants)).toBe(Array.prototype);
    expect(Object.isFrozen(parsed.grants)).toBe(true);
    expect(Reflect.ownKeys(parsed.grants)).toEqual(['0', '1', 'length']);
    expectFrozenRecord(parsed.grants[0]!, ['scope', 'domainId', 'toolId', 'operation']);
    expectFrozenRecord(parsed.grants[0]!.scope, ['kind']);
    expectFrozenRecord(parsed.grants[1]!, ['scope', 'domainId', 'toolId', 'operation']);
    expectFrozenRecord(parsed.grants[1]!.scope, ['kind', 'projectId']);
  });

  it('parses the exact request graph and locks key order and descriptors', () => {
    const parsed = parseCapabilityCheckRequestV1(request({ scope: projectScope('project:alpha') }));

    expectFrozenRecord(parsed, [
      'contractId', 'contractVersion', 'actorId', 'tenantId', 'scope', 'domainId', 'toolId', 'operation',
    ]);
    expectFrozenRecord(parsed.scope, ['kind', 'projectId']);
    expect(parsed.scope).toEqual(projectScope('project:alpha'));
  });

  it('allows exact tenant grants for tenant and same-policy-tenant project requests', () => {
    expect(evaluateCapabilityV1(policy(), request())).toEqual({ allowed: true, reason: 'allowed' });
    expect(evaluateCapabilityV1(policy(), request({ scope: projectScope('project:any') })))
      .toEqual({ allowed: true, reason: 'allowed' });
  });

  it('limits project grants to the exact project scope', () => {
    const projectPolicy = policy({ grants: [grant({ scope: projectScope('project:alpha') })] });

    expect(evaluateCapabilityV1(projectPolicy, request({ scope: projectScope('project:alpha') })))
      .toEqual({ allowed: true, reason: 'allowed' });
    expect(evaluateCapabilityV1(projectPolicy, request({ scope: projectScope('project:beta') })))
      .toEqual({ allowed: false, reason: 'denied' });
    expect(evaluateCapabilityV1(projectPolicy, request({ scope: tenantScope() })))
      .toEqual({ allowed: false, reason: 'denied' });
  });

  it('denies actor and tenant mismatches before otherwise matching grants', () => {
    expect(evaluateCapabilityV1(policy(), request({ actorId: 'actor:bob' })))
      .toEqual({ allowed: false, reason: 'denied' });
    expect(evaluateCapabilityV1(policy(), request({ tenantId: 'tenant:other' })))
      .toEqual({ allowed: false, reason: 'denied' });
  });

  it('requires exact case-sensitive domain, tool, and operation with no admin bypass', () => {
    const adminPolicy = policy({ grants: [grant({ operation: 'admin' })] });
    const readPolicy = policy();

    expect(evaluateCapabilityV1(policy(), request({ domainId: 'Memory.semantic' }))).toEqual({
      allowed: false, reason: 'denied',
    });
    expect(evaluateCapabilityV1(policy(), request({ toolId: 'Berry_context' }))).toEqual({
      allowed: false, reason: 'denied',
    });
    expect(evaluateCapabilityV1(adminPolicy, request({ operation: 'read' }))).toEqual({
      allowed: false, reason: 'denied',
    });
    expect(evaluateCapabilityV1(readPolicy, request({ operation: 'admin' }))).toEqual({
      allowed: false, reason: 'denied',
    });
    expect(evaluateCapabilityV1(adminPolicy, request({ operation: 'admin' }))).toEqual({
      allowed: true, reason: 'allowed',
    });
  });

  it('denies empty and unmatched policies without defaults, aliases, or coercion', () => {
    expect(evaluateCapabilityV1(policy({ grants: [] }), request())).toEqual({ allowed: false, reason: 'denied' });
    expect(evaluateCapabilityV1(policy(), request({ operation: 'update' }))).toEqual({
      allowed: false, reason: 'denied',
    });
    expectFailure(() => evaluateCapabilityV1(policy(), request({ operation: 'READ' })), 'invalid-request');
    expectFailure(() => evaluateCapabilityV1(policy(), request({ operation: 1 })), 'invalid-request');
  });

  it('returns exact frozen null-prototype decisions', () => {
    const allowed = evaluateCapabilityV1(policy(), request());
    const denied = evaluateCapabilityV1(policy({ grants: [] }), request());

    expectFrozenRecord(allowed, ['allowed', 'reason']);
    expectFrozenRecord(denied, ['allowed', 'reason']);
    expect(allowed).toEqual({ allowed: true, reason: 'allowed' });
    expect(denied).toEqual({ allowed: false, reason: 'denied' });
  });

  it('rejects structural duplicate grants but not delimiter-like field collisions', () => {
    expectFailure(() => parseActorCapabilityPolicyV1(policy({ grants: [grant(), grant()] })), 'invalid-policy');
    expectFailure(() => parseActorCapabilityPolicyV1(policy({
      grants: [
        grant({ scope: projectScope('project:alpha') }),
        grant({ scope: projectScope('project:alpha') }),
      ],
    })), 'invalid-policy');

    const collisionAttempt = policy({
      grants: [
        grant({ domainId: 'a:b', toolId: 'c' }),
        grant({ domainId: 'a', toolId: 'b:c' }),
        grant({ scope: tenantScope(), domainId: 'scope', toolId: 'same' }),
        grant({ scope: projectScope('project:tenant'), domainId: 'scope', toolId: 'same' }),
      ],
    });
    expect(parseActorCapabilityPolicyV1(collisionAttempt).grants).toHaveLength(4);
  });

  it('preserves caller grant order while evaluation is insertion-order independent', () => {
    const first = grant({ domainId: 'memory.blocks', toolId: 'berry_store', operation: 'create' });
    const second = grant();
    const parsed = parseActorCapabilityPolicyV1(policy({ grants: [first, second] }));
    expect(parsed.grants[0]!.domainId).toBe('memory.blocks');
    expect(parsed.grants[1]!.domainId).toBe('memory.semantic');

    const reorderedRequest = {
      operation: 'read',
      toolId: 'berry_context',
      domainId: 'memory.semantic',
      scope: tenantScope(),
      tenantId: 'tenant:acme',
      actorId: 'actor:alice',
      contractVersion: '1.0.0',
      contractId: 'memberry.capability-policy',
    };
    expect(evaluateCapabilityV1(policy(), reorderedRequest)).toEqual({ allowed: true, reason: 'allowed' });
  });

  it('accepts ordinary and null-prototype data records, including parsed frozen outputs', () => {
    const nullPolicy = Object.assign(Object.create(null), policy());
    const nullRequest = Object.assign(Object.create(null), request());
    const parsedPolicy = parseActorCapabilityPolicyV1(nullPolicy);
    const parsedRequest = parseCapabilityCheckRequestV1(nullRequest);

    expect(evaluateCapabilityV1(parsedPolicy, parsedRequest)).toEqual({ allowed: true, reason: 'allowed' });
  });

  it('rejects extra, missing, symbol, accessor, and unsafe-prototype record shapes without getters', () => {
    expectFailure(() => parseActorCapabilityPolicyV1(policy({ extra: true })), 'invalid-policy');
    const missing = policy();
    delete missing.actorId;
    expectFailure(() => parseActorCapabilityPolicyV1(missing), 'invalid-policy');
    const symbol = policy();
    Object.defineProperty(symbol, Symbol('extra'), { value: true, enumerable: true });
    expectFailure(() => parseActorCapabilityPolicyV1(symbol), 'invalid-policy');

    let getterCalls = 0;
    const accessor = policy();
    Object.defineProperty(accessor, 'actorId', {
      enumerable: true,
      configurable: true,
      get() {
        getterCalls += 1;
        return 'actor:alice';
      },
    });
    expectFailure(() => parseActorCapabilityPolicyV1(accessor), 'invalid-policy');
    expect(getterCalls).toBe(0);

    const unsafe = policy();
    Object.setPrototypeOf(unsafe, { inherited: true });
    expectFailure(() => parseActorCapabilityPolicyV1(unsafe), 'invalid-policy');
  });

  it('rejects sparse, decorated, aliased, and unsafe-prototype grant arrays', () => {
    const sparse = new Array(2);
    sparse[0] = grant();
    expectFailure(() => parseActorCapabilityPolicyV1(policy({ grants: sparse })), 'invalid-policy');

    const decorated = [grant()];
    Object.defineProperty(decorated, 'extra', { value: true, enumerable: true });
    expectFailure(() => parseActorCapabilityPolicyV1(policy({ grants: decorated })), 'invalid-policy');

    const sharedScope = tenantScope();
    expectFailure(() => parseActorCapabilityPolicyV1(policy({
      grants: [grant({ scope: sharedScope }), grant({ scope: sharedScope, operation: 'update' })],
    })), 'invalid-policy');

    const unsafe = [grant()];
    Object.setPrototypeOf(unsafe, Object.create(Array.prototype));
    expectFailure(() => parseActorCapabilityPolicyV1(policy({ grants: unsafe })), 'invalid-policy');
  });

  it('defines parsed array indexes without dispatching inherited numeric setters', () => {
    const deniedPolicy = policy({ grants: [grant({ toolId: 'denied_tool' })] });
    const deniedRequest = request();
    const forgedGrant = grant();
    const originalIndexDescriptor = Object.getOwnPropertyDescriptor(Array.prototype, '0');
    const originalDefineProperty = Object.defineProperty;
    let hooks = 0;
    let parsed: ReturnType<typeof parseActorCapabilityPolicyV1> | undefined;
    originalDefineProperty(Array.prototype, '0', {
      configurable: true,
      set(this: unknown[]) {
        hooks += 1;
        originalDefineProperty(this, '0', {
          value: forgedGrant,
          writable: true,
          enumerable: true,
          configurable: true,
        });
      },
    });
    try {
      parsed = parseActorCapabilityPolicyV1(deniedPolicy);
    } finally {
      if (originalIndexDescriptor === undefined) {
        delete (Array.prototype as unknown as Record<string, unknown>)['0'];
      } else {
        originalDefineProperty(Array.prototype, '0', originalIndexDescriptor);
      }
    }

    const indexDescriptor = Object.getOwnPropertyDescriptor(parsed!.grants, '0')!;
    expect(hooks).toBe(0);
    expect(indexDescriptor.value.toolId).toBe('denied_tool');
    expect(indexDescriptor.enumerable).toBe(true);
    expect(indexDescriptor.writable).toBe(false);
    expect(indexDescriptor.configurable).toBe(false);
    expect(evaluateCapabilityV1(parsed, deniedRequest)).toEqual({ allowed: false, reason: 'denied' });
  });

  it('rejects proxies and revoked proxies with zero hostile hooks', () => {
    let hooks = 0;
    const proxy = new Proxy(policy(), {
      get() { hooks += 1; throw new Error('get'); },
      getOwnPropertyDescriptor() { hooks += 1; throw new Error('descriptor'); },
      getPrototypeOf() { hooks += 1; throw new Error('prototype'); },
      ownKeys() { hooks += 1; throw new Error('keys'); },
    });
    expect(nodeUtilTypes.isProxy(proxy)).toBe(true);
    expectFailure(() => parseActorCapabilityPolicyV1(proxy), 'invalid-policy');
    expect(hooks).toBe(0);

    const revoked = Proxy.revocable(request(), {});
    revoked.revoke();
    expectFailure(() => parseCapabilityCheckRequestV1(revoked.proxy), 'invalid-request');
  });

  it('validates both complete graphs before actor or tenant mismatch can deny', () => {
    const malformedPolicy = policy({
      actorId: 'actor:other',
      grants: [grant({ operation: 'wildcard' })],
    });
    expectFailure(() => evaluateCapabilityV1(malformedPolicy, request()), 'invalid-policy');

    const malformedRequest = request({ actorId: 'actor:other', extra: true });
    expectFailure(() => evaluateCapabilityV1(policy(), malformedRequest), 'invalid-request');
  });

  it('enforces 128/129 grants and every identifier byte cap at N/N+1', () => {
    const distinctGrants = Array.from({ length: CAPABILITY_POLICY_MAX_GRANTS }, (_, index) => grant({
      domainId: `d${index}`,
    }));
    expect(parseActorCapabilityPolicyV1(policy({ grants: distinctGrants })).grants)
      .toHaveLength(CAPABILITY_POLICY_MAX_GRANTS);
    expectFailure(() => parseActorCapabilityPolicyV1(policy({
      grants: [...distinctGrants, grant({ domainId: 'overflow' })],
    })), 'budget-exceeded');

    const caps: ReadonlyArray<[string, number, 'policy' | 'request', string]> = [
      ['actorId', CAPABILITY_POLICY_MAX_ACTOR_ID_BYTES, 'policy', 'invalid-policy'],
      ['tenantId', CAPABILITY_POLICY_MAX_TENANT_ID_BYTES, 'policy', 'invalid-policy'],
      ['projectId', CAPABILITY_POLICY_MAX_PROJECT_ID_BYTES, 'policy', 'invalid-policy'],
      ['domainId', CAPABILITY_POLICY_MAX_DOMAIN_ID_BYTES, 'policy', 'invalid-policy'],
      ['toolId', CAPABILITY_POLICY_MAX_TOOL_ID_BYTES, 'request', 'invalid-request'],
    ];
    for (let index = 0; index < caps.length; index += 1) {
      const [field, cap, owner] = caps[index]!;
      const exact = 'a'.repeat(cap);
      const overflow = 'a'.repeat(cap + 1);
      if (field === 'projectId') {
        expect(parseActorCapabilityPolicyV1(policy({ grants: [grant({ scope: projectScope(exact) })] })))
          .toBeDefined();
        expectFailure(() => parseActorCapabilityPolicyV1(policy({
          grants: [grant({ scope: projectScope(overflow) })],
        })), 'budget-exceeded');
      } else if (owner === 'policy') {
        const exactPolicy = field === 'domainId'
          ? policy({ grants: [grant({ domainId: exact })] })
          : policy({ [field]: exact });
        const overflowPolicy = field === 'domainId'
          ? policy({ grants: [grant({ domainId: overflow })] })
          : policy({ [field]: overflow });
        expect(parseActorCapabilityPolicyV1(exactPolicy)).toBeDefined();
        expectFailure(() => parseActorCapabilityPolicyV1(overflowPolicy), 'budget-exceeded');
      } else {
        expect(parseCapabilityCheckRequestV1(request({ [field]: exact }))).toBeDefined();
        expectFailure(() => parseCapabilityCheckRequestV1(request({ [field]: overflow })), 'budget-exceeded');
      }
    }
  });

  it('rejects wildcard-like, unsafe, empty, control, and non-ASCII identifiers', () => {
    const invalid = ['', '*', 'memory.*', 'tool?', 'a[b]', 'a b', 'a/b', '.hidden', 'trailing-', 'é', '\ud800'];
    for (let index = 0; index < invalid.length; index += 1) {
      expectFailure(() => parseCapabilityCheckRequestV1(request({ toolId: invalid[index] })), 'invalid-request');
    }
  });

  it('uses captured intrinsics and never dispatches JSON, iterators, or ambient Map hooks', () => {
    const validPolicy = policy();
    const validRequest = request();
    const originalGetPrototypeOf = Object.getPrototypeOf;
    const originalGetOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
    const originalDefineProperty = Object.defineProperty;
    const originalHasOwn = Object.hasOwn;
    const originalFreeze = Object.freeze;
    const originalCreate = Object.create;
    const originalOwnKeys = Reflect.ownKeys;
    const originalIsArray = Array.isArray;
    const originalString = globalThis.String;
    const originalMap = globalThis.Map;
    const originalMapGet = Map.prototype.get;
    const originalMapSet = Map.prototype.set;
    const originalMapHas = Map.prototype.has;
    const originalWeakSet = globalThis.WeakSet;
    const originalWeakSetAdd = WeakSet.prototype.add;
    const originalWeakSetHas = WeakSet.prototype.has;
    const originalByteLength = NodeBuffer.byteLength;
    const originalError = globalThis.Error;
    const originalIterator = Array.prototype[Symbol.iterator];
    const originalJsonParse = JSON.parse;
    const originalJsonStringify = JSON.stringify;
    const originalIsProxy = nodeUtilTypes.isProxy;
    let hooks = 0;
    const hostile = () => { hooks += 1; throw new Error('ambient hook'); };
    let result: unknown;
    try {
      Object.getPrototypeOf = hostile as typeof Object.getPrototypeOf;
      Object.getOwnPropertyDescriptor = hostile as typeof Object.getOwnPropertyDescriptor;
      Object.defineProperty = hostile as typeof Object.defineProperty;
      Object.hasOwn = hostile as typeof Object.hasOwn;
      Object.freeze = hostile as typeof Object.freeze;
      Object.create = hostile as typeof Object.create;
      Reflect.ownKeys = hostile as typeof Reflect.ownKeys;
      Array.isArray = hostile as unknown as typeof Array.isArray;
      globalThis.String = hostile as unknown as StringConstructor;
      originalMap.prototype.get = hostile as typeof Map.prototype.get;
      originalMap.prototype.set = hostile as typeof Map.prototype.set;
      originalMap.prototype.has = hostile as typeof Map.prototype.has;
      globalThis.Map = hostile as unknown as MapConstructor;
      originalWeakSet.prototype.add = hostile as typeof WeakSet.prototype.add;
      originalWeakSet.prototype.has = hostile as typeof WeakSet.prototype.has;
      globalThis.WeakSet = hostile as unknown as WeakSetConstructor;
      NodeBuffer.byteLength = hostile as typeof NodeBuffer.byteLength;
      globalThis.Error = hostile as unknown as ErrorConstructor;
      Array.prototype[Symbol.iterator] = hostile as unknown as typeof originalIterator;
      JSON.parse = hostile as typeof JSON.parse;
      JSON.stringify = hostile as typeof JSON.stringify;
      nodeUtilTypes.isProxy = hostile as typeof nodeUtilTypes.isProxy;
      result = evaluateCapabilityV1(validPolicy, validRequest);
    } finally {
      Object.getPrototypeOf = originalGetPrototypeOf;
      Object.getOwnPropertyDescriptor = originalGetOwnPropertyDescriptor;
      Object.defineProperty = originalDefineProperty;
      Object.hasOwn = originalHasOwn;
      Object.freeze = originalFreeze;
      Object.create = originalCreate;
      Reflect.ownKeys = originalOwnKeys;
      Array.isArray = originalIsArray;
      globalThis.String = originalString;
      globalThis.Map = originalMap;
      originalMap.prototype.get = originalMapGet;
      originalMap.prototype.set = originalMapSet;
      originalMap.prototype.has = originalMapHas;
      originalWeakSet.prototype.add = originalWeakSetAdd;
      originalWeakSet.prototype.has = originalWeakSetHas;
      globalThis.WeakSet = originalWeakSet;
      NodeBuffer.byteLength = originalByteLength;
      globalThis.Error = originalError;
      Array.prototype[Symbol.iterator] = originalIterator;
      JSON.parse = originalJsonParse;
      JSON.stringify = originalJsonStringify;
      nodeUtilTypes.isProxy = originalIsProxy;
    }
    expect(result).toEqual({ allowed: true, reason: 'allowed' });
    expect(hooks).toBe(0);
  });

  it('is deterministic, validation-only, and exposed only through the approved root seam', async () => {
    const first = evaluateCapabilityV1(policy(), request());
    const second = evaluateCapabilityV1(policy(), request());
    expect(first).toEqual(second);

    expect(CAPABILITY_POLICY_CONTRACT_ID).toBe('memberry.capability-policy');
    expect(CAPABILITY_POLICY_CONTRACT_VERSION).toBe('1.0.0');
    const source = readFileSync(new URL('../capability-policy.ts', import.meta.url), 'utf8');
    const index = readFileSync(new URL('../index.ts', import.meta.url), 'utf8');
    expect(source).not.toMatch(/JSON\.|\.sort\(|for\s*\([^)]*\sof\s|process\.|globalThis\.(?:fetch|process)/);
    expect(source).not.toMatch(/from ['"]node:(?:fs|path|child_process|os|net|http|https|crypto)['"]/);
    expect(source).not.toMatch(/@memberry\/(?:mcp|neo4j|redis)/);
    expect(index.match(/from '\.\/capability-policy\.js'/g)).toHaveLength(2);
    const root = await import('../index.js');
    expect(root.CAPABILITY_POLICY_CONTRACT_ID).toBe(CAPABILITY_POLICY_CONTRACT_ID);
    expect(root.CAPABILITY_POLICY_CONTRACT_VERSION).toBe(CAPABILITY_POLICY_CONTRACT_VERSION);
    expect(root.CapabilityPolicyContractError).toBe(CapabilityPolicyContractError);
    expect(root.parseActorCapabilityPolicyV1).toBe(parseActorCapabilityPolicyV1);
    expect(root.parseCapabilityCheckRequestV1).toBe(parseCapabilityCheckRequestV1);
    expect(root.evaluateCapabilityV1).toBe(evaluateCapabilityV1);
    expect(index).not.toContain('CAPABILITY_POLICY_MAX_GRANTS');
  });
});
