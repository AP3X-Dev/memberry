---
id: vqbIJ4vwvsbM8TzTaIwBy
session_id: session-20260609-130500
agent_id: default
task: V2 rebuild — WS push transport (engine side) + out-of-band liveness probe
outcome: approved
created_at: "2026-06-10T05:40:38.146Z"
---

Two more Phase 1 slices on v2-rebuild-spec (17 commits total). (1) 2cc51f1 WS push §5.2 engine-side: /ws on the control-plane port, subscribe{session_id,last_seq,epoch} → snapshot unless client already current on this engine epoch → deltas on AssistState version change via 200ms internal watcher (P2's commit bus later replaces the watcher with true committed-delta push on the SAME wire protocol) + 1s heartbeats {engine_health}. Key design choices: state payload is byte-identical to the flattened GET /sessions/{id}/assist response (ADR 0001 — future renderer adapter passes it to handleAssistUpdate unchanged); Engine.boot_epoch (uuid per process) so seq numbers never compare across respawns. Hard-won asyncio lesson: in a FastAPI websocket endpoint with background tasks, never await in the finally after cancellation (re-raises and strands siblings), re-raise CancelledError (suppressing it leaked the cancellation into UNRELATED TestClient connections — manifested as a different test failing), and treat send-after-close RuntimeError as normal lifecycle, not an error. Strictly additive: all five poll chains untouched; polling retirement stays gated.

(2) 623649e liveness probe §5.3: LiveProbeServer serving GET /health/live from a plain daemon thread (never the asyncio loop) so the supervisor can distinguish process-dead (both endpoints silent) from event-loop-hung (/health silent, /health/live answering). Windows gotcha: http.server's allow_reuse_address=True lets a second engine SILENTLY double-bind the port via SO_REUSEADDR — subclassed with allow_reuse_address=False so conflicts are loud and degrade honestly (bind failure = warning, boot never blocks, I-31). Disabled by default (live_probe_port=0 keeps tests port-clean); Electron spawn env opts production in (CIC_LIVE_PROBE_PORT=8743, dev override wins). The kill decision on top (grace windows, drain-aware I-29 thresholds) deliberately not built — gated on CIC Harness validation.