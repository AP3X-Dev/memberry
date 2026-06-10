---
id: AxIlc9PmV-rPmcNPKx1Tl
session_id: session-20260609-120000
agent_id: default
task: Produce crash-only rebuild proposal for CIC Assistant (principal-engineer subagent)
outcome: approved
created_at: "2026-06-09T19:04:25.584Z"
---

Drafted full crash-only rebuild proposal: kill the Python sidecar (single TS runtime — Electron main as supervisor, engine as Node utilityProcess on one event loop, hidden AudioWorklet capture window), replace all locks/registries with a single-writer reducer over an append-only per-call NDJSON journal that is simultaneously the rescue file, audit log, cost log, and replay/eval fixture. Push snapshot+delta over MessagePort replaces 1s polling; heartbeats + journal replay give <3s MTTR on engine death (fixes frozen-UI failure). Idempotent submission via journaled submissionId minted at call start. Accuracy plan: constrained-decoding SOP citations (enum of real source_paths), journal replay eval with AgentEdit events as free ground-truth labels, pinned-head transcript window. Keeps: dual-stream Deepgram design + reconnect buffer, LOCK_STREAK, prompt caching, evidence-only must-book grounding, per-section SOP rescue, confirmed-by-agent guards, DPAPI/secrets discipline. Returned via StructuredOutput to orchestrator.