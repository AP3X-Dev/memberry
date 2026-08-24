// bench/lab/lifecycle-noise.ts
//
// MEM-006 G3 noise-load bench: seed a deterministic lab corpus in one scope,
// run `memberry lifecycle` against it, then measure. Registered thresholds
// (docs/agent-runs/specs/2026-08-25-mem006-lifecycle.md §5, budget=200,
// maxAge=180d, multiplier=2):
//   - total sidecar rows reduced by >= 50%
//   - active (non-archived) memory-node count reduced by >= 10%
//   - >= 5 review-gated decay proposals emitted
//   - ZERO protected-node mutation (P1-P5 seeds intact, protected sidecars intact)
//   - 100% of archived/deleted rows present in the export artifact
//
// Usage (cerebro test clone):
//   npx tsx bench/lab/lifecycle-noise.ts --seed
//   MEMBERRY_LIFECYCLE_V1=live MEMBERRY_LIFECYCLE_SIDECAR_BUDGET=200 \
//     npx tsx packages/core/src/cli.ts lifecycle --scope project:lifecycle-lab
//   npx tsx bench/lab/lifecycle-noise.ts --measure
//
// The measure step also records the R3 datapoint: wall-time of one
// byScope-shaped semantic query against the seeded scope (the seed step prints
// the same timing pre-predicate for comparison).

import fs from 'node:fs';
import path from 'node:path';
import neo4j, { type Driver } from 'neo4j-driver';

const SCOPE = 'project:lifecycle-lab';
const TENANT = 'default';
const DAY_MS = 86_400_000;

const SIDECARS_PER_LABEL = 500;
const PROTECTED_SIDECARS_PER_LABEL = 25;
const EPISODIC_TOTAL = 200;
const SEMANTIC_TOTAL = 50;

function iso(daysAgo: number): string {
  return new Date(Date.now() - daysAgo * DAY_MS).toISOString();
}

function driverFromEnv(): Driver {
  const uri = process.env['NEO4J_URI']?.trim() || 'bolt://localhost:7687';
  const user = process.env['NEO4J_USER']?.trim() || 'neo4j';
  const password = process.env['NEO4J_PASSWORD'] ?? '';
  return neo4j.driver(uri, neo4j.auth.basic(user, password));
}

async function run(driver: Driver, cypher: string, params: Record<string, unknown> = {}) {
  const session = driver.session();
  try {
    return await session.run(cypher, params);
  } finally {
    await session.close();
  }
}

async function wipe(driver: Driver): Promise<void> {
  await run(driver, `MATCH (n) WHERE n.id STARTS WITH 'lab-lifecycle-' CALL { WITH n DETACH DELETE n } IN TRANSACTIONS OF 1000 ROWS`);
}

// ─── Seed ────────────────────────────────────────────────────────────────────

async function seed(driver: Driver): Promise<void> {
  await wipe(driver);

  // Sidecar rows: 500 per label, observed_at spread over 365 days, 25/label
  // protected-tier (older than everything — only the tier saves them).
  for (const label of ['AdmissionObservation', 'AdmissionRoutingRecommendation'] as const) {
    const rows: Array<Record<string, unknown>> = [];
    for (let n = 0; n < SIDECARS_PER_LABEL; n++) {
      const isProtected = n < PROTECTED_SIDECARS_PER_LABEL;
      rows.push({
        id: `lab-lifecycle-${label === 'AdmissionObservation' ? 'obs' : 'rec'}-${n}`,
        tenant_id: TENANT,
        project_scope: SCOPE,
        recommended_tier: isProtected ? 'protected' : 'candidate',
        // Protected rows are the OLDEST; the rest spread evenly across 365d.
        observed_at: iso(isProtected ? 400 : Math.floor((n / SIDECARS_PER_LABEL) * 365)),
      });
    }
    await run(driver, `UNWIND $rows AS row CREATE (x:${label}) SET x = row`, { rows });
  }

  // Memory nodes. Protected subset (each of P1-P5, all aged > 180d so ONLY the
  // protection row keeps them active), an archivable slice of ~15% (aged >
  // 180d, unprotected, unreferenced), decay candidates (aged 100-170d), and
  // fresh filler.
  const episodes: Array<Record<string, unknown>> = [];
  const semantics: Array<Record<string, unknown>> = [];
  const ep = (id: string, daysAgo: number, extra: Record<string, unknown> = {}) => episodes.push({
    id: `lab-lifecycle-${id}`, session_id: 'lab', agent_id: 'lab', task: 'lifecycle lab seed',
    content: `lab episode ${id}`, created_at: iso(daysAgo), scope: SCOPE, tags: [SCOPE],
    tenant_id: TENANT, outcome: null, memory_type: null, ttl: null, ...extra,
  });
  const sem = (id: string, daysAgo: number, extra: Record<string, unknown> = {}) => semantics.push({
    id: `lab-lifecycle-${id}`, content: `lab semantic ${id}`, confidence: 0.8, signal_count: 1,
    created_at: iso(daysAgo + 10), updated_at: iso(daysAgo), decay_class: 'stable',
    tags: [SCOPE], scope: SCOPE, tenant_id: TENANT, memory_type: null, ...extra,
  });

  // Protected seeds (ids carry 'prot' for the integrity check).
  ep('prot-p1-ep-decision', 300, { memory_type: 'decision', outcome: 'revised' });
  sem('prot-p1-sem-decision', 300, { memory_type: 'decision' });
  sem('prot-p2-sem-reinforced', 300); // REINFORCES edge added below
  ep('prot-p2-src-episode', 20); // fresh signal source, not itself protected-tagged
  sem('prot-p3-sem-permanent', 400, { decay_class: 'permanent' });
  ep('prot-p4-ep-approved', 300, { outcome: 'approved' });
  ep('prot-p5-ep-obs', 300); // linked protected AdmissionObservation below
  ep('prot-p5-ep-rec', 300); // linked protected AdmissionRoutingRecommendation below

  // Archivable slice: 32 episodes + 6 semantics aged > 360d (2x stable 90d x2
  // margin) = 38 of ~250 memory nodes (~15%).
  for (let n = 0; n < 32; n++) ep(`arch-ep-${n}`, 361 + n);
  for (let n = 0; n < 6; n++) sem(`arch-sem-${n}`, 361 + n);

  // Decay candidates: 12 stable semantics one-plus half-life old but under the
  // archive threshold (drop >= 0.05, not archivable).
  for (let n = 0; n < 12; n++) sem(`decay-sem-${n}`, 100 + n * 5);

  // Fresh filler up to 200 episodes / 50 semantics.
  for (let n = episodes.length; n < EPISODIC_TOTAL; n++) ep(`fresh-ep-${n}`, 1 + (n % 30));
  for (let n = semantics.length; n < SEMANTIC_TOTAL; n++) sem(`fresh-sem-${n}`, 1 + (n % 30));

  await run(driver, 'UNWIND $rows AS row CREATE (e:Episodic) SET e = row', { rows: episodes });
  await run(driver, 'UNWIND $rows AS row CREATE (s:Semantic) SET s = row', { rows: semantics });

  // P2: explicit reinforcement edge.
  await run(driver, `MATCH (e:Episodic {id: 'lab-lifecycle-prot-p2-src-episode'}), (s:Semantic {id: 'lab-lifecycle-prot-p2-sem-reinforced'})
     MERGE (e)-[:REINFORCES {valid_at: $now}]->(s)`, { now: new Date().toISOString() });
  // P5: protected-tier sidecar rows linked to their episodes.
  await run(driver, `MATCH (o:AdmissionObservation {id: 'lab-lifecycle-obs-0'}), (e:Episodic {id: 'lab-lifecycle-prot-p5-ep-obs'})
     MERGE (o)-[:OBSERVES]->(e)`);
  await run(driver, `MATCH (r:AdmissionRoutingRecommendation {id: 'lab-lifecycle-rec-0'}), (e:Episodic {id: 'lab-lifecycle-prot-p5-ep-rec'})
     MERGE (r)-[:RECOMMENDS_FOR]->(e)`);

  const counts = await collectCounts(driver);
  console.log(JSON.stringify({ phase: 'seed', scope: SCOPE, counts }, null, 2));
}

// ─── Measure ─────────────────────────────────────────────────────────────────

interface Counts {
  sidecar_total: number;
  sidecar_protected: number;
  memory_total: number;
  memory_active: number;
  memory_archived: number;
  protected_seed_archived: string[];
  decay_pending_hint: string;
  byscope_semantic_wall_ms: number;
}

async function collectCounts(driver: Driver): Promise<Counts> {
  const num = async (cypher: string): Promise<number> => {
    const res = await run(driver, cypher);
    const v = res.records[0]?.get('c');
    return typeof v === 'number' ? v : (v?.toNumber?.() ?? Number(v));
  };
  const sidecarTotal = await num(`MATCH (x) WHERE (x:AdmissionObservation OR x:AdmissionRoutingRecommendation) AND x.id STARTS WITH 'lab-lifecycle-' RETURN count(x) AS c`);
  const sidecarProtected = await num(`MATCH (x) WHERE (x:AdmissionObservation OR x:AdmissionRoutingRecommendation) AND x.id STARTS WITH 'lab-lifecycle-' AND x.recommended_tier = 'protected' RETURN count(x) AS c`);
  const memoryTotal = await num(`MATCH (m) WHERE (m:Episodic OR m:Semantic) AND m.id STARTS WITH 'lab-lifecycle-' RETURN count(m) AS c`);
  const memoryArchived = await num(`MATCH (m) WHERE (m:Episodic OR m:Semantic) AND m.id STARTS WITH 'lab-lifecycle-' AND m.archived = true RETURN count(m) AS c`);
  const protRes = await run(driver, `MATCH (m) WHERE (m:Episodic OR m:Semantic) AND m.id STARTS WITH 'lab-lifecycle-prot-' AND m.archived = true RETURN m.id AS id`);

  // R3 datapoint: byScope-shaped semantic read (query.ts byScope no-filter branch).
  const start = process.hrtime.bigint();
  await run(driver, `MATCH (s:Semantic)
     WHERE coalesce(s.tenant_id, 'default') = $tenantId AND (s.scope = $projectScope OR $projectScope IN s.tags)
       AND coalesce(s.archived, false) = false
     RETURN s { .*, embedding: null } AS s ORDER BY s.confidence DESC, s.updated_at DESC LIMIT 25`,
    { tenantId: TENANT, projectScope: SCOPE });
  const wallMs = Number(process.hrtime.bigint() - start) / 1e6;

  return {
    sidecar_total: sidecarTotal,
    sidecar_protected: sidecarProtected,
    memory_total: memoryTotal,
    memory_active: memoryTotal - memoryArchived,
    memory_archived: memoryArchived,
    protected_seed_archived: protRes.records.map((r) => r.get('id') as string),
    decay_pending_hint: 'count decay proposals via the run JSON / review queue (Redis-side)',
    byscope_semantic_wall_ms: Math.round(wallMs * 100) / 100,
  };
}

function newestArtifact(): { path: string; body: Record<string, unknown> } | null {
  const roots = ['./.memberry', './.amp'];
  for (const root of roots) {
    const dir = path.join(root, 'lifecycle');
    if (!fs.existsSync(dir)) continue;
    const files = fs.readdirSync(dir).filter((f) => f.includes('lifecycle-lab')).sort();
    const file = files[files.length - 1];
    if (!file) continue;
    const full = path.join(dir, file);
    return { path: full, body: JSON.parse(fs.readFileSync(full, 'utf8')) as Record<string, unknown> };
  }
  return null;
}

async function measure(driver: Driver): Promise<void> {
  const counts = await collectCounts(driver);
  const seedSidecarTotal = 2 * SIDECARS_PER_LABEL;
  const seedMemoryTotal = EPISODIC_TOTAL + SEMANTIC_TOTAL;

  // Artifact coverage: every archived/deleted id from the newest run artifact
  // must be reflected in the graph (archived flag set / sidecar row gone).
  const artifact = newestArtifact();
  let artifactCoverage: Record<string, unknown> = { found: false };
  if (artifact) {
    const body = artifact.body;
    const archive = body.archive as { episodic: Array<{ id: string }>; semantic: Array<{ id: string }> };
    const sidecars = body.sidecar_delete as { admission_observation: Array<{ id: string }>; admission_routing_recommendation: Array<{ id: string }> };
    const archivedIds = [...archive.episodic, ...archive.semantic].map((n) => n.id);
    const deletedIds = [...sidecars.admission_observation, ...sidecars.admission_routing_recommendation].map((n) => n.id);
    const archivedInGraph = await run(driver, `MATCH (m) WHERE m.id IN $ids AND m.archived = true RETURN count(m) AS c`, { ids: archivedIds });
    const deletedStillPresent = await run(driver, `MATCH (x) WHERE x.id IN $ids RETURN count(x) AS c`, { ids: deletedIds });
    artifactCoverage = {
      found: true,
      path: artifact.path,
      archived_rows_in_artifact: archivedIds.length,
      archived_rows_flagged_in_graph: Number(archivedInGraph.records[0].get('c')),
      deleted_rows_in_artifact: deletedIds.length,
      deleted_rows_still_present: Number(deletedStillPresent.records[0].get('c')),
      decay_proposals_in_artifact: (body.decay_proposals as unknown[]).length,
    };
  }

  const g3 = {
    sidecar_reduction_pct: Math.round((1 - counts.sidecar_total / seedSidecarTotal) * 1000) / 10,
    sidecar_reduction_pass: counts.sidecar_total <= seedSidecarTotal / 2,
    memory_active_reduction_pct: Math.round((1 - counts.memory_active / seedMemoryTotal) * 1000) / 10,
    memory_active_reduction_pass: counts.memory_active <= seedMemoryTotal * 0.9,
    decay_proposals_min5_pass: artifact ? (artifact.body.decay_proposals as unknown[]).length >= 5 : false,
    zero_protected_mutation_pass:
      counts.protected_seed_archived.length === 0
      && counts.sidecar_protected === 2 * PROTECTED_SIDECARS_PER_LABEL,
  };

  console.log(JSON.stringify({ phase: 'measure', scope: SCOPE, counts, artifact_coverage: artifactCoverage, g3 }, null, 2));
  const pass = g3.sidecar_reduction_pass && g3.memory_active_reduction_pass
    && g3.decay_proposals_min5_pass && g3.zero_protected_mutation_pass;
  if (!pass) process.exitCode = 1;
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const mode = process.argv.includes('--seed') ? 'seed'
    : process.argv.includes('--measure') ? 'measure'
    : process.argv.includes('--wipe') ? 'wipe' : null;
  if (!mode) {
    console.error('Usage: npx tsx bench/lab/lifecycle-noise.ts --seed | --measure | --wipe');
    process.exit(1);
  }
  const driver = driverFromEnv();
  try {
    if (mode === 'seed') await seed(driver);
    else if (mode === 'measure') await measure(driver);
    else await wipe(driver);
  } finally {
    await driver.close();
  }
}

main().catch((err: unknown) => {
  console.error('Fatal:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
