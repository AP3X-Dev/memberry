---
id: QLO8PDud-v4vP0LA7kMMK
session_id: session-20260609-rebuild-assessment
agent_id: default
task: [project:amp] User asked: how would you rebuild MemBerry from first principles to be 10x more effective
outcome: approved
created_at: "2026-06-09T18:30:21.842Z"
---

[project:amp] Gave a first-principles rebuild assessment. Key diagnosis: effectiveness is capped by (1) compliance-dependence — capture and recall rely on the agent voluntarily following a ~5k-token CLAUDE.md manual instead of harness-driven automation; (2) retrieval precision — a tag-scoped project:amp load returned mostly fugazi/mars-fps memories at ~0.001 scores, showing cross-project bleed and weak ranking; (3) noisy write-time extraction — auto-extracted SPO triples like 'core has 507' and 'amp blocks amp CLI bin' are lossy garbage stored at 0.5 confidence; (4) tool-surface bloat — 49 tools/9 domains taxes every session; (5) infra weight — Neo4j+Redis for a single-user system forces tsx runtime hack and BigInt gotchas. Proposed rebuild principles: automatic transcript ingestion (offline, good model) instead of in-loop berry_store; hook-injected small high-precision context (~800 tokens); ~5-tool surface; verbatim episodes as ground truth with structure as derived disposable index; structural tenancy not advisory tags; outcome-based learning loop (was injected memory actually used) as the north-star metric; single storage engine (SQLite+FTS+vectors or Postgres+pgvector) with graph as a view. No decision made — advisory only.