#!/bin/sh

# Run one required release-gate stage without stopping the remaining stages.
# The caller owns ordering and performs the final fail-closed receipt check.
run_release_gate_stage() {
  receipt_file="$1"
  log_root="$2"
  stage="$3"
  log="$4"
  shift 4
  case $- in *e*) restore_errexit=1 ;; *) restore_errexit=0 ;; esac
  set +e
  "$@" >"$log_root/$log" 2>&1
  code=$?
  printf '%s_EXIT=%s\n' "$stage" "$code" >>"$receipt_file"
  printf '%s_EXIT=%s\n' "$stage" "$code" >>"$log_root/$log"
  if [ "$restore_errexit" -eq 1 ]; then set -e; fi
  return 0
}
