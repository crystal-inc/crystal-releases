#!/usr/bin/env bash
set -euo pipefail

# The wrapper hides checkout messages and private commit subjects. The header
# exists only for these commands: no token is saved in Git configuration or URLs.
auth=$(printf 'x-access-token:%s' "$SOURCE_READ_TOKEN" | base64 | tr -d '\n')
git init --quiet .
git remote add origin https://github.com/crystal-inc/crystal.git
git -c "http.https://github.com/.extraheader=AUTHORIZATION: basic $auth" \
  fetch --quiet --depth 1 origin "$CRYSTAL_SOURCE_SHA"
git checkout --quiet --detach FETCH_HEAD
test "$(git rev-parse HEAD)" = "$CRYSTAL_SOURCE_SHA"
git config submodule.recurse false
git -c "http.https://github.com/.extraheader=AUTHORIZATION: basic $auth" \
  -c 'url.https://github.com/.insteadOf=git@github.com:' \
  submodule update --init .private/crystal-server
unset auth SOURCE_READ_TOKEN
bash scripts/ensure-links.sh
test -f apps/server/package.json
