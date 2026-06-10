---
id: Cx0SWT22hqMqih9begVjO
session_id: session-20260609-180000
agent_id: default
task: [project:skill-jar] Build loop-engineering skill and wire self-hosted loops into the repo
outcome: approved
created_at: "2026-06-09T18:22:51.858Z"
---

[project:skill-jar] Built the loop-engineering Agent Skill (spine SKILL.md + 6 references + 3 role-skill templates + idempotent scaffold-loop.py) and then dogfooded it: scaffolded two self-hosted loops into the skill-jar repo itself. Key decisions: (1) loop-engineering is the general meta-skill; building-optimization-loops stays untouched and is cross-referenced as a specialized loop the meta-skill can scaffold as an execution stage — they compose, not compete. (2) Canonical vocabulary: autonomy ladder uses 'Level 1-4' (Phase N reserved for the Layer-1 scaffolding process); triage-inbox entries use '### F-<id>' heading + High/Medium/Low priority + owner enum explorer|implementer|verifier|security-reviewer; driver prompts live at docs/prompts/<loop>-driver.md. (3) Recurring footgun caught twice: unquoted SKILL.md frontmatter descriptions containing ': ' break YAML parsing — always quote descriptions; the audit gate now checks this. (4) Repo loops: jar-audit (gate = python scripts/audit-jar.py: frontmatter/triggers/naming/links/compile/idempotency) and bug-pipeline (Hunter→Fixer→Validator over agent-state/BUG_TRACKER.md, fixer on sonnet, validator on opus for cross-brain checking). Both Level 2: commit locally, never push — human pushes. Commit convention: jar-audit(N): / bug-pipeline(N):. First cycles both closed clean. User preference confirmed: no AI attribution in commits; run audit checks then push directly for this repo.