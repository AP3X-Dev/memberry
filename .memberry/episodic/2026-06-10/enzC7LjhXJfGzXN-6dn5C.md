---
id: enzC7LjhXJfGzXN-6dn5C
session_id: session-20260610-ag3ntic-tachi-ui
agent_id: default
task: Consolidate duplicated console surfaces after the Tachi redesign
outcome: approved
created_at: "2026-06-10T16:09:19.633Z"
---

User correction (treat as a console design convention): no redundant duplication — one surface per job. "We don't need two places to chat with an agent." Applied at commit 1cf2f64 on morph/opt-hardening: chat lives ONLY at /chat (employee detail page lost its Chat tab, gained an "Open chat" deep link to /chat?e=<id>); employee detail is management-only (runtime events, launch/stop, artifacts) — its duplicate "Start a run" prompt box and "Recent runs" list were removed (chat is how an employee gets work; /tasks is the single run-history surface, detail links to it); the chat page's RUNS right rail was removed as a duplicate of /tasks (right rail returns when the Computer capability provides a real browser/files surface). EmployeeChat reduced to one full-page mode. Gold-spec step 10 repointed to /chat?e=<id>. Future console work must keep this single-surface-per-job rule.