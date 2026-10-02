import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { requirePromotion, verifyInstaller } from "../channels.ts";

const bytes = Buffer.from("verified app");
const build = {
  schemaVersion: 1,
  buildId: "123",
  version: "0.1.123",
  sourceCommit: "a".repeat(40),
  installers: Object.fromEntries(
    ["aarch64", "x86_64"].map((arch) => [
      arch,
      {
        name: `Crystal_0.1.123_darwin-${arch}.dmg`,
        size: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      },
    ]),
  ),
};
const nightly = {
  schemaVersion: 1,
  channel: "nightly",
  buildId: "123",
  sourceChannel: null,
  actor: "builder",
};

test("normal promotion preserves the build through nightly, latest and stable", () => {
  const latest = requirePromotion({
    target: "latest",
    sourceRecord: nightly,
    build,
    actor: "maintainer",
  });
  const stable = requirePromotion({
    target: "stable",
    sourceRecord: latest.channel,
    build: latest.build,
    actor: "maintainer",
  });
  assert.deepEqual(latest.build, build);
  assert.deepEqual(stable.build, build);
  assert.equal(stable.channel.sourceChannel, "latest");
  assert.equal(stable.channel.buildId, "123");
});

test("stable defaults to latest and allows nightly only when explicitly selected", () => {
  assert.throws(() =>
    requirePromotion({
      target: "stable",
      sourceRecord: nightly,
      build,
      actor: "maintainer",
    }),
  );
  const stable = requirePromotion({
    target: "stable",
    source: "nightly",
    sourceRecord: nightly,
    build,
    actor: "maintainer",
  });
  assert.equal(stable.channel.sourceChannel, "nightly");
  assert.deepEqual(stable.build, build);
});

test("source selection never bypasses build identity or installer verification", () => {
  assert.throws(() =>
    requirePromotion({
      target: "stable",
      source: "nightly",
      sourceRecord: { ...nightly, buildId: "124" },
      build,
      actor: "maintainer",
    }),
  );
  const result = requirePromotion({
    target: "latest",
    sourceRecord: nightly,
    build,
    actor: "maintainer",
  });
  verifyInstaller(bytes, result.build.installers.aarch64);
  assert.throws(() =>
    verifyInstaller(
      Buffer.from("modified app"),
      result.build.installers.aarch64,
    ),
  );
  assert.throws(() =>
    requirePromotion({
      target: "latest",
      source: "latest",
      sourceRecord: result.channel,
      build,
      actor: "maintainer",
    }),
  );
});

test("invalid build records and unrelated source channels cannot be promoted", () => {
  for (const invalid of [
    null,
    {},
    { ...build, version: "0.1.123;bad" },
    { ...build, installers: { aarch64: build.installers.aarch64 } },
  ])
    assert.throws(() =>
      requirePromotion({
        target: "latest",
        sourceRecord: nightly,
        build: invalid,
        actor: "maintainer",
      }),
    );
  assert.throws(() =>
    requirePromotion({
      target: "latest",
      sourceRecord: { ...nightly, channel: "stable", sourceChannel: "latest" },
      build,
      actor: "maintainer",
    }),
  );
});

test("build IDs reject whitespace, path fragments and option-like values at the boundary", () => {
  for (const buildId of ["123\n", " 123", "../123", "--123", "0"]) {
    const candidate = { ...build, buildId };
    assert.throws(() =>
      requirePromotion({
        target: "latest",
        sourceRecord: { ...nightly, buildId },
        build: candidate,
        actor: "maintainer",
      }),
    );
  }
});
