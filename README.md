# Crystal releases

Crystal installers and distribution workflows. Application source is maintained
in separate repositories; this repository contains only distribution tooling.

Run the dependency-free tooling tests with `npm test`. Runtime scripts live in
`scripts/`; their tests live in `scripts/test/`.

## Test a macOS build

Open **Actions → Build macOS installers → Run workflow**. Select a trusted source
branch, tag or commit and a version such as `0.1.0`. Until the release tooling is
merged into the source repository's main branch, use `codex/native-release-ci`.

The workflow resolves the source to one immutable commit before building on
standard Apple Silicon and Intel macOS runners. After both jobs succeed, download
their `crystal-macos-*` artifacts. Each contains a DMG and its SHA-256 checksum.
Artifacts are retained for seven days. A successful dispatch in the source
repository means that the build was requested; inspect this repository for the
actual build result.

These test installers use ad-hoc signatures. They are not notarized by Apple;
macOS may require explicit approval in Privacy & Security before opening them.
The workflow does not publish a release or enable client updates.

## Configuration

Use one GitHub App installed on `crystal-inc/crystal`, `crystal-inc/crystal-server`
and `crystal-inc/crystal-releases`, with Contents write and Metadata read.

- Actions variable: `CRYSTAL_RELEASE_BOT_CLIENT_ID`.
- Actions secret: `CRYSTAL_RELEASE_BOT_PRIVATE_KEY` (the complete PEM).

Build jobs request Contents **read** tokens limited to the two source repositories.
The source dispatcher requests Contents **write** limited to this repository.
The App's private key itself can mint write tokens for every installed repository.
No Apple credentials are required for this first build stage.

Public workflows accept manual requests by maintainers and dispatches from this
App. They never run for public pull requests. Private checkout, installation,
compiler and test output stays off public logs. Only the explicit DMG/checksum
allowlist is uploaded; private source and compiler caches are never uploaded.
Public caches contain the Emscripten SDK, pinned Tauri CLI, public Rust toolchain,
crates.io download archives and public npm registry packages. Keys include the
architecture, tool versions or dependency lock fingerprints. Existing packages
can be reused when a lock changes; the package managers still verify the requested
versions and integrity. GitHub may evict a cache, so a missing cache remains safe.

The pnpm store is filled in a separate directory using only an integrity-only
lockfile and the public npm registry, with scripts disabled. It is saved **before**
installing or building private workspaces; subsequent private changes to the store
are not uploaded. File/Git/URL resolutions and patched packages disable this cache.
`node_modules`, private workspace files, Cargo targets, Git dependencies, extracted
crate sources and project WASM output are never part of these cache paths.
