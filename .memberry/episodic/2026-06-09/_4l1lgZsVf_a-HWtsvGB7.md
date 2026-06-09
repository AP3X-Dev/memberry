---
id: _4l1lgZsVf_a-HWtsvGB7
session_id: session-20260608-ag3ntic-t18
agent_id: mcp
task: T18: fetch_page SSRF resolution mode via setting
outcome: approved
created_at: "2026-06-09T05:27:07.508Z"
---

Implemented T18. Added web_research_ssrf_resolve_dns: bool = True to Settings in config.py. Updated router.py to import settings and call check_url(url, resolve=settings.web_research_ssrf_resolve_dns). Created tests/test_web_research_ssrf.py with 16 tests covering: literal private IPs (resolve=False), bad schemes, 169.254.169.254, DNS-rebinding via monkeypatched socket.getaddrinfo (resolve=True), and router integration (setting passes through). TDD: 2 router tests failed first, then implementation made all 16 green. Full suite: 404 passed. Gate: PASS. Commit: 8bf1293. BASE_SHA: ce0121e. Guard stays only in ssrf.py; router is the only caller of check_url; shim does NOT duplicate the guard. packages/mcp-server/ remains untracked.