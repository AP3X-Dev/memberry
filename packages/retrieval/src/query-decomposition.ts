import { isProxy } from 'node:util/types';

/**
 * RET-007 bounded, in-process query decomposition.
 *
 * This module deliberately accepts only query text plus candidate content and
 * ordinal position. Retrieval identity, metadata, scope, provenance, and
 * adapter state are not part of the contract and therefore cannot influence a
 * multiplier.
 */

export const QUERY_DECOMPOSITION_MAX_CANDIDATES = 100;
export const QUERY_DECOMPOSITION_MAX_MULTIPLIER = 1.25;

const MAX_QUERY_CODE_UNITS = 4_096;
const MAX_CONTENT_CODE_UNITS = 16_384;
const MAX_TOKENS_PER_TEXT = 256;
const MIN_BRIDGE_TOKEN_LENGTH = 4;

const STOPWORDS = new Set([
  'a', 'an', 'and', 'are', 'at', 'be', 'before', 'by', 'does', 'for', 'from', 'has',
  'in', 'is', 'it', 'its', 'of', 'on', 'or', 'that', 'the', 'then', 'this', 'to',
  'what', 'when', 'where', 'which', 'while', 'who', 'whose', 'with',
]);

// Closed, domain-neutral two-clause grammar. Ordering is part of the v1 tie-break.
const CLAUSE_BOUNDARIES = Object.freeze([
  /(?:,\s*(?:and|then)\s+|\s+(?:and\s+then|and|then)\s+)/giu,
  /\s*;\s*/gu,
  /\s*:\s*/gu,
  /[.!?]\s+/gu,
  /\s+(?:where|which|who|whose|while|after\s+that|before\s+that)\s+/giu,
]);
const TOKEN = /[\p{L}\p{N}][\p{L}\p{N}'’\-]*/gu;

export interface QueryDecompositionCandidateV1 {
  readonly content: string;
  readonly ordinal: number;
}

interface TokenizedCandidate {
  readonly ordinal: number;
  readonly tokens: ReadonlySet<string>;
}

interface Pair {
  readonly left: number;
  readonly right: number;
  readonly complement: number;
  readonly bridges: number;
  readonly splitOrdinal: number;
  readonly firstOrdinal: number;
  readonly secondOrdinal: number;
}

interface Clauses {
  readonly left: ReadonlySet<string>;
  readonly right: ReadonlySet<string>;
}

function boundedArrayLength(value: unknown): number | undefined {
  try {
    if (isProxy(value)) return undefined;
    if (!Array.isArray(value)) return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(value, 'length');
    const length = descriptor && 'value' in descriptor ? descriptor.value : undefined;
    return typeof length === 'number' && Number.isSafeInteger(length)
      && length >= 0 && length <= QUERY_DECOMPOSITION_MAX_CANDIDATES
      ? length : undefined;
  } catch {
    return undefined;
  }
}

function ownNumberVector(length: number, value: number): number[] {
  const result = new Array<number>(length);
  for (let index = 0; index < length; index += 1) {
    Object.defineProperty(result, index, {
      value, enumerable: true, writable: true, configurable: true,
    });
  }
  return result;
}

function ownDataValue(value: unknown, key: PropertyKey): unknown {
  if ((typeof value !== 'object' || value === null) && typeof value !== 'function') return undefined;
  if (isProxy(value)) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && 'value' in descriptor ? descriptor.value : undefined;
}

function tokenize(value: string): ReadonlySet<string> {
  const tokens = new Set<string>();
  if (value.length > MAX_CONTENT_CODE_UNITS) return tokens;
  const normalized = value.normalize('NFKC').toLocaleLowerCase('en-US');
  for (const match of normalized.matchAll(TOKEN)) {
    let token = match[0]!.replace(/[’']s$/u, '');
    token = token.replace(/^[’']+|[’']+$/gu, '');
    if (!token || STOPWORDS.has(token)) continue;
    tokens.add(token);
    if (tokens.size >= MAX_TOKENS_PER_TEXT) break;
  }
  return tokens;
}

function splitClauses(query: string): ReadonlyMap<number, Clauses> | undefined {
  if (!query || query.length > MAX_QUERY_CODE_UNITS) return undefined;
  const proposals = new Map<string, { readonly start: number; readonly end: number }>();
  let clusterStart: number | undefined;
  let clusterEnd: number | undefined;
  for (const pattern of CLAUSE_BOUNDARIES) {
    for (const match of query.matchAll(pattern)) {
      const start = match.index!;
      const end = start + match[0]!.length;
      if (clusterStart === undefined) {
        clusterStart = start;
        clusterEnd = end;
      } else if (start <= clusterEnd! + 2 && end >= clusterStart - 2) {
        clusterStart = Math.min(clusterStart, start);
        clusterEnd = Math.max(clusterEnd!, end);
      } else {
        // Two disjoint clause boundaries describe more than two hops.
        return undefined;
      }
      proposals.set(`${start}:${end}`, { start, end });
    }
  }
  if (proposals.size === 0) return undefined;
  const clauses = new Map<number, Clauses>();
  let ordinal = 0;
  for (const proposal of proposals.values()) {
    const left = tokenize(query.slice(0, proposal.start));
    const right = tokenize(query.slice(proposal.end));
    if (left.size >= 2 && right.size >= 2) clauses.set(ordinal, Object.freeze({ left, right }));
    ordinal += 1;
  }
  return clauses.size > 0 ? clauses : undefined;
}

function overlap(tokens: ReadonlySet<string>, clause: ReadonlySet<string>): number {
  let count = 0;
  for (const token of clause) if (tokens.has(token)) count += 1;
  return count;
}

function comparePair(left: Pair, right: Pair): number {
  return right.complement - left.complement
    || right.bridges - left.bridges
    || left.splitOrdinal - right.splitOrdinal
    || left.firstOrdinal - right.firstOrdinal
    || left.secondOrdinal - right.secondOrdinal;
}

/**
 * Return one multiplier for every safely bounded input candidate. Invalid or
 * non-decomposable bounded inputs fail to exact identity; hostile/unknown or
 * over-limit lengths return the bounded empty fallback without allocation.
 */
export function queryDecompositionMultipliersV1(
  query: string,
  candidates: readonly QueryDecompositionCandidateV1[],
): readonly number[] {
  const length = boundedArrayLength(candidates);
  if (length === undefined) return Object.freeze(ownNumberVector(0, 1));
  const identity = Object.freeze(ownNumberVector(length, 1));
  if (length < 2 || typeof query !== 'string') return identity;
  try {
    const tokenized = new Map<number, TokenizedCandidate>();
    for (let index = 0; index < length; index += 1) {
      const candidate = ownDataValue(candidates, index);
      const ordinal = ownDataValue(candidate, 'ordinal');
      const content = ownDataValue(candidate, 'content');
      if (ordinal !== index || typeof content !== 'string' || content.length > MAX_CONTENT_CODE_UNITS) {
        return identity;
      }
      tokenized.set(index, { ordinal, tokens: tokenize(content) });
    }

    const clauses = splitClauses(query);
    if (!clauses) return identity;
    let selected: Pair | undefined;
    for (const [splitOrdinal, clause] of clauses) {
      const queryTokens = new Set<string>();
      for (const token of clause.left) queryTokens.add(token);
      for (const token of clause.right) queryTokens.add(token);
      const leftExclusive = new Set<string>();
      const rightExclusive = new Set<string>();
      for (const token of clause.left) if (!clause.right.has(token)) leftExclusive.add(token);
      for (const token of clause.right) if (!clause.left.has(token)) rightExclusive.add(token);
      if (leftExclusive.size === 0 || rightExclusive.size === 0) continue;
      const documentFrequency = new Map<string, number>();
      for (const candidate of tokenized.values()) {
        for (const token of candidate.tokens) {
          if (token.length < MIN_BRIDGE_TOKEN_LENGTH || queryTokens.has(token)) continue;
          documentFrequency.set(token, (documentFrequency.get(token) ?? 0) + 1);
        }
      }
      for (let left = 0; left < length; left += 1) {
        const leftCandidate = tokenized.get(left)!;
        const leftFirst = overlap(leftCandidate.tokens, leftExclusive);
        const leftSecond = overlap(leftCandidate.tokens, rightExclusive);
        for (let right = left + 1; right < length; right += 1) {
          const rightCandidate = tokenized.get(right)!;
          const rightFirst = overlap(rightCandidate.tokens, leftExclusive);
          const rightSecond = overlap(rightCandidate.tokens, rightExclusive);
          const forward = leftFirst > 0 && leftSecond === 0 && rightSecond > 0 && rightFirst === 0
            ? leftFirst + rightSecond : 0;
          const reverse = rightFirst > 0 && rightSecond === 0 && leftSecond > 0 && leftFirst === 0
            ? rightFirst + leftSecond : 0;
          const complement = Math.max(forward, reverse);
          if (complement <= 0) continue;
          let bridges = 0;
          for (const token of leftCandidate.tokens) {
            if (token.length >= MIN_BRIDGE_TOKEN_LENGTH && !queryTokens.has(token)
              && documentFrequency.get(token) === 2 && rightCandidate.tokens.has(token)) bridges += 1;
          }
          if (bridges === 0) continue;
          const pair: Pair = {
            left,
            right,
            complement,
            bridges,
            splitOrdinal,
            firstOrdinal: Math.min(leftCandidate.ordinal, rightCandidate.ordinal),
            secondOrdinal: Math.max(leftCandidate.ordinal, rightCandidate.ordinal),
          };
          if (!selected || comparePair(pair, selected) < 0) selected = pair;
        }
      }
    }
    if (!selected) return identity;
    const result = ownNumberVector(length, 1);
    Object.defineProperty(result, selected.left, {
      value: QUERY_DECOMPOSITION_MAX_MULTIPLIER,
      enumerable: true,
      writable: false,
      configurable: false,
    });
    Object.defineProperty(result, selected.right, {
      value: QUERY_DECOMPOSITION_MAX_MULTIPLIER,
      enumerable: true,
      writable: false,
      configurable: false,
    });
    return Object.freeze(result);
  } catch {
    return identity;
  }
}
