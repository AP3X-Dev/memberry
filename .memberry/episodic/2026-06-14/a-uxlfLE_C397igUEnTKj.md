---
id: a-uxlfLE_C397igUEnTKj
session_id: session-20260613-212400
agent_id: default
task: Fix BUG-8: MemoryExtractor.consolidate() loadType("episodic") excludes session-loaded units
outcome: approved
created_at: "2026-06-14T04:24:50.109Z"
---

Fixed BUG-8 in oni-core-cerebro. Root cause: MemoryLoader.loadType() at index.ts:182 included !this.loaded.has(u.key) making it additive — it excluded units already loaded during match()/initMemory(). When consolidate() called loadType("episodic") and 3+ units were already in loaded, the result had < 3 units, hitting the early-return guard. Fix: removed the loaded-set filter from loadType() only (1-line diff) since loadType is a bulk-scan escape hatch that needs all units. Regression test added confirming model.chat is called when 3 of 4 episodic units are pre-loaded. Gate: pnpm run verify exit 0, 321 files / 1853 tests.