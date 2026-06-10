---
id: 0bVuTg_qS79f0G_SYgwEY
session_id: session-20260609-fence-cadence
agent_id: default
task: Chesterton's fence audit: timer-based extraction cadence vs event-driven per-utterance triggers
outcome: approved
created_at: "2026-06-09T19:46:59.498Z"
---

Fence analysis of StreamingCadenceTimer (4s initial / 3s interval, version-gated). Findings: (1) clean-room/IMPROVEMENTS.md item 12 already ACCEPTED event-driven extraction on turn/utterance boundaries (H-M-med) — the rebuild recommendation matches the repo's own triage. (2) Documented TPM rate-limit incident (docs/cost-analysis-and-benchmarks.md:160-167, 132K tokens/min at 16 calls/min) is the strongest cost rationale for cadence-gating; shared CIC OpenAI account amplifies it. (3) Hidden couplings: consume_rerun_request is dead code in prod — the next timer tick is the only retry after a coalesced run; Stage-2 lock-streak=3 counts runs not wall-clock (was retuned 4->3 when interval went 15s->8s in b63ee21); notes 12s throttle and SOP-feed 4s debounce are both driven by the same cadence tick fan-out; instant latency was already solved by the per-segment fast-match lane, so event-driven LLM triggering buys less latency than it appears. (4) Cadence value history: chunk-based ~42s -> 15s timer (74ef33a) -> 8s (b63ee21) -> 4s/3s (1b77222 'Live transcript -> form responsiveness tuning'). Verdict: supersede-premise-changed, with must-preserve list (call-rate ceiling, multi-turn batching window, cross-channel coalescing, trailing-edge retrigger, fire_final drain flush, re-driving notes/SOP feed, 12k window, lock-streak retune).