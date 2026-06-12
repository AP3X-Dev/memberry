---
id: xmKot0QZADGAOur9vsIo-
session_id: session-20260611-audit-quality
agent_id: default
task: Code quality robustness audit of AG3NTIC platform (Desktop checkout)
created_at: "2026-06-11T19:32:42.967Z"
---

Code-quality audit of C:\Users\Guerr\Desktop\AG3NTIC (pristine checkout, NOT the active Documents\platform repo). Codebase is exceptionally clean: ruff default config (E,W,F only) reports just 2 F401. Zero TODO/FIXME/HACK markers in source, zero mutable default args, zero TS `any`, TS strict:true, no bare excepts. 

TOP CONFIRMED CORRECTNESS BUG: apps/api/platform_core/tool_capsules/runtime.py:73-76 — `volumes = {spec.workspace_dir: {...} for mount in manifest.required_mounts}` keys every mount on the SAME host path spec.workspace_dir (B035 static-key dict comprehension). required_mounts allows max_length=50 (manifest.py:177). Docker volumes dict is keyed by host path so 2+ mounts collapse to last-wins; other container targets never get mounted, yet artifact resolution (agent_tasks/router.py:1611-1618) expects every target to exist as a subdir of workspace. Real bug for multi-mount capsules.

OBSERVABILITY GAPS (med/low): limits.py:331 except Exception swallows Redis errors with no log (fail-closed for backend=redis is correct, but a Redis outage is invisible); files/router.py:378 silently orphans storage object on delete.

LOW: mcp-server/tools/computers.py:82 int(args.get('timeout_seconds')...) crashes ValueError on non-numeric MCP arg (untyped args); incus_provider.py:74 json.loads(out) unguarded (trusted CLI, minor).

FALSE POSITIVES verified: service.py:610 metadata_json nested index is safe (locally constructed via _agent_runner_metadata which always returns script_sha256); manifest.py:66-71 os.environ[...] is inside a triple-quoted script string that runs INSIDE the capsule container; all S105 hardcoded-password hits are ID/marker prefixes (rt_, ck_, sec); ASYNC109 is style not bug; RUF012 chat/adapters.py are constant schema dicts. 2 F401 real: mcp-server tools/context.py:4 and vault.py:4 (unused `from .. import results`).