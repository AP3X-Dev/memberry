---
id: 0nx42Rau0jqwOe4XaTmqL
session_id: session-20260613-opt06
agent_id: default
task: OPT-06 interim ReDoS mitigation for berry_grep (no-dep)
outcome: approved
created_at: "2026-06-14T06:36:55.394Z"
---

Implemented OPT-06 interim no-dep ReDoS mitigation for berry_grep in packages/mcp. Added packages/mcp/src/safe-regex.ts exporting assertSafeRegex(pattern) (static conservative ReDoS screen: rejects nested quantifiers like (a+)+, quantified alternations like (a|aa)+, and bounded repetitions >1000 like a{2000}), capScanText(text, max=50000), and UnsafeRegexError. Wired one chokepoint in tools.ts berry_grep: assertSafeRegex runs immediately before new RegExp(pattern) in the isRegex validation block, surfaced via the existing **Error:** textContent channel (no crash). Capped all 5 JS-side .test()/.exec() sites at 50_000 chars via capScanText: extractSnippet, episodic content, fact subject, block name, entity name. Pattern length already capped at 500 by AmpGrepSchema (kept). Added 5 RED vitest tests asserting rejection of (a+)+$, (a|aa)+$, a{2000} (each asserts rawCypher NOT called = short-circuit before exec), plus benign-pass test (foo.*bar, \bword\b, JWT|OAuth2, a{1,10}) and a regex=false bypass test. Robust linear-time fix (re2 dependency) deferred to a Blocked item — re2 needs human approval. Known gaps: heuristic misses polynomial single-quantifier ReDoS like a*a*...$ chains, lookaround-driven backtracking, and unbalanced-paren patterns (those fall back to the 50k input cap only).