import { readFile } from 'node:fs/promises';
import { createCoreServices, embeddingDescriptorFingerprint, parseEmbeddingRequest, parseEmbeddingDescriptor, OpenAIEmbedding } from '@memberry/core';
import type { GenerationReplayQuery } from '@memberry/neo4j';

// One explicit command per process. No implicit environment loading or unbounded worker.
const [commandFile, ...extra] = process.argv.slice(2);
if (!commandFile || extra.length) throw new Error('usage: npx tsx scripts/embedding-generation.mts command.json');
const command = JSON.parse(await readFile(commandFile, 'utf8')) as Record<string, unknown>;
const scope = parseEmbeddingRequest(command.scope);
const action = command.action;
const actions = ['status', 'create', 'ensure-indexes', 'backfill', 'complete', 'reopen', 'qualify', 'activate', 'rollback', 'observe', 'retire'];
if (typeof action !== 'string' || !actions.includes(action)) throw new Error('generation_command:invalid_action');
function id(key = 'generationId'): string {
  const value = command[key];
  if (typeof value !== 'string' || !/^[a-f0-9]{32}$/.test(value)) throw new Error(`generation_command:invalid_${key}`);
  return value;
}
const core = createCoreServices();
try {
  if (core.config.readonly && action !== 'status') throw new Error('generation_command:readonly');
  const store = core.embeddingGenerations;
  let result: unknown;
  switch (action) {
    case 'status': result = await store.status(scope, embeddingDescriptorFingerprint(core.embeddingDescriptor)); break;
    case 'create': {
      if (typeof command.revisionBindingEvidence !== 'string') throw new Error('generation_command:revision_evidence_required');
      result = { generationId: await store.create(scope, core.embeddingDescriptor, { revisionBindingEvidence: command.revisionBindingEvidence }) };
      break;
    }
    case 'ensure-indexes': await store.ensureIndexes(scope, id()); break;
    case 'backfill': result = await store.backfill(scope, id(), core.embedding, { batchSize: 50 }); break;
    case 'complete': await store.complete(scope, id()); break;
    case 'reopen': await store.reopen(scope, id()); break;
    case 'qualify': {
      if (!Array.isArray(command.queries)) throw new Error('generation_command:queries_required');
      const baselineDescriptor = command.baselineDescriptor === undefined ? undefined : parseEmbeddingDescriptor(command.baselineDescriptor);
      if (baselineDescriptor && !core.config.embedding.apiKey) throw new Error('generation_command:baseline_provider_unavailable');
      const baselineProvider = baselineDescriptor ? new OpenAIEmbedding(core.config.embedding.apiKey, baselineDescriptor) : undefined;
      result = await store.replayAndQualify(scope, id(), core.embedding, { queries: command.queries as GenerationReplayQuery[],
        ...(baselineProvider ? { baselineProvider } : {}) });
      break;
    }
    case 'activate': await store.activate(scope, id(), command.expectedActiveId === null ? null : id('expectedActiveId')); break;
    case 'rollback': await store.rollback(scope, id(), id('expectedActiveId'), embeddingDescriptorFingerprint(core.embeddingDescriptor)); break;
    case 'observe': {
      if (!command.query || typeof command.query !== 'object') throw new Error('generation_command:query_required');
      result = { healthy: await store.observe(scope, core.embedding, command.query as GenerationReplayQuery) }; break;
    }
    case 'retire': await store.retire(scope, id(), id('expectedActiveId')); break;
  }
  console.log(JSON.stringify({ action, scope, result: result ?? { completed: true } }, null, 2));
} catch (error) {
  // Provider/driver errors can contain connection details or source content.
  const message = error instanceof Error && /^(embedding_generation|generation_command):[a-z_]+$/.test(error.message)
    ? error.message : 'generation_command:failed';
  console.error(message);
  process.exitCode = 1;
} finally {
  await core.close();
}
