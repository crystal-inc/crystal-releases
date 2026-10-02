#!/usr/bin/env bash
set -euo pipefail
umask 077

stage=$1
shift
log=$(mktemp "$RUNNER_TEMP/crystal-private-XXXXXX.log")
trap 'rm -f "$log"' EXIT
cd "$RUNNER_TEMP/crystal-source"
printf '%s started. Private output is suppressed.\n' "$stage"
if "$@" > "$log" 2>&1; then
  printf '%s passed.\n' "$stage"
else
  result=$?
  printf '::error::%s failed (exit %s). Reproduce in the private source repository for diagnostics.\n' "$stage" "$result"
  exit "$result"
fi
