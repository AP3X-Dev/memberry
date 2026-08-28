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
# ONE KNOWN-RED TEST. CAUSE NOT ESTABLISHED.
#
#   RET-010E > "drains every retained finalizer owner once after an injected close failure and
#   emits no output"   <- IDENTITY NOT RE-CONFIRMED; recorded alongside the withdrawn cause.
#
# This block used to assert that the test shells out to the `docker` CLI, which the node:NN image
# does not contain. THAT ATTRIBUTION IS UNSUPPORTED and has been withdrawn: `grep -i docker` over
# bench/lab/ret010/__tests__/dev-gate.test.ts and bench/lab/ret010/dev-gate.cjs both return zero,
# and the test compiles the gate in-process and calls __testFinalize with injected hooks — no
# docker, no container. It is NOT subprocess-free: developmentFailureFixture runs
# `execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' })` at
# dev-gate.test.ts:307 — the same git-against-a-host-owned-worktree operation blamed for the other
# 13. A lead, not a cause, and a weak one: this failure SURVIVED the uid fix that cleared those
# 13, which is evidence the class is different. Not checked either way.
#
# Nor is docker reachable from this run at all: the lab's docker spawns live behind
# candidate/live.ts and candidate-v3/live.ts, which run from the bench:lab:admission:*:live
# scripts as their own CI steps, NOT from `vitest run bench/lab`. So "docker is missing" cannot
# explain a failure in this sweep, whichever test it is.
#
# The real cause is NOT ESTABLISHED. The suite HAS been run — that is how we know one case still
# fails after the uid fix — but nobody has read that case's output. Establishing the cause means
# reading the failure in lab.log, not producing another one. Do not restate the docker story as fact and
# do not install a replacement — including the failing test's identity above, which was recorded
# alongside the withdrawn cause and has not itself been re-confirmed.
#
# NOTE ON CI. CI runs the same command (`npm run bench:lab:test`, ci.yml:50) and is expected green
# — no run id was ever recorded, so that is an expectation, not an attestation. The old header
# reasoned from this that CI "is the authority for that test, not this script". That inference is
# ALSO withdrawn: its premise was the docker story (CI's runner has a docker CLI, the container
# does not). With the cause unknown, there is no established reason CI's environment differs from
# this container's, so a green CI does not license ignoring the red here.
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
