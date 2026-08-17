import { request as httpsRequest } from 'node:https';
import { TextDecoder, types as nodeUtilTypes } from 'node:util';

import {
  RERANKER_MAX_RESPONSE_BYTES,
  createRerankerProviderV1,
  parseSerializedRerankerProviderRequestV1,
  serializeRerankerProviderResponseV1,
  type RerankerCancellationV1,
  type RerankerProviderCandidateV1,
  type RerankerProviderIdentityV1,
  type RerankerProviderRunV1,
  type RerankerProviderV1,
  type SerializedRerankerProviderRequestV1,
} from './reranker.js';

const OBJECT_CREATE = Object.create;
const OBJECT_DEFINE_PROPERTY = Object.defineProperty;
const OBJECT_FREEZE = Object.freeze;
const OBJECT_GET_OWN_PROPERTY_DESCRIPTOR = Object.getOwnPropertyDescriptor;
const OBJECT_GET_PROTOTYPE_OF = Object.getPrototypeOf;
const OBJECT_HAS_OWN = Object.hasOwn;
const OBJECT_PROTOTYPE = Object.prototype;
const ARRAY_IS_ARRAY = Array.isArray;
const ARRAY_BUFFER_IS_VIEW = ArrayBuffer.isView;
const ARRAY_INCLUDES = Function.prototype.call.bind(Array.prototype.includes) as (
  input: readonly unknown[], value: unknown,
) => boolean;
const REFLECT_OWN_KEYS = Reflect.ownKeys;
const NODE_IS_PROXY = nodeUtilTypes.isProxy;
const NODE_IS_PROMISE = nodeUtilTypes.isPromise;
const BUFFER_BYTE_LENGTH = Buffer.byteLength;
const BUFFER_CONCAT = Buffer.concat;
const BUFFER_FROM = Buffer.from;
const BUFFER_IS_BUFFER = Buffer.isBuffer;
const NUMBER_IS_FINITE = Number.isFinite;
const NUMBER_IS_SAFE_INTEGER = Number.isSafeInteger;
const OBJECT_IS = Object.is;
const PROMISE = Promise;
const PROMISE_PROTOTYPE = Promise.prototype;
const SYMBOL_SPECIES = Symbol.species;
const PROMISE_CONSTRUCTOR_DESCRIPTOR = OBJECT_FREEZE({
  ...OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(Promise.prototype, 'constructor')!,
});
const PROMISE_SPECIES_DESCRIPTOR = OBJECT_FREEZE({
  ...OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(Promise, SYMBOL_SPECIES)!,
});
const PROMISE_RESOLVE = Function.prototype.call.bind(Promise.resolve) as <T>(
  constructor: PromiseConstructor, value: T | PromiseLike<T>,
) => Promise<Awaited<T>>;
const PROMISE_REJECT = Function.prototype.call.bind(Promise.reject) as <T = never>(
  constructor: PromiseConstructor, reason?: unknown,
) => Promise<T>;
const PROMISE_THEN = Function.prototype.call.bind(Promise.prototype.then) as (
  promise: Promise<unknown>,
  fulfilled: (value: unknown) => unknown,
  rejected: () => unknown,
) => Promise<unknown>;
const URL_CONSTRUCTOR = URL;
const URL_PROTOTYPE = URL.prototype;
const URL_PROTOCOL_DESCRIPTOR = OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(URL_PROTOTYPE, 'protocol');
const URL_USERNAME_DESCRIPTOR = OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(URL_PROTOTYPE, 'username');
const URL_PASSWORD_DESCRIPTOR = OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(URL_PROTOTYPE, 'password');
const URL_HASH_DESCRIPTOR = OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(URL_PROTOTYPE, 'hash');
const URL_HREF_DESCRIPTOR = OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(URL_PROTOTYPE, 'href');
if (typeof URL_PROTOCOL_DESCRIPTOR?.get !== 'function'
  || typeof URL_USERNAME_DESCRIPTOR?.get !== 'function'
  || typeof URL_PASSWORD_DESCRIPTOR?.get !== 'function'
  || typeof URL_HASH_DESCRIPTOR?.get !== 'function'
  || typeof URL_HREF_DESCRIPTOR?.get !== 'function') {
  throw new Error('unavailable-url-intrinsics');
}
const URL_PROTOCOL = Function.prototype.call.bind(URL_PROTOCOL_DESCRIPTOR.get) as (url: URL) => string;
const URL_USERNAME = Function.prototype.call.bind(URL_USERNAME_DESCRIPTOR.get) as (url: URL) => string;
const URL_PASSWORD = Function.prototype.call.bind(URL_PASSWORD_DESCRIPTOR.get) as (url: URL) => string;
const URL_HASH = Function.prototype.call.bind(URL_HASH_DESCRIPTOR.get) as (url: URL) => string;
const URL_HREF = Function.prototype.call.bind(URL_HREF_DESCRIPTOR.get) as (url: URL) => string;
const ABORT_CONTROLLER = AbortController;
const ABORT_CONTROLLER_PROTOTYPE = AbortController.prototype;
const ABORT_SIGNAL_DESCRIPTOR = OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(
  ABORT_CONTROLLER_PROTOTYPE, 'signal',
);
const ABORT_DESCRIPTOR = OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(ABORT_CONTROLLER_PROTOTYPE, 'abort');
if (typeof ABORT_SIGNAL_DESCRIPTOR?.get !== 'function'
  || typeof ABORT_DESCRIPTOR?.value !== 'function') {
  throw new Error('unavailable-abort-intrinsics');
}
const ABORT_SIGNAL = Function.prototype.call.bind(ABORT_SIGNAL_DESCRIPTOR.get) as (
  controller: AbortController,
) => AbortSignal;
const ABORT = Function.prototype.call.bind(ABORT_DESCRIPTOR.value) as (
  controller: AbortController,
) => void;
const SET_INTERVAL = setInterval;
const CLEAR_INTERVAL = clearInterval;
const STRING_INCLUDES = Function.prototype.call.bind(String.prototype.includes) as (
  input: string, search: string,
) => boolean;
const REGEXP_TEST = Function.prototype.call.bind(RegExp.prototype.test) as (
  pattern: RegExp, input: string,
) => boolean;

type NullRecord = Record<string, unknown>;

function nullRecord<T extends object>(fields: T): Readonly<T> {
  const result = OBJECT_CREATE(null) as T;
  const keys = REFLECT_OWN_KEYS(fields);
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index]!;
    OBJECT_DEFINE_PROPERTY(result, key, OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(fields, key)!);
  }
  return OBJECT_FREEZE(result);
}

function exactOptionalRecord(input: unknown, allowed: readonly string[]): NullRecord {
  try {
    if (typeof input !== 'object' || input === null || NODE_IS_PROXY(input)
      || ARRAY_IS_ARRAY(input) || ARRAY_BUFFER_IS_VIEW(input)) throw new Error();
    const prototype = OBJECT_GET_PROTOTYPE_OF(input);
    if (prototype !== null && prototype !== OBJECT_PROTOTYPE) throw new Error();
    const keys = REFLECT_OWN_KEYS(input);
    const result = OBJECT_CREATE(null) as NullRecord;
    for (let index = 0; index < keys.length; index += 1) {
      const key = keys[index]!;
      if (typeof key !== 'string' || !ARRAY_INCLUDES(allowed, key)) throw new Error();
      const descriptor = OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(input, key);
      if (descriptor === undefined || !OBJECT_HAS_OWN(descriptor, 'value')
        || descriptor.enumerable !== true) throw new Error();
      result[key] = descriptor.value;
    }
    return result;
  } catch {
    throw new Error('invalid-reranker-provider-config');
  }
}

function isExactNativePromise(input: unknown): input is Promise<unknown> {
  try {
    if (typeof input !== 'object' || input === null || NODE_IS_PROXY(input)
      || !NODE_IS_PROMISE(input) || OBJECT_GET_PROTOTYPE_OF(input) !== PROMISE_PROTOTYPE
      || REFLECT_OWN_KEYS(input).length !== 0) return false;
    const constructorDescriptor = OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(PROMISE_PROTOTYPE, 'constructor');
    if (constructorDescriptor === undefined || !OBJECT_HAS_OWN(constructorDescriptor, 'value')
      || constructorDescriptor.value !== PROMISE
      || constructorDescriptor.writable !== PROMISE_CONSTRUCTOR_DESCRIPTOR.writable
      || constructorDescriptor.enumerable !== PROMISE_CONSTRUCTOR_DESCRIPTOR.enumerable
      || constructorDescriptor.configurable !== PROMISE_CONSTRUCTOR_DESCRIPTOR.configurable) return false;
    const speciesDescriptor = OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(PROMISE, SYMBOL_SPECIES);
    return speciesDescriptor !== undefined && OBJECT_HAS_OWN(speciesDescriptor, 'get')
      && speciesDescriptor.get === PROMISE_SPECIES_DESCRIPTOR.get
      && speciesDescriptor.set === PROMISE_SPECIES_DESCRIPTOR.set
      && speciesDescriptor.enumerable === PROMISE_SPECIES_DESCRIPTOR.enumerable
      && speciesDescriptor.configurable === PROMISE_SPECIES_DESCRIPTOR.configurable;
  } catch {
    return false;
  }
}

export type LocalRerankerScorerV1 = (
  query: string,
  candidate: RerankerProviderCandidateV1,
) => number;

export function baselineIdentityRerankerScoreV1(
  _query: string,
  candidate: RerankerProviderCandidateV1,
): number {
  return candidate.baselineScore;
}

export function createLocalRerankerProviderV1(
  identityInput: RerankerProviderIdentityV1 | unknown,
  scorer: LocalRerankerScorerV1,
): RerankerProviderV1 {
  if (typeof scorer !== 'function' || NODE_IS_PROXY(scorer)) {
    throw new Error('invalid-local-reranker-scorer');
  }
  let identity: RerankerProviderIdentityV1;
  const run: RerankerProviderRunV1 = (serialized, cancellation) => {
    try {
      if (cancellation.isCancelled()) throw new Error();
      const request = parseSerializedRerankerProviderRequestV1(serialized);
      const scores: number[] = [];
      for (let index = 0; index < request.candidates.length; index += 1) {
        if (cancellation.isCancelled()) throw new Error();
        const candidate = request.candidates[index]!;
        const score = scorer(request.query, candidate);
        if (typeof score !== 'number' || !NUMBER_IS_FINITE(score) || OBJECT_IS(score, -0)
          || score < 0 || score > 1) throw new Error();
        scores[index] = score;
      }
      if (cancellation.isCancelled()) throw new Error();
      const response = serializeRerankerProviderResponseV1(request, identity, OBJECT_FREEZE(scores));
      return PROMISE_RESOLVE(PROMISE, response);
    } catch {
      return PROMISE_REJECT(PROMISE, new Error('local-reranker-failed'));
    }
  };
  const provider = createRerankerProviderV1(identityInput, run);
  if (provider.identity.locality !== 'local') throw new Error('invalid-local-reranker-identity');
  identity = provider.identity;
  return provider;
}

export interface RerankerHttpsTransportRequestV1 {
  readonly url: string;
  readonly method: 'POST';
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
  readonly maxResponseBytes: typeof RERANKER_MAX_RESPONSE_BYTES;
}

export interface RerankerHttpsTransportResponseV1 {
  readonly statusCode: number;
  readonly body: string;
}

export type RerankerHttpsTransportV1 = (
  request: RerankerHttpsTransportRequestV1,
  cancellation: RerankerCancellationV1,
) => Promise<RerankerHttpsTransportResponseV1>;

export interface HttpsRerankerProviderConfigV1 {
  readonly identity: RerankerProviderIdentityV1;
  readonly endpoint: string;
  readonly authorizationHeader?: string;
  readonly transport?: RerankerHttpsTransportV1;
}

const defaultHttpsTransport: RerankerHttpsTransportV1 = (input, cancellation) => new PROMISE((resolve, reject) => {
  let settled = false;
  let poll: ReturnType<typeof setInterval> | undefined;
  let nativeRequest: ReturnType<typeof httpsRequest> | undefined;
  const controller = new ABORT_CONTROLLER();
  const signal = ABORT_SIGNAL(controller);
  const clearPoll = (): void => {
    if (poll !== undefined) {
      CLEAR_INTERVAL(poll);
      poll = undefined;
    }
  };
  const fail = (cancelNative = false): void => {
    if (settled) return;
    settled = true;
    clearPoll();
    if (cancelNative) {
      try {
        ABORT(controller);
      } catch {
        // The private request is also destroyed below.
      }
      try {
        nativeRequest?.destroy();
      } catch {
        // Failure is already contained by this transport promise.
      }
    }
    reject(new Error('https-reranker-transport-failed'));
  };
  try {
    if (cancellation.isCancelled()) {
      fail(true);
      return;
    }
    nativeRequest = httpsRequest(input.url, {
      method: 'POST',
      headers: input.headers,
      signal,
      agent: false,
    }, (response) => {
      const chunks: Buffer[] = [];
      let size = 0;
      response.on('data', (chunk: unknown) => {
        if (settled) return;
        if (!(typeof chunk === 'string' || BUFFER_IS_BUFFER(chunk))) {
          response.destroy();
          fail();
          return;
        }
        const bytes = BUFFER_FROM(chunk);
        size += bytes.byteLength;
        if (size > input.maxResponseBytes) {
          response.destroy();
          fail();
          return;
        }
        chunks[chunks.length] = bytes;
      });
      response.on('aborted', fail);
      response.on('error', fail);
      response.on('end', () => {
        if (settled) return;
        try {
          const body = new TextDecoder('utf-8', { fatal: true }).decode(BUFFER_CONCAT(chunks, size));
          settled = true;
          clearPoll();
          resolve(nullRecord({ statusCode: response.statusCode ?? 0, body }));
        } catch {
          fail();
        }
      });
    });
    nativeRequest.on('error', fail);
    poll = SET_INTERVAL(() => {
      try {
        if (cancellation.isCancelled()) fail(true);
      } catch {
        fail(true);
      }
    }, 1);
    nativeRequest.end(input.body);
  } catch {
    fail(true);
  }
});

function parseTransportResponse(input: unknown): RerankerHttpsTransportResponseV1 {
  const record = exactOptionalRecord(input, ['statusCode', 'body']);
  if (REFLECT_OWN_KEYS(record).length !== 2
    || typeof record.statusCode !== 'number' || !NUMBER_IS_SAFE_INTEGER(record.statusCode)
    || record.statusCode < 100 || record.statusCode > 599
    || typeof record.body !== 'string'
    || BUFFER_BYTE_LENGTH(record.body, 'utf8') > RERANKER_MAX_RESPONSE_BYTES) {
    throw new Error('invalid-reranker-transport-response');
  }
  return nullRecord({ statusCode: record.statusCode, body: record.body });
}

export function createHttpsRerankerProviderV1(
  configInput: HttpsRerankerProviderConfigV1 | unknown,
): RerankerProviderV1 {
  const config = exactOptionalRecord(configInput, [
    'identity', 'endpoint', 'authorizationHeader', 'transport',
  ]);
  if (!OBJECT_HAS_OWN(config, 'identity') || !OBJECT_HAS_OWN(config, 'endpoint')) {
    throw new Error('invalid-reranker-provider-config');
  }
  if (typeof config.endpoint !== 'string'
    || BUFFER_BYTE_LENGTH(config.endpoint, 'utf8') > 65_536) {
    throw new Error('invalid-reranker-endpoint');
  }
  let endpoint: URL;
  try {
    endpoint = new URL_CONSTRUCTOR(config.endpoint);
  } catch {
    throw new Error('invalid-reranker-endpoint');
  }
  let endpointHref: string;
  try {
    if (URL_PROTOCOL(endpoint) !== 'https:' || URL_USERNAME(endpoint) !== ''
      || URL_PASSWORD(endpoint) !== '' || URL_HASH(endpoint) !== '') {
      throw new Error();
    }
    endpointHref = URL_HREF(endpoint);
    if (STRING_INCLUDES(endpointHref, '#')) throw new Error();
  } catch {
    throw new Error('invalid-reranker-endpoint');
  }
  let authorizationHeader: string | undefined;
  if (OBJECT_HAS_OWN(config, 'authorizationHeader')) {
    if (typeof config.authorizationHeader !== 'string' || config.authorizationHeader.length === 0
      || BUFFER_BYTE_LENGTH(config.authorizationHeader, 'utf8') > 8_192
      || !REGEXP_TEST(/^[\x20-\x7e]+$/, config.authorizationHeader)
      || STRING_INCLUDES(config.authorizationHeader, '\r')
      || STRING_INCLUDES(config.authorizationHeader, '\n')) {
      throw new Error('invalid-reranker-authorization');
    }
    authorizationHeader = config.authorizationHeader;
  }
  let transport = defaultHttpsTransport;
  if (OBJECT_HAS_OWN(config, 'transport')) {
    if (typeof config.transport !== 'function' || NODE_IS_PROXY(config.transport)) {
      throw new Error('invalid-reranker-transport');
    }
    transport = config.transport as RerankerHttpsTransportV1;
  }
  const run: RerankerProviderRunV1 = (body, cancellation) => new PROMISE((resolve, reject) => {
    const headers = OBJECT_CREATE(null) as Record<string, string>;
    headers.accept = 'application/json';
    headers['content-type'] = 'application/json';
    headers['content-length'] = `${BUFFER_BYTE_LENGTH(body, 'utf8')}`;
    if (authorizationHeader !== undefined) headers.authorization = authorizationHeader;
    const transportRequest = nullRecord({
      url: endpointHref,
      method: 'POST' as const,
      headers: OBJECT_FREEZE(headers),
      body,
      maxResponseBytes: RERANKER_MAX_RESPONSE_BYTES,
    });
    let pending: unknown;
    try {
      if (cancellation.isCancelled()) throw new Error();
      pending = transport(transportRequest, cancellation);
    } catch {
      reject(new Error('https-reranker-failed'));
      return;
    }
    if (!isExactNativePromise(pending)) {
      reject(new Error('https-reranker-failed'));
      return;
    }
    try {
      PROMISE_THEN(
        pending,
        (raw) => {
          try {
            if (cancellation.isCancelled()) throw new Error();
            const response = parseTransportResponse(raw);
            if (response.statusCode !== 200) throw new Error();
            resolve(response.body);
          } catch {
            reject(new Error('https-reranker-failed'));
          }
          return undefined;
        },
        () => {
          reject(new Error('https-reranker-failed'));
          return undefined;
        },
      );
    } catch {
      reject(new Error('https-reranker-failed'));
    }
  });
  const provider = createRerankerProviderV1(config.identity, run);
  if (provider.identity.locality !== 'remote') throw new Error('invalid-remote-reranker-identity');
  return provider;
}
