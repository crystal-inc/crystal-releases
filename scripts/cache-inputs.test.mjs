import assert from "node:assert/strict";
import test from "node:test";
import {
  canCachePublicPnpmPackages,
  dependencyFingerprint,
} from "./cache-inputs.mjs";

const lockfile = `lockfileVersion: '9.0'
importers:
  private-workspace:
    dependencies:
      internal:
        version: link:../internal
packages:
  is-number@7.0.0:
    resolution: {integrity: sha512-dGVzdA==}
snapshots:
  is-number@7.0.0: {}
`;

test("workspace links outside package resolutions do not enter the registry-only cache", () => {
  assert.equal(canCachePublicPnpmPackages(lockfile), true);
});

test("a public package deprecation notice may contain a documentation URL", () => {
  const deprecated = lockfile.replace(
    "snapshots:",
    "    deprecated: Please see https://eslint.org/version-support for other options.\nsnapshots:",
  );
  assert.equal(canCachePublicPnpmPackages(deprecated), true);
});

test("file, Git, URL and patched packages are excluded from public dependency caching", () => {
  for (const resolution of [
    "{directory: ../private, type: directory}",
    "{repo: git@github.com:crystal-inc/private.git, type: git}",
    "{integrity: sha512-dGVzdA==, tarball: https://private.example/package.tgz}",
    "\n      integrity: sha512-dGVzdA==\n      tarball: https://private.example/package.tgz",
  ])
    assert.equal(
      canCachePublicPnpmPackages(
        lockfile.replace("{integrity: sha512-dGVzdA==}", resolution),
      ),
      false,
    );
  assert.equal(
    canCachePublicPnpmPackages(
      lockfile.replace(
        "packages:",
        "patchedDependencies:\n  is-number@7.0.0: patches/private.patch\npackages:",
      ),
    ),
    false,
  );
  for (const key of [
    "private@file:../private:",
    "private@link:../private:",
    "https://private.example/package.tgz:",
    "private@git+ssh://git@github.com/private:",
  ]) {
    assert.equal(
      canCachePublicPnpmPackages(lockfile.replace("is-number@7.0.0:", key)),
      false,
    );
  }
  assert.equal(
    canCachePublicPnpmPackages(
      lockfile.replace(
        "snapshots:",
        '  unresolved@1.0.0:\n    engines: {node: ">=18"}\nsnapshots:',
      ),
    ),
    false,
  );
});

test("changing any dependency lock invalidates its cache fingerprint", () => {
  const original = dependencyFingerprint([
    ["a", "one"],
    ["b", "two"],
  ]);
  assert.equal(
    dependencyFingerprint([
      ["a", "one"],
      ["b", "two"],
    ]),
    original,
  );
  assert.notEqual(
    dependencyFingerprint([
      ["a", "one"],
      ["b", "changed"],
    ]),
    original,
  );
  assert.notEqual(
    dependencyFingerprint([
      ["different", "one"],
      ["b", "two"],
    ]),
    original,
  );
});
