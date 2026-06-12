---
id: ElKNtaGDd8yiDtgZJW6Sz
session_id: session-20260611-ag3ntic-morph
agent_id: default
task: Clarify status of the 'browser' (ag3ntic-browser) capability vs 'computer' for default browser use
created_at: "2026-06-12T01:27:05.802Z"
---

User wants "ag3ntic-browser" to be the DEFAULT browser-use capability for employees. Investigation of the live Cerebro deploy shows a mismatch with reality:

- The `browser` capability (slug=browser, name "Web Browser", type=browser_worker, cap_ad1756a7757ad6d9af494cf8) is a SEEDED MANIFEST STUB. It is NOT functional: no shared-browser worker is running (nothing on :9300, no browser/playwright/chromium container), and `browser_worker` is NOT in sidecars.CONTAINER_BACKED_TYPES = {mcp_custom_container, computer}. ensure_capability_sidecar() returns None for browser_worker, so attaching `browser` provisions no backing and wires no tools. Its manifest advertises browse_url/extract_content/search_web/download_file but nothing serves them.
- The ACTUALLY-WORKING browser-capable capability is `computer` (slug=computer, name "Computer", type=computer, cap_15b82f0a5e5184a9f37a97f8), container-backed by the running mcp-demo-computer image (ag3ntic/computer-capability). PLAN.md WQ-16 (2026-06-10) live-verified it: open_url/screenshot/read_text, 11 tools discovered. This is what lets an employee open Google today.
- There is NO global "default capabilities"/auto-attach mechanism; the Operator LLM selects capabilities per-employee via its list_capabilities tool (operator/tools.py), which returns the whole catalog including the non-functional `browser` (status=available) — so the Operator can pick a capability that does nothing.

Decision pending from user: (A) make the working `computer` capability the default browser, (B) build the real browser_worker backing (image + sidecar provisioning + shim wiring + tests) then make it default, or (C) alias the `browser` slug onto the computer backing. No change made yet.