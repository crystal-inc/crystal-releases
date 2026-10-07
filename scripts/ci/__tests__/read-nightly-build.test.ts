import assert from "node:assert/strict";
import test from "node:test";
import { readNightlyBuildVersion } from "../read-nightly-build.ts";
import { build } from "../../release/__tests__/fixtures.ts";

test("a rerun without an existing release can resolve a new version", async () => {
  assert.equal(
    await readNightlyBuildVersion("123", build.sourceCommit, async () => ({
      data: { repository: { release: null } },
    })),
    undefined,
  );
});

test("an incomplete existing draft cannot acquire a different version", async () => {
  const responses: unknown[] = [
    { data: { repository: { release: { databaseId: 7 } } } },
    { assets: [] },
  ];
  await assert.rejects(
    readNightlyBuildVersion("123", build.sourceCommit, async () =>
      responses.shift(),
    ),
    /Existing nightly has no build metadata/,
  );
});

test("a rerun must match its immutable build and source identities", async () => {
  for (const [buildId, source] of [
    ["124", build.sourceCommit],
    ["123", "b".repeat(40)],
  ]) {
    const responses: unknown[] = [
      { data: { repository: { release: { databaseId: 7 } } } },
      { assets: [{ id: 8, name: "build.json" }] },
      build,
    ];
    await assert.rejects(
      readNightlyBuildVersion(buildId, source, async () => responses.shift()),
      /Nightly retry build identity is invalid/,
    );
  }
});
