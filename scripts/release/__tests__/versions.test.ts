import assert from "node:assert/strict";
import test from "node:test";
import { bumpVersion } from "../versions.ts";

test("minor and major bumps reset the lower version components", () => {
  assert.equal(bumpVersion("1.9.99", "minor"), "1.10.0");
  assert.equal(bumpVersion("1.9.99", "major"), "2.0.0");
  assert.equal(bumpVersion("0.2.0", "patch"), "0.2.1");
});

test("version bumps do not lose numeric precision", () => {
  assert.equal(
    bumpVersion("1.0.9007199254740992", "patch"),
    "1.0.9007199254740993",
  );
});

test("version bumps reject malformed published versions", () => {
  for (const version of ["", "v0.1.23", "0.01.23", "0.1.23\n", "0.1.23-beta"])
    assert.throws(() => bumpVersion(version, "patch"));
});
