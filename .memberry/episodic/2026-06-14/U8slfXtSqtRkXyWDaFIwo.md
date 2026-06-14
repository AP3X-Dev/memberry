---
id: U8slfXtSqtRkXyWDaFIwo
session_id: session-20260613-ag3ntic-morph
agent_id: default
task: [project:ag3ntic] Convention: where Alembic migrations must live + how to verify them.
outcome: approved
created_at: "2026-06-14T04:39:17.858Z"
---

CONVENTION (cost a verifier REJECT to learn): Alembic migrations for the AG3NTIC platform MUST be created in apps/api/alembic/versions/ — NOT apps/api/platform_core/alembic/versions/. The live config apps/api/alembic.ini sets script_location = %(here)s/alembic, so apps/api/alembic/versions/ is the ONLY directory alembic scans; a migration placed anywhere else is silently orphaned and `alembic upgrade head` skips it (the prod schema never changes, then the app crashes on the missing columns). This is INVISIBLE to the test suite, ruff, and the cleanliness gate because tests build the schema via SQLAlchemy create_all, not migrations — so a misplaced migration passes every runnable gate and only fails in production (or is caught by an adversarial maker≠checker verifier read). After writing any migration, VERIFY it is discoverable: `cd apps/api && python -m alembic heads` must show your new revision as the single head, and `python -m alembic history` must show a clean linear chain with no gaps. The current chain ends at 20260612_1101 → 20260613_2301 → 2401 → 2501 → 2601 (head as of WQ-B). New migrations chain off the on-disk head (re-confirm at merge time).