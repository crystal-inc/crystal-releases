#!/usr/bin/env bash
set -euo pipefail
umask 077

# No application files, npm credentials, workspace config or pnpm hooks are
# copied here. Only the integrity-only lockfile is used with the public registry.
fetch_directory="$RUNNER_TEMP/crystal-dependency-fetch"
mkdir -p "$fetch_directory"
cp "$RUNNER_TEMP/crystal-source/pnpm-lock.yaml" "$fetch_directory/pnpm-lock.yaml"
printf 'registry=https://registry.npmjs.org/\nignore-scripts=true\n' > "$fetch_directory/.npmrc"
cd "$fetch_directory"
pnpm fetch --ignore-scripts --store-dir "$RUNNER_TEMP/crystal-pnpm-store"
