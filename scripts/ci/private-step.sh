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
  # Never print log lines: only finite tool/action/reason labels and bounded codes.
  native_failure='^(xcrun|spctl|codesign|/usr/bin/codesign|/usr/bin/hdiutil|/usr/bin/ditto|/usr/bin/tar|/usr/bin/xattr|/bin/cp|minisign|cargo|pnpm) exited with status (0|[1-9][0-9]?|1[0-9][0-9]|2[0-4][0-9]|25[0-5])$'
  image_failure='^hdiutil: (convert|resize|attach|detach|verify) failed - (Resource busy|No space left on device|Operation not permitted|Device not configured)$'
  while IFS= read -r line || [[ -n "$line" ]]; do
    if [[ "$line" =~ $native_failure ]]; then
      tool=${BASH_REMATCH[1]##*/}
      printf '::error::%s native tool failed: %s (exit %s).\n' "$stage" "$tool" "${BASH_REMATCH[2]}"
    elif [[ "$line" =~ $image_failure ]]; then
      printf '::error::%s disk image %s failed: %s.\n' "$stage" "${BASH_REMATCH[1]}" "${BASH_REMATCH[2]}"
    fi
  done < "$log"
  printf '::error::%s failed (exit %s). Reproduce in the private source repository for diagnostics.\n' "$stage" "$result"
  exit "$result"
fi
