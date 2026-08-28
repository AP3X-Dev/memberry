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
# Running this as the container's default root against a host-owned worktree produced FOURTEEN lab
# failures that looked like product defects for three consecutive gates. They were not. Thirteen
# were `fatal: detected dubious ownership in repository at '/w'` — git refuses a repo owned by a
# different uid. `git config --global --add safe.directory` does NOT fix it here: the lab's sandbox
# spawns git with a sanitised environment, so HOME is unset and the global config is never read.
#
# Matching the container uid to the worktree owner removes the mismatch at the source. But npm ci
# must run under the SAME uid, or node_modules ends up root-owned and the tests fail the other way,
# on EACCES writing node_modules/.cache. Both halves are required; either alone trades one failure
# mode for the other.
#
# ---------------------------------------------------------------------------
# ONE KNOWN-RED TEST, AND IT IS AN ENVIRONMENT GAP, NOT A DEFECT
#
#   RET-010E > "drains every retained finalizer owner once after an injected close failure"
#
# Its sandbox shells out to the `docker` CLI, which the node:NN image does not contain. CI runs on
# a runner that has one, and CI is green — so CI is the authority for that test, not this script.
# Mounting the docker socket in here would hand the test suite control of the host daemon, which is
# not a trade worth making for one assertion.
#
# So: LAB_EXIT=1 with exactly ONE failure is the expected steady state. TWO or more is a real
# regression and must be read. Do not "fix" this by filtering the test out — a gate you have taught
# to ignore its own output is the thing this whole comment exists to prevent.
set -eu

NODE_MAJOR="${1:?usage: gate.sh <node-major> <worktree>}"
WORKTREE="${2:?usage: gate.sh <node-major> <worktree>}"

OWNER_UID="$(stat -c %u "$WORKTREE")"
OWNER_GID="$(stat -c %g "$WORKTREE")"
echo "gate: node:${NODE_MAJOR}  worktree=${WORKTREE}  user=${OWNER_UID}:${OWNER_GID}"

docker run --rm --network host \
  --user "${OWNER_UID}:${OWNER_GID}" \
  -e HOME=/tmp \
  -v "$WORKTREE":/w -w /w "node:${NODE_MAJOR}" sh -c "
  npm ci --no-audit --no-fund > /w/install.log 2>&1; echo INSTALL_EXIT=\$? >> /w/install.log;
  npm test                    > /w/ws.log      2>&1; echo WS_EXIT=\$?      >> /w/ws.log;
  npx vitest run bench/lab    > /w/lab.log     2>&1; echo LAB_EXIT=\$?     >> /w/lab.log;
  npm run build               > /w/tsc.log     2>&1; echo TSC_EXIT=\$?     >> /w/tsc.log;
" > "$WORKTREE"/docker.log 2>&1 || true

echo "--- exits ---"
for f in install ws lab tsc; do
  grep -oE '[A-Z]+_EXIT=[0-9]+' "$WORKTREE/$f.log" 2>/dev/null || echo "${f}: no log"
done

echo "--- workspace suite totals (summed across all workspaces) ---"
grep -oE '^ *Tests +.*' "$WORKTREE/ws.log" 2>/dev/null \
  | grep -oE '[0-9]+ (passed|failed|skipped)' \
  | awk '{s[$2]+=$1} END {for (k in s) print k, s[k]}'

echo "--- lab failures (expected: exactly 1, see the header) ---"
grep -oE '^ *Tests +.*' "$WORKTREE/lab.log" 2>/dev/null | tail -1
