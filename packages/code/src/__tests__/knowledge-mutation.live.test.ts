import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Driver, ManagedTransaction } from 'neo4j-driver';
import { createNeo4jDriver, initSchema, KnowledgeEpochStore } from '@memberry/neo4j';
import { ArchEntityStore } from '../../../arch/src/entity-store.js';
import { StructuralRelationStore } from '../../../arch/src/relation-store.js';
import { ExperimentStore } from '../../../research/src/experiment.js';
import { ResearchConsolidation } from '../../../research/src/consolidation.js';
import { AspectStore } from '../../../arch/src/aspect-store.js';
import { SymbolStore } from '../symbol-store.js';
import { ImportResolver } from '../resolver.js';

const mode = process.env.MEMBERRY_PR02_LIVE;
if (mode !== undefined && mode !== 'required') throw new Error('MEMBERRY_PR02_LIVE must be exactly required');
const liveDescribe = mode === 'required' ? describe : describe.skip;
const prefix = `code-epoch-live-${Date.now()}`;

liveDescribe('Code and architecture visibility live authority', () => {
  const driver = createNeo4jDriver(process.env.NEO4J_URI || 'bolt://localhost:7687',
    process.env.NEO4J_USER || 'neo4j', process.env.NEO4J_PASSWORD || 'password');
  const authority = new KnowledgeEpochStore(driver);
  const scope = { tenantId: 'default', projectScope: null };
  const filePath = `/${prefix}/source.ts`;
  const from = `${prefix}-from`;
  const to = `${prefix}-to`;
  const symbolId = `${prefix}-symbol`;
  let available = false;

  beforeAll(async () => {
    if (!process.env.NEO4J_URI || !process.env.NEO4J_USER || !process.env.NEO4J_PASSWORD) {
      throw new Error('required live mode needs explicit disposable Neo4j credentials');
    }
    await driver.getServerInfo();
    await initSchema(driver);
    available = true;
    const session = driver.session();
    try {
      await session.run(`CREATE (:Entity:Component {id: $from, name: $from, path: $path, tenant_id: 'default'}),
        (:Entity {id: $to, name: $to, tenant_id: 'default'})`, { from, to, path: filePath });
    } finally { await session.close(); }
  });

  afterAll(async () => {
    if (available) {
      const session = driver.session();
      try {
        await session.run('MATCH (n) WHERE n.id STARTS WITH $prefix OR n.name STARTS WITH $prefix OR n.path STARTS WITH $pathPrefix OR $campaignTag IN coalesce(n.tags, []) DETACH DELETE n', { prefix, pathPrefix: `/${prefix}/`, campaignTag: `campaign:${from}` });
      } finally { await session.close(); }
    }
    await driver.close();
  });

  async function advances(work: () => Promise<unknown>) {
    const before = BigInt((await authority.read(scope)).knowledgeEpoch);
    await work();
    expect(BigInt((await authority.read(scope)).knowledgeEpoch)).toBeGreaterThan(before);
  }

  it('advances authoritative aggregate for symbol, expansion, entity, relation and aspect writes', async () => {
    const symbols = new SymbolStore(driver);
    const now = new Date().toISOString();
    await advances(() => symbols.create({ id: symbolId, name: from, kind: 'function', language: 'typescript',
      file_path: filePath, start_line: 1, end_line: 2, signature: 'original()', doc_comment: '',
      content_hash: 'synthetic', parent_symbol: null, created_at: now, updated_at: now }));
    await advances(() => symbols.update(symbolId, { signature: 'current()' }));
    await advances(() => new ImportResolver(driver).linkSymbolsToEntity(filePath));
    await advances(() => new ArchEntityStore(driver).setArchProperties(from, { responsibility: 'synthetic' }));
    const relations = new StructuralRelationStore(driver);
    await advances(() => relations.create(from, to, 'USES'));
    await advances(() => relations.remove(from, to, 'USES'));
    const aspects = new AspectStore(driver);
    await advances(() => aspects.create({ name: `${prefix}-aspect`, description: 'synthetic', stability_tier: 'implementation',
      implies: [`${prefix}-implied`] }));
    await advances(() => aspects.applyTo(`${prefix}-aspect`, from));
    await advances(() => aspects.removeFrom(`${prefix}-aspect`, from));
  });

  it('rolls back the actual Neo4j symbol update when epoch advancement fails', async () => {
    const store = new SymbolStore(driver);
    const beforeNode = await store.getById(symbolId);
    expect(beforeNode).not.toBeNull();
    const failingDriver = { session: () => {
      const session = driver.session();
      return {
        close: () => session.close(),
        executeWrite: (work: (tx: Pick<ManagedTransaction, 'run'>) => Promise<unknown>) => session.executeWrite((tx) => work({
          run: (query: string, parameters?: Record<string, unknown>) => {
            const result = tx.run(query, parameters);
            if (query.includes('AS knowledgeEpoch')) {
              return result.then(() => { throw new Error('injected epoch failure'); }) as unknown as ReturnType<ManagedTransaction['run']>;
            }
            return result;
          },
        })),
      };
    } } as unknown as Driver;
    await expect(new SymbolStore(failingDriver).update(symbolId, { signature: 'must-not-commit()' }))
      .rejects.toThrow('injected epoch failure');
    expect((await store.getById(symbolId))?.signature).toBe(beforeNode?.signature);
    await advances(() => store.delete(symbolId));
  });
  it('advances research evidence epochs and does not reinforce foreign-tenant semantics', async () => {
    const experiments = new ExperimentStore(driver);
    const domain = `${prefix}-domain`;
    const component = `/${prefix}/research-component.ts`;
    const now = new Date().toISOString();
    for (let i = 0; i < 2; i++) {
      const id = `${prefix}-experiment-${i}`;
      await advances(() => experiments.create({ id, session_id: prefix, agent_id: prefix, campaign_id: from,
        experiment_number: i, branch: 'synthetic', parent_id: null, commit_hash: null, metric_name: 'score',
        metric_value: 1, secondary_metrics: { synthetic: 1 }, status: 'keep', duration_s: 1, hypothesis: 'synthetic',
        description: 'synthetic', insight: 'synthetic', components_touched: [component], created_at: now }));
      await advances(() => experiments.linkToComponent(id, component, domain, 'approved'));
    }
    const session = driver.session();
    try {
      await session.run(`UNWIND ['default', 'foreign'] AS tenant
        CREATE (:Semantic {id: $prefix + '-principle-' + tenant, tenant_id: tenant,
          content: 'synthetic principle', confidence: 0.5, signal_count: 0,
          valid_at: $now, tags: ['research', $domain]})`, { prefix, domain, now });
    } finally { await session.close(); }
    await advances(() => new ResearchConsolidation(driver).run(from));
    const check = driver.session();
    try {
      const result = await check.run('MATCH (s:Semantic) WHERE s.id IN $ids RETURN s.tenant_id AS tenant, s.confidence AS confidence',
        { ids: [`${prefix}-principle-default`, `${prefix}-principle-foreign`] });
      const values = new Map(result.records.map((record) => [record.get('tenant'), record.get('confidence')]));
      expect(values.get('default')).toBeCloseTo(0.6);
      expect(values.get('foreign')).toBe(0.5);
    } finally { await check.close(); }
  });

});
