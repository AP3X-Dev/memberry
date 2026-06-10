---
id: rjkHH0IGyGeYGJjbsk3vB
session_id: session-20260609-130500
agent_id: default
task: V2 rebuild — shadow journal slice + first real-extractor baseline run
outcome: approved
created_at: "2026-06-10T05:19:49.877Z"
---

Two more commits on v2-rebuild-spec (15 total). (1) 2ca1932 shadow journal: §5.1 write-behind journal behind journal_enabled=False (CIC_JOURNAL_ENABLED env; 30-day retention sweep per spec default) — per-call NDJSON calls/<sid>/journal.ndjson, envelope {v,seq,mono_ms,epoch,type,payload}, mpsc queue + single daemon writer with group-commit fsync ≤250ms, hardened at create, every failure degrades to warning. Producers wired: CallStarted, final Segments (interims never journaled), ExtractRun per applied tick + drain final sweep, DrainPhase started/completed brackets on phases 1/3/4, SubmitIntent (pre-POST, with rescue_path) + SubmitResult, SessionTerminal + handle close at eviction. Typed queue item (tuple|None sentinel) instead of type: ignore — the repo bans type: ignore in src/engine and mypy --strict can't type heterogeneous tuple unpacking from object. No replay/reducer (P2, gated on user confirmation to replace AssistStateStore). Activation of the journal = the §7.1 sign-off decision, deliberately not a code change.

(2) 5432cfd first REAL baseline: user provided keys (C:/Users/Guerr/Desktop/CIC Agent/.env, authorized for any use). Live replay over the synthetic seed, 3 samples: classification stable + correct (all 8 Stage-2 taxonomy classes at zero, 6/6 dimensions pass). HEADLINE MEASURED FINDING: uncached Stage 2 SOP match ≈ 22s p50 / 25s p90 on default gpt-5.5; stage1 ≈ 3.7s p50; stage3 probing ≈ 6.5s p50 — the FR-19 lock (6/18 stage-2 calls were cache hits even in a short replay) is provably what keeps the live hot path viable, confirming the spec's §3 fence verdict with data. Committed report: docs/phase0-baseline-report-2026-06-10.md with explicit caveats (corpus n=1, repo-default models — prod overlay may pin different ones, replay-shaped serial latency). Seed lesson → convention: synthetic corpus expected.customer must contain only verbatim-copyable facts (address/city/zip); paraphrasable free-text (equipment age) fails exact-match judging on wording not correctness — semantic judging is a flagged v2 judge improvement.

Environment gotcha worth remembering: sandboxed shell writes OUTSIDE the workspace (%APPDATA%/cic-assistant) are virtualized and vanish — eval tooling must target repo-local paths (eval_runs/ now gitignored; CIC_DATA_DIR pointed into the repo for runs).