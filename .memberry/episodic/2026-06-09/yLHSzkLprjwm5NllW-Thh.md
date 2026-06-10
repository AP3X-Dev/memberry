---
id: yLHSzkLprjwm5NllW-Thh
session_id: session-20260609-rebuild-assessment
agent_id: default
task: [project:amp] Rebuild discussion — user raised open-source self-hosting constraint (can't assume a dedicated server)
created_at: "2026-06-09T18:40:37.382Z"
---

[project:amp] User constraint stated: MemBerry is open source — the architecture can't assume a Cerebro-style dedicated server or mandatory Docker; single-machine self-hosters must be first-class. Proposed resolution: keep one topology (clients → API boundary → server), but make it local-first with deployment profiles. Default profile = embedded local mode: one process à la Ollama, serving on localhost, SQLite(+FTS+vec) storage, no Docker, no Neo4j/Redis required — `npx memberry up` level onboarding. Server profile = same binary bound to the network with token auth and optional Postgres/Neo4j via a storage interface; Docker compose offered but never required. Agents always talk to a URL and never know which profile they're on; localhost is just the degenerate case of remote. Provide `memberry migrate --to <url>` to graduate from laptop-local to a central server later. This makes the earlier single-storage-engine (SQLite default) argument load-bearing for usability, not just ops simplicity.