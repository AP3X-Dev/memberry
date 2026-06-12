---
id: qn4yZwfZykB4Z5S71KG3-
session_id: session-20260611-093000
agent_id: default
task: Hardening loop cycle 6: Deepgram reconnect-buffer overflow telemetry (OPT-5)
outcome: approved
created_at: "2026-06-11T11:37:34.767Z"
---

Cycle 6 (3c64899): DeepgramStreamClient now counts frames the bounded reconnect deque evicts during an outage — one warning at the first eviction of a burst (flag carried outside the lock; logging never under the client lock), and the post-reconnect flush emits an "outage dropped N buffered frame(s)... transcript may have a gap" summary, resetting the counter per burst. send_audio's two buffer branches (not-connected / conn-None) were merged into one condition — verifier confirmed logically identical, with anchor-ms assignment still exclusively on the connected path (anchor feeds transcript session-time mapping; regression there would corrupt timestamps). Accepted gap: a stream that dies without ever reconnecting never emits the flush summary (initial overflow warning still fires). Test-craft lesson reinforced: caplog filters must be message-specific — a pre-existing "DeepGram cost dropped: no cost_tracker wired" warning collides with any generic "dropped" filter in these fixtures.