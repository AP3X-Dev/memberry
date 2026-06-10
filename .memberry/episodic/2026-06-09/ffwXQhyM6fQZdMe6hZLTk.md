---
id: ffwXQhyM6fQZdMe6hZLTk
session_id: session-20260609-research-scheduling
agent_id: default
task: Research AI agent scheduling primitives: Codex, Hermes, OpenClaw, Cursor, Devin, GitHub Copilot, AutoGPT, OpenHands
created_at: "2026-06-09T21:07:38.225Z"
---

Completed authoritative research on AI agent scheduling primitives. Key findings: (1) OpenAI Codex App has standalone automations (cold, local machine required) and thread automations (warm/conversational). CLI has codex exec for headless but NO built-in scheduler. (2) Hermes Agent (NousResearch) has full built-in cron with cron syntax, natural language, and intervals. COLD sessions by default. Self-hosted via gateway daemon. Official docs at hermes-agent.nousresearch.com. (3) OpenClaw is Peter Steinberger's open-source self-hosted gateway with 68k GitHub stars. Full cron primitive with isolated/main/current/custom session modes. Cold by default for isolated mode. (4) Cursor Automations: cloud-based, cron + event triggers, agents in isolated Ubuntu sandboxes. (5) Devin: natural language scheduling (no cron syntax), WARM context between runs (reads/writes notes across sessions). Cloud. March 2026. (6) GitHub Copilot cloud agent: hourly/daily/weekly UI picker (no cron syntax), cloud, private/internal repos only as of June 2026. (7) AutoGPT Platform: UI-based scheduler (weekday/time picker), cloud via backend.agpt.co, cold/persistence not documented. (8) OpenHands: scheduling still RFC/Draft as of March 2026 — not shipped. Aider: no built-in scheduler confirmed.