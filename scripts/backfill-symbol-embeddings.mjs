// IDX-003 backfill: dense-embed Symbol nodes that have none, so the
// symbol_embedding vector index becomes populated and the code.dense-vector
// channel actually returns results.
//
// WHY THIS EXISTS. CodeIndexer was constructed without an embedding provider,
// so `symbol.embedding` was never assigned and `mini_vector` (derived from it)
// never generated. Every Symbol ever indexed has both null. The channel queried
// an empty index, returned zero rows, and reported SUCCESS — so code search has
// been lexical-only with nothing in any log. scripts/backfill-embeddings.mjs is
// the same fix for Semantic nodes; this is its Symbol twin.
//
// Uses the same model as the app (text-embedding-3-small, 1536-dim).
// Idempotent and resumable: only touches null-embedding nodes, commits per
// batch, so an interrupted run picks up where it stopped.
//
// Usage (from the repo root, needs node_modules):
//   node scripts/backfill-symbol-embeddings.mjs [--project project:memberry] [--limit N] [--dry-run]
import { readFileSync } from 'node:fs';
import neo4j from 'neo4j-driver';
import OpenAI from 'openai';
import { generateMiniVector } from '../packages/code/dist/vectors.js';

const env = {};
try {
  for (const line of readFileSync('.env', 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
} catch { /* no .env — rely on process.env */ }

const argv = process.argv.slice(2);
const arg = (flag, fallback) => {
  const i = argv.indexOf(flag);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const PROJECT = arg('--project', null);
const LIMIT = Number(arg('--limit', '0')) || 0;
const DRY_RUN = argv.includes('--dry-run');
const BATCH = 256;

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || env.OPENAI_API_KEY;
const NEO4J_PASSWORD = process.env.NEO4J_PASSWORD || env.NEO4J_PASSWORD;
const NEO4J_USER = process.env.NEO4J_USER || env.NEO4J_USER || 'neo4j';
const NEO4J_URI = process.env.NEO4J_URI || env.NEO4J_URI || 'bolt://localhost:7687';
if (!OPENAI_API_KEY && !DRY_RUN) { console.error('No OPENAI_API_KEY'); process.exit(1); }

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });
const driver = neo4j.driver(NEO4J_URI, neo4j.auth.basic(NEO4J_USER, NEO4J_PASSWORD));

// Must match packages/code/src/indexer.ts symbolVectorText EXACTLY: a backfilled
// symbol and a freshly indexed one have to be embedded from the same text, or
// the two populations are not comparable and ranking drifts by provenance.
const vectorText = (r) => [r.get('name'), r.get('signature'), r.get('doc')].filter(Boolean).join(' ');

async function embedBatch(texts) {
  let lastErr;
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      const r = await openai.embeddings.create({ model: 'text-embedding-3-small', input: texts });
      return r.data.map((d) => d.embedding);
    } catch (err) {
      lastErr = err;
      console.error(`    batch attempt ${attempt} failed: ${err?.message ?? err}`);
      await new Promise((res) => setTimeout(res, 1000 * attempt));
    }
  }
  throw lastErr;
}

const scope = PROJECT ? 'AND s.project_tag = $project' : '';
const session = driver.session();
let done = 0, skipped = 0;
try {
  const countRes = await session.run(
    `MATCH (s:Symbol) WHERE s.embedding IS NULL ${scope} RETURN count(s) AS n`,
    { project: PROJECT },
  );
  const total = Number(countRes.records[0].get('n'));
  const target = LIMIT > 0 ? Math.min(LIMIT, total) : total;
  console.log(`Symbols needing embeddings: ${total}${PROJECT ? ` (scope ${PROJECT})` : ''}`);
  console.log(`Backfilling: ${target}${DRY_RUN ? ' (DRY RUN — no writes, no API calls)' : ''}`);

  while (done + skipped < target) {
    const res = await session.run(
      `MATCH (s:Symbol) WHERE s.embedding IS NULL ${scope}
       RETURN s.id AS id, s.name AS name, s.signature AS signature, s.doc_comment AS doc
       LIMIT $batch`,
      { project: PROJECT, batch: neo4j.int(Math.min(BATCH, target - done - skipped)) },
    );
    if (res.records.length === 0) break;

    const rows = res.records.map((r) => ({ id: r.get('id'), text: vectorText(r) }));
    const usable = rows.filter((r) => r.text.trim().length > 0);
    skipped += rows.length - usable.length;
    if (usable.length === 0) break;

    if (DRY_RUN) {
      done += usable.length;
      console.log(`  [${done}/${target}] would embed ${usable.length} (e.g. ${JSON.stringify(usable[0].text.slice(0, 60))})`);
      continue;
    }

    const vectors = await embedBatch(usable.map((r) => r.text));
    const updates = usable.map((r, i) => ({
      id: r.id, vec: vectors[i], mini: Array.from(generateMiniVector(vectors[i])),
    }));
    await session.run(
      `UNWIND $updates AS u
       MATCH (s:Symbol {id: u.id})
       SET s.embedding = u.vec, s.mini_vector = u.mini`,
      { updates },
    );
    done += updates.length;
    console.log(`  [${done}/${target}] embedded ${updates.length} (${vectors[0].length}-dim)`);
  }

  const verify = await session.run(
    `MATCH (s:Symbol) ${PROJECT ? 'WHERE s.project_tag = $project' : ''}
     RETURN count(s) AS total,
            sum(CASE WHEN s.embedding IS NOT NULL THEN 1 ELSE 0 END) AS embedded,
            sum(CASE WHEN s.mini_vector IS NOT NULL THEN 1 ELSE 0 END) AS mini`,
    { project: PROJECT },
  );
  const v = verify.records[0];
  console.log(`\nDone. embedded=${done} skipped_empty_text=${skipped}`);
  console.log(`Verify: ${v.get('embedded')}/${v.get('total')} symbols have an embedding, ${v.get('mini')} have a mini_vector.`);
} finally {
  await session.close();
  await driver.close();
}
