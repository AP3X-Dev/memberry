---
id: jpiJNrHVKwgC7JjP1sorp
session_id: session-20260609-rebuild-assessment
agent_id: default
task: [project:amp] User approved the first-principles rebuild direction; wrote the rebuild roadmap
outcome: approved
created_at: "2026-06-09T18:45:47.138Z"
---

[project:amp] Decision: user approved the 10x rebuild plan ("memory that works when ignored") and asked for a roadmap, kept out of GitHub. Created docs/rebuild-roadmap.md (docs/ is already blanket-gitignored as internal planning). Roadmap structure: north-star metric = fraction of sessions where injected memory changed the outcome; 8 phases ordered by leverage — P0 baseline+bleed repro test, P1 structural tenancy (scope as enforced storage column, EntityResolver scope-aware), P2 automatic Claude Code transcript capture via collector + offline strong-model extraction, P3 injection telemetry + observed outcome loop replacing voluntary berry_feedback, P4 precision retrieval (~800-token budget, empty-result-respectable, verbatim episodes immutable + derived structure versioned/regenerable via rederive job), P5 service split + local-first profiles (storage interface, SQLite+FTS5+sqlite-vec default backend, graph-as-view, embedded vs server profile of one binary, memberry connect/migrate/doctor, Neo4j data migration), P6 tool surface shrink to ~5 core tools with wiki/research/code/arch/graph as plugins + berry_* compat layer, P7 continuous consolidation gated by outcome metrics. Keeps: eval harness, hooks infra, EntityResolver semantics, hardening-sprint security features, wiki as flagship plugin. Non-goal: no from-scratch repo — staged re-architecture in place, shippable after every phase. Phases 1-4 run on the current Neo4j codebase before the P5 storage split.