---
id: Di4w8j83aOjEmyYfKoHEH
session_id: session-20260609-rebuild-assessment
agent_id: default
task: [project:amp] Rebuild paused after Phase 1 — handoff state
outcome: approved
created_at: "2026-06-09T22:48:01.449Z"
---

[project:amp] Rebuild work paused by user after Phases 0+1 completed and verified (full suite green, quality gates unchanged, bleed repro 5/5). All changes are UNCOMMITTED on master. Roadmap (docs/rebuild-roadmap.md) updated with DONE markers for Phases 0-1; per-phase detail in docs/rebuild-progress.md. Next up when resumed: Phase 2 (automatic capture for Claude Code) — design groundwork already done: reuse defaultReadTranscriptPrompts/extractText in packages/core/src/cli/adapters/claude.ts as the parser seed, build collector as `memberry capture scan/watch/status` CLI commands + systemd timer (pattern: deploy/systemd/memberry-dream.*), construct services via createCoreServices (services-factory.ts), extraction model via config.models (MEMBERRY_MODEL_* envs), stamp episodes with capture_tier/machine/source_agent (needs EpisodeInput + EpisodicStore.create additions), dedup against Tier-C stores by detecting berry_store tool calls inside the transcript. Reminder: migrations 0005-injection-log + 0006-structural-scope apply at next MCP server bootstrap; the running Cerebro MCP service still serves unscoped loads until restarted.