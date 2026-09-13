import { createHash, randomUUID } from 'node:crypto';
import neo4j, { type Driver, type ManagedTransaction } from 'neo4j-driver';
import {
  embeddingDescriptorFingerprint, parseEmbeddingDescriptor, parseEmbeddingRequest,
  validateEmbeddingVector, type EmbeddingDescriptor, type EmbeddingProvider, type EmbeddingRequest,
} from '@memberry/core';
import { endpointProjectScopeWhere, semanticEligibilityWhere } from './query.js';

export type EmbeddingSourceKind = 'semantic' | 'episodic' | 'symbol' | 'episodic-index-key';
export const EMBEDDING_SOURCE_KINDS: readonly EmbeddingSourceKind[] = ['semantic', 'episodic', 'symbol', 'episodic-index-key'];
const INVENTORY_CAP = 10_000;
const POLICY = 'canonical-input-v1';
const sha = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');
const fail = (reason: string): never => { throw new Error(`embedding_generation:${reason}`); };
type Runner = Pick<ManagedTransaction, 'run'>;
export interface GenerationManifest {
  id: string;
  descriptor: EmbeddingDescriptor;
  descriptorFingerprint: string;
  state: string;
  inventoryDigest?: string;
  qualificationDigest?: string;
}
export interface GenerationStatus {
  activeId: string | null;
  compatibleActive: boolean;
  sourceCount: number;
  generations: Array<{ id: string; state: string; descriptorFingerprint: string; currentCount: number;
    pendingCount: number; staleCount: number; failureCount: number; indexCompatible: boolean; qualified: boolean }>;
}
export interface GenerationSource {
  id: string;
  kind: EmbeddingSourceKind;
  inputText: string;
  dependencyText: string;
  inputHash: string;
  keySourceHash?: string;
}
export interface GenerationSearchResult {
  generationId: string | null;
  results: Array<{ id: string; score: number; properties: Record<string, unknown> }>;
  degradedReason?: string;
}
export interface GenerationReplayQuery {
  id: string;
  text: string;
  kind: EmbeddingSourceKind;
  expectedIds: string[];
}
export interface GenerationReplayRow {
  id: string;
  candidateIds: string[];
  baselineIds: string[];
  candidateRecall: number;
  baselineRecall: number;
  candidateReciprocalRank: number;
  baselineReciprocalRank: number;
  passed: boolean;
}
export function evaluateGenerationReplayRow(id: string, expectedIds: readonly string[], candidateIds: string[], baselineIds: string[]): GenerationReplayRow {
  if (!expectedIds.length) fail('invalid_replay');
  const expected = new Set(expectedIds);
  const recall = (ids: string[]) => [...expected].filter(value => ids.includes(value)).length / expected.size;
  const rr = (ids: string[]) => { const first = ids.findIndex(value => expected.has(value)); return first < 0 ? 0 : 1 / (first + 1); };
  const candidateRecall = recall(candidateIds); const baselineRecall = recall(baselineIds);
  const candidateReciprocalRank = rr(candidateIds); const baselineReciprocalRank = rr(baselineIds);
  return { id, candidateIds, baselineIds, candidateRecall, baselineRecall, candidateReciprocalRank, baselineReciprocalRank,
    passed: candidateRecall === 1 && candidateRecall >= baselineRecall && candidateReciprocalRank >= baselineReciprocalRank };
}
function bounded(value: number, max: number): number {
  if (!Number.isInteger(value) || value < 1 || value > max) fail('invalid_limit');
  return value;
}
function identity(id: string): string {
  if (!/^[a-f0-9]{32}$/.test(id)) fail('invalid_id');
  return id;
}
function kindValue(kind: EmbeddingSourceKind): EmbeddingSourceKind {
  if (!EMBEDDING_SOURCE_KINDS.includes(kind)) fail('invalid_source_kind');
  return kind;
}
export function generationIndexName(id: string, kind: EmbeddingSourceKind): string {
  return `eg_${identity(id)}_${kindValue(kind).replaceAll('-', '_')}`;
}
export function generationIndexCompatible(metadata: Record<string, unknown>, name: string, descriptor: EmbeddingDescriptor): boolean {
  const options = metadata.options as { indexConfig?: Record<string, unknown> } | undefined;
  return metadata.name === name && metadata.state === 'ONLINE' && metadata.type === 'VECTOR'
    && JSON.stringify(metadata.labelsOrTypes) === JSON.stringify([name])
    && JSON.stringify(metadata.properties) === '["vector"]'
    && Number(options?.indexConfig?.['vector.dimensions']) === descriptor.dimensions
    && String(options?.indexConfig?.['vector.similarity_function']).toLowerCase() === 'cosine';
}
/** Parameters for projection joins inside an existing authorized source query. */
export function generationReadParameters(scope: EmbeddingRequest, descriptorFingerprint: string, generationId: string): Record<string, unknown> {
  if (!/^[a-f0-9]{64}$/.test(descriptorFingerprint)) fail('invalid_fingerprint');
  return { embeddingScopeKey: parameters(scope).scopeKey, embeddingDescriptorFingerprint: descriptorFingerprint,
    embeddingGenerationId: identity(generationId) };
}
/**
 * Active-pointer guard, emitted ONCE per query before the first projection join and evaluated in
 * the same read transaction (one snapshot). It binds only $embeddingScopeKey / $embeddingGenerationId /
 * $embeddingDescriptorFingerprint, so repeating it per projection join added planner cost without
 * adding any check (measured +30% cold planning on the structured episodic query).
 */
export function generationActivePointerMatch(): string {
  return `MATCH (pointer:EmbeddingGenerationPointer {scopeKey: $embeddingScopeKey})
    MATCH (generation:EmbeddingGeneration {id: pointer.activeId, scopeKey: $embeddingScopeKey})
    WHERE pointer.activeId = $embeddingGenerationId AND generation.state = 'active'
      AND generation.descriptorFingerprint = $embeddingDescriptorFingerprint AND generation.qualificationDigest IS NOT NULL`;
}
/** Correlated MATCH/WHERE fragment; caller retains canonical authorization and lifecycle checks and MUST emit generationActivePointerMatch once. */
export function generationProjectionMatch(kind: EmbeddingSourceKind, sourceAlias: string, projectionAlias: string, parentAlias?: string): string {
  for (const name of [sourceAlias, projectionAlias, ...(parentAlias ? [parentAlias] : [])]) {
    if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(name)) fail('invalid_alias');
  }
  kindValue(kind);
  if (kind === 'episodic-index-key' && !parentAlias) fail('parent_alias_required');
  const s = sourceAlias; const v = projectionAlias;
  const input = kind === 'symbol'
    ? `reduce(text = '', part IN [${s}.name, ${s}.signature, ${s}.doc_comment] | CASE WHEN coalesce(part, '') = '' THEN text WHEN text = '' THEN part ELSE text + ' ' + part END)`
    : kind === 'episodic-index-key' ? `${s}.value` : `${s}.content`;
  return `MATCH (${v}:EmbeddingProjection)-[:EMBEDS]->(${s})
    WHERE ${v}.generationId = $embeddingGenerationId AND ${v}.scopeKey = $embeddingScopeKey
      AND ${v}.descriptorFingerprint = $embeddingDescriptorFingerprint AND ${v}.sourceKind = '${kind}'
      AND ${v}.sourceId = ${s}.id AND ${v}.inputText = ${input}
      ${parentAlias ? `AND ${v}.dependencyText = ${parentAlias}.content AND ${s}.source_hash = ${v}.keySourceHash` : ''}`;
}
function parameters(scope: EmbeddingRequest): Record<string, unknown> {
  const parsed = parseEmbeddingRequest(scope);
  if (parsed.projectScope !== null && !/^project:[a-z0-9][a-z0-9._-]*$/.test(parsed.projectScope)) fail('noncanonical_scope');
  return { tenantId: parsed.tenantId, projectScope: parsed.projectScope,
    scopeKey: sha(JSON.stringify([parsed.tenantId, parsed.projectScope])), semanticAsOf: new Date().toISOString() };
}
function sourceShape(kind: EmbeddingSourceKind, tenant: string) {
  kindValue(kind);
  const label = { semantic: 'Semantic', episodic: 'Episodic', symbol: 'Symbol', 'episodic-index-key': 'EpisodicIndexKey' }[kind];
  const tenantWhere = `(s.tenant_id = $tenantId OR (s.tenant_id IS NULL AND $tenantId = 'default'))`;
  const scopeField = kind === 'symbol' ? 's.project_tag' : kind === 'episodic-index-key' ? 's.project_scope' : 's.scope';
  const scopeWhere = kind === 'semantic' || kind === 'episodic'
    ? `(($projectScope IS NOT NULL AND ${endpointProjectScopeWhere('s')})
      OR ($projectScope IS NULL AND s.scope IS NULL AND none(tag IN coalesce(s.tags, []) WHERE toLower(toString(tag)) STARTS WITH 'project:')))`
    : `((${scopeField} IS NULL AND $projectScope IS NULL) OR ${scopeField} = $projectScope)`;
  let where = `${kind === 'symbol' ? "$tenantId = 'default' AND (s.tenant_id IS NULL OR s.tenant_id = 'default')" : tenantWhere}
    AND ${scopeWhere}`;
  if (kind === 'semantic') where += ` AND ${semanticEligibilityWhere('s', tenant)}`;
  else where += ' AND coalesce(s.archived, false) = false';
  const input = kind === 'symbol'
    ? "reduce(text = '', part IN [s.name, s.signature, s.doc_comment] | CASE WHEN coalesce(part, '') = '' THEN text WHEN text = '' THEN part ELSE text + ' ' + part END)"
    : kind === 'episodic-index-key' ? 's.value' : 's.content';
  const extraMatch = kind === 'episodic-index-key' ? 'MATCH (parent:Episodic)-[:HAS_INDEX_KEY]->(s)' : '';
  if (kind === 'episodic-index-key') where += ` AND parent.id = s.episode_id
    AND parent.tenant_id = $tenantId AND ${endpointProjectScopeWhere('parent')}
    AND coalesce(parent.archived, false) = false AND s.schema_version = 1`;
  return { match: `MATCH (s:${label}) ${extraMatch}`, where: `${where} AND coalesce(${input}, '') <> ''`,
    input, dependency: kind === 'episodic-index-key' ? "coalesce(parent.content, '')" : "''" };
}
function mapManifest(props: Record<string, unknown>): GenerationManifest {
  return { id: String(props.id), descriptor: parseEmbeddingDescriptor(JSON.parse(String(props.descriptor))),
    descriptorFingerprint: String(props.descriptorFingerprint), state: String(props.state),
    ...(typeof props.inventoryDigest === 'string' ? { inventoryDigest: props.inventoryDigest } : {}),
    ...(typeof props.qualificationDigest === 'string' ? { qualificationDigest: props.qualificationDigest } : {}) };
}
function inventoryDigest(sources: GenerationSource[]): string {
  return sha(JSON.stringify(sources.map(s => [s.kind, s.id, s.inputHash]).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))));
}

/** Replaceable vector projections. Canonical evidence is never overwritten by a migration. */
export class EmbeddingGenerationStore {
  constructor(private readonly driver: Driver) {}

  private async read<T>(scope: EmbeddingRequest, work: (tx: ManagedTransaction, p: Record<string, unknown>) => Promise<T>): Promise<T> {
    const p = parameters(scope);
    const session = this.driver.session({ defaultAccessMode: 'READ' });
    try { return await session.executeRead(tx => work(tx, p), { timeout: 5_000 }); }
    finally { await session.close(); }
  }

  private async transaction<T>(scope: EmbeddingRequest, work: (tx: ManagedTransaction, p: Record<string, unknown>) => Promise<T>): Promise<T> {
    const p = parameters(scope);
    const session = this.driver.session();
    try {
      return await session.executeWrite(async tx => {
        // The aggregate is bumped by both project memory writers and default-tenant code writers.
        // Acquire it first everywhere; scope pointer is the second lock in the shared order.
        const epoch = await tx.run(`MERGE (e:KnowledgeEpoch {tenant_id: $tenantId, project_scope: '_unscoped'})
          ON CREATE SET e.value = 0 SET e.generation_lock = coalesce(e.generation_lock, 0) + 1
          RETURN toString(e.value) AS epoch`, p);
        await tx.run(`MERGE (p:EmbeddingGenerationPointer {scopeKey: $scopeKey})
          ON CREATE SET p.tenantId = $tenantId, p.projectScope = $projectScope
          SET p.lock = coalesce(p.lock, 0) + 1`, p);
        return work(tx, { ...p, epoch: epoch.records[0]?.get('epoch') });
      }, { timeout: 30_000 });
    } finally { await session.close(); }
  }

  private async manifest(tx: Runner, p: Record<string, unknown>, id: string): Promise<Record<string, unknown>> {
    const result = await tx.run('MATCH (g:EmbeddingGeneration {id: $generationId, scopeKey: $scopeKey}) RETURN g', { ...p, generationId: identity(id) });
    const props = result.records[0]?.get('g')?.properties as Record<string, unknown> | undefined;
    if (!props) return fail('not_found');
    return props;
  }

  private async inventory(tx: Runner, p: Record<string, unknown>): Promise<GenerationSource[]> {
    const rows: GenerationSource[] = [];
    for (const kind of EMBEDDING_SOURCE_KINDS) {
      const shape = sourceShape(kind, String(p.tenantId));
      const result = await tx.run(`${shape.match} WHERE ${shape.where}
        RETURN DISTINCT s.id AS id, ${shape.input} AS inputText, ${shape.dependency} AS dependencyText,
          s.source_hash AS parentHash ORDER BY id LIMIT $cap`, { ...p, cap: neo4j.int(INVENTORY_CAP + 1) });
      if (result.records.length > INVENTORY_CAP) fail('inventory_limit_exceeded');
      for (const row of result.records) {
        const id: unknown = row.get('id'); const inputText: unknown = row.get('inputText');
        const dependencyText: unknown = row.get('dependencyText');
        if (typeof id !== 'string' || typeof inputText !== 'string' || typeof dependencyText !== 'string') fail('invalid_canonical_source');
        const keySourceHash = kind === 'episodic-index-key' ? row.get('parentHash') as unknown : undefined;
        if (kind === 'episodic-index-key' && (typeof keySourceHash !== 'string' || !/^[a-f0-9]{64}$/.test(keySourceHash))) fail('invalid_index_key_source');
        rows.push({ id: id as string, kind, inputText: inputText as string, dependencyText: dependencyText as string,
          ...(typeof keySourceHash === 'string' ? { keySourceHash } : {}),
          inputHash: sha(JSON.stringify([POLICY, kind, id, inputText, dependencyText, keySourceHash ?? null])) });
      }
    }
    if (rows.length > INVENTORY_CAP) fail('inventory_limit_exceeded');
    return rows;
  }

  async create(scope: EmbeddingRequest, descriptor: EmbeddingDescriptor, options: {
    revisionBindingEvidence: string; observationWindowMs?: number;
  }): Promise<string> {
    const d = parseEmbeddingDescriptor(descriptor);
    if (d.dimensions > 4096) fail('unsupported_index_dimensions');
    if (!options.revisionBindingEvidence?.trim() || /^(alias|unversioned|unknown|unspecified)(?:[:_-]|$)/i.test(d.revision)) fail('revision_binding_required');
    const observationWindowMs = options.observationWindowMs ?? 86_400_000;
    if (!Number.isSafeInteger(observationWindowMs) || observationWindowMs < 86_400_000) fail('invalid_observation_window');
    const id = randomUUID().replaceAll('-', '');
    await this.transaction(scope, async (tx, p) => {
      await tx.run(`CREATE (g:EmbeddingGeneration {id: $generationId, scopeKey: $scopeKey, tenantId: $tenantId,
        projectScope: $projectScope, descriptor: $descriptor, descriptorFingerprint: $fingerprint,
        state: 'building', policy: $policy, revisionBindingEvidence: $evidence, observationWindowMs: $window,
        createdAt: $now})`, { ...p, generationId: id, descriptor: JSON.stringify(d), fingerprint: embeddingDescriptorFingerprint(d),
        policy: POLICY, evidence: options.revisionBindingEvidence, window: neo4j.int(observationWindowMs), now: new Date().toISOString() });
    });
    await this.ensureIndexes(scope, id);
    return id;
  }

  /** Idempotent retry after index creation was interrupted; the generation remains building. */
  async ensureIndexes(scope: EmbeddingRequest, id: string): Promise<void> {
    const session = this.driver.session();
    try {
      const g = mapManifest(await this.manifest(session, parameters(scope), id));
      if (g.state === 'retired') fail('retired');
      for (const kind of EMBEDDING_SOURCE_KINDS) {
        const name = generationIndexName(id, kind);
        await session.run(`CREATE VECTOR INDEX ${name} IF NOT EXISTS FOR (p:${name}) ON (p.vector)
          OPTIONS {indexConfig: {\`vector.dimensions\`: ${g.descriptor.dimensions}, \`vector.similarity_function\`: 'cosine'}}`);
      }
    } finally { await session.close(); }
  }

  private checkProvider(provider: EmbeddingProvider, g: GenerationManifest): void {
    if (provider.available === false || !provider.descriptor || embeddingDescriptorFingerprint(provider.descriptor) !== g.descriptorFingerprint) fail('provider_mismatch');
  }

  /** One bounded resumable batch. Model calls occur outside the source/pointer transaction. */
  async backfill(scope: EmbeddingRequest, id: string, provider: EmbeddingProvider, options: { batchSize?: number } = {}): Promise<{ written: number; failed: number; remaining: number }> {
    scope = parseEmbeddingRequest(scope);
    const batchSize = bounded(options.batchSize ?? 50, 100);
    const snapshot = await this.transaction(scope, async (tx, p) => {
      const g = mapManifest(await this.manifest(tx, p, id));
      if (!['building', 'active', 'retained'].includes(g.state)) fail('not_writable');
      this.checkProvider(provider, g);
      const sources = await this.inventory(tx, p);
      const result = await tx.run(`MATCH (v:EmbeddingProjection {generationId: $generationId, scopeKey: $scopeKey})
        RETURN v.sourceKind AS kind, v.sourceId AS id, v.inputHash AS inputHash`, { ...p, generationId: id });
      const done = new Set(result.records.map(r => JSON.stringify([r.get('kind'), r.get('id'), r.get('inputHash')])));
      const pending = sources.filter(s => !done.has(JSON.stringify([s.kind, s.id, s.inputHash])));
      return { g, pending: pending.slice(0, batchSize), remaining: pending.length };
    });
    let written = 0; let failed = 0;
    for (const source of snapshot.pending) {
      try {
        this.checkProvider(provider, snapshot.g);
        const vector = validateEmbeddingVector(await provider.embed(source.inputText, scope), snapshot.g.descriptor);
        this.checkProvider(provider, snapshot.g);
        await this.writeProjection(scope, id, source, vector, snapshot.g.descriptorFingerprint);
        written++;
      } catch {
        failed++;
        await this.transaction(scope, async (tx, p) => {
          await tx.run(`OPTIONAL MATCH (current:EmbeddingProjection {generationId: $generationId, scopeKey: $scopeKey,
              sourceId: $sourceId, sourceKind: $kind, inputHash: $inputHash})
            MERGE (f:EmbeddingBackfillFailure {id: $failureId})
            SET f.generationId = $generationId, f.scopeKey = $scopeKey, f.sourceId = $sourceId,
              f.sourceKind = $kind, f.inputHash = $inputHash, f.reason = 'embedding_or_source_changed', f.resolved = current IS NOT NULL,
              f.resolution = CASE WHEN current IS NOT NULL THEN 'concurrent_projection_repaired' ELSE null END`,
          { ...p, failureId: sha(JSON.stringify([id, source.kind, source.id])), generationId: id,
            sourceId: source.id, kind: source.kind, inputHash: source.inputHash });
        });
      }
    }
    return { written, failed, remaining: snapshot.remaining - written };
  }

  async writeProjection(scope: EmbeddingRequest, id: string, source: GenerationSource, vector: number[], descriptorFingerprint: string): Promise<void> {
    scope = parseEmbeddingRequest(scope);
    await this.transaction(scope, async (tx, p) => {
      const g = mapManifest(await this.manifest(tx, p, id));
      if (!['building', 'active', 'retained'].includes(g.state)) fail('not_writable');
      if (descriptorFingerprint !== g.descriptorFingerprint) fail('provider_mismatch');
      const validated = validateEmbeddingVector(vector, g.descriptor);
      if (!validated.some(value => value !== 0)) fail('zero_vector');
      if (source.inputHash !== sha(JSON.stringify([POLICY, source.kind, source.id, source.inputText, source.dependencyText, source.keySourceHash ?? null]))) fail('source_hash_mismatch');
      const shape = sourceShape(source.kind, scope.tenantId);
      const label = generationIndexName(id, source.kind);
      const result = await tx.run(`${shape.match} WHERE ${shape.where} AND s.id = $sourceId
        AND ${shape.input} = $inputText AND ${shape.dependency} = $dependencyText
        ${source.kind === 'episodic-index-key' ? 'AND s.source_hash = $keySourceHash' : ''}
        MERGE (v:EmbeddingProjection:${label} {id: $projectionId})
        SET v.generationId = $generationId, v.scopeKey = $scopeKey, v.sourceKind = $kind,
          v.sourceId = $sourceId, v.inputText = $inputText, v.dependencyText = $dependencyText,
          v.inputHash = $inputHash, v.keySourceHash = $keySourceHash, v.descriptorFingerprint = $fingerprint, v.vector = $vector
        MERGE (v)-[:EMBEDS]->(s) RETURN v.id AS id`,
      { ...p, generationId: id, sourceId: source.id, kind: source.kind, inputText: source.inputText,
        dependencyText: source.dependencyText, inputHash: source.inputHash, fingerprint: g.descriptorFingerprint,
        keySourceHash: source.keySourceHash ?? '', vector: validated, projectionId: sha(JSON.stringify([id, source.kind, source.id])) });
      if (result.records.length !== 1) fail('source_changed');
      await tx.run("MATCH (f:EmbeddingBackfillFailure {id: $failureId}) SET f.resolved = true, f.resolution = 'projection_repaired'", { failureId: sha(JSON.stringify([id, source.kind, source.id])) });
    });
  }

  private async assertComplete(tx: Runner, p: Record<string, unknown>, id: string): Promise<string> {
    const inventory = await this.inventory(tx, p);
    const result = await tx.run(`MATCH (v:EmbeddingProjection {generationId: $generationId, scopeKey: $scopeKey})
      RETURN v.sourceKind AS kind, v.sourceId AS id, v.inputHash AS inputHash`, { ...p, generationId: id });
    const hashes = new Set(result.records.map(r => JSON.stringify([r.get('kind'), r.get('id'), r.get('inputHash')])));
    if (inventory.some(s => !hashes.has(JSON.stringify([s.kind, s.id, s.inputHash])))) fail('incomplete');
    await tx.run(`MATCH (f:EmbeddingBackfillFailure {generationId: $generationId, scopeKey: $scopeKey})
      WHERE NOT f.inputHash IN $hashes SET f.resolved = true, f.resolution = 'source_absent_or_changed'`,
    { ...p, generationId: id, hashes: inventory.map(s => s.inputHash) });
    await tx.run(`MATCH (f:EmbeddingBackfillFailure {generationId: $generationId, scopeKey: $scopeKey})
      MATCH (v:EmbeddingProjection {generationId: $generationId, scopeKey: $scopeKey})
      WHERE v.sourceId = f.sourceId AND v.sourceKind = f.sourceKind AND v.inputHash = f.inputHash
      SET f.resolved = true, f.resolution = 'projection_repaired'`, { ...p, generationId: id });
    const failed = await tx.run(`MATCH (f:EmbeddingBackfillFailure {generationId: $generationId, scopeKey: $scopeKey})
      WHERE coalesce(f.resolved, false) = false RETURN count(f) AS failures`, { ...p, generationId: id });
    if (Number(failed.records[0]?.get('failures') ?? 0) !== 0) fail('backfill_failures');
    return inventoryDigest(inventory);
  }

  private async assertIndexes(tx: Runner, id: string, descriptor: EmbeddingDescriptor): Promise<void> {
    const names = EMBEDDING_SOURCE_KINDS.map(k => generationIndexName(id, k));
    const result = await tx.run('SHOW INDEXES YIELD name, state, type, labelsOrTypes, properties, options WHERE name IN $names RETURN *', { names });
    const metadata = result.records.map(r => ({
      name: r.get('name'), state: r.get('state'), type: r.get('type'), labelsOrTypes: r.get('labelsOrTypes'),
      properties: r.get('properties'), options: r.get('options'),
    }));
    if (metadata.length !== names.length || metadata.some(item => !generationIndexCompatible(item, String(item.name), descriptor))) {
      fail('index_not_compatible');
    }
  }

  async complete(scope: EmbeddingRequest, id: string): Promise<void> {
    await this.transaction(scope, async (tx, p) => {
      const g = mapManifest(await this.manifest(tx, p, id));
      if (g.state !== 'building') fail('not_building');
      await this.assertIndexes(tx, id, g.descriptor);
      const digest = await this.assertComplete(tx, p, id);
      await tx.run(`MATCH (g:EmbeddingGeneration {id: $generationId, scopeKey: $scopeKey})
        SET g.state = 'complete', g.inventoryDigest = $digest, g.completionEpoch = $epoch`, { ...p, generationId: id, digest });
    });
  }

  /** Explicitly invalidate a stale completion/replay and resume repair without changing active serving. */
  async reopen(scope: EmbeddingRequest, id: string): Promise<void> {
    await this.transaction(scope, async (tx, p) => {
      const raw = await this.manifest(tx, p, id);
      if (!['building', 'complete', 'qualified'].includes(String(raw.state))) fail('not_reopenable');
      await tx.run(`MATCH (g:EmbeddingGeneration {id: $generationId, scopeKey: $scopeKey})
        SET g.state = 'building' REMOVE g.inventoryDigest, g.completionEpoch, g.qualificationDigest,
          g.qualificationEpoch, g.frozenReplayDigest, g.frozenReplayManifest`, { ...p, generationId: id });
    });
  }

  async compatible(scope: EmbeddingRequest, descriptorFingerprint: string): Promise<GenerationManifest | null> {
    if (!/^[a-f0-9]{64}$/.test(descriptorFingerprint)) fail('invalid_fingerprint');
    return this.read(scope, async (tx, p) => {
      const result = await tx.run(`MATCH (p:EmbeddingGenerationPointer {scopeKey: $scopeKey})
        MATCH (g:EmbeddingGeneration {id: p.activeId, scopeKey: $scopeKey, state: 'active', descriptorFingerprint: $fingerprint})
        WHERE g.qualificationDigest IS NOT NULL RETURN g`, { ...p, fingerprint: descriptorFingerprint });
      if (!result.records.length) return null;
      const g = mapManifest(result.records[0]!.get('g').properties);
      await this.assertIndexes(tx, g.id, g.descriptor);
      return g;
    });
  }

  /** Scope-bound operational evidence; contains no source text, vectors, credentials or provider prompts. */
  async status(scope: EmbeddingRequest, descriptorFingerprint?: string): Promise<GenerationStatus> {
    if (descriptorFingerprint !== undefined && !/^[a-f0-9]{64}$/.test(descriptorFingerprint)) fail('invalid_fingerprint');
    return this.transaction(scope, async (tx, p) => {
      const sources = await this.inventory(tx, p);
      const canonical = new Set(sources.map(s => JSON.stringify([s.kind, s.id, s.inputHash])));
      const ptr = await tx.run('MATCH (p:EmbeddingGenerationPointer {scopeKey: $scopeKey}) RETURN p.activeId AS id', p);
      const manifests = await tx.run('MATCH (g:EmbeddingGeneration {scopeKey: $scopeKey}) RETURN g ORDER BY g.createdAt LIMIT 101', p);
      if (manifests.records.length > 100) fail('generation_manifest_limit_exceeded');
      const generations: GenerationStatus['generations'] = [];
      for (const row of manifests.records) {
        const g = mapManifest(row.get('g').properties);
        const vectors = await tx.run(`MATCH (v:EmbeddingProjection {generationId: $generationId, scopeKey: $scopeKey})
          RETURN v.sourceKind AS kind, v.sourceId AS id, v.inputHash AS inputHash`, { ...p, generationId: g.id });
        const current = new Set(vectors.records.map(r => JSON.stringify([r.get('kind'), r.get('id'), r.get('inputHash')])).filter(key => canonical.has(key)));
        const failures = await tx.run(`MATCH (f:EmbeddingBackfillFailure {generationId: $generationId, scopeKey: $scopeKey})
          WHERE coalesce(f.resolved, false) = false RETURN count(f) AS count`, { ...p, generationId: g.id });
        let indexCompatible = true;
        try { await this.assertIndexes(tx, g.id, g.descriptor); } catch { indexCompatible = false; }
        generations.push({ id: g.id, state: g.state, descriptorFingerprint: g.descriptorFingerprint,
          currentCount: current.size, pendingCount: canonical.size - current.size, staleCount: vectors.records.length - current.size,
          failureCount: Number(failures.records[0]?.get('count') ?? 0), indexCompatible, qualified: !!g.qualificationDigest });
      }
      const activeId = ptr.records[0]?.get('id') as string | null ?? null;
      return { activeId, compatibleActive: generations.some(g => g.id === activeId && g.state === 'active' && g.qualified
        && g.indexCompatible && (descriptorFingerprint === undefined || g.descriptorFingerprint === descriptorFingerprint)),
      sourceCount: canonical.size, generations };
    });
  }

  private async searchGeneration(tx: Runner, p: Record<string, unknown>, g: GenerationManifest,
    input: { vector: number[]; kind: EmbeddingSourceKind; limit: number; sourceIds?: string[] }, active: boolean): Promise<GenerationSearchResult['results']> {
    const shape = sourceShape(input.kind, String(p.tenantId));
    const indexName = generationIndexName(g.id, input.kind);
    const result = await tx.run(`MATCH (g:EmbeddingGeneration {id: $generationId, scopeKey: $scopeKey, descriptorFingerprint: $fingerprint})
      ${active ? "MATCH (pointer:EmbeddingGenerationPointer {scopeKey: $scopeKey}) WHERE pointer.activeId = g.id AND g.state = 'active' AND g.qualificationDigest IS NOT NULL" : "WHERE g.state IN ['complete', 'qualified', 'active', 'retained']"}
      WITH g CALL db.index.vector.queryNodes($indexName, $fetch, $vector) YIELD node AS v, score
      ${shape.match} MATCH (v)-[:EMBEDS]->(s)
      WHERE ${shape.where} AND v.generationId = g.id AND v.scopeKey = $scopeKey
        AND v.descriptorFingerprint = $fingerprint AND v.sourceKind = $kind AND v.sourceId = s.id
        AND v.inputText = ${shape.input} AND v.dependencyText = ${shape.dependency}
        ${input.kind === 'episodic-index-key' ? 'AND s.source_hash = v.keySourceHash' : ''}
        AND ($sourceIds IS NULL OR s.id IN $sourceIds)
      RETURN s {.*, embedding: null} AS properties, score ORDER BY score DESC, s.id ASC LIMIT $limit`,
    { ...p, generationId: g.id, fingerprint: g.descriptorFingerprint, indexName, vector: validateEmbeddingVector(input.vector, g.descriptor),
      kind: input.kind, fetch: neo4j.int(Math.min(input.limit * 10, 1000)), limit: neo4j.int(input.limit), sourceIds: input.sourceIds ?? null });
    return result.records.map(r => { const properties = r.get('properties') as Record<string, unknown>;
      return { id: String(properties.id), properties, score: Number(r.get('score')) }; });
  }

  async search(scope: EmbeddingRequest, input: { descriptorFingerprint: string; vector: number[]; kind: EmbeddingSourceKind; limit?: number; sourceIds?: string[] }): Promise<GenerationSearchResult> {
    scope = parseEmbeddingRequest(scope);
    if (!Array.isArray(input.vector)) fail('invalid_query_vector');
    input = { ...input, vector: [...input.vector], ...(input.sourceIds ? { sourceIds: [...input.sourceIds] } : {}) };
    const limit = bounded(input.limit ?? 20, 100);
    kindValue(input.kind);
    if (input.sourceIds && input.sourceIds.length > 100) fail('source_limit_exceeded');
    const g = await this.compatible(scope, input.descriptorFingerprint);
    if (!g) return { generationId: null, results: [], degradedReason: 'embedding_generation_unavailable' };
    return this.read(scope, async (tx, p) => {
      const results = await this.searchGeneration(tx, p, g, { ...input, limit }, true);
      return { generationId: g.id, results };
    });
  }

  async vectors(scope: EmbeddingRequest, input: { descriptorFingerprint: string; kind: EmbeddingSourceKind; sourceIds: string[] }): Promise<{
    generationId: string | null; rows: Array<{ id: string; vector: number[]; inputText: string; dependencyText: string }>; degradedReason?: string;
  }> {
    scope = parseEmbeddingRequest(scope);
    if (!Array.isArray(input.sourceIds) || input.sourceIds.length > 100 || input.sourceIds.some(id => typeof id !== 'string' || !id)) fail('source_limit_exceeded');
    input = { ...input, sourceIds: [...input.sourceIds] };
    const g = await this.compatible(scope, input.descriptorFingerprint);
    if (!g) return { generationId: null, rows: [], degradedReason: 'embedding_generation_unavailable' };
    const shape = sourceShape(input.kind, scope.tenantId);
    return this.read(scope, async (tx, p) => {
      const result = await tx.run(`${generationActivePointerMatch()}
        ${shape.match} WHERE ${shape.where} AND s.id IN $sourceIds
        ${generationProjectionMatch(input.kind, 's', 'v', input.kind === 'episodic-index-key' ? 'parent' : undefined)}
        RETURN s.id AS id, v.vector AS vector, v.inputText AS inputText, v.dependencyText AS dependencyText LIMIT 100`,
      { ...p, ...generationReadParameters(scope, input.descriptorFingerprint, g.id), sourceIds: input.sourceIds });
      return { generationId: g.id, rows: result.records.map(r => ({ id: String(r.get('id')),
        vector: validateEmbeddingVector(r.get('vector'), g.descriptor), inputText: String(r.get('inputText')), dependencyText: String(r.get('dependencyText')) })) };
    });
  }

  /** Fixed, bounded labeled replay; callers cannot submit a fabricated pass receipt. */
  async replayAndQualify(scope: EmbeddingRequest, id: string, provider: EmbeddingProvider, options: {
    queries: GenerationReplayQuery[]; topK?: number; baselineProvider?: EmbeddingProvider;
  }): Promise<{ passed: boolean; replayDigest: string; baseline: string; rows: GenerationReplayRow[] }> {
    scope = parseEmbeddingRequest(scope);
    const topK = bounded(options.topK ?? 10, 100);
    bounded(options.queries.length, 100);
    const queries = options.queries.map(q => ({ id: q.id, text: q.text, kind: kindValue(q.kind), expectedIds: [...q.expectedIds] }));
    if (new Set(queries.map(q => q.id)).size !== queries.length || queries.some(q => !q.id || !q.text || !q.expectedIds.length || q.expectedIds.length > topK)) fail('invalid_replay');
    const snapshot = await this.transaction(scope, async (tx, p) => {
      const raw = await this.manifest(tx, p, id); const g = mapManifest(raw);
      if (g.state !== 'complete') fail('not_complete');
      this.checkProvider(provider, g);
      const digest = await this.assertComplete(tx, p, id);
      if (digest !== g.inventoryDigest || raw.completionEpoch !== p.epoch) fail('source_changed');
      const ptr = await tx.run('MATCH (p:EmbeddingGenerationPointer {scopeKey: $scopeKey}) RETURN p.activeId AS activeId', p);
      const activeId = ptr.records[0]?.get('activeId') as string | null;
      const baseline = activeId ? mapManifest(await this.manifest(tx, p, activeId)) : null;
      if (baseline) this.checkProvider(options.baselineProvider ?? provider, baseline);
      const sources = await this.inventory(tx, p);
      if (EMBEDDING_SOURCE_KINDS.some(kind => sources.some(s => s.kind === kind) && !queries.some(q => q.kind === kind))) fail('replay_source_coverage');
      const frozenDigest = sha(JSON.stringify({ queries, topK, candidate: id, baseline: activeId, inventory: digest, policy: 'all-labels-per-query-recall-and-reciprocal-rank-nonregression-v1' }));
      if (raw.frozenReplayDigest !== undefined && raw.frozenReplayDigest !== null && raw.frozenReplayDigest !== frozenDigest) fail('replay_manifest_changed_reopen_required');
      await tx.run(`MATCH (g:EmbeddingGeneration {id: $generationId})
        SET g.frozenReplayDigest = $digest, g.frozenReplayManifest = $manifest`,
      { generationId: id, digest: frozenDigest, manifest: JSON.stringify({ queries, topK, baseline: activeId }) });
      return { g, baseline, sources, epoch: p.epoch, frozenDigest };
    });
    const rows: GenerationReplayRow[] = [];
    for (const query of queries) {
      this.checkProvider(provider, snapshot.g);
      const vector = await provider.embed(query.text, scope);
      this.checkProvider(provider, snapshot.g);
      const session = this.driver.session();
      try {
        const candidate = await this.searchGeneration(session, parameters(scope), snapshot.g, { vector, kind: query.kind, limit: topK }, false);
        let baselineIds: string[];
        if (snapshot.baseline) {
          const baselineProvider = options.baselineProvider ?? provider;
          this.checkProvider(baselineProvider, snapshot.baseline);
          const oldVector = await baselineProvider.embed(query.text, scope);
          this.checkProvider(baselineProvider, snapshot.baseline);
          baselineIds = (await this.searchGeneration(session, parameters(scope), snapshot.baseline, { vector: oldVector, kind: query.kind, limit: topK }, false)).map(r => r.id);
        } else {
          const tokens = [...new Set(query.text.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? [])];
          baselineIds = snapshot.sources.filter(s => s.kind === query.kind).map(s => ({ id: s.id,
            score: tokens.filter(t => s.inputText.toLowerCase().includes(t)).length })).filter(s => s.score > 0)
            .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id)).slice(0, topK).map(s => s.id);
        }
        const candidateIds = candidate.map(r => r.id);
        rows.push(evaluateGenerationReplayRow(query.id, query.expectedIds, candidateIds, baselineIds));
      } finally { await session.close(); }
    }
    const passed = rows.every(r => r.passed);
    const replayDigest = sha(JSON.stringify([snapshot.frozenDigest, rows]));
    await this.transaction(scope, async (tx, p) => {
      const raw = await this.manifest(tx, p, id);
      const ptr = await tx.run('MATCH (p:EmbeddingGenerationPointer {scopeKey: $scopeKey}) RETURN p.activeId AS activeId', p);
      if (raw.state !== 'complete' || raw.frozenReplayDigest !== snapshot.frozenDigest || p.epoch !== snapshot.epoch
        || (ptr.records[0]?.get('activeId') ?? null) !== (snapshot.baseline?.id ?? null)
        || await this.assertComplete(tx, p, id) !== snapshot.g.inventoryDigest) fail('qualification_changed');
      await this.assertIndexes(tx, id, snapshot.g.descriptor);
      await tx.run(`MATCH (g:EmbeddingGeneration {id: $generationId, scopeKey: $scopeKey})
        SET g.lastReplayDigest = $replayDigest, g.replayResults = $rows, g.replayPassed = $passed,
          g.state = CASE WHEN $passed THEN 'qualified' ELSE 'complete' END,
          g.qualificationDigest = CASE WHEN $passed THEN $replayDigest ELSE null END,
          g.qualificationEpoch = CASE WHEN $passed THEN $epoch ELSE null END`,
      { ...p, generationId: id, replayDigest, rows: JSON.stringify(rows), passed });
      await tx.run(`MATCH (g:EmbeddingGeneration {id: $generationId, scopeKey: $scopeKey})
        MERGE (r:EmbeddingGenerationReplay {id: $replayDigest})
        ON CREATE SET r.scopeKey = $scopeKey, r.generationId = $generationId, r.manifestDigest = $manifestDigest,
          r.manifest = $manifest, r.results = $rows, r.passed = $passed, r.epoch = $epoch, r.recordedAt = $now
        MERGE (r)-[:REPLAY_FOR]->(g)`,
      { ...p, generationId: id, replayDigest, manifestDigest: snapshot.frozenDigest, manifest: String(raw.frozenReplayManifest),
        rows: JSON.stringify(rows), passed, now: new Date().toISOString() });
    });
    return { passed, replayDigest, baseline: snapshot.baseline?.id ?? 'bounded-lexical-v1', rows };
  }

  async activate(scope: EmbeddingRequest, id: string, expectedActiveId: string | null): Promise<void> {
    await this.transaction(scope, async (tx, p) => {
      const raw = await this.manifest(tx, p, id); const g = mapManifest(raw);
      if (g.state !== 'qualified' || !g.qualificationDigest || raw.qualificationEpoch !== p.epoch) fail('not_qualified');
      if (await this.assertComplete(tx, p, id) !== g.inventoryDigest) fail('source_changed');
      await this.assertIndexes(tx, id, g.descriptor);
      await this.switchPointer(tx, p, id, expectedActiveId);
    });
  }

  private async switchPointer(tx: Runner, p: Record<string, unknown>, id: string, expected: string | null): Promise<void> {
    const result = await tx.run(`MATCH (p:EmbeddingGenerationPointer {scopeKey: $scopeKey})
      WHERE ($expected IS NULL AND p.activeId IS NULL) OR p.activeId = $expected
      OPTIONAL MATCH (old:EmbeddingGeneration {id: p.activeId, scopeKey: $scopeKey})
      SET old.state = 'retained', old.retainedAt = $now
      WITH p MATCH (g:EmbeddingGeneration {id: $generationId, scopeKey: $scopeKey})
      SET p.activeId = g.id, g.state = 'active', g.activatedAt = $now,
        g.healthyObservations = 0, g.unhealthyObservations = 0
      RETURN g.id AS id`, { ...p, generationId: id, expected, now: new Date().toISOString() });
    if (result.records.length !== 1) fail('pointer_conflict');
  }

  async rollback(scope: EmbeddingRequest, id: string, expectedActiveId: string, descriptorFingerprint: string): Promise<void> {
    await this.transaction(scope, async (tx, p) => {
      const g = mapManifest(await this.manifest(tx, p, id));
      if (g.state !== 'retained' || !g.qualificationDigest || g.descriptorFingerprint !== descriptorFingerprint) fail('rollback_incompatible');
      await this.assertIndexes(tx, id, g.descriptor);
      // Retained projections may miss new evidence. Requiring completeness avoids silent recall loss.
      await this.assertComplete(tx, p, id);
      await this.switchPointer(tx, p, id, expectedActiveId);
    });
  }

  /** Observation is generated by an actual compatible serving replay, not a caller-supplied boolean. */
  async observe(scope: EmbeddingRequest, provider: EmbeddingProvider, query: GenerationReplayQuery): Promise<boolean> {
    scope = parseEmbeddingRequest(scope);
    query = { ...query, expectedIds: [...query.expectedIds] };
    const descriptor = provider.descriptor;
    if (!descriptor || !query.expectedIds.length) return fail('invalid_observation');
    const fingerprint = embeddingDescriptorFingerprint(descriptor);
    const vector = await provider.embed(query.text, scope);
    if (!provider.descriptor || embeddingDescriptorFingerprint(provider.descriptor) !== fingerprint) fail('provider_mismatch');
    const result = await this.search(scope, { descriptorFingerprint: fingerprint, vector, kind: query.kind, limit: 100 });
    if (!result.generationId) fail('no_active_generation');
    const healthy = query.expectedIds.every(id => result.results.some(r => r.id === id));
    await this.transaction(scope, async (tx, p) => {
      await tx.run(`MATCH (ptr:EmbeddingGenerationPointer {scopeKey: $scopeKey})
        MATCH (g:EmbeddingGeneration {id: ptr.activeId, scopeKey: $scopeKey}) WHERE g.id = $generationId
        SET g.healthyObservations = coalesce(g.healthyObservations, 0) + CASE WHEN $healthy THEN 1 ELSE 0 END,
          g.unhealthyObservations = coalesce(g.unhealthyObservations, 0) + CASE WHEN $healthy THEN 0 ELSE 1 END,
          g.lastObservationAt = $now`, { ...p, generationId: result.generationId, healthy, now: new Date().toISOString() });
    });
    return healthy;
  }

  /** Retirement is logical and reversible at storage level; deleting indexes requires separate cleanup. */
  async retire(scope: EmbeddingRequest, id: string, expectedActiveId: string): Promise<void> {
    await this.transaction(scope, async (tx, p) => {
      const old = await this.manifest(tx, p, id);
      const active = await this.manifest(tx, p, expectedActiveId);
      const ptr = await tx.run('MATCH (p:EmbeddingGenerationPointer {scopeKey: $scopeKey}) RETURN p.activeId AS id', p);
      if (id === expectedActiveId || old.state !== 'retained' || active.state !== 'active'
        || ptr.records[0]?.get('id') !== expectedActiveId || !active.qualificationDigest
        || Number(active.healthyObservations ?? 0) < 1 || Number(active.unhealthyObservations ?? 0) !== 0
        || Date.now() - Date.parse(String(active.activatedAt)) < Number(old.observationWindowMs)
        || !Number.isFinite(Date.parse(String(active.lastObservationAt)))
        || Date.parse(String(active.lastObservationAt)) - Date.parse(String(active.activatedAt)) < Number(old.observationWindowMs)
        || !Number.isFinite(Date.parse(String(active.activatedAt)))) fail('observation_required');
      const activeManifest = mapManifest(active);
      await this.assertIndexes(tx, expectedActiveId, activeManifest.descriptor);
      await this.assertComplete(tx, p, expectedActiveId);
      await tx.run("MATCH (g:EmbeddingGeneration {id: $generationId, scopeKey: $scopeKey}) SET g.state = 'retired', g.retiredAt = $now",
        { ...p, generationId: id, now: new Date().toISOString() });
    });
  }
}
