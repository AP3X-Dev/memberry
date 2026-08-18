import { readFileSync } from "node:fs";
import crypto from "node:crypto";
import { syncBuiltinESMExports } from "node:module";
import { types as nodeUtilTypes } from "node:util";

import { describe, expect, it, vi } from "vitest";

import {
  RETRIEVAL_EXPLANATION_VIEW_CONTRACT_ID,
  RETRIEVAL_EXPLANATION_VIEW_CONTRACT_VERSION,
  RetrievalExplanationViewContractError,
  buildRetrievalExplanationViewV1,
  renderRetrievalExplanationTextV1,
} from "../retrieval-explanation-view.js";
import {
  RetrievalTraceCollector,
  computeRetrievalTraceReplayStateDigest,
  type RetrievalTraceCandidateDraft,
  type RetrievalTraceCandidateHandle,
  type RetrievalTraceRequestShapeV1,
  type RetrievalTraceV1,
} from "../trace.js";

const request: RetrievalTraceRequestShapeV1 = {
  sources: { code: true, architecture: false, memory: true },
  projectScopeApplied: true,
  tenantScope: "named",
  entityScope: "few",
  tagScope: "one",
  temporalFilterApplied: true,
  queryLength: "short",
  queryForm: "identifier-heavy",
  tokenBudget: "medium",
  diversification: "mmr",
  plannedChannels: ["memory.scope", "memory.semantic-vector", "memory.fact"],
};

function candidate(
  channel: "memory.scope" | "memory.semantic-vector",
  rank: number,
  score: number,
): RetrievalTraceCandidateDraft {
  return {
    sourceType: "semantic",
    channels: [{ channel, rank, score }],
    evidence: {
      confidence: score,
      sourceCount: rank,
      superseded: false,
      invalidated: false,
    },
    estimatedTokens: 40 + rank,
  };
}

function buildCompleteTrace(): RetrievalTraceV1 {
  const collector = new RetrievalTraceCollector("ranked-v1", request);
  collector.attemptChannel("memory.scope");
  collector.settleChannel("memory.scope", { outcome: "success" });
  collector.attemptChannel("memory.semantic-vector");
  collector.settleChannel("memory.semantic-vector", { outcome: "success" });
  collector.attemptChannel("memory.fact");
  collector.settleChannel("memory.fact", {
    outcome: "safe-failure",
    code: "query-failed",
  });

  const first = collector.addCandidate(candidate("memory.scope", 1, 0.91));
  const second = collector.addCandidate(
    candidate("memory.semantic-vector", 2, 0.81),
  );
  collector.recordFilter(first, { name: "tenant", outcome: "pass" });
  collector.recordFilter(first, { name: "project", outcome: "pass" });
  collector.recordFilter(first, { name: "mmr", outcome: "pass" });
  collector.recordFilter(second, { name: "dedup", outcome: "fail" });
  collector.recordFilter(second, { name: "mmr", outcome: "pass" });
  collector.recordScore(first, { name: "input", value: 0.91 });
  collector.recordScore(first, { name: "final", value: 0.91 });
  collector.recordScore(second, { name: "input", value: 0.81 });
  collector.recordScore(second, { name: "final", value: 0.81 });
  collector.recordMmrRound(1, first, [
    { candidate: first, relevance: 0.91, lambda: 0.6, pairwise: [] },
    { candidate: second, relevance: 0.81, lambda: 0.6, pairwise: [] },
  ]);
  collector.recordMmrRound(2, second, [
    {
      candidate: second,
      relevance: 0.81,
      lambda: 0.6,
      pairwise: [{ selected: first, similarity: 0.1 }],
    },
  ]);
  collector.recordOutput(first, 1);
  collector.recordTerminal(first, { outcome: "included", reasons: [] });
  collector.recordTerminal(second, {
    outcome: "excluded",
    reasons: ["duplicate"],
    duplicateOf: first,
  });
  collector.recordStageFailure("feedback", "timeout");
  return collector.finalize();
}

function buildIncompleteTrace(): RetrievalTraceV1 {
  const collector = new RetrievalTraceCollector("ranked-v1", {
    ...request,
    diversification: "none",
    plannedChannels: ["memory.scope"],
  });
  return collector.finalize();
}

function buildArchitectureTrace(): RetrievalTraceV1 {
  const collector = new RetrievalTraceCollector("deterministic-v2", {
    sources: { code: false, architecture: true, memory: false },
    projectScopeApplied: true,
    tenantScope: "default",
    entityScope: "none",
    tagScope: "none",
    temporalFilterApplied: false,
    queryLength: "empty",
    queryForm: "identifier-heavy",
    tokenBudget: "small",
    diversification: "none",
    plannedChannels: ["arch.fulltext", "arch.entity"],
  });
  collector.attemptChannel("arch.fulltext");
  collector.settleChannel("arch.fulltext", { outcome: "success" });
  collector.attemptChannel("arch.entity");
  collector.settleChannel("arch.entity", { outcome: "success" });
  const handle = collector.addCandidate({
    sourceType: "arch_entity",
    channels: [{ channel: "arch.entity", rank: 1 }],
    evidence: {},
    estimatedTokens: 1,
  });
  collector.recordTerminal(handle, { outcome: "included", reasons: [] });
  return collector.finalize();
}

function buildIncompleteArchitectureTrace(): RetrievalTraceV1 {
  const collector = new RetrievalTraceCollector("deterministic-v2", {
    sources: { code: false, architecture: true, memory: false },
    projectScopeApplied: true,
    tenantScope: "default",
    entityScope: "none",
    tagScope: "none",
    temporalFilterApplied: false,
    queryLength: "empty",
    queryForm: "identifier-heavy",
    tokenBudget: "small",
    diversification: "none",
    plannedChannels: ["arch.fulltext", "arch.entity"],
  });
  collector.attemptChannel("arch.entity");
  collector.settleChannel("arch.entity", { outcome: "success" });
  const handle = collector.addCandidate({
    sourceType: "arch_entity",
    channels: [{ channel: "arch.entity", rank: 1 }],
    evidence: {},
    estimatedTokens: 1,
  });
  collector.recordTerminal(handle, { outcome: "included", reasons: [] });
  return collector.finalize();
}

function buildEmptyCompleteTrace(): RetrievalTraceV1 {
  return new RetrievalTraceCollector("ranked-v1", {
    ...request,
    sources: { code: false, architecture: false, memory: false },
    diversification: "none",
    plannedChannels: [],
  }).finalize();
}

function mutableCopy<T>(value: T): T {
  return structuredClone(value);
}

function assertDeeplyFrozen(value: unknown, seen = new Set<object>()): void {
  if (
    (typeof value !== "object" && typeof value !== "function") ||
    value === null
  )
    return;
  if (seen.has(value)) return;
  seen.add(value);
  expect(Object.isFrozen(value)).toBe(true);
  if (!Array.isArray(value)) expect(Object.getPrototypeOf(value)).toBeNull();
  for (const key of Reflect.ownKeys(value)) {
    if (key === "length") continue;
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    expect(descriptor.get).toBeUndefined();
    expect(descriptor.set).toBeUndefined();
    expect(descriptor.enumerable).toBe(true);
    assertDeeplyFrozen(descriptor.value, seen);
  }
}

function errorSnapshot(action: () => unknown): {
  name: string;
  message: string;
  code: string;
} {
  try {
    action();
    throw new Error("expected contract error");
  } catch (error) {
    expect(error).toBeInstanceOf(RetrievalExplanationViewContractError);
    const contractError = error as RetrievalExplanationViewContractError;
    return {
      name: contractError.name,
      message: contractError.message,
      code: contractError.code,
    };
  }
}

describe("UI-001A retrieval explanation view", () => {
  it("builds the exact secret-safe view and independently binds complete replay", () => {
    const trace = buildCompleteTrace();
    const view = buildRetrievalExplanationViewV1(trace);

    expect(Object.keys(view)).toEqual([
      "contractId",
      "contractVersion",
      "traceSchemaVersion",
      "algorithmVersion",
      "requestShape",
      "complete",
      "incompleteReasons",
      "candidates",
      "events",
      "replayReceipt",
    ]);
    expect(view.contractId).toBe(RETRIEVAL_EXPLANATION_VIEW_CONTRACT_ID);
    expect(view.contractVersion).toBe(
      RETRIEVAL_EXPLANATION_VIEW_CONTRACT_VERSION,
    );
    expect(view.replayReceipt).toEqual({
      replayable: true,
      resultOrder: trace.resultOrder,
      terminalExclusions: trace.terminalExclusions,
      replayStateDigest: trace.replayStateDigest,
    });
    expect(view.requestShape).toEqual(trace.requestShape);
    expect(view.candidates).toEqual(trace.candidates);
    expect(view.events).toEqual(trace.events);
    expect(view.candidates).not.toBe(trace.candidates);
    expect(view.events).not.toBe(trace.events);
    if (!view.replayReceipt.replayable)
      throw new Error("expected replayable receipt");
    expect(view.replayReceipt.resultOrder).not.toBe(trace.resultOrder);
    assertDeeplyFrozen(view);
  });

  it("preserves caller order for candidates, channels, events, MMR records, pairwise, and outputs", () => {
    const trace = buildCompleteTrace();
    const view = buildRetrievalExplanationViewV1(trace);
    expect(view.candidates.map((item) => item.ref)).toEqual(
      trace.candidates.map((item) => item.ref),
    );
    expect(view.candidates[0]!.channels).toEqual(trace.candidates[0]!.channels);
    expect(view.events.map((event) => event.sequence)).toEqual(
      trace.events.map((event) => event.sequence),
    );
    const sourceMmr = trace.events.filter(
      (event) => event.kind === "mmr-round",
    );
    const viewMmr = view.events.filter((event) => event.kind === "mmr-round");
    expect(viewMmr).toEqual(sourceMmr);
    expect(viewMmr[1]!.records[0]!.pairwise).toEqual(
      sourceMmr[1]!.records[0]!.pairwise,
    );
    expect(
      view.replayReceipt.replayable && view.replayReceipt.resultOrder,
    ).toEqual(["c0001"]);
  });

  it("exposes every selection-affecting category but no original identities or content", () => {
    const view = buildRetrievalExplanationViewV1(buildCompleteTrace());
    const encoded = JSON.stringify(view);
    for (const expected of [
      "projectScopeApplied",
      "tenantScope",
      "entityScope",
      "tagScope",
      "temporalFilterApplied",
      "queryLength",
      "queryForm",
      "tokenBudget",
      "plannedChannels",
      "sourceType",
      "channels",
      "rank",
      "score",
      "evidence",
      "estimatedTokens",
      "candidate-filter",
      "candidate-score",
      "mmr-round",
      "pairwise",
      "ranked-output",
      "candidate-terminal",
      "duplicateOfRef",
      "stage-failure",
      "query-failed",
      "replayStateDigest",
    ])
      expect(encoded).toContain(expected);
    for (const forbidden of [
      "queryText",
      "content",
      "tenantId",
      "projectId",
      "sourceId",
      "task",
      "tags",
      "metadata",
      "entityId",
      "credential",
    ])
      expect(encoded).not.toContain(forbidden);
  });

  it("represents incomplete traces without claiming reproduced selection", () => {
    const trace = buildIncompleteTrace();
    const view = buildRetrievalExplanationViewV1(trace);
    expect(view.complete).toBe(false);
    expect(view.incompleteReasons).toEqual(trace.incompleteReasons);
    expect(view.replayReceipt).toEqual({
      replayable: false,
      incompleteReasons: trace.incompleteReasons,
      replayStateDigest: trace.replayStateDigest,
    });
    expect(Object.keys(view.replayReceipt)).not.toContain("resultOrder");
    expect(Object.keys(view.replayReceipt)).not.toContain("terminalExclusions");
    assertDeeplyFrozen(view);
  });

  it("rejects complete traces whose stored result echo is not independently replayable", () => {
    const trace = mutableCopy(buildCompleteTrace());
    trace.resultOrder = ["c0002"];
    expect(errorSnapshot(() => buildRetrievalExplanationViewV1(trace))).toEqual(
      {
        name: "RetrievalExplanationViewContractError",
        message: "Retrieval explanation view contract error: invalid-trace",
        code: "invalid-trace",
      },
    );
  });

  it("rejects malformed, decorated, secret-bearing, and digest-tampered traces with fixed errors", () => {
    const cases: unknown[] = [
      null,
      [],
      { ...buildCompleteTrace(), query: "private question" },
      { ...buildCompleteTrace(), credential: "Bearer abcdefghijklmnop" },
      { ...buildCompleteTrace(), replayStateDigest: "sha256:".padEnd(71, "0") },
    ];
    for (const value of cases) {
      expect(
        errorSnapshot(() => buildRetrievalExplanationViewV1(value)),
      ).toEqual({
        name: "RetrievalExplanationViewContractError",
        message: "Retrieval explanation view contract error: invalid-trace",
        code: "invalid-trace",
      });
    }
  });

  it("rejects oversized scalar values and property keys before measuring their UTF-8 bytes", async () => {
    const hostileValue = `${"v".repeat(4 * 1024 * 1024)}\ud800`;
    const hostileKey = `${"k".repeat(4 * 1024 * 1024)}\ud800`;
    const scalarTrace = mutableCopy(buildCompleteTrace());
    scalarTrace.algorithmVersion = hostileValue;
    const keyTrace = mutableCopy(buildCompleteTrace());
    Object.defineProperty(keyTrace.requestShape, hostileKey, {
      value: true,
      enumerable: true,
      writable: true,
      configurable: true,
    });
    const baseView = mutableCopy(
      buildRetrievalExplanationViewV1(buildCompleteTrace()),
    );
    const scalarView = mutableCopy(baseView);
    scalarView.algorithmVersion = hostileValue;
    const keyView = mutableCopy(baseView);
    Object.defineProperty(keyView.requestShape, hostileKey, {
      value: true,
      enumerable: true,
      writable: true,
      configurable: true,
    });
    const originalDescriptor = Object.getOwnPropertyDescriptor(
      Buffer,
      "byteLength",
    )!;
    const originalByteLength = Buffer.byteLength;
    let hostileValueScans = 0;
    let hostileKeyScans = 0;
    let positiveControlScans = 0;

    Object.defineProperty(Buffer, "byteLength", {
      ...originalDescriptor,
      value: ((value, encoding) => {
        if (value === hostileValue) hostileValueScans += 1;
        else if (value === hostileKey) hostileKeyScans += 1;
        else positiveControlScans += 1;
        return Reflect.apply(originalByteLength, Buffer, [value, encoding]);
      }) satisfies typeof Buffer.byteLength,
    });
    vi.resetModules();

    try {
      const instrumented = await import("../retrieval-explanation-view.js");
      for (const action of [
        () => instrumented.buildRetrievalExplanationViewV1(scalarTrace),
        () => instrumented.buildRetrievalExplanationViewV1(keyTrace),
        () => instrumented.renderRetrievalExplanationTextV1(scalarView),
        () => instrumented.renderRetrievalExplanationTextV1(keyView),
      ]) {
        let outcome: unknown;
        try {
          action();
        } catch (error) {
          outcome = error;
        }
        expect(outcome).toMatchObject({
          name: "RetrievalExplanationViewContractError",
        });
      }

      instrumented.buildRetrievalExplanationViewV1(buildCompleteTrace());
      expect(positiveControlScans).toBeGreaterThan(0);
      expect(hostileValueScans).toBe(0);
      expect(hostileKeyScans).toBe(0);
    } finally {
      Object.defineProperty(Buffer, "byteLength", originalDescriptor);
      vi.resetModules();
    }
  });

  it("rejects proxies, revoked proxies, accessors, symbols, sparse arrays, aliases, and cycles without hooks", () => {
    let hooks = 0;
    const getterTrace = mutableCopy(
      buildCompleteTrace(),
    ) as RetrievalTraceV1 & { query?: string };
    Object.defineProperty(getterTrace, "query", {
      enumerable: true,
      get() {
        hooks += 1;
        return "secret";
      },
    });
    const proxy = new Proxy(buildCompleteTrace(), {
      ownKeys() {
        hooks += 1;
        return [];
      },
    });
    const revoked = Proxy.revocable(buildCompleteTrace(), {});
    revoked.revoke();
    const symbolTrace = mutableCopy(
      buildCompleteTrace(),
    ) as RetrievalTraceV1 & { [key: symbol]: unknown };
    symbolTrace[Symbol("secret")] = "hidden";
    const sparse = mutableCopy(buildCompleteTrace());
    sparse.events = new Array(1);
    const alias = mutableCopy(buildCompleteTrace());
    alias.events = alias.candidates as unknown as typeof alias.events;
    const cycle = mutableCopy(buildCompleteTrace()) as RetrievalTraceV1 & {
      self?: unknown;
    };
    cycle.self = cycle;

    for (const value of [
      getterTrace,
      proxy,
      revoked.proxy,
      symbolTrace,
      sparse,
      alias,
      cycle,
    ]) {
      expect(() => buildRetrievalExplanationViewV1(value)).toThrow(
        RetrievalExplanationViewContractError,
      );
    }
    expect(hooks).toBe(0);
  });

  it("does not mutate, freeze, or alias any caller-owned trace data", () => {
    const trace = mutableCopy(buildCompleteTrace());
    const before = structuredClone(trace);
    buildRetrievalExplanationViewV1(trace);
    expect(trace).toEqual(before);
    expect(Object.isFrozen(trace)).toBe(false);
    expect(Object.isFrozen(trace.requestShape)).toBe(false);
    expect(Object.isFrozen(trace.candidates)).toBe(false);
  });

  it("renders deterministic bounded plain text containing the complete explanation", () => {
    const view = buildRetrievalExplanationViewV1(buildCompleteTrace());
    const first = renderRetrievalExplanationTextV1(view);
    const second = renderRetrievalExplanationTextV1(view);
    expect(second).toBe(first);
    expect(Buffer.byteLength(first, "utf8")).toBeLessThanOrEqual(
      8 * 1024 * 1024,
    );
    expect(first).toContain("contractId=memberry.retrieval-explanation-view");
    expect(first).toContain("requestShape.tenantScope=named");
    expect(first).toContain("events[0].kind=channel-attempt");
    expect(first).toContain("events[6].kind=candidate-filter");
    expect(first).toContain("replayReceipt.replayable=true");
    expect(first).toContain("replayReceipt.resultOrder[0]=c0001");
    expect(first).toContain(
      "replayReceipt.terminalExclusions[0].duplicateOfRef=c0001",
    );
    expect(first).not.toMatch(/[<>&`*#]/);
  });

  it("renders incomplete reasons while omitting reproduced result and exclusion lines", () => {
    const text = renderRetrievalExplanationTextV1(
      buildRetrievalExplanationViewV1(buildIncompleteTrace()),
    );
    expect(text).toContain("replayReceipt.replayable=false");
    expect(text).toContain("replayReceipt.incompleteReasons[0]=channel-gap");
    expect(text).not.toContain("replayReceipt.resultOrder");
    expect(text).not.toContain("replayReceipt.terminalExclusions");
  });

  it("revalidates the view before rendering and transactionally rejects every tamper class", () => {
    const base = buildRetrievalExplanationViewV1(buildCompleteTrace());
    const extra = mutableCopy(base) as typeof base & { content?: string };
    extra.content = "private";
    const receipt = mutableCopy(base);
    if (receipt.replayReceipt.replayable) {
      (
        receipt.replayReceipt as unknown as { resultOrder: string[] }
      ).resultOrder = ["c0002"];
    }
    const event = mutableCopy(base);
    event.events[0]!.sequence = 2;
    const sparse = mutableCopy(base);
    (sparse as unknown as { candidates: unknown[] }).candidates = new Array(1);
    const alias = mutableCopy(base);
    (alias as unknown as { events: unknown }).events = alias.candidates;
    const proxy = new Proxy(base, { ownKeys: () => [] });
    const accessor = mutableCopy(base);
    let hooks = 0;
    Object.defineProperty(accessor, "complete", {
      enumerable: true,
      get() {
        hooks += 1;
        return true;
      },
    });

    for (const value of [
      extra,
      receipt,
      event,
      sparse,
      alias,
      proxy,
      accessor,
    ]) {
      expect(
        errorSnapshot(() => renderRetrievalExplanationTextV1(value)),
      ).toEqual({
        name: "RetrievalExplanationViewContractError",
        message: "Retrieval explanation view contract error: invalid-view",
        code: "invalid-view",
      });
    }
    expect(hooks).toBe(0);
  });

  it("uses no caller toJSON or iterator behavior in either public operation", () => {
    let hooks = 0;
    const trace = mutableCopy(buildCompleteTrace()) as RetrievalTraceV1 & {
      toJSON?: () => never;
    };
    trace.toJSON = () => {
      hooks += 1;
      throw new Error("must not run");
    };
    expect(() => buildRetrievalExplanationViewV1(trace)).toThrow(
      RetrievalExplanationViewContractError,
    );

    const view = mutableCopy(
      buildRetrievalExplanationViewV1(buildCompleteTrace()),
    );
    Object.defineProperty(view.events, Symbol.iterator, {
      configurable: true,
      value() {
        hooks += 1;
        throw new Error("must not run");
      },
    });
    expect(() => renderRetrievalExplanationTextV1(view)).toThrow(
      RetrievalExplanationViewContractError,
    );
    expect(hooks).toBe(0);
  });

  it("fails closed before inherited numeric setter dispatch", () => {
    const trace = buildCompleteTrace();
    const previous = Object.getOwnPropertyDescriptor(Array.prototype, "0");
    let hooks = 0;
    let view: ReturnType<typeof buildRetrievalExplanationViewV1> | undefined;
    try {
      Object.defineProperty(Array.prototype, "0", {
        configurable: true,
        set(value: unknown) {
          hooks += 1;
          Object.defineProperty(this, "0", {
            value,
            enumerable: true,
            writable: true,
            configurable: true,
          });
        },
      });
      expect(() => buildRetrievalExplanationViewV1(trace)).toThrow(
        RetrievalExplanationViewContractError,
      );
    } finally {
      if (previous === undefined) delete Array.prototype["0"];
      else Object.defineProperty(Array.prototype, "0", previous);
    }
    expect(hooks).toBe(0);
    expect(view).toBeUndefined();
  });

  it("rejects an inherited Object.prototype confidence getter with zero hooks", () => {
    const trace = mutableCopy(buildIncompleteArchitectureTrace());
    trace.replayStateDigest = "sha256:".padEnd(71, "0");
    const previous = Object.getOwnPropertyDescriptor(
      Object.prototype,
      "confidence",
    );
    let hooks = 0;
    let outcome: unknown;
    try {
      Object.defineProperty(Object.prototype, "confidence", {
        configurable: true,
        get() {
          hooks += 1;
          return 0.75;
        },
      });
      try {
        outcome = buildRetrievalExplanationViewV1(trace);
      } catch (error) {
        outcome = error;
      }
    } finally {
      if (previous === undefined)
        Reflect.deleteProperty(Object.prototype, "confidence");
      else Object.defineProperty(Object.prototype, "confidence", previous);
    }
    expect(hooks).toBe(0);
    expect(outcome).toMatchObject({
      name: "RetrievalExplanationViewContractError",
      code: "invalid-trace",
    });
  });

  it("guards numeric setters across the complete Array prototype chain", () => {
    const trace = buildIncompleteTrace();
    const previous = Object.getOwnPropertyDescriptor(Object.prototype, "0");
    let hooks = 0;
    let outcome: unknown;
    try {
      Object.defineProperty(Object.prototype, "0", {
        configurable: true,
        set(value: unknown) {
          hooks += 1;
          Object.defineProperty(this, "0", {
            value,
            enumerable: true,
            writable: true,
            configurable: true,
          });
        },
      });
      try {
        outcome = buildRetrievalExplanationViewV1(trace);
      } catch (error) {
        outcome = error;
      }
    } finally {
      if (previous === undefined) Reflect.deleteProperty(Object.prototype, "0");
      else Object.defineProperty(Object.prototype, "0", previous);
    }
    expect(hooks).toBe(0);
    expect(outcome).toMatchObject({
      name: "RetrievalExplanationViewContractError",
      code: "invalid-trace",
    });
  });

  it("guards an inserted Array prototype-chain numeric setter with zero hooks", () => {
    const trace = buildIncompleteTrace();
    const getPrototypeOf = Object.getPrototypeOf;
    const setPrototypeOf = Object.setPrototypeOf;
    const previous = getPrototypeOf(Array.prototype);
    const sibling = Object.create(previous) as object;
    let hooks = 0;
    let outcome: unknown;
    Object.defineProperty(sibling, "0", {
      configurable: true,
      set(value: unknown) {
        hooks += 1;
        Object.defineProperty(this, "0", {
          value,
          enumerable: true,
          writable: true,
          configurable: true,
        });
      },
    });
    try {
      setPrototypeOf(Array.prototype, sibling);
      try {
        outcome = buildRetrievalExplanationViewV1(trace);
      } catch (error) {
        outcome = error;
      }
    } finally {
      setPrototypeOf(Array.prototype, previous);
    }
    expect(hooks).toBe(0);
    expect(outcome).toMatchObject({
      name: "RetrievalExplanationViewContractError",
      code: "invalid-trace",
    });
  });

  it("guards the topology of every trace runtime surface", () => {
    const trace = buildIncompleteTrace();
    const getPrototypeOf = Object.getPrototypeOf;
    const setPrototypeOf = Object.setPrototypeOf;
    const create = Object.create;
    const targets: Array<{ name: string; target: object }> = [
      { name: "Object.prototype", target: Object.prototype },
      { name: "Array.prototype", target: Array.prototype },
      { name: "Object", target: Object },
      { name: "Array", target: Array },
      { name: "Reflect", target: Reflect },
      { name: "JSON", target: JSON },
      { name: "Number", target: Number },
      { name: "Number.prototype", target: Number.prototype },
      { name: "Math", target: Math },
      { name: "String", target: String },
      { name: "String.prototype", target: String.prototype },
      { name: "RegExp.prototype", target: RegExp.prototype },
      { name: "Set", target: Set },
      { name: "Set.prototype", target: Set.prototype },
      { name: "Map", target: Map },
      { name: "Map.prototype", target: Map.prototype },
      { name: "WeakSet", target: WeakSet },
      { name: "WeakSet.prototype", target: WeakSet.prototype },
      { name: "Buffer", target: Buffer },
      {
        name: "Hash.prototype",
        target: getPrototypeOf(crypto.createHash("sha256")) as object,
      },
      {
        name: "ArrayIterator.prototype",
        target: getPrototypeOf([][Symbol.iterator]()) as object,
      },
      {
        name: "SetIterator.prototype",
        target: getPrototypeOf(new Set()[Symbol.iterator]()) as object,
      },
      {
        name: "MapIterator.prototype",
        target: getPrototypeOf(new Map().entries()) as object,
      },
      { name: "nodeUtilTypes", target: nodeUtilTypes },
    ];
    const results: Array<{
      name: string;
      mutable: boolean;
      hooks: number;
      outcome: unknown;
    }> = [];

    for (const item of targets) {
      const previous = getPrototypeOf(item.target);
      const sibling = create(previous) as object;
      let hooks = 0;
      let mutable = false;
      let outcome: unknown;
      Object.defineProperty(sibling, "topologyProbe", {
        configurable: true,
        get() {
          hooks += 1;
          throw new Error("must not run");
        },
      });
      try {
        try {
          setPrototypeOf(item.target, sibling);
          mutable = true;
        } catch {
          // Object.prototype has an immutable [[Prototype]] by specification.
        }
        if (mutable) {
          try {
            outcome = buildRetrievalExplanationViewV1(trace);
          } catch (error) {
            outcome = error;
          }
        }
      } finally {
        if (mutable) setPrototypeOf(item.target, previous);
      }
      results.push({ name: item.name, mutable, hooks, outcome });
    }

    expect(results).toHaveLength(targets.length);
    for (const result of results) {
      expect(result.hooks, result.name).toBe(0);
      if (!result.mutable) {
        expect(result.name).toBe("Object.prototype");
        continue;
      }
      expect(result.outcome, result.name).toMatchObject({
        name: "RetrievalExplanationViewContractError",
        code: "invalid-trace",
      });
    }
  });

  it("guards ambient Object.values before trace secret scanning", () => {
    const trace = buildEmptyCompleteTrace();
    const view = buildRetrievalExplanationViewV1(trace);
    const original = Object.values;
    let hooks = 0;
    let outcome: unknown;
    let renderOutcome: unknown;
    try {
      Object.values = ((value: object) => {
        hooks += 1;
        return original(value);
      }) as typeof Object.values;
      try {
        outcome = buildRetrievalExplanationViewV1(trace);
      } catch (error) {
        outcome = error;
      }
      try {
        renderOutcome = renderRetrievalExplanationTextV1(view);
      } catch (error) {
        renderOutcome = error;
      }
    } finally {
      Object.values = original;
    }
    expect(hooks).toBe(0);
    expect(outcome).toMatchObject({
      name: "RetrievalExplanationViewContractError",
      code: "invalid-trace",
    });
    expect(renderOutcome).toMatchObject({
      name: "RetrievalExplanationViewContractError",
      code: "invalid-view",
    });
  });

  it("guards post-import Array.isArray replacement", () => {
    const trace = new Array(1);
    const original = Array.isArray;
    let hooks = 0;
    let outcome: unknown;
    try {
      Array.isArray = ((value: unknown) => {
        hooks += 1;
        return original(value);
      }) as typeof Array.isArray;
      try {
        outcome = buildRetrievalExplanationViewV1(trace);
      } catch (error) {
        outcome = error;
      }
    } finally {
      Array.isArray = original;
    }
    expect(hooks).toBe(0);
    expect(outcome).toMatchObject({
      name: "RetrievalExplanationViewContractError",
      code: "invalid-trace",
    });
  });

  it("guards the global Array binding without invoking an inherited getter", () => {
    const trace = buildIncompleteTrace();
    const globalObject = globalThis;
    const defineProperty = Object.defineProperty;
    const previous = Object.getOwnPropertyDescriptor(globalObject, "Array")!;
    const original = Array;
    let hooks = 0;
    let outcome: unknown;
    try {
      defineProperty(globalObject, "Array", {
        configurable: previous.configurable,
        enumerable: previous.enumerable,
        get() {
          hooks += 1;
          return original;
        },
      });
      try {
        outcome = buildRetrievalExplanationViewV1(trace);
      } catch (error) {
        outcome = error;
      }
    } finally {
      defineProperty(globalObject, "Array", previous);
    }
    expect(hooks).toBe(0);
    expect(outcome).toMatchObject({
      name: "RetrievalExplanationViewContractError",
      code: "invalid-trace",
    });
  });

  it("guards every global binding read by the trace integrity boundary", () => {
    const trace = buildIncompleteTrace();
    const globalObject = globalThis;
    const defineProperty = Object.defineProperty;
    const getDescriptor = Object.getOwnPropertyDescriptor;
    const cases: Array<{ name: string; value: unknown }> = [
      { name: "Array", value: Array },
      { name: "Object", value: Object },
      { name: "Reflect", value: Reflect },
      { name: "JSON", value: JSON },
      { name: "Number", value: Number },
      { name: "Math", value: Math },
      { name: "String", value: String },
      { name: "Set", value: Set },
      { name: "Map", value: Map },
      { name: "WeakSet", value: WeakSet },
      { name: "Buffer", value: Buffer },
    ];
    const results: Array<{
      name: string;
      hooks: number;
      outcome: unknown;
    }> = [];

    for (const item of cases) {
      const previous = getDescriptor(globalObject, item.name)!;
      let hooks = 0;
      let outcome: unknown;
      try {
        defineProperty(globalObject, item.name, {
          configurable: previous.configurable,
          enumerable: previous.enumerable,
          get() {
            hooks += 1;
            return item.value;
          },
        });
        try {
          outcome = buildRetrievalExplanationViewV1(trace);
        } catch (error) {
          outcome = error;
        }
      } finally {
        defineProperty(globalObject, item.name, previous);
      }
      results.push({ name: item.name, hooks, outcome });
    }

    for (const result of results) {
      expect(result.hooks, result.name).toBe(0);
      expect(result.outcome, result.name).toMatchObject({
        name: "RetrievalExplanationViewContractError",
        code: "invalid-trace",
      });
    }
  });

  it("guards node crypto createHash live-binding replacement", () => {
    const trace = buildIncompleteTrace();
    const original = crypto.createHash;
    let hooks = 0;
    let outcome: unknown;
    try {
      crypto.createHash = ((...args: Parameters<typeof crypto.createHash>) => {
        hooks += 1;
        return original(...args);
      }) as typeof crypto.createHash;
      syncBuiltinESMExports();
      try {
        outcome = buildRetrievalExplanationViewV1(trace);
      } catch (error) {
        outcome = error;
      }
    } finally {
      crypto.createHash = original;
      syncBuiltinESMExports();
    }
    expect(hooks).toBe(0);
    expect(outcome).toMatchObject({
      name: "RetrievalExplanationViewContractError",
      code: "invalid-trace",
    });
  });

  it("guards sibling mutable ambient methods reachable through trace validation and replay", () => {
    const trace = buildCompleteTrace();
    const hashPrototype = Object.getPrototypeOf(
      crypto.createHash("sha256"),
    ) as object;
    const arrayIteratorPrototype = Object.getPrototypeOf(
      [][Symbol.iterator](),
    ) as object;
    const setIteratorPrototype = Object.getPrototypeOf(
      new Set()[Symbol.iterator](),
    ) as object;
    const cases: Array<{ target: object; key: PropertyKey }> = [
      ...[
        "every",
        "filter",
        "forEach",
        "includes",
        "map",
        "pop",
        "push",
        "some",
        "sort",
        Symbol.iterator,
      ].map((key) => ({ target: Array.prototype, key })),
      ...[
        "create",
        "entries",
        "getOwnPropertyDescriptor",
        "getPrototypeOf",
        "hasOwn",
        "is",
      ].map((key) => ({ target: Object, key })),
      { target: Reflect, key: "ownKeys" },
      { target: JSON, key: "stringify" },
      { target: Number, key: "isFinite" },
      { target: Number, key: "isSafeInteger" },
      { target: Number.prototype, key: "toFixed" },
      { target: Math, key: "abs" },
      { target: String.prototype, key: "padStart" },
      { target: RegExp.prototype, key: "test" },
      { target: Set.prototype, key: "add" },
      { target: Set.prototype, key: "has" },
      { target: Set.prototype, key: Symbol.iterator },
      { target: Map.prototype, key: "get" },
      { target: Map.prototype, key: "has" },
      { target: WeakSet.prototype, key: "add" },
      { target: WeakSet.prototype, key: "delete" },
      { target: WeakSet.prototype, key: "has" },
      { target: Buffer, key: "byteLength" },
      { target: hashPrototype, key: "update" },
      { target: hashPrototype, key: "digest" },
      { target: arrayIteratorPrototype, key: "next" },
      { target: setIteratorPrototype, key: "next" },
    ];

    for (const item of cases) {
      const previous = Object.getOwnPropertyDescriptor(item.target, item.key)!;
      let hooks = 0;
      let outcome: unknown;
      Object.defineProperty(item.target, item.key, {
        ...previous,
        value: function hostileAmbientMethod() {
          hooks += 1;
          throw new Error("must not run");
        },
      });
      try {
        try {
          outcome = buildRetrievalExplanationViewV1(trace);
        } catch (error) {
          outcome = error;
        }
      } finally {
        Object.defineProperty(item.target, item.key, previous);
      }
      expect(hooks, String(item.key)).toBe(0);
      expect(outcome, String(item.key)).toMatchObject({
        name: "RetrievalExplanationViewContractError",
        code: "invalid-trace",
      });
    }
  });

  it("renders fixed underscore-bearing source categories as plain text", () => {
    const text = renderRetrievalExplanationTextV1(
      buildRetrievalExplanationViewV1(buildArchitectureTrace()),
    );
    expect(text).toContain("candidates[0].sourceType=arch_entity");
  });

  it("keeps errors value-free and stable for late invalid data", () => {
    const early = errorSnapshot(() => buildRetrievalExplanationViewV1(null));
    const late = mutableCopy(buildCompleteTrace());
    const lateEvents =
      late.events as unknown as RetrievalTraceV1["events"][number][];
    lateEvents[lateEvents.length - 1] = {
      ...late.events[late.events.length - 1]!,
      code: "private-cause",
    } as unknown as RetrievalTraceV1["events"][number];
    expect(errorSnapshot(() => buildRetrievalExplanationViewV1(late))).toEqual(
      early,
    );
  });

  it("keeps source and rendered output stable across property insertion order", () => {
    const trace = buildCompleteTrace();
    const reordered = {
      replayStateDigest: trace.replayStateDigest,
      terminalExclusions: trace.terminalExclusions,
      resultOrder: trace.resultOrder,
      events: trace.events,
      candidates: trace.candidates,
      incompleteReasons: trace.incompleteReasons,
      complete: trace.complete,
      requestShape: trace.requestShape,
      algorithmVersion: trace.algorithmVersion,
      schemaVersion: trace.schemaVersion,
    };
    const a = buildRetrievalExplanationViewV1(trace);
    const b = buildRetrievalExplanationViewV1(reordered);
    expect(b).toEqual(a);
    expect(renderRetrievalExplanationTextV1(b)).toBe(
      renderRetrievalExplanationTextV1(a),
    );
  });

  it("statically remains a pure unwired explanation module", () => {
    const source = readFileSync(
      new URL("../retrieval-explanation-view.ts", import.meta.url),
      "utf8",
    );
    expect(source).toMatch(/from ["']\.\/trace\.js["']/);
    expect(source).not.toMatch(/@memberry\//);
    expect(source).not.toMatch(
      /from ['"](?:node:)?(?:fs|http|https|net|tls|async_hooks)/,
    );
    expect(source).not.toMatch(
      /fetch\(|axios|process\.|Date\.|Math\.random|randomUUID/,
    );
    expect(source.match(/\bglobalThis\b/g)).toHaveLength(1);
    expect(source).not.toMatch(
      /\b(?:viewer|wiki|telemetry|database|neo4j|redis|mcp)\b/i,
    );
    expect(source).not.toMatch(/JSON\.|\.toJSON\(|localeCompare|normalize\(/);
  });

  it("detects replay digest tampering even when other trace fields are unchanged", () => {
    const trace = mutableCopy(buildCompleteTrace());
    trace.candidates[0]!.estimatedTokens += 1;
    expect(trace.replayStateDigest).not.toBe(
      computeRetrievalTraceReplayStateDigest(trace),
    );
    expect(() => buildRetrievalExplanationViewV1(trace)).toThrow(
      RetrievalExplanationViewContractError,
    );
  });
});
