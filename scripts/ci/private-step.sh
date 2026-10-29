#!/usr/bin/env bash
set -euo pipefail
umask 077

stage=$1
shift
log=$(mktemp "$RUNNER_TEMP/crystal-private-XXXXXX.log")
trap 'rm -f "$log"' EXIT
cd "$RUNNER_TEMP/crystal-source"
printf '%s started. Private output is suppressed.\n' "$stage"
release_phase='(wasm|mcp|local-ai-server|local-ai-resources|frontend|native-app|copy-app|provision-profile|clear-attributes|sign-plugin-host|sign-node|runtime-manifest|sign-app|verify-plugin-host|verify-app|runtime-check|notarization-archive|app-submit|app-wait|app-info|app-staple|app-validate|gatekeeper|dmg-prepare-tools|dmg-install-tools|dmg-build-image|dmg-verify-image|sign-dmg|dmg-submit|dmg-wait|dmg-info|dmg-staple|dmg-validate|node-jit|updater-archive|updater-sign|release-metadata|cleanup)'
release_progress="^Release step: ${release_phase} (started|finished|failed)$"
filter_progress() {
  while IFS= read -r line || [[ -n "$line" ]]; do
    if [[ "$line" =~ $release_progress ]]; then
      printf 'Release step: %s %s\n' "${BASH_REMATCH[1]}" "${BASH_REMATCH[2]}"
    fi
  done
}
if "$@" 2>&1 | tee "$log" 2>/dev/null | filter_progress; then
  printf '%s passed.\n' "$stage"
else
  result=$?
  # Never print log lines: only finite tool/action/reason labels and bounded codes.
  native_exit_pattern='(0|[1-9][0-9]?|1[0-9][0-9]|2[0-4][0-9]|25[0-5])'
  native_failure="^(xcrun|spctl|codesign|/usr/bin/codesign|/usr/bin/hdiutil|/usr/bin/ditto|/usr/bin/tar|/usr/bin/xattr|/bin/cp|minisign|cargo|pnpm) exited with status ${native_exit_pattern}$"
  apple_failure="^Apple notarization failed: artifact=(app|dmg) operation=(submit|wait|info|staple|validate) exit=${native_exit_pattern}$"
  dmg_phase_failure='^DMG operation failed: phase=(prepare-tools|install-tools|build-image|create-image|resize|attach|copy-app|verify-app|detach|convert-final|verify-image)$'
  image_failure='^hdiutil: (convert|resize|attach|detach|verify) failed - (Resource busy|No space left on device|Operation not permitted|Device not configured)$'
  while IFS= read -r line || [[ -n "$line" ]]; do
    if [[ "$line" =~ $native_failure ]]; then
      tool=${BASH_REMATCH[1]##*/}
      printf '::error::%s native tool failed: %s (exit %s).\n' "$stage" "$tool" "${BASH_REMATCH[2]}"
    elif [[ "$line" =~ $apple_failure ]]; then
      printf '::error::%s Apple notarization failed: %s %s (exit %s).\n' "$stage" "${BASH_REMATCH[1]}" "${BASH_REMATCH[2]}" "${BASH_REMATCH[3]}"
    elif [[ "$line" =~ $dmg_phase_failure ]]; then
      printf '::error::%s DMG operation failed: %s.\n' "$stage" "${BASH_REMATCH[1]}"
    elif [[ "$line" =~ $image_failure ]]; then
      printf '::error::%s disk image %s failed: %s.\n' "$stage" "${BASH_REMATCH[1]}" "${BASH_REMATCH[2]}"
    fi
  done < "$log"
  printf '::error::%s failed (exit %s). Reproduce in the private source repository for diagnostics.\n' "$stage" "$result"
  exit "$result"
fi
