import { readFileSync } from "node:fs";
import { types as nodeUtilTypes } from "node:util";

import { describe, expect, it } from "vitest";

import {
  OPERATION_TRACE_CONTEXT_CONTRACT_ID,
  OPERATION_TRACE_CONTEXT_CONTRACT_VERSION,
  OPERATION_TRACE_STAGES,
  OperationTraceContextContractError,
  deriveOperationTraceChildV1,
  formatOperationTraceparentV1,
  parseOperationTraceContextV1,
} from "../operation-trace-context.js";

const TRACE_ID = "0123456789abcdef0123456789abcdef";
const ROOT_SPAN_ID = "0123456789abcdef";
const CHILD_SPAN_ID = "fedcba9876543210";

function context(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    contractId: "memberry.operation-trace-context",
    contractVersion: "1.0.0",
    traceId: TRACE_ID,
    spanId: ROOT_SPAN_ID,
    parentSpanId: null,
    traceFlags: "01",
    stage: "store",
    ...overrides,
  };
}

function expectFrozenContext(value: object): void {
  const keys = [
    "contractId",
    "contractVersion",
    "traceId",
    "spanId",
    "parentSpanId",
    "traceFlags",
    "stage",
  ];
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

function expectFailure(
  work: () => unknown,
  code: "invalid-context" | "invalid-span-id" | "invalid-stage",
): void {
  let caught: unknown;
  try {
    work();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(OperationTraceContextContractError);
  expect((caught as OperationTraceContextContractError).code).toBe(code);
  expect(String(caught)).toBe(
    `OperationTraceContextContractError: operation_trace_context:${code}`,
  );
  expect(String(caught)).not.toContain(TRACE_ID);
  expect(String(caught)).not.toContain(ROOT_SPAN_ID);
}

describe("operation trace context v1", () => {
  it("parses an exact root context into a copied frozen null-prototype record", () => {
    const input = context();
    const parsed = parseOperationTraceContextV1(input);

    expect(parsed).toEqual(input);
    expect(parsed).not.toBe(input);
    expectFrozenContext(parsed);
    expect(input).toEqual(context());
  });

  it("parses an exact child context with a non-null parent span", () => {
    const parsed = parseOperationTraceContextV1(
      context({
        spanId: CHILD_SPAN_ID,
        parentSpanId: ROOT_SPAN_ID,
        stage: "retrieval",
        traceFlags: "00",
      }),
    );

    expect(parsed.parentSpanId).toBe(ROOT_SPAN_ID);
    expect(parsed.spanId).toBe(CHILD_SPAN_ID);
    expect(parsed.stage).toBe("retrieval");
    expectFrozenContext(parsed);
  });

  it("derives a pure child while preserving trace identity and flags", () => {
    const parentInput = context({ traceFlags: "00", stage: "extraction" });
    const child = deriveOperationTraceChildV1(
      parentInput,
      CHILD_SPAN_ID,
      "consolidation",
    );

    expect(child).toEqual({
      contractId: "memberry.operation-trace-context",
      contractVersion: "1.0.0",
      traceId: TRACE_ID,
      spanId: CHILD_SPAN_ID,
      parentSpanId: ROOT_SPAN_ID,
      traceFlags: "00",
      stage: "consolidation",
    });
    expectFrozenContext(child);
    expect(parentInput).toEqual(
      context({ traceFlags: "00", stage: "extraction" }),
    );
  });

  it("accepts exactly the fixed stage roster for parsing and derivation", () => {
    const expected = [
      "store",
      "extraction",
      "consolidation",
      "retrieval",
      "mutation",
      "wiki-publication",
    ];
    expect(OPERATION_TRACE_STAGES).toEqual(expected);
    expect(Object.isFrozen(OPERATION_TRACE_STAGES)).toBe(true);
    for (let index = 0; index < expected.length; index += 1) {
      const stage = expected[index]!;
      expect(parseOperationTraceContextV1(context({ stage })).stage).toBe(
        stage,
      );
      expect(
        deriveOperationTraceChildV1(context(), CHILD_SPAN_ID, stage).stage,
      ).toBe(stage);
    }
  });

  it("formats the exact canonical W3C traceparent form", () => {
    expect(formatOperationTraceparentV1(context())).toBe(
      `00-${TRACE_ID}-${ROOT_SPAN_ID}-01`,
    );
    const child = deriveOperationTraceChildV1(
      context(),
      CHILD_SPAN_ID,
      "wiki-publication",
    );
    expect(formatOperationTraceparentV1(child)).toBe(
      `00-${TRACE_ID}-${CHILD_SPAN_ID}-01`,
    );
  });

  it("accepts only trace flags 00 and 01 without bit aliases or coercion", () => {
    expect(
      parseOperationTraceContextV1(context({ traceFlags: "00" })).traceFlags,
    ).toBe("00");
    expect(
      parseOperationTraceContextV1(context({ traceFlags: "01" })).traceFlags,
    ).toBe("01");
    const invalid = ["02", "ff", "1", "000", "0x01", 1, true];
    for (let index = 0; index < invalid.length; index += 1) {
      expectFailure(
        () =>
          parseOperationTraceContextV1(context({ traceFlags: invalid[index] })),
        "invalid-context",
      );
    }
  });

  it("requires exact lowercase nonzero 32-character trace IDs", () => {
    const invalid = [
      "0".repeat(32),
      "0123456789abcdef0123456789abcde",
      "0123456789abcdef0123456789abcdef0",
      "0123456789abcdef0123456789abcdeg",
      "0123456789ABCDEF0123456789ABCDEF",
      ` ${TRACE_ID}`,
      123,
    ];
    for (let index = 0; index < invalid.length; index += 1) {
      expectFailure(
        () =>
          parseOperationTraceContextV1(context({ traceId: invalid[index] })),
        "invalid-context",
      );
    }
  });

  it("requires exact lowercase nonzero 16-character current and parent span IDs", () => {
    const invalid = [
      "0".repeat(16),
      "0123456789abcde",
      "0123456789abcdef0",
      "0123456789abcdeg",
      "0123456789ABCDEF",
      "",
      123,
    ];
    for (let index = 0; index < invalid.length; index += 1) {
      expectFailure(
        () => parseOperationTraceContextV1(context({ spanId: invalid[index] })),
        "invalid-context",
      );
      expectFailure(
        () =>
          parseOperationTraceContextV1(
            context({ parentSpanId: invalid[index] }),
          ),
        "invalid-context",
      );
      expectFailure(
        () => deriveOperationTraceChildV1(context(), invalid[index], "store"),
        "invalid-span-id",
      );
    }
  });

  it("rejects self-parent contexts and reused child span identifiers", () => {
    expectFailure(
      () =>
        parseOperationTraceContextV1(context({ parentSpanId: ROOT_SPAN_ID })),
      "invalid-context",
    );
    expectFailure(
      () => deriveOperationTraceChildV1(context(), ROOT_SPAN_ID, "retrieval"),
      "invalid-span-id",
    );

    const parent = context({
      spanId: CHILD_SPAN_ID,
      parentSpanId: ROOT_SPAN_ID,
    });
    expectFailure(
      () => deriveOperationTraceChildV1(parent, ROOT_SPAN_ID, "retrieval"),
      "invalid-span-id",
    );
    expectFailure(
      () => deriveOperationTraceChildV1(parent, CHILD_SPAN_ID, "retrieval"),
      "invalid-span-id",
    );
  });

  it("rejects unknown stages with no hierarchy, aliases, or normalization", () => {
    const invalid = [
      "Store",
      "wiki_publication",
      "wiki/publication",
      "*",
      "",
      1,
      null,
    ];
    for (let index = 0; index < invalid.length; index += 1) {
      expectFailure(
        () => parseOperationTraceContextV1(context({ stage: invalid[index] })),
        "invalid-context",
      );
      expectFailure(
        () =>
          deriveOperationTraceChildV1(context(), CHILD_SPAN_ID, invalid[index]),
        "invalid-stage",
      );
    }
  });

  it("accepts null-prototype and parsed frozen records as independent inputs", () => {
    const nullInput = Object.assign(Object.create(null), context());
    const parsed = parseOperationTraceContextV1(nullInput);
    const reparsed = parseOperationTraceContextV1(parsed);

    expect(parsed).toEqual(nullInput);
    expect(reparsed).toEqual(parsed);
    expect(parsed).not.toBe(nullInput);
    expect(reparsed).not.toBe(parsed);
  });

  it("rejects extra, missing, symbol, accessor, array, and unsafe-prototype shapes without getters", () => {
    expectFailure(
      () => parseOperationTraceContextV1(context({ extra: true })),
      "invalid-context",
    );
    const missing = context();
    delete missing.traceId;
    expectFailure(
      () => parseOperationTraceContextV1(missing),
      "invalid-context",
    );
    const symbol = context();
    Object.defineProperty(symbol, Symbol("extra"), {
      value: true,
      enumerable: true,
    });
    expectFailure(
      () => parseOperationTraceContextV1(symbol),
      "invalid-context",
    );

    let getterCalls = 0;
    const accessor = context();
    Object.defineProperty(accessor, "traceId", {
      enumerable: true,
      configurable: true,
      get() {
        getterCalls += 1;
        return TRACE_ID;
      },
    });
    expectFailure(
      () => parseOperationTraceContextV1(accessor),
      "invalid-context",
    );
    expect(getterCalls).toBe(0);
    expectFailure(() => parseOperationTraceContextV1([]), "invalid-context");
    const unsafe = context();
    Object.setPrototypeOf(unsafe, { inherited: true });
    expectFailure(
      () => parseOperationTraceContextV1(unsafe),
      "invalid-context",
    );
  });

  it("rejects proxies, revoked proxies, and boxed/coercible values with zero hostile hooks", () => {
    let hooks = 0;
    const proxy = new Proxy(context(), {
      get() {
        hooks += 1;
        throw new Error("get");
      },
      getOwnPropertyDescriptor() {
        hooks += 1;
        throw new Error("descriptor");
      },
      getPrototypeOf() {
        hooks += 1;
        throw new Error("prototype");
      },
      ownKeys() {
        hooks += 1;
        throw new Error("keys");
      },
    });
    expect(nodeUtilTypes.isProxy(proxy)).toBe(true);
    expectFailure(() => parseOperationTraceContextV1(proxy), "invalid-context");
    expect(hooks).toBe(0);

    const revoked = Proxy.revocable(context(), {});
    revoked.revoke();
    expectFailure(
      () => parseOperationTraceContextV1(revoked.proxy),
      "invalid-context",
    );

    const boxed = new String(CHILD_SPAN_ID);
    Object.defineProperty(boxed, "toString", {
      value() {
        hooks += 1;
        throw new Error("coercion");
      },
    });
    expectFailure(
      () => deriveOperationTraceChildV1(context(), boxed, "store"),
      "invalid-span-id",
    );
    expect(hooks).toBe(0);
  });

  it("validates the complete parent before checking fresh span and stage inputs", () => {
    expectFailure(
      () =>
        deriveOperationTraceChildV1(
          context({ traceId: "bad" }),
          CHILD_SPAN_ID,
          "retrieval",
        ),
      "invalid-context",
    );
    expectFailure(
      () => formatOperationTraceparentV1(context({ extra: true })),
      "invalid-context",
    );
  });

  it("uses captured structural and string intrinsics without ambient JSON or iterator dispatch", () => {
    const input = context();
    const originalGetPrototypeOf = Object.getPrototypeOf;
    const originalGetOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
    const originalDefineProperty = Object.defineProperty;
    const originalCreate = Object.create;
    const originalFreeze = Object.freeze;
    const originalHasOwn = Object.hasOwn;
    const originalOwnKeys = Reflect.ownKeys;
    const originalIsArray = Array.isArray;
    const originalString = globalThis.String;
    const originalCharCodeAt = String.prototype.charCodeAt;
    const originalIsProxy = nodeUtilTypes.isProxy;
    const originalJsonParse = JSON.parse;
    const originalJsonStringify = JSON.stringify;
    const originalIterator = Array.prototype[Symbol.iterator];
    let hooks = 0;
    const hostile = () => {
      hooks += 1;
      throw new Error("ambient hook");
    };
    let child: unknown;
    let header: unknown;
    try {
      Object.getPrototypeOf = hostile as typeof Object.getPrototypeOf;
      Object.getOwnPropertyDescriptor =
        hostile as typeof Object.getOwnPropertyDescriptor;
      Object.defineProperty = hostile as typeof Object.defineProperty;
      Object.create = hostile as typeof Object.create;
      Object.freeze = hostile as typeof Object.freeze;
      Object.hasOwn = hostile as typeof Object.hasOwn;
      Reflect.ownKeys = hostile as typeof Reflect.ownKeys;
      Array.isArray = hostile as unknown as typeof Array.isArray;
      originalString.prototype.charCodeAt =
        hostile as typeof String.prototype.charCodeAt;
      globalThis.String = hostile as unknown as StringConstructor;
      nodeUtilTypes.isProxy = hostile as typeof nodeUtilTypes.isProxy;
      JSON.parse = hostile as typeof JSON.parse;
      JSON.stringify = hostile as typeof JSON.stringify;
      Array.prototype[Symbol.iterator] =
        hostile as unknown as typeof originalIterator;
      child = deriveOperationTraceChildV1(input, CHILD_SPAN_ID, "mutation");
      header = formatOperationTraceparentV1(child);
    } finally {
      Object.getPrototypeOf = originalGetPrototypeOf;
      Object.getOwnPropertyDescriptor = originalGetOwnPropertyDescriptor;
      Object.defineProperty = originalDefineProperty;
      Object.create = originalCreate;
      Object.freeze = originalFreeze;
      Object.hasOwn = originalHasOwn;
      Reflect.ownKeys = originalOwnKeys;
      Array.isArray = originalIsArray;
      globalThis.String = originalString;
      originalString.prototype.charCodeAt = originalCharCodeAt;
      nodeUtilTypes.isProxy = originalIsProxy;
      JSON.parse = originalJsonParse;
      JSON.stringify = originalJsonStringify;
      Array.prototype[Symbol.iterator] = originalIterator;
    }
    expect(child).toEqual({
      contractId: "memberry.operation-trace-context",
      contractVersion: "1.0.0",
      traceId: TRACE_ID,
      spanId: CHILD_SPAN_ID,
      parentSpanId: ROOT_SPAN_ID,
      traceFlags: "01",
      stage: "mutation",
    });
    expect(header).toBe(`00-${TRACE_ID}-${CHILD_SPAN_ID}-01`);
    expect(hooks).toBe(0);
  });

  it("is deterministic, observational only, relatively imported, and not runtime wired", () => {
    const first = deriveOperationTraceChildV1(
      context(),
      CHILD_SPAN_ID,
      "retrieval",
    );
    const second = deriveOperationTraceChildV1(
      context(),
      CHILD_SPAN_ID,
      "retrieval",
    );
    expect(first).toEqual(second);
    expect(OPERATION_TRACE_CONTEXT_CONTRACT_ID).toBe(
      "memberry.operation-trace-context",
    );
    expect(OPERATION_TRACE_CONTEXT_CONTRACT_VERSION).toBe("1.0.0");

    const source = readFileSync(
      new URL("../operation-trace-context.ts", import.meta.url),
      "utf8",
    );
    const index = readFileSync(new URL("../index.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(
      /Date\.|Math\.random|randomUUID|process\.|globalThis\.|JSON\./,
    );
    expect(source).not.toMatch(
      /AsyncLocalStorage|OpenTelemetry|@opentelemetry|exporter|collector/,
    );
    expect(source).not.toMatch(
      /from ['"]node:(?:fs|path|child_process|os|net|http|https|crypto|async_hooks)['"]/,
    );
    expect(source).not.toMatch(/@memberry\/(?:neo4j|redis|mcp)/);
    expect(Reflect.ownKeys(first)).not.toContain("tenantId");
    expect(Reflect.ownKeys(first)).not.toContain("projectScope");
    expect(Reflect.ownKeys(first)).not.toContain("authority");
    expect(index).not.toContain("operation-trace-context");
  });
});
