// One-off backfill: compute embeddings for Semantic nodes that have none, so
// the previously-empty semantic_embedding vector index becomes populated and
// semantic vector recall works. Uses the same model as the app
// (text-embedding-3-small, 1536-dim). Idempotent: only touches null-embedding
// nodes. Run from the repo root (needs node_modules: openai, neo4j-driver).
import { readFileSync } from 'node:fs';
import neo4j from 'neo4j-driver';
import OpenAI from 'openai';

// Config precedence: process.env (works in-container) first, then a local .env
// (works for host runs). .env is optional — absent in the container.
const env = {};
try {
  // Split on /\r?\n/, not '\n'. JS `.` never matches \r and `$` (without /m) only
  // matches end-of-input, so on a CRLF .env this regex fails to match ANY line and
  // every var comes back undefined. That reads as a missing .env, not a mangled
  // one — you get "No OPENAI_API_KEY" while the key sits right there in the file.
  for (const line of readFileSync('.env', 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
    if (m) env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
  }
} catch { /* no .env — rely on process.env */ }

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || env.OPENAI_API_KEY;
const NEO4J_PASSWORD = process.env.NEO4J_PASSWORD || env.NEO4J_PASSWORD;
const NEO4J_USER = process.env.NEO4J_USER || env.NEO4J_USER || 'neo4j';
const NEO4J_URI = process.env.NEO4J_URI || env.NEO4J_URI || 'bolt://localhost:7687';
if (!OPENAI_API_KEY) { console.error('No OPENAI_API_KEY'); process.exit(1); }

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });
const driver = neo4j.driver(NEO4J_URI, neo4j.auth.basic(NEO4J_USER, NEO4J_PASSWORD));

async function embed(text) {
  let lastErr;
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      const r = await openai.embeddings.create({ model: 'text-embedding-3-small', input: text });
      return r.data[0].embedding;
    } catch (err) {
      lastErr = err;
      console.error(`    embed attempt ${attempt} failed: ${err?.message ?? err}`);
      await new Promise((res) => setTimeout(res, 1000 * attempt));
    }
  }
  throw lastErr;
}

const session = driver.session();
try {
  const res = await session.run(
    `MATCH (s:Semantic) WHERE s.embedding IS NULL AND s.content IS NOT NULL
     RETURN s.id AS id, s.content AS content`,
  );
  console.log(`Semantics needing embeddings: ${res.records.length}`);
  let done = 0;
  for (const rec of res.records) {
    const id = rec.get('id');
    const content = rec.get('content');
    if (!content) continue;
    const vec = await embed(content);
    await session.run('MATCH (s:Semantic {id: $id}) SET s.embedding = $vec', { id, vec });
    done++;
    console.log(`  [${done}/${res.records.length}] ${id} (${vec.length}-dim)`);
  }
  console.log(`Backfilled ${done} semantic embeddings.`);
} finally {
  await session.close();
  await driver.close();
}
