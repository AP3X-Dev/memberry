#!/bin/sh
# Full local gate in a pinned Node container.
#
#   ./scripts/gate.sh 20 /path/to/worktree
#   ./scripts/gate.sh 22 /path/to/worktree
#
# Runs install, the workspace suite, the evaluation lab, and the build, writing one log per stage
# into the worktree and echoing an *_EXIT line into each.
#
# ---------------------------------------------------------------------------
# WHY --user, AND WHY npm ci RUNS UNDER IT TOO
#
# Running this as the container's default root against a host-owned worktree produced THIRTEEN of
# the fourteen lab failures that looked like product defects for three consecutive gates. Those
# thirteen were not defects: they were `fatal: detected dubious ownership in repository at '/w'`
# — git refuses a repo owned by a different uid. (The FOURTEENTH is a different matter and is NOT
# explained by anything in this section — see ONE KNOWN-RED TEST below. Nothing here says it is
# not a product defect.) `git config --global --add safe.directory` does NOT fix it here: the lab's sandbox
# spawns git with a sanitised environment, so HOME is unset and the global config is never read.
#
# Matching the container uid to the worktree owner removes the mismatch at the source. But npm ci
# must run under the SAME uid, or node_modules ends up root-owned and the tests fail the other way,
# on EACCES writing node_modules/.cache. Both halves are required; either alone trades one failure
# mode for the other.
#
# ---------------------------------------------------------------------------
# ONE KNOWN-RED TEST. CAUSE ESTABLISHED 2026-08-28: A SPAWN TIMEOUT UNDER LOAD.
#
# This block used to blame a missing `docker` CLI. That was withdrawn (grep finds no docker in the
# test or in the gate it loads, and the lab's docker spawns sit behind candidate/live.ts and
# candidate-v3/live.ts, which are their own CI steps and unreachable from `vitest run bench/lab`).
# Then somebody read the logs, which is all it ever needed.
#
# THE TWO ARMS FAIL ON DIFFERENT TESTS:
#   node:20  bench/lab/admission-features/scorer-only/__tests__/blinded-holdout-v2.test.ts
#            "loads the assembled v2 policy through the real preflight CLI" -> timed out in 5000ms
#   node:22  bench/lab/ret010/__tests__/dev-gate.test.ts:2199
#            "runs the exact production finalize CLI..." -> spawnSync node ETIMEDOUT (errno -110)
#
# Same class both times: a short hard timeout around spawning a Node subprocess. The node:22 case
# allows timeout: 3_000 (dev-gate.test.ts:2196); the node:20 case is vitest's default 5s. That one
# file carries seven such 2-3s spawn budgets, so WHICH test trips depends on machine load, not on
# any defect. Both arms reported "Tests 1 failed | 2116 passed", at 160-220s of test time on a
# 4-core box measured at load 2.83.
#
# That is why this looked like one stable known-red test for three packets: stable in COUNT,
# unstable in IDENTITY. Nothing is missing from this container — the budgets are simply too tight
# for it under parallel load. The real fix is to raise those budgets or serialise the lab run, not
# to filter anything out.
#
# CORRECTED 2026-08-29: LAB_EXIT=1 IS NOT THE STEADY STATE. LAB_EXIT=0 IS.
#
# Measured this date on node:22, clean worktree, nothing else competing for the box:
# LAB_EXIT=0, `Test Files 68 passed (68)`, `Tests 2117 passed (2117)`. The lab is not
# unconditionally red, and the earlier "expected steady state" wording was wrong — it taught the
# reader to expect a failure, which is exactly how a real regression gets waved through.
#
# The lab goes red under two SEPARATE and independently avoidable conditions:
#   1. Parallel load, which trips one of the seven tight spawn budgets above (this block).
#      Load-dependent, so the identity of the failing test moves. RESEARCH-LEDGER.md RL-017.
#   2. A dirty worktree, which makes the RET-010 custody check reject before opening a handle.
#      Deterministic, reproduces in under a second, and reports as `expected [] to have a
#      length of 62`. RESEARCH-LEDGER.md RL-020, and the preflight warning below.
#
# Both had been running together, which is why the count looked stable at one while the identity
# moved. Remove both — clean tree, one gate at a time — and the correct expectation is ZERO
# failures. Read any failure; do not budget for one in advance. And do not "fix" this by
# filtering the test out — a gate you have taught to ignore its own output is the thing this
# whole comment exists to prevent.
set -u

NODE_MAJOR="${1:?usage: gate.sh <node-major> <worktree>}"
WORKTREE="${2:?usage: gate.sh <node-major> <worktree>}"

OWNER_UID="$(stat -c %u "$WORKTREE")"
OWNER_GID="$(stat -c %g "$WORKTREE")"
echo "gate: node:${NODE_MAJOR}  worktree=${WORKTREE}  user=${OWNER_UID}:${OWNER_GID}"

# A DIRTY WORKTREE FAILS THE RET-010 CUSTODY TESTS, AND THE FAILURE DOES NOT LOOK LIKE ONE.
#
# `bench/lab/ret010/dev-gate.cjs` pinPaths()/auditPinnedPaths() open with
#   git rev-parse HEAD ... || git status --porcelain=v1 --untracked-files=all != '' -> reject()
# so the finalizer refuses to pin sources it cannot prove match HEAD. That is the point of the
# gate and is correct. But it rejects BEFORE opening a single file handle, so the test that
# counts handles reports `expected [] to have a length of 62` -- which reads as a product defect
# and is really one stray edited file anywhere in the tree.
#
# Demonstrated 2026-08-29: appending one comment line to an unrelated source file flips
# "drains every retained finalizer owner once after an injected close failure" from pass to fail,
# and `git checkout --` flips it straight back.
#
# Note `git clean -fd` is NOT sufficient to get here -- it removes untracked files but leaves
# MODIFIED TRACKED ones, which is exactly the state that bites. This warns rather than refuses,
# because running the gate on a work-in-progress tree is otherwise legitimate.
DIRT="$(git -C "$WORKTREE" status --porcelain=v1 --untracked-files=all 2>/dev/null)"
if [ -n "$DIRT" ]; then
  echo "gate: WARNING -- worktree is NOT clean. The RET-010 custody tests will fail on this,"
  echo "gate:            and the failure will look like a product defect. It is not one."
  echo "$DIRT" | sed 's/^/gate:            /'
fi

STATUS_FILE="$WORKTREE/.release-gate-status"
INITIAL_HEAD="$(git -C "$WORKTREE" rev-parse HEAD)"
if [ -z "$DIRT" ]; then INITIAL_CLEAN=1; else INITIAL_CLEAN=0; fi
rm -f "$STATUS_FILE" \
  "$WORKTREE/install.log" "$WORKTREE/gate-contract.log" \
  "$WORKTREE/format.log" "$WORKTREE/lint.log" "$WORKTREE/build.log" \
  "$WORKTREE/guidance.log" "$WORKTREE/ws.log" "$WORKTREE/lab.log" \
  "$WORKTREE/lab-typecheck.log" "$WORKTREE/lab-validate.log" \
  "$WORKTREE/baseline.log" "$WORKTREE/lab-ci.log" "$WORKTREE/docker.log"

GATE_CONTAINER_NAME="memberry-gate-node${NODE_MAJOR}-$$"

docker run --name "$GATE_CONTAINER_NAME" \
  --label memberry.release-gate=true \
  --user "${OWNER_UID}:${OWNER_GID}" \
  -e HOME=/tmp \
  -e GATE_SOURCE_COMMIT="$INITIAL_HEAD" \
  -e GATE_SOURCE_CLEAN="$INITIAL_CLEAN" \
  -v "$WORKTREE":/w -w /w "node:${NODE_MAJOR}" sh -c "
  set +e
  . /w/scripts/release-gate-runner.sh
  run_release_gate_stage /w/.release-gate-status /w INSTALL install.log npm ci --no-audit --no-fund
  run_release_gate_stage /w/.release-gate-status /w GATE_CONTRACT gate-contract.log npm run test:release-gate
  run_release_gate_stage /w/.release-gate-status /w FORMAT format.log npm run format:check
  run_release_gate_stage /w/.release-gate-status /w LINT lint.log npm run lint:ci
  run_release_gate_stage /w/.release-gate-status /w BUILD build.log npm run build
  run_release_gate_stage /w/.release-gate-status /w GUIDANCE guidance.log npm run validate:memberry-guidance
  run_release_gate_stage /w/.release-gate-status /w WORKSPACE ws.log npm run test --workspaces --if-present
  run_release_gate_stage /w/.release-gate-status /w LAB lab.log npm run bench:lab:test
  run_release_gate_stage /w/.release-gate-status /w LAB_TYPECHECK lab-typecheck.log npm run bench:lab:typecheck
  run_release_gate_stage /w/.release-gate-status /w LAB_VALIDATE lab-validate.log npm run bench:lab:validate
  run_release_gate_stage /w/.release-gate-status /w BASELINE baseline.log npm run bench:lab:baseline:verify
  run_release_gate_stage /w/.release-gate-status /w LAB_CI lab-ci.log npm run bench:lab:ci
  run_release_gate_stage /w/.release-gate-status /w SOURCE_BINDING source-binding.log sh -c 'test \"\$GATE_SOURCE_CLEAN\" = 1 && test \"\$(git rev-parse HEAD)\" = \"\$GATE_SOURCE_COMMIT\" && test -z \"\$(git status --porcelain=v1 --untracked-files=all)\"'
  node scripts/release-candidate-manifest.mjs \
    /w /w/release-candidate-manifest.json /w/.release-gate-status
" > "$WORKTREE/docker.log" 2>&1
DOCKER_EXIT=$?

# Keep daemon-side container removal outside the evidence-producing command.
# Docker can leave an already-exited `--rm` container in `removing` indefinitely,
# which used to prevent this wrapper from ever reporting otherwise-complete gate
# results. Cleanup is exact-name and bounded; a timeout is observable but does
# not rewrite the container's recorded exit code or any stage receipt.
if ! timeout 30 docker rm "$GATE_CONTAINER_NAME" >/dev/null 2>&1; then
  echo "gate: WARNING -- cleanup timed out for exited container $GATE_CONTAINER_NAME" >&2
fi

echo "--- exits ---"
if [ "$DOCKER_EXIT" -ne 0 ]; then
  echo "DOCKER_EXIT=$DOCKER_EXIT"
fi
node "$WORKTREE/scripts/release-gate-status.mjs" "$STATUS_FILE"
GATE_EXIT=$?
if [ -f "$WORKTREE/release-candidate-manifest.json" ]; then MANIFEST_EXIT=0; else MANIFEST_EXIT=1; fi

# Preserve each matrix arm before a subsequent invocation replaces root logs.
# The source check above has already finished; this ignored evidence directory
# cannot contaminate the repository snapshot being qualified.
ARCHIVE_DIR="$WORKTREE/.release-gate-runs/${INITIAL_HEAD}/node${NODE_MAJOR}-$(date -u +%Y%m%dT%H%M%SZ)-$$"
ARCHIVE_EXIT=0
mkdir -p "$ARCHIVE_DIR" || ARCHIVE_EXIT=1
for artifact in .release-gate-status release-candidate-manifest.json install.log \
  gate-contract.log format.log lint.log build.log guidance.log ws.log lab.log \
  lab-typecheck.log lab-validate.log baseline.log lab-ci.log source-binding.log docker.log; do
  if [ -f "$WORKTREE/$artifact" ]; then
    cp "$WORKTREE/$artifact" "$ARCHIVE_DIR/$artifact" || ARCHIVE_EXIT=1
  fi
done
echo "gate: preserved evidence at $ARCHIVE_DIR"

echo "--- workspace suite totals (summed across all workspaces) ---"
grep -oE '^ *Tests +.*' "$WORKTREE/ws.log" 2>/dev/null \
  | grep -oE '[0-9]+ (passed|failed|skipped)' \
  | awk '{s[$2]+=$1} END {for (k in s) print k, s[k]}'

echo "--- lab failures (expected: ZERO on a clean tree with no competing run -- see the header) ---"
grep -oE '^ *Tests +.*' "$WORKTREE/lab.log" 2>/dev/null | tail -1

if [ "$DOCKER_EXIT" -ne 0 ] || [ "$GATE_EXIT" -ne 0 ] || [ "$MANIFEST_EXIT" -ne 0 ] || [ "$ARCHIVE_EXIT" -ne 0 ]; then
  exit 1
fi
