import { types as nodeUtilTypes } from 'node:util';

import { readRuntimeQueryPlannerAuthorityV1, type RuntimeQueryPlannerResolvedReceiptV1 } from './runtime-query-planner.js';
import {
  RERANKER_DEFAULT_TIMEOUT_MS,
  executeCalibratedRerankV1,
  type RerankCandidateInputV1,
  type RerankerProviderIdentityV1,
  type RerankerProviderV1,
} from './reranker.js';
import type { CandidateChannelExecutionResultV1 } from './candidate-channel.js';
import type { RetrievalResult } from './types.js';

const SET_IMMEDIATE = setImmediate;
const CLEAR_IMMEDIATE = clearImmediate;
const SET_TIMEOUT = setTimeout;
const CLEAR_TIMEOUT = clearTimeout;
const IS_PROXY = nodeUtilTypes.isProxy;

export const RERANKER_SHADOW_MAX_ACTIVE = 32 as const;
export const RERANKER_SHADOW_SHUTDOWN_DRAIN_MS = 1_000 as const;
export const RERANKER_SHADOW_PROVIDER_IDENTITY = Object.freeze(Object.assign(Object.create(null), {
  providerId: 'memberry.local.reference', modelId: 'baseline-identity-v1',
  calibrationId: 'none-v1', locality: 'local',
})) as RerankerProviderIdentityV1;

export type RerankerShadowModeV1 = 'disabled' | 'shadow';
export function resolveRerankerShadowModeV1(value: string | undefined): RerankerShadowModeV1 {
  if (value === undefined || value === '') return 'disabled';
  if (value === 'shadow') return 'shadow';
  throw new Error('reranker_shadow:invalid_mode');
}

export interface RerankerShadowWorkV1 {
  readonly receipt: RuntimeQueryPlannerResolvedReceiptV1;
  readonly execution: CandidateChannelExecutionResultV1;
  readonly query: string;
  readonly candidates: readonly Pick<RetrievalResult, 'id' | 'source_type' | 'title' | 'content' | 'score'>[];
}

export interface RerankerShadowObservationV1 {
  readonly contractId: 'memberry.reranker-shadow-observation';
  readonly contractVersion: '1.0.0';
  readonly authorityBinding: 'matched';
  readonly provider: RerankerProviderIdentityV1;
  readonly candidateCount: number;
  readonly outcome: 'reranked' | 'fallback';
  readonly orderChanged: boolean;
  readonly movedCandidateCount: number;
}

export interface RerankerShadowSnapshotV1 {
  readonly accepted: number;
  readonly completed: number;
  readonly reranked: number;
  readonly fallback: number;
  readonly orderChanged: number;
  readonly capacitySkipped: number;
  readonly invalidSkipped: number;
  readonly shutdownSkipped: number;
  readonly inFlight: number;
}

export interface RerankerShadowCoordinatorPortV1 {
  trySchedule(thunk: () => RerankerShadowWorkV1): boolean;
  snapshot(): RerankerShadowSnapshotV1;
  shutdown(): Promise<void>;
}

interface Slot { handle?: ReturnType<typeof setImmediate>; released: boolean; done: Promise<void>; finish(): void }

function nullFrozen<T extends object>(fields: T): Readonly<T> {
  return Object.freeze(Object.assign(Object.create(null), fields)) as Readonly<T>;
}

function sameProvider(provider: RerankerProviderV1): boolean {
  try {
    return provider.identity.providerId === RERANKER_SHADOW_PROVIDER_IDENTITY.providerId
      && provider.identity.modelId === RERANKER_SHADOW_PROVIDER_IDENTITY.modelId
      && provider.identity.calibrationId === RERANKER_SHADOW_PROVIDER_IDENTITY.calibrationId
      && provider.identity.locality === 'local';
  } catch { return false; }
}

function authenticated(work: RerankerShadowWorkV1): boolean {
  try {
    const authority = readRuntimeQueryPlannerAuthorityV1(work.receipt);
    const execution = work.execution;
    const request = execution.request;
    if (execution.contractId !== 'memberry.candidate-channel' || execution.contractVersion !== '1.0.0'
      || request.contractId !== execution.contractId || request.contractVersion !== execution.contractVersion
      || request.tenantId !== authority.tenantId || request.projectScope !== authority.projectScope
      || !Array.isArray(request.resolvedEntityIds) || IS_PROXY(request.resolvedEntityIds)
      || request.resolvedEntityIds.length !== 1 || request.resolvedEntityIds[0] !== authority.resolvedEntityId) return false;
    const frame = request.temporalFrame;
    return frame.mode === authority.temporalFrame.mode
      && (frame.mode === 'current'
        || (authority.temporalFrame.mode === 'as-of' && frame.asOf === authority.temporalFrame.asOf));
  } catch { return false; }
}

function ownedInput(work: RerankerShadowWorkV1): { query: string; candidates: readonly RerankCandidateInputV1<string>[] } | undefined {
  try {
    if (typeof work.query !== 'string' || !Array.isArray(work.candidates) || IS_PROXY(work.candidates)
      || work.candidates.length > 50) return undefined;
    const candidates: RerankCandidateInputV1<string>[] = [];
    for (let index = 0; index < work.candidates.length; index += 1) {
      const source = work.candidates[index]!;
      if (typeof source !== 'object' || source === null || IS_PROXY(source)
        || typeof source.id !== 'string' || typeof source.source_type !== 'string'
        || typeof source.title !== 'string' || typeof source.content !== 'string'
        || typeof source.score !== 'number' || !Number.isFinite(source.score)) return undefined;
      candidates.push(nullFrozen({
        value: source.id, sourceType: source.source_type, title: source.title,
        content: source.content, baselineScore: source.score,
      }) as RerankCandidateInputV1<string>);
    }
    return nullFrozen({ query: work.query, candidates: Object.freeze(candidates) });
  } catch { return undefined; }
}

export class RerankerShadowCoordinatorV1 implements RerankerShadowCoordinatorPortV1 {
  private readonly slots = new Set<Slot>();
  private stopping = false;
  private shutdownPromise?: Promise<void>;
  private accepted = 0; private completed = 0; private reranked = 0; private fallback = 0;
  private changed = 0; private capacity = 0; private invalid = 0; private stopped = 0;

  constructor(
    private readonly provider: RerankerProviderV1,
    private readonly sink: (observation: RerankerShadowObservationV1) => void | Promise<void>,
  ) {
    if (!sameProvider(provider) || typeof sink !== 'function' || IS_PROXY(sink)) {
      throw new Error('reranker_shadow:invalid_configuration');
    }
  }

  trySchedule(thunk: () => RerankerShadowWorkV1): boolean {
    if (this.stopping) { this.stopped += 1; return false; }
    if (this.slots.size >= RERANKER_SHADOW_MAX_ACTIVE) { this.capacity += 1; return false; }
    let resolveDone!: () => void;
    const slot: Slot = {
      released: false,
      done: new Promise<void>((resolve) => { resolveDone = resolve; }),
      finish: () => {
        if (slot.released) return;
        slot.released = true; this.slots.delete(slot); resolveDone();
      },
    };
    this.slots.add(slot); this.accepted += 1;
    try {
      slot.handle = SET_IMMEDIATE(() => { void this.run(slot, thunk); });
      return true;
    } catch {
      slot.finish(); this.invalid += 1; return false;
    }
  }

  private async run(slot: Slot, thunk: () => RerankerShadowWorkV1): Promise<void> {
    slot.handle = undefined;
    if (this.stopping) { slot.finish(); return; }
    try {
      const work = thunk();
      if (!authenticated(work)) { this.invalid += 1; return; }
      const input = ownedInput(work);
      if (!input) { this.invalid += 1; return; }
      const result = await executeCalibratedRerankV1(input, this.provider, { timeoutMs: RERANKER_DEFAULT_TIMEOUT_MS });
      let moved = 0;
      if (result.outcome === 'reranked') {
        for (let index = 0; index < result.candidates.length; index += 1) {
          if (result.candidates[index]!.value !== input.candidates[index]!.value) moved += 1;
        }
      }
      const observation = nullFrozen({
        contractId: 'memberry.reranker-shadow-observation' as const,
        contractVersion: '1.0.0' as const,
        authorityBinding: 'matched' as const,
        provider: RERANKER_SHADOW_PROVIDER_IDENTITY,
        candidateCount: input.candidates.length,
        outcome: result.outcome === 'reranked' ? 'reranked' as const : 'fallback' as const,
        orderChanged: moved > 0,
        movedCandidateCount: moved,
      });
      try { await this.sink(observation); } catch { /* contained */ }
      // A sink that settles after the bounded shutdown drain cannot mutate the
      // aggregate proof after its reservation has been forcibly released.
      if (slot.released) return;
      this.completed += 1;
      if (observation.outcome === 'reranked') this.reranked += 1; else this.fallback += 1;
      if (observation.orderChanged) this.changed += 1;
    } catch {
      this.invalid += 1;
    } finally {
      slot.finish();
    }
  }

  snapshot(): RerankerShadowSnapshotV1 {
    return nullFrozen({
      accepted: this.accepted, completed: this.completed, reranked: this.reranked,
      fallback: this.fallback, orderChanged: this.changed, capacitySkipped: this.capacity,
      invalidSkipped: this.invalid, shutdownSkipped: this.stopped, inFlight: this.slots.size,
    });
  }

  shutdown(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.stopping = true;
    for (const slot of this.slots) {
      if (slot.handle !== undefined) { CLEAR_IMMEDIATE(slot.handle); slot.handle = undefined; slot.finish(); }
    }
    const pending = [...this.slots];
    this.shutdownPromise = pending.length === 0 ? Promise.resolve() : new Promise<void>((resolve) => {
      let done = false;
      const finish = (): void => {
        if (done) return; done = true; CLEAR_TIMEOUT(timer);
        for (const slot of pending) slot.finish();
        resolve();
      };
      const timer = SET_TIMEOUT(finish, RERANKER_SHADOW_SHUTDOWN_DRAIN_MS);
      void Promise.allSettled(pending.map((slot) => slot.done)).then(finish, finish);
    });
    return this.shutdownPromise;
  }
}
