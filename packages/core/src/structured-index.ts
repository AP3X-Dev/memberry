import { createHash } from 'node:crypto';

export const STRUCTURED_INDEX_SCHEMA_VERSION = 1 as const;
export const STRUCTURED_INDEX_MAX_FACTS = 32;
export const STRUCTURED_INDEX_MAX_ALIASES = 32;
export const STRUCTURED_INDEX_MAX_ALIAS_VALUES = 16;
export const STRUCTURED_INDEX_MAX_VALUE_CODE_UNITS = 500;
export const STRUCTURED_INDEX_MAX_TOTAL_BYTES = 16_384;
export const STRUCTURED_INDEX_MAX_KEYS = 64;
export const STRUCTURED_INDEX_GRAPH_MAX_FACTS = 16;
export const STRUCTURED_INDEX_GRAPH_DERIVATION = 'graph-v1' as const;

const SAFE_PROJECT_SCOPE = /^project:[a-z0-9][a-z0-9._-]*$/;
const SAFE_ENTITY_ID = /^[A-Za-z0-9_-][A-Za-z0-9._:@/+~-]{0,199}$/;
const TEXT_BYTES = new TextEncoder();

export interface EpisodeIndexAliasInputV1 {
  entity_id: string;
  values: string[];
}

export interface EpisodeStructuredIndexInputV1 {
  facts?: string[];
  aliases?: EpisodeIndexAliasInputV1[];
}

export interface ValidatedEpisodeStructuredIndexV1 {
  schema_version: typeof STRUCTURED_INDEX_SCHEMA_VERSION;
  facts: readonly string[];
  aliases: readonly Readonly<{ entity_id: string; values: readonly string[] }>[];
}

export interface EpisodeIndexKeyNodeV1 {
  id: string;
  episode_id: string;
  kind: 'fact' | 'alias';
  value: string;
  entity_id?: string;
  embedding?: number[];
  source_fact_id?: string;
  derivation?: 'model-v1' | typeof STRUCTURED_INDEX_GRAPH_DERIVATION;
  schema_version: typeof STRUCTURED_INDEX_SCHEMA_VERSION;
  source: 'agent' | 'backfill';
  source_hash: string;
  tenant_id: string;
  project_scope: string;
  created_at: string;
}

export interface EpisodeGraphBackfillFactV1 {
  source_fact_id: string;
  entity_id: string;
  subject: string;
  predicate: string;
  object: string;
}

function plainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return Object.getPrototypeOf(value) === Object.prototype;
}

function normalizedValue(value: unknown, field: string): string {
  if (typeof value !== 'string') throw new Error(`structured_index:${field}:invalid_type`);
  if (/\p{Cc}/u.test(value)) throw new Error(`structured_index:${field}:control_character`);
  const normalized = value.normalize('NFKC').trim().replace(/\s+/g, ' ');
  if (normalized.length === 0 || normalized.length > STRUCTURED_INDEX_MAX_VALUE_CODE_UNITS) {
    throw new Error(`structured_index:${field}:invalid_length`);
  }
  return normalized;
}

function denseArray(value: unknown, field: string, max: number): unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > max) {
    throw new Error(`structured_index:${field}:invalid_array`);
  }
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.hasOwn(value, index)) throw new Error(`structured_index:${field}:invalid_array`);
  }
  return value;
}

/**
 * Validate and snapshot advisory write-time structure at the Core trust boundary.
 * MCP validation is intentionally duplicated here because AMPService also has
 * direct callers. Malformed extras reject the whole store before persistence.
 */
export function validateEpisodeStructuredIndexV1(input: {
  facts?: unknown;
  aliases?: unknown;
  entities?: unknown;
  scope?: unknown;
}): ValidatedEpisodeStructuredIndexV1 | undefined {
  if (input.facts === undefined && input.aliases === undefined) return undefined;
  if (typeof input.scope !== 'string' || !SAFE_PROJECT_SCOPE.test(input.scope)) {
    throw new Error('structured_index:canonical_project_scope_required');
  }

  const entities = input.entities === undefined
    ? []
    : denseArray(input.entities, 'entities', 32).map((value) => {
      if (typeof value !== 'string' || !SAFE_ENTITY_ID.test(value)) {
        throw new Error('structured_index:entities:invalid_id');
      }
      return value;
    });
  if (new Set(entities).size !== entities.length) throw new Error('structured_index:entities:duplicate');
  const entitySet = new Set(entities);

  const facts = input.facts === undefined
    ? []
    : denseArray(input.facts, 'facts', STRUCTURED_INDEX_MAX_FACTS)
      .map((value) => normalizedValue(value, 'facts'));
  if (new Set(facts.map((value) => value.toLocaleLowerCase('en-US'))).size !== facts.length) {
    throw new Error('structured_index:facts:duplicate');
  }

  const aliases = input.aliases === undefined
    ? []
    : denseArray(input.aliases, 'aliases', STRUCTURED_INDEX_MAX_ALIASES).map((value) => {
      if (!plainRecord(value) || Reflect.ownKeys(value).length !== 2
        || !Object.hasOwn(value, 'entity_id') || !Object.hasOwn(value, 'values')) {
        throw new Error('structured_index:aliases:invalid_object');
      }
      const entityId = value.entity_id;
      if (typeof entityId !== 'string' || !SAFE_ENTITY_ID.test(entityId) || !entitySet.has(entityId)) {
        throw new Error('structured_index:aliases:unauthorized_entity');
      }
      const values = denseArray(value.values, 'alias_values', STRUCTURED_INDEX_MAX_ALIAS_VALUES)
        .map((item) => normalizedValue(item, 'alias_values'));
      if (values.length === 0
        || new Set(values.map((item) => item.toLocaleLowerCase('en-US'))).size !== values.length) {
        throw new Error('structured_index:alias_values:empty_or_duplicate');
      }
      return Object.freeze({ entity_id: entityId, values: Object.freeze(values) });
    });
  if (new Set(aliases.map(({ entity_id }) => entity_id)).size !== aliases.length) {
    throw new Error('structured_index:aliases:duplicate_entity');
  }

  if (facts.length === 0 && aliases.length === 0) throw new Error('structured_index:empty');
  if (facts.length + aliases.reduce((sum, alias) => sum + alias.values.length, 0) > STRUCTURED_INDEX_MAX_KEYS) {
    throw new Error('structured_index:too_many_keys');
  }
  const totalBytes = [...facts, ...aliases.flatMap(({ values }) => values)]
    .reduce((sum, value) => sum + TEXT_BYTES.encode(value).length, 0);
  if (totalBytes > STRUCTURED_INDEX_MAX_TOTAL_BYTES) throw new Error('structured_index:payload_too_large');

  return Object.freeze({
    schema_version: STRUCTURED_INDEX_SCHEMA_VERSION,
    facts: Object.freeze(facts),
    aliases: Object.freeze(aliases),
  });
}

export function buildEpisodeIndexKeysV1(input: {
  episodeId: string;
  structured: ValidatedEpisodeStructuredIndexV1;
  embeddings: readonly number[][];
  source: 'agent' | 'backfill';
  tenantId: string;
  projectScope: string;
  createdAt: string;
}): EpisodeIndexKeyNodeV1[] {
  const descriptors = [
    ...input.structured.facts.map((value) => ({ kind: 'fact' as const, value })),
    ...input.structured.aliases.flatMap(({ entity_id, values }) =>
      values.map((value) => ({ kind: 'alias' as const, value, entity_id }))),
  ];
  if (descriptors.length !== input.embeddings.length) throw new Error('structured_index:embedding_count_mismatch');
  return descriptors.map((descriptor, index) => {
    const sourceHash = createHash('sha256')
      .update(`${descriptor.kind}\0${'entity_id' in descriptor ? descriptor.entity_id : ''}\0${descriptor.value}`)
      .digest('hex');
    return {
      id: `eik1:${input.episodeId}:${sourceHash}`,
      episode_id: input.episodeId,
      ...descriptor,
      embedding: [...input.embeddings[index]!],
      schema_version: STRUCTURED_INDEX_SCHEMA_VERSION,
      source: input.source,
      source_hash: sourceHash,
      tenant_id: input.tenantId,
      project_scope: input.projectScope,
      created_at: input.createdAt,
    };
  });
}

/**
 * Build model-free historical keys from already-authorized graph facts.
 *
 * The Neo4j store selects at most one current, same-tenant Fact per canonical
 * Entity. This Core boundary repeats the important shape, identity, and cap
 * checks before any derived node can be written. No embedding is invented:
 * graph-derived retrieval follows the exact entity_id instead.
 */
export function buildGraphBackfillIndexKeysV1(input: {
  episodeId: string;
  facts: readonly EpisodeGraphBackfillFactV1[];
  tenantId: string;
  projectScope: string;
  createdAt: string;
}): EpisodeIndexKeyNodeV1[] {
  if (typeof input.episodeId !== 'string' || !SAFE_ENTITY_ID.test(input.episodeId)) {
    throw new Error('structured_index_graph:invalid_episode_id');
  }
  if (typeof input.tenantId !== 'string' || input.tenantId.length === 0
    || typeof input.projectScope !== 'string' || !SAFE_PROJECT_SCOPE.test(input.projectScope)) {
    throw new Error('structured_index_graph:invalid_scope');
  }
  if (!Array.isArray(input.facts) || Object.getPrototypeOf(input.facts) !== Array.prototype
    || input.facts.length > STRUCTURED_INDEX_GRAPH_MAX_FACTS) {
    throw new Error('structured_index_graph:invalid_facts');
  }

  const seenFactIds = new Set<string>();
  const seenEntityIds = new Set<string>();
  let totalBytes = 0;
  return input.facts.map((fact, index) => {
    if (!Object.hasOwn(input.facts, index) || !plainRecord(fact)
      || Reflect.ownKeys(fact).length !== 5) {
      throw new Error('structured_index_graph:invalid_fact');
    }
    const { source_fact_id: sourceFactId, entity_id: entityId } = fact;
    if (typeof sourceFactId !== 'string' || !SAFE_ENTITY_ID.test(sourceFactId)
      || typeof entityId !== 'string' || !SAFE_ENTITY_ID.test(entityId)) {
      throw new Error('structured_index_graph:invalid_fact_identity');
    }
    if (seenFactIds.has(sourceFactId) || seenEntityIds.has(entityId)) {
      throw new Error('structured_index_graph:duplicate_fact_or_entity');
    }
    seenFactIds.add(sourceFactId);
    seenEntityIds.add(entityId);

    if (typeof fact.subject !== 'string' || typeof fact.predicate !== 'string'
      || typeof fact.object !== 'string') {
      throw new Error('structured_index_graph:invalid_fact_text');
    }
    const value = normalizedValue(`${fact.subject} ${fact.predicate} ${fact.object}`, 'graph_fact');
    totalBytes += TEXT_BYTES.encode(value).length;
    if (totalBytes > STRUCTURED_INDEX_MAX_TOTAL_BYTES) {
      throw new Error('structured_index:payload_too_large');
    }
    const sourceHash = createHash('sha256')
      .update(`${STRUCTURED_INDEX_GRAPH_DERIVATION}\0${sourceFactId}\0${entityId}\0${value}`)
      .digest('hex');
    return {
      id: `eik1:${input.episodeId}:${sourceHash}`,
      episode_id: input.episodeId,
      kind: 'fact' as const,
      value,
      entity_id: entityId,
      source_fact_id: sourceFactId,
      derivation: STRUCTURED_INDEX_GRAPH_DERIVATION,
      schema_version: STRUCTURED_INDEX_SCHEMA_VERSION,
      source: 'backfill' as const,
      source_hash: sourceHash,
      tenant_id: input.tenantId,
      project_scope: input.projectScope,
      created_at: input.createdAt,
    };
  });
}
